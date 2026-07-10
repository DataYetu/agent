/**
 * Optional LLM fallback when no human Telegram validator replies in time.
 * OpenAI-compatible chat completions (Groq, OpenAI, local vLLM, etc.).
 */
export interface LlmFallbackConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Hard cap on LLM confidence (humans can score higher). */
  confidence: number;
}

export interface LlmAnswer {
  answer: string;
  confidence: number;
  model: string;
  raw: string;
}

const SYSTEM_PROMPT = [
  "You are Datayetu Oracle's LLM fallback. Answer like a brief human validator.",
  "",
  "Rules:",
  "- One sentence only, max ~25 words, single line. No lists or essays.",
  "- Sound natural and direct, as if typed in a Telegram chat.",
  "- Prefer East Africa context when the query is local.",
  "- Do not invent exact numbers, dates, or statistics.",
  "",
  "Tone by topic:",
  "- Prices / cost of living / markets: be assertive — say costlier or cheaper",
  "  (or stable). Avoid soft words like \"feels\", \"seems\", \"might\".",
  "- Weather / comfort: softer language is fine (e.g. \"feels cold\", \"a bit cloudy\").",
  "- If truly unsure: one clear sentence + confidence 0.4–0.55.",
  "",
  "Respond ONLY as: <one-line answer> | <confidence 0-1>",
  "Price example: Maize flour is costlier in Nairobi markets this week | 0.62",
  "Weather example: It feels a bit cold and cloudy in Nairobi today | 0.58",
].join("\n");

/** Collapse model output to a single human-readable line. */
export function humanizeLlmAnswer(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
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
      temperature: 0.3,
      max_tokens: 80,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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

  answer = humanizeLlmAnswer(answer);
  // Cap LLM confidence so human validators remain higher-trust when present.
  confidence = Math.min(confidence, cfg.confidence);
  if (!answer) throw new Error("LLM fallback produced empty answer");

  return { answer, confidence, model: cfg.model, raw };
}
