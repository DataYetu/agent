/**
 * A2A requester smoke test against Datayetu Oracle on CROO.
 *
 * Needs a SECOND agent SDK key (requester) with USDC in its AA wallet.
 *
 *   npm run a2a -- "Is maize flour up in Nairobi this week?"
 */
import {
  AgentClient,
  EventType,
  InsufficientBalanceError,
  type Event,
} from "@croo-network/sdk";
import "dotenv/config";

const apiUrl = process.env.CROO_API_URL ?? "https://api.croo.network";
const wsUrl = process.env.CROO_WS_URL ?? "wss://api.croo.network/ws";
const rpcUrl = process.env.BASE_RPC_URL?.trim() || undefined;
const sdkKey =
  process.env.CROO_REQUESTER_SDK_KEY ?? process.env.CROO_A2A_TESTER_SDK_KEY;
const serviceId = process.env.CROO_TARGET_SERVICE_ID ?? process.env.CROO_SERVICE_ID;
const query = process.argv.slice(2).join(" ").trim();
const maxPrice = Number(process.env.MAX_PRICE ?? "0.1");
const fundToken =
  process.env.CROO_FUND_TOKEN ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const fundAmount = process.env.CROO_FUND_AMOUNT ?? "1000";

if (!sdkKey) {
  console.error(
    "Set CROO_REQUESTER_SDK_KEY or CROO_A2A_TESTER_SDK_KEY (not the provider key).",
  );
  process.exit(1);
}
if (!serviceId) {
  console.error("Set CROO_TARGET_SERVICE_ID to Datayetu's service UUID.");
  process.exit(1);
}
if (!query || query.length < 10) {
  console.error(
    'Pass a real question (min 10 chars), e.g.: npm run a2a -- "Is maize flour up in Nairobi?"',
  );
  process.exit(1);
}
if (/probe|smoke\s*test|^test$/i.test(query)) {
  console.error("Use a meaningful demo question — not a probe/test placeholder.");
  process.exit(1);
}

/**
 * Pay via the raw REST endpoint, skipping the SDK's ethers balance pre-check.
 * `payOrder()` runs `checkERC20Balance` (a `JsonRpcProvider` call) before the
 * actual pay; that pre-check can hang ("failed to detect network" / TIMEOUT) on
 * some networks even when the wallet is funded and CROO is reachable.
 */
async function directPay(
  orderId: string,
): Promise<{ txHash?: string; status?: string }> {
  const resp = await fetch(`${apiUrl}/backend/v1/orders/${orderId}/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SDK-Key": sdkKey! },
    body: "{}",
  });
  const text = await resp.text();
  if (resp.status >= 400) throw new Error(`pay HTTP ${resp.status}: ${text}`);
  const parsed = text ? JSON.parse(text) : {};
  return { txHash: parsed.txHash, status: parsed.order?.status };
}

/** Ignore websocket backlog from earlier CLI runs until this session's negotiation is active. */
function belongsToThisRun(e: Event, activeNegotiationId: string | undefined): boolean {
  if (!activeNegotiationId) return false;
  if (e.negotiation_id && e.negotiation_id !== activeNegotiationId) return false;
  return true;
}

const client = new AgentClient(
  { baseURL: apiUrl, wsURL: wsUrl, ...(rpcUrl ? { rpcURL: rpcUrl } : {}) },
  sdkKey,
);
if (rpcUrl) console.log(`[a2a] using Base RPC ${rpcUrl}`);
const stream = await client.connectWebSocket();
let activeNegotiationId: string | undefined;
const paidOrderIds = new Set<string>();

stream.on(EventType.OrderCreated, async (e) => {
  if (!e.order_id) return;
  if (!belongsToThisRun(e, activeNegotiationId)) {
    console.log(
      `[a2a] ignoring stale order_created ${e.order_id} (negotiation ${e.negotiation_id ?? "?"})`,
    );
    return;
  }
  if (paidOrderIds.has(e.order_id)) return;
  paidOrderIds.add(e.order_id);
  console.log(`[a2a] order created ${e.order_id}; paying...`);
  try {
    const paid = await client.payOrder(e.order_id);
    console.log(`[a2a] paid tx=${paid.txHash}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof InsufficientBalanceError) {
      console.error(`[a2a] pay failed: insufficient balance — fund the requester AA wallet. ${msg}`);
      return;
    }
    // The ethers balance pre-check couldn't reach the RPC (not a funds problem).
    // Fall back to paying via the REST endpoint directly.
    if (/timeout|failed to detect network|ECONN|fetch failed|ETIMEDOUT|network/i.test(msg)) {
      console.warn(`[a2a] balance pre-check unreachable (${msg}); paying via API directly...`);
      try {
        const paid = await directPay(e.order_id);
        console.log(`[a2a] paid (direct) status=${paid.status ?? "?"} tx=${paid.txHash ?? "(pending)"}`);
      } catch (err2) {
        console.error(`[a2a] direct pay failed: ${(err2 as Error).message}`);
      }
      return;
    }
    console.error(`[a2a] pay failed: ${msg}`);
  }
});

stream.on(EventType.OrderCompleted, async (e) => {
  if (!e.order_id) return;
  if (!belongsToThisRun(e, activeNegotiationId)) {
    console.log(`[a2a] ignoring stale order_completed ${e.order_id}`);
    return;
  }
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
  if (!belongsToThisRun(e, activeNegotiationId)) {
    console.log(
      `[a2a] ignoring stale order_rejected ${e.order_id} (${e.reason ?? "no reason"})`,
    );
    return;
  }
  console.error(`[a2a] order rejected: ${e.order_id} ${e.reason ?? ""}`);
  stream.close();
  process.exit(1);
});

stream.on(EventType.OrderExpired, (e) => {
  if (!belongsToThisRun(e, activeNegotiationId)) {
    console.log(`[a2a] ignoring stale order_expired ${e.order_id}`);
    return;
  }
  console.error(`[a2a] order expired: ${e.order_id}`);
  stream.close();
  process.exit(1);
});

const requirements = JSON.stringify({
  query,
  max_price: maxPrice,
  caller_type: "agent",
  caller_id: "did:croo:agent:a2a-requester",
  principal_amount: Number(fundAmount) / 1_000_000,
});

console.log(`[a2a] negotiating with ${serviceId}`);
console.log(`[a2a] query=${query}`);
const neg = await client.negotiateOrder({
  serviceId,
  requirements,
  fundAmount,
  fundToken,
});
activeNegotiationId = neg.negotiationId;
console.log(`[a2a] negotiation ${neg.negotiationId} status=${neg.status}`);

setTimeout(() => {
  console.error("[a2a] timed out waiting for completion (5 min)");
  stream.close();
  process.exit(1);
}, 5 * 60 * 1000);
