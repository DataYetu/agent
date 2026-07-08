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
    },
    runtime: {
      // 3 minutes by default — humans need breathing room; LLM covers timeouts.
      validatorTimeoutMs: Number(optional("VALIDATOR_TIMEOUT_MS", "180000")),
      servicePrice: Number(optional("SERVICE_PRICE", "0.05")),
      serviceCurrency: optional("SERVICE_CURRENCY", "USDC"),
      port: Number(optional("PORT", "3000")),
      enableDevEndpoint: optional("ENABLE_DEV_ENDPOINT", "false") === "true",
    },
    llm: {
      enabled: optional("LLM_FALLBACK_ENABLED", "false") === "true",
      baseUrl: optional("LLM_BASE_URL", "https://api.openai.com/v1"),
      apiKey: optional("LLM_API_KEY", ""),
      model: optional("LLM_MODEL", "gpt-4o-mini"),
      confidence: Number(optional("LLM_FALLBACK_CONFIDENCE", "0.65")),
    },
  };
}
