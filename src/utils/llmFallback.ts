/**
 * Optional LLM fallback when no human Telegram validator replies in time.
 * OpenAI-compatible chat completions (Groq, OpenAI, local vLLM, etc.).
 */
export interface LlmFallbackConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Confidence assigned to LLM answers (kept below typical human scores). */
  confidence: number;
}

export interface LlmAnswer {
  answer: string;
  confidence: number;
  model: string;
  raw: string;
}

const SYSTEM_PROMPT = [
  "You are Datayetu Oracle — a controlled LLM fallback for a human-validated",
  "data agent on CROO. Humans on Telegram are preferred; you only answer when",
  "they do not reply in time so a paid order can still complete.",
  "",
  "Context for accuracy:",
  "- Focus on East Africa (Kenya, Uganda, Tanzania) when the query is local.",
  "- Prefer concrete, current market / weather / cost-of-living style answers.",
  "- If uncertain, say so briefly and use lower confidence (0.4–0.55).",
  "- Do not invent precise prices or statistics you cannot support; stay qualitative.",
  "",
  "Respond ONLY in this exact format (no markdown, no extra lines):",
  "<answer> | <confidence 0-1>",
  "",
  "Example:",
  "Yes, maize flour prices in Nairobi markets have risen recently | 0.62",
].join("\n");

export async function askLlmFallback(
  query: string,
  cfg: LlmFallbackConfig,
): Promise<LlmAnswer> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 180,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Oracle query from a CROO order (answer for delivery):\n\n${query}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM fallback HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error("LLM fallback returned empty content");

  const pipe = raw.indexOf("|");
  let answer = raw;
  let confidence = cfg.confidence;
  if (pipe >= 0) {
    answer = raw.slice(0, pipe).trim();
    const confRaw = Number.parseFloat(raw.slice(pipe + 1).trim());
    if (!Number.isNaN(confRaw)) {
      confidence = Math.min(1, Math.max(0, confRaw));
    }
  }

  // Cap LLM confidence so human validators remain higher-trust when present.
  confidence = Math.min(confidence, cfg.confidence);
  if (!answer) throw new Error("LLM fallback produced empty answer");

  return { answer, confidence, model: cfg.model, raw };
}
