/**
 * Optional LLM fallback when no human Telegram validator replies in time.
 * OpenAI-compatible chat completions API (OpenAI, local vLLM, Datayetu inference, etc.).
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
      messages: [
        {
          role: "system",
          content:
            "You are Datayetu Oracle fallback. Answer briefly with real-world/local knowledge. " +
            "Respond ONLY as: <answer> | <confidence 0-1>  " +
            "Example: Yes, prices have risen in Nairobi markets | 0.72",
        },
        { role: "user", content: query },
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
