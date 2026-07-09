const TASK_ID_PREFIX = /TASK_ID:\s*(\S+)/;
const ORDER_ID_PREFIX = /ORDER_ID:\s*(\S+)/;

export interface ParsedReply {
  answer: string;
  confidence: number;
}

/**
 * Parses a validator reply of the form `<answer> | <confidence>`.
 * Returns null when the message is malformed (missing delimiter, empty answer,
 * non-numeric or out-of-range confidence).
 */
export function parseValidatorReply(text: string): ParsedReply | null {
  if (!text.includes("|")) return null;

  const delimiterIndex = text.indexOf("|");
  const answer = text.slice(0, delimiterIndex).trim();
  const confidenceRaw = text.slice(delimiterIndex + 1).trim();

  if (answer.length === 0) return null;

  const confidence = Number.parseFloat(confidenceRaw);
  if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  return { answer, confidence };
}

/** Extracts the TASK_ID from a bot task message (the replied-to text). */
export function extractTaskId(text: string | undefined): string | null {
  if (!text) return null;
  const match = TASK_ID_PREFIX.exec(text);
  return match ? match[1] : null;
}

/** Extracts the ORDER_ID from a standby preview message. */
export function extractOrderId(text: string | undefined): string | null {
  if (!text) return null;
  const match = ORDER_ID_PREFIX.exec(text);
  return match ? match[1] : null;
}

/** Renders the outgoing task message posted to the validator group. */
export function formatTaskMessage(taskId: string, query: string): string {
  return [
    `TASK_ID: ${taskId}`,
    "",
    "Question:",
    query,
    "",
    "Reply in this format:",
    "<answer> | <confidence (0-1)>",
  ].join("\n");
}
