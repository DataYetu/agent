import { randomUUID } from "node:crypto";
import type {
  CallerType,
  ErrorCode,
  Task,
  ValidatorResponse,
} from "../types/index.js";
import { taskStore } from "../utils/taskStore.js";
import type { ValidatorBot } from "../telegram/bot.js";

export interface OrchestratorOptions {
  bot: ValidatorBot;
  validatorTimeoutMs: number;
}

export interface HandleQueryInput {
  query: string;
  caller_type: CallerType;
  caller_id?: string | null;
  max_price: number;
  order_id?: string;
  negotiation_id?: string;
}

export class OrchestratorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly taskId?: string,
    public readonly orderId?: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export interface ValidatedTask {
  task: Task;
  validator: ValidatorResponse;
}

/**
 * The core engine. Registers a task, dispatches it to the human validator
 * network, and resolves once a validator replies (or fails on timeout).
 * CAP delivery + settlement are handled by the caller (the provider module or
 * the dev endpoint) using the returned task + validator response.
 */
export class Orchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  async handleQuery(input: HandleQueryInput): Promise<ValidatedTask> {
    const now = new Date().toISOString();
    const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const task: Task = {
      task_id: taskId,
      order_id: input.order_id,
      negotiation_id: input.negotiation_id,
      query: input.query,
      status: "CREATED",
      caller_type: input.caller_type,
      caller_id: input.caller_id ?? null,
      max_price: input.max_price,
      created_at: now,
      updated_at: now,
    };
    taskStore.create(task);

    const dispatchedAt = Date.now();
    try {
      await this.opts.bot.dispatchTask(taskId, input.query);
    } catch (err) {
      taskStore.update(taskId, {
        status: "FAILED",
        error: { code: "INTERNAL_ERROR", message: "Telegram dispatch failed" },
      });
      throw new OrchestratorError(
        "INTERNAL_ERROR",
        `Failed to dispatch task to Telegram: ${(err as Error).message}`,
        taskId,
        input.order_id,
      );
    }

    taskStore.update(taskId, {
      status: "AWAITING_VALIDATOR",
      dispatched_at: new Date().toISOString(),
    });

    let validator: ValidatorResponse;
    try {
      validator = await taskStore.waitForValidator(
        taskId,
        this.opts.validatorTimeoutMs,
      );
    } catch {
      taskStore.update(taskId, {
        status: "TIMEOUT",
        error: {
          code: "NO_VALIDATOR_RESPONSE",
          message: "No validator responded within the configured timeout window.",
        },
      });
      throw new OrchestratorError(
        "NO_VALIDATOR_RESPONSE",
        "No validator responded within the configured timeout window.",
        taskId,
        input.order_id,
      );
    }

    const latencyMs = Date.now() - dispatchedAt;
    const updated = taskStore.update(taskId, {
      status: "VALIDATED",
      validated_at: validator.received_at,
      validator_response: validator,
      latency_ms: latencyMs,
    });

    return { task: updated ?? task, validator };
  }
}
