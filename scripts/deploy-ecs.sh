#!/usr/bin/env bash
# Build, push, and deploy the Datayetu agent to ECS Fargate.
# Designed for GitHub Actions (no local .env required when SKIP_SECRET_UPLOAD=1).
#
# Usage:
#   IMAGE_TAG=<sha> ./scripts/deploy-ecs.sh
#   SKIP_SECRET_UPLOAD=1 IMAGE_TAG=<sha> ./scripts/deploy-ecs.sh   # CI default
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO="${ECR_REPO:-datayetu-agent}"
ECS_CLUSTER="${ECS_CLUSTER:-datayetu}"
AGENT_SERVICE_NAME="${AGENT_SERVICE_NAME:-datayetu-agent-prod}"
AGENT_TASK_FAMILY="${AGENT_TASK_FAMILY:-datayetu-agent-prod}"
AGENT_SECRET_NAME="${AGENT_SECRET_NAME:-datayetu/prod/agent}"
AGENT_CPU="${AGENT_CPU:-256}"
AGENT_MEMORY="${AGENT_MEMORY:-512}"
AGENT_DESIRED_COUNT="${AGENT_DESIRED_COUNT:-1}"
AGENT_LOG_RETENTION_DAYS="${AGENT_LOG_RETENTION_DAYS:-30}"
AGENT_PORT="${AGENT_PORT:-3000}"
SKIP_SECRET_UPLOAD="${SKIP_SECRET_UPLOAD:-0}"

: "${ECS_SUBNETS:?Set ECS_SUBNETS}"
: "${ECS_TASK_SG:?Set ECS_TASK_SG}"
: "${ECS_EXECUTION_ROLE_ARN:?Set ECS_EXECUTION_ROLE_ARN}"
: "${ECS_TASK_ROLE_ARN:?Set ECS_TASK_ROLE_ARN}"

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "$AWS_REGION")"
ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)}"
IMAGE_URI="$ECR_URI:$IMAGE_TAG"

echo "==> Ensure ECR repository: $ECR_REPO"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" >/dev/null

echo "==> Build and push: $IMAGE_URI"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_URI" >/dev/null
docker build -t "$ECR_REPO:$IMAGE_TAG" "$ROOT_DIR"
docker tag "$ECR_REPO:$IMAGE_TAG" "$IMAGE_URI"
docker tag "$ECR_REPO:$IMAGE_TAG" "$ECR_URI:latest"
docker tag "$ECR_REPO:$IMAGE_TAG" "$ECR_URI:prod-latest"
docker push "$IMAGE_URI"
docker push "$ECR_URI:latest"
docker push "$ECR_URI:prod-latest"

if [[ "$SKIP_SECRET_UPLOAD" != "1" ]]; then
  [[ -f "$ROOT_DIR/.env" ]] || { echo "Missing $ROOT_DIR/.env (or set SKIP_SECRET_UPLOAD=1)"; exit 1; }
  echo "==> Upload secrets to: $AGENT_SECRET_NAME"
  SECRET_JSON="$(
    node -e '
      const fs = require("fs");
      const needed = [
        "CROO_API_URL","CROO_WS_URL","CROO_SDK_KEY","CROO_SERVICE_ID",
        "TELEGRAM_BOT_TOKEN","TELEGRAM_GROUP_ID","VALIDATOR_TIMEOUT_MS",
        "SERVICE_PRICE","SERVICE_CURRENCY","PORT","ENABLE_DEV_ENDPOINT","BASE_RPC_URL"
      ];
      const out = {};
      for (const line of fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i <= 0) continue;
        const k = t.slice(0, i).trim();
        if (needed.includes(k)) out[k] = t.slice(i + 1);
      }
      for (const k of needed) {
        if (!out[k]) { console.error(`Missing .env key: ${k}`); process.exit(1); }
      }
      process.stdout.write(JSON.stringify(out));
    ' "$ROOT_DIR/.env"
  )"
  if aws secretsmanager describe-secret --secret-id "$AGENT_SECRET_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$AGENT_SECRET_NAME" --secret-string "$SECRET_JSON" --region "$AWS_REGION" >/dev/null
  else
    aws secretsmanager create-secret --name "$AGENT_SECRET_NAME" --secret-string "$SECRET_JSON" --region "$AWS_REGION" >/dev/null
  fi
else
  echo "==> Skip secret upload (using existing $AGENT_SECRET_NAME)"
  aws secretsmanager describe-secret --secret-id "$AGENT_SECRET_NAME" --region "$AWS_REGION" >/dev/null
fi

SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$AGENT_SECRET_NAME" --region "$AWS_REGION" --query ARN --output text)"
LOG_GROUP="/ecs/$AGENT_TASK_FAMILY"

aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$AWS_REGION" >/dev/null 2>&1 || true
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days "$AGENT_LOG_RETENTION_DAYS" --region "$AWS_REGION" >/dev/null

SECRET_KEYS="$(aws secretsmanager get-secret-value --secret-id "$AGENT_SECRET_NAME" --region "$AWS_REGION" \
  --query SecretString --output text | node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(Object.keys(o).join(' '))")"

SECRETS_JSON="["
first=1
for key in $SECRET_KEYS; do
  [[ $first -eq 1 ]] && first=0 || SECRETS_JSON+=","
  SECRETS_JSON+="{\"name\":\"${key}\",\"valueFrom\":\"${SECRET_ARN}:${key}::\"}"
done
SECRETS_JSON+="]"

TASK_DEF=$(cat <<EOF
{
  "family": "${AGENT_TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${AGENT_CPU}",
  "memory": "${AGENT_MEMORY}",
  "executionRoleArn": "${ECS_EXECUTION_ROLE_ARN}",
  "taskRoleArn": "${ECS_TASK_ROLE_ARN}",
  "runtimePlatform": {
    "cpuArchitecture": "X86_64",
    "operatingSystemFamily": "LINUX"
  },
  "containerDefinitions": [
    {
      "name": "agent",
      "image": "${IMAGE_URI}",
      "essential": true,
      "portMappings": [{ "containerPort": ${AGENT_PORT}, "protocol": "tcp" }],
      "secrets": ${SECRETS_JSON},
      "healthCheck": {
        "command": ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${AGENT_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 30
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "agent",
          "awslogs-create-group": "true"
        }
      }
    }
  ]
}
EOF
)

echo "$TASK_DEF" > /tmp/datayetu-agent-task-def.json
TASK_DEF_ARN="$(aws ecs register-task-definition --cli-input-json file:///tmp/datayetu-agent-task-def.json --region "$AWS_REGION" --query 'taskDefinition.taskDefinitionArn' --output text)"

ASSIGN_PUBLIC_IP="${ECS_ASSIGN_PUBLIC_IP:-ENABLED}"
NET_CFG="awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[${ECS_TASK_SG}],assignPublicIp=${ASSIGN_PUBLIC_IP}}"
DEPLOY_CFG="deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100"

SERVICE_STATUS="$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$AGENT_SERVICE_NAME" --region "$AWS_REGION" --query 'services[0].status' --output text 2>/dev/null || echo MISSING)"

if [[ "$SERVICE_STATUS" == "ACTIVE" || "$SERVICE_STATUS" == "DRAINING" ]]; then
  echo "==> Update service: $AGENT_SERVICE_NAME"
  aws ecs update-service \
    --cluster "$ECS_CLUSTER" \
    --service "$AGENT_SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count "$AGENT_DESIRED_COUNT" \
    --force-new-deployment \
    --deployment-configuration "$DEPLOY_CFG" \
    --region "$AWS_REGION" >/dev/null
else
  echo "==> Create service: $AGENT_SERVICE_NAME"
  aws ecs create-service \
    --cluster "$ECS_CLUSTER" \
    --service-name "$AGENT_SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count "$AGENT_DESIRED_COUNT" \
    --deployment-configuration "$DEPLOY_CFG" \
    --health-check-grace-period-seconds 60 \
    --network-configuration "$NET_CFG" \
    --capacity-provider-strategy "capacityProvider=FARGATE,weight=1,base=1" \
    --region "$AWS_REGION" >/dev/null
fi

echo "==> Wait for service stability"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$AGENT_SERVICE_NAME" --region "$AWS_REGION"

echo "IMAGE_URI=$IMAGE_URI"
aws ecs describe-services \
  --cluster "$ECS_CLUSTER" \
  --services "$AGENT_SERVICE_NAME" \
  --region "$AWS_REGION" \
  --query 'services[0].{service:serviceName,status:status,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,events:events[0:3]}' \
  --output json
