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
    if (!text) return;

    // Only consider replies to the bot's own task messages.
    const repliedText = msg.reply_to_message?.text;
    const taskId = extractTaskId(repliedText);
    if (!taskId) return;

    const parsed = parseValidatorReply(text);
    if (!parsed) {
      console.warn(`[telegram] ignoring malformed reply for task ${taskId}`);
      return;
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
