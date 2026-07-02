# Datayetu Agent

A **CROO-native oracle agent**. It sources real-world, human-validated answers
through a Telegram validator network and settles payment on-chain via the
**CROO Agent Protocol (CAP)** — never through manual wallet transfers.

- **A2A + H2A**: callable by other agents or by humans through CROO.
- **Human-grounded**: every answer comes from a real validator, with a
  confidence score.
- **CAP-settled**: `Negotiate → Lock → Deliver → Clear`; payment metadata is
  derived from CAP events, not fabricated.

Full specification: [`../docs/DATAYETU-ORACLE-CROO-SPEC.md`](../docs/DATAYETU-ORACLE-CROO-SPEC.md)

## Architecture

```
CROO caller (H2A / A2A)
   │  negotiate + pay (CAP escrow)
   ▼
CrooProvider ──► Orchestrator ──► ValidatorBot ──► Telegram group
   ▲                                   │
   │        validator reply            ▼
   └──── deliverOrder (proof) ◄── Orchestrator (normalize)
   │
   ▼
CAP clear → on-chain settlement
```

| Path | Module |
|------|--------|
| CAP event loop | `src/croo/provider.ts`, `src/croo/client.ts` |
| Core engine | `src/core/orchestrator.ts` |
| Human validation | `src/telegram/bot.ts`, `src/telegram/parser.ts` |
| Async wait + task state | `src/utils/taskStore.ts` |
| Response shaping | `src/utils/formatters.ts` |
| Schemas / types | `src/types/index.ts` |
| HTTP (health + dev) | `src/api/agent.ts` |

## Prerequisites

1. **CROO Dashboard** — create the agent, register a service, and issue an
   SDK-Key. Fund the agent **AA wallet** with USDC on Base.
   - Service **input schema** should match the request schema in the spec.
   - Service **output schema** should match the delivery payload in
     `buildDeliveryPayload` (`src/utils/formatters.ts`).
2. **Telegram** — create a bot via [@BotFather](https://t.me/BotFather), add it
   to a private validator group with message-reading enabled, and note the
   group chat id.
3. **Node.js 18+**.

## Setup

```bash
cd agent
npm install
cp .env.example .env   # fill in CROO + Telegram values
```

## Run

```bash
npm run dev      # tsx watch (development)
# or
npm run build && npm start
```

On boot the agent:
1. starts the Telegram validator bot,
2. connects to CAP and listens for negotiations/orders,
3. exposes `GET /health` (and `POST /agent/query` if `ENABLE_DEV_ENDPOINT=true`).

## Order lifecycle

| CAP event | Agent action |
|-----------|--------------|
| `NegotiationCreated` | Validate `requirements`, check price, `acceptNegotiation` |
| `OrderPaid` | Dispatch query to Telegram, await validator, `deliverOrder` |
| `OrderCompleted` | Log settlement (payment cleared on-chain) |
| timeout / failure | `rejectOrder` with reason |

Requesters send the query as the order **`requirements`** JSON string, e.g.:

```json
{
  "query": "Is the cost of living rising in Nairobi?",
  "max_price": 0.05,
  "caller_type": "agent",
  "caller_id": "did:croo:agent:requester-abc123"
}
```

## CAP SDK methods used

Built on [`@croo-network/sdk`](https://github.com/CROO-Network/node-sdk)
(`AgentClient`). Methods exercised by this agent:

| Method / API | Where | Purpose |
|--------------|-------|---------|
| `new AgentClient(config, sdkKey)` | `src/croo/client.ts` | Authenticated CAP runtime client (SDK-Key) |
| `connectWebSocket()` | `src/croo/provider.ts` | Real-time order event stream |
| `EventType.NegotiationCreated` | `src/croo/provider.ts` | Trigger to evaluate + accept work |
| `getNegotiation(negotiationId)` | `src/croo/provider.ts` | Read `requirements` (the query payload) |
| `acceptNegotiation(negotiationId)` | `src/croo/provider.ts` | Accept terms → create on-chain order |
| `rejectNegotiation(id, reason)` | `src/croo/provider.ts` | Decline out-of-scope / underpriced work |
| `EventType.OrderPaid` | `src/croo/provider.ts` | Escrow funded → begin fulfillment |
| `getOrder(orderId)` | `src/croo/provider.ts` | Recover query context if negotiation event missed |
| `deliverOrder(orderId, req)` | `src/croo/provider.ts` | Submit verifiable delivery (`DeliverableType.Text`) |
| `rejectOrder(orderId, reason)` | `src/croo/provider.ts` | Fail gracefully on timeout / error |
| `EventType.OrderCompleted` | `src/croo/provider.ts` | Settlement cleared on-chain |

## Integration notes

- **Settlement is CAP-native.** Payment is escrowed on order lock and released
  by the protocol after `deliverOrder`; the agent never sends manual wallet
  transfers. Delivery/settlement tx hashes come from CAP results and events.
- **The deliverable is the answer.** The requester reads the structured oracle
  response via `getDelivery(orderId)`; the payload shape is produced by
  `buildDeliveryPayload` (`src/utils/formatters.ts`) and includes answer,
  confidence, validator attribution, latency, and an evidence hash of the raw
  human reply for dispute resistance.
- **A2A + H2A on one path.** Both human (via CROO Navigator / Store) and agent
  (via `negotiateOrder`) callers converge on the same order lifecycle;
  `caller_id` is required for agent callers.
- **Wallet funding.** Before accepting paid orders, deposit USDC to the agent's
  **AA wallet** (shown in the CROO Dashboard) — not the controller address.
- **Chain.** CAP settles on Base; the SDK defaults to Base mainnet RPC unless
  `BASE_RPC_URL` is set.
- **Human layer stays sovereign.** Execution (the Telegram validator loop) runs
  in this runtime; CAP verifies auth + proof only.

## Validator reply format

Validators must **reply to the bot's task message** using:

```
<answer> | <confidence 0-1>
```

Example: `Yes, prices have increased significantly | 0.9`

## Local testing (no CAP)

Set `ENABLE_DEV_ENDPOINT=true`, then:

```bash
curl -X POST http://localhost:3000/agent/query \
  -H 'content-type: application/json' \
  -d '{"query":"Is the cost of living rising in Nairobi?","max_price":0.05,"caller_type":"human"}'
```

This exercises the Telegram loop and returns a structured response with
`payment.status: "pending"` (real settlement requires the CAP path).

## Tests

Pure-logic and orchestration tests run with the built-in Node test runner (no
external services needed) via `tsx`:

```bash
npm test              # run all tests
npm run typecheck     # typecheck src
npm run typecheck:test # typecheck src + tests
```

Coverage:

| Suite | What it dry-runs |
|-------|------------------|
| `tests/parser.test.ts` | Validator reply parsing, TASK_ID extraction, message formatting |
| `tests/formatters.test.ts` | Confidence clamping, answer normalization, success/error/delivery payloads |
| `tests/schema.test.ts` | Request validation, A2A `caller_id` rule, strict `context` |
| `tests/taskStore.test.ts` | Async wait/resolve and timeout of the pending-task registry |
| `tests/orchestrator.test.ts` | End-to-end dispatch → validate → result, timeout and dispatch-failure paths (with a fake bot) |

The orchestrator tests exercise the full engine loop without CROO or Telegram,
so you can dry-run behavior and catch regressions as the code changes.

## Environment variables

See [`.env.example`](.env.example).

## Hackathon submission (CROO Agent Hackathon)

Built for the [CROO Agent Hackathon](https://dorahacks.io/hackathon/croo-hackathon).
Status against the five mandatory requirements:

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Listed on CROO Agent Store | Operational — register the service + list via the CROO Dashboard |
| 2 | Integrated with CAP (callable, settles on-chain) | Done in code (`src/croo/`); needs SDK-Key + funded AA wallet to run live |
| 3 | Open source, permissive license | Done — MIT ([`LICENSE`](LICENSE)) |
| 4 | Demo video + README (setup, SDK methods, integration notes) | README done; **record ≤5-min demo video** |
| 5 | BUIDL filed on DoraHacks | Operational — submit before the deadline |

## License

MIT — see [`LICENSE`](LICENSE).
