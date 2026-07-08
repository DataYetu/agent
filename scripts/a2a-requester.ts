/**
 * A2A requester smoke test against Datayetu Oracle on CROO.
 *
 * Needs a SECOND agent SDK key (requester) with USDC in its AA wallet.
 *
 *   CROO_REQUESTER_SDK_KEY=croo_sk_... \
 *   CROO_TARGET_SERVICE_ID=svc-new-1783069024874 \
 *   npx tsx scripts/a2a-requester.ts "Is maize flour up in Nairobi this week?"
 */
import { AgentClient, EventType } from "@croo-network/sdk";
import "dotenv/config";

const apiUrl = process.env.CROO_API_URL ?? "https://api.croo.network";
const wsUrl = process.env.CROO_WS_URL ?? "wss://api.croo.network/ws";
const sdkKey = process.env.CROO_REQUESTER_SDK_KEY;
const serviceId = process.env.CROO_TARGET_SERVICE_ID ?? process.env.CROO_SERVICE_ID;
const query =
  process.argv.slice(2).join(" ").trim() ||
  "Is the cost of living rising in Nairobi right now?";
const maxPrice = Number(process.env.MAX_PRICE ?? "0.05");

if (!sdkKey) {
  console.error("Set CROO_REQUESTER_SDK_KEY (second agent key, not the provider key).");
  process.exit(1);
}
if (!serviceId) {
  console.error("Set CROO_TARGET_SERVICE_ID to Datayetu's service id.");
  process.exit(1);
}

const client = new AgentClient({ baseURL: apiUrl, wsURL: wsUrl }, sdkKey);
const stream = await client.connectWebSocket();

stream.on(EventType.OrderCreated, async (e) => {
  if (!e.order_id) return;
  console.log(`[a2a] order created ${e.order_id}; paying...`);
  try {
    const paid = await client.payOrder(e.order_id);
    console.log(`[a2a] paid tx=${paid.txHash}`);
  } catch (err) {
    console.error(`[a2a] pay failed: ${(err as Error).message}`);
  }
});

stream.on(EventType.OrderCompleted, async (e) => {
  if (!e.order_id) return;
  try {
    const delivery = await client.getDelivery(e.order_id);
    console.log("[a2a] delivery:");
    console.log(delivery.deliverableText);
  } catch (err) {
    console.error(`[a2a] getDelivery failed: ${(err as Error).message}`);
  } finally {
    stream.close();
    process.exit(0);
  }
});

stream.on(EventType.OrderRejected, (e) => {
  console.error(`[a2a] order rejected: ${e.order_id} ${e.reason ?? ""}`);
  stream.close();
  process.exit(1);
});

stream.on(EventType.OrderExpired, (e) => {
  console.error(`[a2a] order expired: ${e.order_id}`);
  stream.close();
  process.exit(1);
});

const requirements = JSON.stringify({
  query,
  max_price: maxPrice,
  caller_type: "agent",
  caller_id: `did:croo:agent:a2a-requester`,
});

console.log(`[a2a] negotiating with ${serviceId}`);
console.log(`[a2a] requirements=${requirements}`);
const neg = await client.negotiateOrder({ serviceId, requirements });
console.log(`[a2a] negotiation ${neg.negotiationId} status=${neg.status}`);

setTimeout(() => {
  console.error("[a2a] timed out waiting for completion (5 min)");
  stream.close();
  process.exit(1);
}, 5 * 60 * 1000);
