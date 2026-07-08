# Datayetu Oracle — Human-Validated Truth, Settled On-Chain

**A CROO-native oracle agent that sells real-world, human-verified answers to humans and other agents — priced per query and settled on-chain through CAP.**

- **Repo:** https://github.com/DataYetu/agent (MIT)
- **Built on:** CROO Agent Protocol (CAP) · `@croo-network/sdk` · Base · USDC
- **Tracks:** Research & Intelligence Agents · Data & Verification Agents

---

## The problem

LLM agents are confident, but they hallucinate — and for many real-world questions there is no on-chain or API source of truth: *"Is the cost of living actually rising in Nairobi right now?"*, *"Is this local vendor legitimate?"*, *"Did this event actually happen on the ground?"*

Agents need a way to **buy ground truth from real humans** — with accountability, confidence scoring, and programmable payment — not another scraped dataset.

## The solution

**Datayetu Oracle** is a paid, callable agent on CROO that routes questions to a **human validator network on Telegram** and returns a **structured, confidence-scored answer**. Every request is a real CAP order: terms lock, humans verify, the answer is delivered as proof, and payment settles on-chain in USDC on Base.

> Truth is **sourced from humans**, **delivered by an agent**, and **monetized via CROO**.

## Why it fits CROO

- **A2A + H2A on one path.** The same agent can be hired by a human (via CROO Navigator / Agent Store) or called programmatically by another agent (`negotiateOrder`) — identical fulfillment pipeline.
- **A2A composability.** Any research, DeFi, or content agent can hire Datayetu as a *human-verification dependency* — "check this claim with real people before you act."
- **Verification-first settlement.** No proof, no payment. The human-validated answer is submitted via `deliverOrder`; CAP clears escrow only after delivery.
- **No side-channel payments.** Settlement is 100% CAP-native — the agent never does manual wallet transfers.

---

## How it works

```
Caller (human via Navigator / agent via SDK)
        │  negotiate + pay  →  CAP escrow locks (USDC on Base)
        ▼
Datayetu Oracle (provider agent)
        │  dispatch question
        ▼
Telegram validator network  →  human replies:  "<answer> | <confidence 0–1>"
        │  parse + normalize + attribute
        ▼
deliverOrder(proof)  →  CAP verifies  →  settlement clears on-chain
        ▼
Structured, confidence-scored answer + payment reference returned to caller
```

### CAP order lifecycle mapped to the agent

| CAP phase | Agent behavior |
|-----------|----------------|
| **Negotiate** | Validate the request payload, check price ceiling, `acceptNegotiation` (or reject) |
| **Lock** | On `OrderPaid`, dispatch the question to the Telegram validator group |
| **Deliver** | On human reply, normalize answer + confidence and submit via `deliverOrder` (`DeliverableType.Text`) with an evidence hash of the raw reply |
| **Clear** | CAP verifies the proof and settles escrow on-chain; `OrderCompleted` finalizes payment metadata |
| **Fail-safe** | Timeout / bad input → `rejectOrder` with reason (escrow returns) |

---

## CAP SDK methods used (`@croo-network/sdk`)

`AgentClient` (authenticated via SDK-Key) is the sole runtime client:

| Method / Event | Purpose |
|----------------|---------|
| `connectWebSocket()` | Real-time order event stream |
| `EventType.NegotiationCreated` | Trigger to evaluate + accept work |
| `getNegotiation(id)` | Read the query payload from `requirements` |
| `acceptNegotiation(id)` | Accept terms → create on-chain order |
| `rejectNegotiation(id, reason)` | Decline out-of-scope / underpriced requests |
| `EventType.OrderPaid` | Escrow funded → begin human validation |
| `getOrder(id)` | Recover query context if a negotiation event is missed |
| `deliverOrder(id, req)` | Submit verifiable delivery (the human answer) |
| `rejectOrder(id, reason)` | Graceful failure on timeout / error |
| `EventType.OrderCompleted` | Settlement cleared on-chain |

---

## Response schema (deterministic)

```json
{
  "status": "success",
  "data": {
    "answer": "Yes, prices have increased",
    "confidence": 0.95,
    "validators": [{ "id": "371152334", "confidence": 0.95, "platform": "telegram" }],
    "metadata": { "task_id": "task_9fb0…", "latency_ms": 37161, "timestamp": "2026-07-03T09:47:48Z" },
    "payment": { "amount": "0.05", "currency": "USDC", "status": "settled", "reference": "ord_…" }
  }
}
```

---

## Tech stack

- **Runtime:** Node.js + TypeScript
- **CROO / commerce:** `@croo-network/sdk` (CAP provider), Base, USDC
- **Human layer:** Telegram bot (`node-telegram-bot-api`) in a private validator group
- **Core:** async task orchestrator with per-task timeout, strict `zod` request/response schemas
- **API:** Express (`/health` + optional local dev endpoint)
- **Quality:** 34 unit/integration tests (parser, formatters, schema, task store, full orchestrator loop)

---

## Status / what's working

- ✅ CAP provider connects to CROO over WebSocket and listens for orders
- ✅ Registered service on CROO (`svc-new-1783069024874`), agent DID + AA wallet
- ✅ Live Telegram validator network (bot **@DataYetuBot**, group "DataYetu Truth")
- ✅ **End-to-end human validation verified**: question → human reply → structured, confidence-scored response (0.95, ~37s latency)
- ✅ Reply-based **and** plain-message task correlation
- ✅ Full test suite green; MIT-licensed public repo
- ⏳ On-chain settlement demo via a real CAP order (final step)

---

## What makes it strong

- **Real human intelligence**, not synthetic data or another LLM guessing.
- **Africa-relevant ground truth** (cost of living, local verification) — a data gap agents genuinely can't fill alone.
- **Composable primitive**: any agent can bolt on human verification as a paid dependency.
- **Clean CAP integration** with verifiable delivery proofs and confidence scoring.

## Roadmap

- Multi-validator consensus + reputation-weighted confidence
- Locale-based routing to language/region-specific validator pools
- Validator payouts split from settled order revenue
- Category expansion: local prices, business verification, event confirmation, translation QA

---

*Datayetu Oracle turns a Telegram group of real people into a callable, paid, on-chain intelligence service for the agent economy.*
