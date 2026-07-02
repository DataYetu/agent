import { loadConfig } from "./utils/config.js";
import { ValidatorBot } from "./telegram/bot.js";
import { Orchestrator } from "./core/orchestrator.js";
import { createCrooClient } from "./croo/client.js";
import { CrooProvider } from "./croo/provider.js";
import { createApp } from "./api/agent.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. Human validator network
  const bot = new ValidatorBot(config.telegram);
  bot.start();

  // 2. Core engine
  const orchestrator = new Orchestrator({
    bot,
    validatorTimeoutMs: config.runtime.validatorTimeoutMs,
  });

  // 3. CAP provider — listens for orders and settles via CROO
  const client = createCrooClient(config);
  const provider = new CrooProvider(client, orchestrator, config);
  await provider.start();

  // 4. HTTP surface (health + optional dev endpoint)
  const app = createApp(orchestrator, config);
  const server = app.listen(config.runtime.port, () => {
    console.log(`[api] listening on :${config.runtime.port}`);
    console.log("datayetu-agent is live — awaiting CAP orders");
  });

  const shutdown = () => {
    console.log("\nshutting down...");
    bot.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
