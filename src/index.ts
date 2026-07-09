import { loadConfig } from "./utils/config.js";
import { ValidatorBot } from "./telegram/bot.js";
import { Orchestrator } from "./core/orchestrator.js";
import { createCrooClient } from "./croo/client.js";
import { CrooProvider } from "./croo/provider.js";
import { createApp } from "./api/agent.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. Human validator network (evicts duplicate pollers before listening)
  const bot = new ValidatorBot(config.telegram);
  await bot.start();

  // 2. Core engine
  const orchestrator = new Orchestrator({
    bot,
    validatorTimeoutMs: config.runtime.validatorTimeoutMs,
    llm: {
      enabled: config.llm.enabled,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      confidence: config.llm.confidence,
    },
  });
  if (config.llm.enabled) {
    console.log(`[llm] fallback enabled model=${config.llm.model}`);
  }
  if (config.croo.providerFundAddress) {
    console.log(`[croo] PROVIDER_FUND_ADDRESS set (${config.croo.providerFundAddress})`);
  }

  // 3. CAP provider — listens for orders and settles via CROO
  const client = createCrooClient(config);
  const provider = new CrooProvider(client, orchestrator, config);
  await provider.start();

  // 4. HTTP surface (health + optional dev endpoint)
  const app = createApp(orchestrator, config);
  const instanceId = process.env.HOSTNAME ?? process.env.ECS_CONTAINER_METADATA_URI ?? "local";
  const server = app.listen(config.runtime.port, () => {
    console.log(`[api] listening on :${config.runtime.port} (instance=${instanceId})`);
    console.log("datayetu-agent is live — awaiting CAP orders");
  });

  const shutdown = async () => {
    console.log("\nshutting down...");
    await bot.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
