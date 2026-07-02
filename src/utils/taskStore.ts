import type { Task, ValidatorResponse } from "../types/index.js";

interface PendingEntry {
  resolve: (response: ValidatorResponse) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * In-memory registry correlating a task_id to its Task record and the pending
 * promise awaiting a validator reply. Sufficient for the hackathon build; swap
 * for Redis/DB to survive restarts in production.
 */
export class TaskStore {
  private tasks = new Map<string, Task>();
  private pending = new Map<string, PendingEntry>();

  create(task: Task): void {
    this.tasks.set(task.task_id, task);
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  update(taskId: string, patch: Partial<Task>): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next: Task = { ...task, ...patch, updated_at: new Date().toISOString() };
    this.tasks.set(taskId, next);
    return next;
  }

  /**
   * Registers a resolver for a validator reply. Rejects with a timeout error
   * if no reply arrives within `timeoutMs`.
   */
  waitForValidator(taskId: string, timeoutMs: number): Promise<ValidatorResponse> {
    return new Promise<ValidatorResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(taskId);
        reject(new Error("VALIDATOR_TIMEOUT"));
      }, timeoutMs);

      this.pending.set(taskId, { resolve, reject, timeout });
    });
  }

  /** Called by the Telegram bot when a well-formed reply arrives. */
  resolveValidator(response: ValidatorResponse): boolean {
    const entry = this.pending.get(response.task_id);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(response.task_id);
    entry.resolve(response);
    return true;
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }
}

export const taskStore = new TaskStore();
