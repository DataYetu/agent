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
  private readonly groupId: string;

  constructor(config: TelegramConfig) {
    this.groupId = config.groupId;
    this.bot = new TelegramBot(config.botToken, { polling: true });
  }

  start(): void {
    this.bot.on("message", (msg) => this.handleMessage(msg));
    this.bot.on("polling_error", (err) => {
      console.error("[telegram] polling error:", err.message);
    });
    console.log("[telegram] validator bot listening");
  }

  /** Posts a task to the validator group. Returns the sent message id. */
  async dispatchTask(taskId: string, query: string): Promise<number> {
    const sent = await this.bot.sendMessage(
      this.groupId,
      formatTaskMessage(taskId, query),
    );
    return sent.message_id;
  }

  private handleMessage(msg: TelegramBot.Message): void {
    const text = msg.text;
    // Debug: observe every update the bot actually receives.
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
    void this.bot.stopPolling();
  }
}
