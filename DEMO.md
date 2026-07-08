# Demo runbook — H2A + A2A (≤2 days)

## Why Telegram never got the last Explorer order

ECS logs show negotiation was received and `query` was present, but accept failed:

`provider_fund_address is required for fund services`

Bot was **not** paused. CROO “Order confirmed” on the Explorer UI can mean the buyer paid/submitted while the **provider accept** still failed—so no `OrderPaid` → no Telegram dispatch.

### Fix (pick one)

1. **Recommended for an oracle:** CROO Dashboard → service → turn **OFF “Require Fund Transfer”**. Oracle sells answers (USDC fee), not a principal transfer.
2. **Or** keep fund-transfer ON and set `PROVIDER_FUND_ADDRESS` to the provider agent **AA wallet** (Dashboard → Configure), then redeploy.

---

## Demo narrative (one continuous take, ~3–4 min)

### Act 1 — H2A (human via CROO Explorer / Navigator)
1. Show agent **Online** in CROO.
2. Hire Datayetu, enter query (`query` field).
3. Confirm payment.
4. Cut to Telegram “DataYetu Truth” — task appears.
5. Human replies: `Yes, prices have increased | 0.9`
6. Show order **completed** / delivery in CROO.

### Act 2 — A2A (second agent)
1. Register a throwaway **requester** agent on CROO; fund its AA wallet with a little USDC.
2. Run locally (uses requester SDK key ≠ provider key):

```bash
cd agent
CROO_REQUESTER_SDK_KEY=croo_sk_requester... \
CROO_TARGET_SERVICE_ID=svc-new-1783069024874 \
npx tsx scripts/a2a-requester.ts "Is maize flour price up in Nairobi this week?"
```

3. Show terminal: negotiate → pay → delivery JSON.
4. Optionally reply in Telegram again (or let LLM fallback fire if you want that beat).

### Act 3 — Fallback mention (optional 20s)
- Turn off Telegram briefly or wait past timeout: LLM fallback delivers with lower confidence (`platform: llm`).
- Narrate: “Humans first; controlled model fallback keeps SLA for paid orders.”

---

## Env knobs for the demo window

| Var | Suggested |
|-----|-----------|
| `VALIDATOR_TIMEOUT_MS` | `180000` (3 min) or `300000` for live demo |
| `LLM_FALLBACK_ENABLED` | `true` |
| `LLM_API_KEY` / `LLM_MODEL` | OpenAI or your inference OpenAI-compatible endpoint |
| `LLM_FALLBACK_CONFIDENCE` | `0.65` (below strong human scores) |
| Service SLA in CROO | ≥ human wait + buffer (e.g. 10–30 min) |

---

## Recording tips

- One screen: CROO UI left, Telegram right, terminal bottom for A2A.
- Use the **same** real question theme for H2A and A2A so the story rhymes.
- Say once: settlement is CAP-native (no manual wallet transfers).
