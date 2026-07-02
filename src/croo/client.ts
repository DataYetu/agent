import { AgentClient } from "@croo-network/sdk";
import type { AppConfig } from "../utils/config.js";

/**
 * Constructs the single CAP runtime client. Authentication is via the SDK-Key;
 * all order negotiation, payment verification, delivery and event streaming go
 * through this client.
 */
export function createCrooClient(config: AppConfig): AgentClient {
  return new AgentClient(
    {
      baseURL: config.croo.apiUrl,
      wsURL: config.croo.wsUrl,
      ...(config.croo.rpcUrl ? { rpcURL: config.croo.rpcUrl } : {}),
    },
    config.croo.sdkKey,
  );
}
