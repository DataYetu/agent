import TelegramBot from "node-telegram-bot-api";
import type { ValidatorResponse } from "../types/index.js";
import { taskStore } from "../utils/taskStore.js";
import { extractTaskId, formatTaskMessage, parseValidatorReply } from "./parser.js";

export interface TelegramConfig {
  botToken: string;
  groupId: string;
}

/**
 * Wraps the validator-group bot: dispatches task messages and listens for
 * structured replies, correlating them back to the originating task via the
 * replied-to message's TASK_ID.
 */
export class ValidatorBot {
  private bot: TelegramBot;
  private readonly botToken: string;
  private readonly groupId: string;
  private pollingRestartTimer?: NodeJS.Timeout;
  private pollingConflictLogged = false;

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken;
    this.groupId = config.groupId;
    // Polling starts in start() after evicting other bot sessions (409 fix).
    this.bot = new TelegramBot(config.botToken, { polling: false });
  }

  async start(): Promise<void> {
    await this.evictConflictingSessions();
    await this.bot.startPolling({ restart: true });
    this.bot.on("message", (msg) => this.handleMessage(msg));
    this.bot.on("polling_error", (err) => this.handlePollingError(err));
    console.log(`[telegram] validator bot listening (group=${this.groupId})`);
  }

  /** Early heads-up while on-chain escrow payment confirms (~seconds before OrderPaid). */
  async notifyEscrowPending(orderId: string, query: string): Promise<void> {
    const shortId = orderId.slice(0, 8);
    await this.bot.sendMessage(
      this.groupId,
      `⚡ CROO order ${shortId}… escrow confirming — stand by\n\nQuestion:\n${query}`,
    );
    console.log(`[telegram] escrow preview sent for order ${orderId}`);
  }

  /** Posts a task to the validator group. Returns the sent message id. */
  async dispatchTask(taskId: string, query: string): Promise<number> {
    console.log(`[telegram] dispatching task ${taskId} to group ${this.groupId}`);
    const sent = await this.bot.sendMessage(
      this.groupId,
      formatTaskMessage(taskId, query),
    );
    console.log(
      `[telegram] dispatched task ${taskId} message_id=${sent.message_id} chat=${sent.chat.id}`,
    );
    return sent.message_id;
  }

  private async evictConflictingSessions(): Promise<void> {
    try {
      await this.telegramApi("deleteWebhook", { drop_pending_updates: true });
    } catch (err) {
      console.warn("[telegram] deleteWebhook:", (err as Error).message);
    }

    try {
      await this.telegramApi("close");
      console.log("[telegram] closed other bot sessions");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      const message = (err as Error).message;
      const retryAfter = /retry after (\d+)/i.exec(message)?.[1];
      if (retryAfter) {
        const waitMs = (Number.parseInt(retryAfter, 10) + 2) * 1000;
        console.warn(`[telegram] close rate-limited; waiting ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        try {
          await this.telegramApi("close");
          console.log("[telegram] closed other bot sessions (after rate-limit wait)");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (retryErr) {
          console.warn("[telegram] close:", (retryErr as Error).message);
        }
      } else {
        console.warn("[telegram] close:", message);
      }
    }
  }

  private handlePollingError(err: Error): void {
    console.error("[telegram] polling error:", err.message);
    if (!/409/.test(err.message)) return;

    if (!this.pollingConflictLogged) {
      this.pollingConflictLogged = true;
      console.error(
        "[telegram] another runtime is polling this bot token — stop local dev, CROO hosted deploy, or rotate TELEGRAM_BOT_TOKEN",
      );
    }

    // One slow retry only; avoid hammering close() (Telegram rate-limits hard).
    if (this.pollingRestartTimer) return;
    this.pollingRestartTimer = setTimeout(() => {
      this.pollingRestartTimer = undefined;
      void this.restartPollingAfterConflict();
    }, 120_000);
  }

  private async restartPollingAfterConflict(): Promise<void> {
    try {
      await this.bot.stopPolling();
      await this.evictConflictingSessions();
      await this.bot.startPolling({ restart: true });
      console.log("[telegram] polling restarted after 409 conflict");
    } catch (err) {
      console.error("[telegram] polling restart failed:", (err as Error).message);
    }
  }

  private async telegramApi(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as {
      ok: boolean;
      result?: unknown;
      description?: string;
    };
    if (!data.ok) {
      throw new Error(data.description ?? `HTTP ${res.status}`);
    }
    return data.result;
  }

  private handleMessage(msg: TelegramBot.Message): void {
    const text = msg.text;
    console.log(
      `[telegram][debug] msg chat=${msg.chat?.id} from=${msg.from?.id} isReply=${Boolean(
        msg.reply_to_message,
      )} text=${JSON.stringify(text)}`,
    );
    if (!text) return;

    const parsed = parseValidatorReply(text);
    if (!parsed) return;

    // Primary correlation: reply to the bot's task message (carries TASK_ID).
    let taskId = extractTaskId(msg.reply_to_message?.text);

    // Fallback: a plain, well-formed answer with exactly one task outstanding.
    if (!taskId) {
      const pending = taskStore.pendingIds();
      if (pending.length === 1) {
        taskId = pending[0];
        console.log(`[telegram] matched plain reply to sole pending task ${taskId}`);
      } else if (pending.length === 0) {
        return;
      } else {
        console.warn(
          `[telegram] ${pending.length} tasks pending; reply to a task message to disambiguate`,
        );
        return;
      }
    }

    if (!taskStore.has(taskId)) {
      console.warn(`[telegram] reply for unknown task ${taskId}`);
      return;
    }

    const response: ValidatorResponse = {
      task_id: taskId,
      answer: parsed.answer,
      confidence: parsed.confidence,
      validator_id: String(msg.from?.id ?? "unknown"),
      validator_username: msg.from?.username ?? null,
      raw_message: text,
      received_at: new Date().toISOString(),
      message_id: msg.message_id,
    };

    const resolved = taskStore.resolveValidator(response);
    if (resolved) {
      console.log(
        `[telegram] task ${taskId} validated by ${response.validator_id} (confidence ${parsed.confidence})`,
      );
    }
  }

  stop(): void {
    if (this.pollingRestartTimer) {
      clearTimeout(this.pollingRestartTimer);
      this.pollingRestartTimer = undefined;
    }
    void this.bot.stopPolling();
  }
}
