/**
 * Manually fund escrow for pending CROO orders (requester side).
 *
 * Why this exists: the SDK's `payOrder()` runs a client-side ethers balance
 * pre-check (`checkERC20Balance` → `new JsonRpcProvider(...)`) BEFORE the actual
 * pay call. In some networks that ethers request hangs ("failed to detect
 * network" / TIMEOUT) even though the wallet is funded and the CROO backend is
 * reachable. This script skips that optional pre-check and calls the same
 * `POST /orders/{id}/pay` endpoint the SDK uses, so escrow still funds and the
 * provider can fulfil + settle the order.
 *
 * Usage:
 *   npm run pay                       # auto-discover + pay all `created` orders
 *   npm run pay -- <orderId> [<id2>]  # pay specific order id(s)
 */
import { AgentClient, OrderStatus, type Order } from "@croo-network/sdk";
import "dotenv/config";

const apiUrl = process.env.CROO_API_URL ?? "https://api.croo.network";
const wsUrl = process.env.CROO_WS_URL ?? "wss://api.croo.network/ws";
const sdkKey =
  process.env.CROO_REQUESTER_SDK_KEY ?? process.env.CROO_A2A_TESTER_SDK_KEY;

if (!sdkKey) {
  console.error(
    "Set CROO_REQUESTER_SDK_KEY or CROO_A2A_TESTER_SDK_KEY (the requester key that created the orders).",
  );
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for transient network blips worth retrying (the CROO API is far/high-latency). */
function isTransient(err: unknown): boolean {
  const m = (err as Error)?.message ?? "";
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
  return /fetch failed|timeout|ECONN|ETIMEDOUT|UND_ERR/i.test(m + " " + code);
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry real API errors (expired, bad params, etc.) — only network blips.
      if (!isTransient(err)) throw err;
      const backoff = Math.min(1000 * 2 ** (i - 1), 8000);
      console.warn(`[pay] ${label} attempt ${i}/${attempts} network blip; retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** Pay via the raw REST endpoint, skipping the SDK's ethers balance pre-check. */
async function directPay(orderId: string): Promise<{ txHash?: string; status?: string }> {
  const url = `${apiUrl}/backend/v1/orders/${orderId}/pay`;
  const resp = await withRetry(`pay ${orderId}`, () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SDK-Key": sdkKey! },
      body: "{}",
    }),
  );
  const text = await resp.text();
  if (resp.status >= 400) {
    throw new Error(`pay HTTP ${resp.status}: ${text}`);
  }
  const parsed = text ? JSON.parse(text) : {};
  return { txHash: parsed.txHash, status: parsed.order?.status };
}

const client = new AgentClient({ baseURL: apiUrl, wsURL: wsUrl }, sdkKey);

const explicitIds = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);

let targets: string[] = explicitIds;

if (targets.length === 0) {
  console.log("[pay] no ids given — listing requester orders in `created` status...");
  const orders = await withRetry("list orders", () =>
    client.listOrders({
      role: "buyer",
      status: OrderStatus.Created,
      pageSize: 50,
    }),
  );
  targets = orders.map((o: Order) => o.orderId);
  if (targets.length === 0) {
    console.log("[pay] no orders in `created` status. Nothing to pay.");
    process.exit(0);
  }
  console.log(`[pay] found ${targets.length} unpaid order(s): ${targets.join(", ")}`);
}

let ok = 0;
let failed = 0;
for (const id of targets) {
  try {
    const r = await directPay(id);
    ok++;
    console.log(`[pay] ✓ ${id} → status=${r.status ?? "?"} tx=${r.txHash ?? "(pending)"}`);
  } catch (err) {
    failed++;
    console.error(`[pay] ✗ ${id} → ${(err as Error).message}`);
  }
}

console.log(`[pay] done. paid=${ok} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
