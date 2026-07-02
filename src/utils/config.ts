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
    },
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      groupId: required("TELEGRAM_GROUP_ID"),
    },
    runtime: {
      validatorTimeoutMs: Number(optional("VALIDATOR_TIMEOUT_MS", "90000")),
      servicePrice: Number(optional("SERVICE_PRICE", "0.05")),
      serviceCurrency: optional("SERVICE_CURRENCY", "USDC"),
      port: Number(optional("PORT", "3000")),
      enableDevEndpoint: optional("ENABLE_DEV_ENDPOINT", "false") === "true",
    },
  };
}
