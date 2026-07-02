import type {
  AgentSuccessResponse,
  ErrorCode,
  AgentErrorResponse,
  PaymentMetadata,
  Task,
  ValidatorResponse,
} from "../types/index.js";

/** Clamp a number into the inclusive [0, 1] confidence range. */
export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Collapse runs of whitespace and trim; preserves meaning of the answer. */
export function normalizeAnswer(answer: string): string {
  return answer.replace(/\s+/g, " ").trim();
}

/**
 * Assembles the strict success response from a resolved task, validator reply
 * and CAP-derived payment metadata.
 */
export function buildSuccessResponse(
  task: Task,
  validator: ValidatorResponse,
  payment: PaymentMetadata,
): AgentSuccessResponse {
  const confidence = clampConfidence(validator.confidence);
  return {
    status: "success",
    data: {
      answer: normalizeAnswer(validator.answer),
      confidence,
      validators: [
        {
          id: validator.validator_id,
          confidence,
          platform: "telegram",
        },
      ],
      metadata: {
        task_id: task.task_id,
        order_id: task.order_id,
        latency_ms: task.latency_ms ?? 0,
        timestamp: new Date().toISOString(),
        caller_type: task.caller_type,
        caller_id: task.caller_id ?? undefined,
      },
      payment,
    },
  };
}

export function buildErrorResponse(
  code: ErrorCode,
  message: string,
  opts?: { task_id?: string; order_id?: string },
): AgentErrorResponse {
  return {
    status: "error",
    error: {
      code,
      message,
      task_id: opts?.task_id,
      order_id: opts?.order_id,
    },
  };
}

/**
 * The structured payload delivered to CAP via `deliverOrder`. Includes the
 * answer, confidence, attribution and a hash of the raw validator message as
 * lightweight dispute evidence.
 */
export function buildDeliveryPayload(
  task: Task,
  validator: ValidatorResponse,
): Record<string, unknown> {
  return {
    answer: normalizeAnswer(validator.answer),
    confidence: clampConfidence(validator.confidence),
    validators: [
      {
        id: validator.validator_id,
        confidence: clampConfidence(validator.confidence),
        platform: "telegram",
      },
    ],
    task_id: task.task_id,
    latency_ms: task.latency_ms ?? 0,
    validated_at: validator.received_at,
    evidence: {
      raw_message_hash: hashString(validator.raw_message),
      message_id: validator.message_id,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Small non-crypto hash (FNV-1a) for evidence fingerprinting. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
