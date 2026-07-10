import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export interface AppConfig {
  croo: {
    apiUrl: string;
    wsUrl: string;
    sdkKey: string;
    serviceId: string;
    rpcUrl?: string;
    /** Required when the CROO service has require_fund_transfer=true. */
    providerFundAddress?: string;
  };
  telegram: {
    botToken: string;
    groupId: string;
    /** If true, call Telegram close() on boot to evict other pollers (can rate-limit). */
    evictOnStart: boolean;
  };
  runtime: {
    validatorTimeoutMs: number;
    servicePrice: number;
    serviceCurrency: string;
    port: number;
    enableDevEndpoint: boolean;
  };
  llm: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    confidence: number;
  };
}

/**
 * Loads and validates configuration. CROO/Telegram values are only required
 * when actually connecting; `loadConfig` throws eagerly so misconfiguration
 * surfaces at boot rather than mid-order.
 */
export function loadConfig(): AppConfig {
  const groqKey = process.env.GROQ_API_KEY?.trim() || "";
  const llmApiKey = process.env.LLM_API_KEY?.trim() || groqKey;
  const usingGroq = Boolean(groqKey) && !process.env.LLM_API_KEY?.trim();
  // Auto-enable when a Groq/LLM key is present unless explicitly disabled.
  const llmEnabledDefault = llmApiKey ? "true" : "false";

  return {
    croo: {
      apiUrl: required("CROO_API_URL"),
      wsUrl: required("CROO_WS_URL"),
      sdkKey: required("CROO_SDK_KEY"),
      serviceId: required("CROO_SERVICE_ID"),
      rpcUrl: process.env.BASE_RPC_URL || undefined,
      providerFundAddress: process.env.PROVIDER_FUND_ADDRESS?.trim() || undefined,
    },
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      groupId: required("TELEGRAM_GROUP_ID"),
      evictOnStart: optional("TELEGRAM_EVICT_ON_START", "false") === "true",
    },
    runtime: {
      // 90s default — humans first; Groq/LLM covers timeouts for completion score.
      validatorTimeoutMs: Number(optional("VALIDATOR_TIMEOUT_MS", "90000")),
      servicePrice: Number(optional("SERVICE_PRICE", "0.05")),
      serviceCurrency: optional("SERVICE_CURRENCY", "USDC"),
      port: Number(optional("PORT", "3000")),
      enableDevEndpoint: optional("ENABLE_DEV_ENDPOINT", "false") === "true",
    },
    llm: {
      enabled: optional("LLM_FALLBACK_ENABLED", llmEnabledDefault) === "true",
      baseUrl: optional(
        "LLM_BASE_URL",
        usingGroq || groqKey
          ? "https://api.groq.com/openai/v1"
          : "https://api.openai.com/v1",
      ),
      apiKey: llmApiKey,
      model: optional(
        "LLM_MODEL",
        usingGroq || groqKey ? "llama-3.3-70b-versatile" : "gpt-4o-mini",
      ),
      confidence: Number(optional("LLM_FALLBACK_CONFIDENCE", "0.65")),
    },
  };
}
