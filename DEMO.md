# Demo runbook — H2A + A2A (≤2 days)

## Troubleshooting Telegram / duplicate runtimes

### Symptom: order paid (green) but no Telegram task

Check CloudWatch (`/ecs/datayetu-agent-prod`) for:

| Log | Meaning |
|-----|---------|
| `provider_fund_address is required` | Accept failed — no `OrderPaid` → no dispatch. Set `PROVIDER_FUND_ADDRESS` or turn off fund transfer. |
| `dispatching to validators` then `NO_VALIDATOR_RESPONSE` | Task was posted (or dispatch hung) but **no validator reply** within `VALIDATOR_TIMEOUT_MS` (default 3 min). |
| `ETELEGRAM: 409 Conflict` | **Another process** is polling `@DataYetuBot` with the same token — replies are lost even if sends work. |
| `websocket policy violation (duplicate key)` | **Another process** holds the same `CROO_SDK_KEY` WebSocket — orders/events may go to the wrong runtime. |

**Only one runtime** may use the provider SDK key + Telegram bot token:

1. **ECS** `datayetu-agent-prod` (desired count = 1) — this is production.
2. Stop any local `npm run dev` / Docker on your laptop.
3. CROO Dashboard → if a **hosted deployment** exists for this agent, keep it **paused** (or delete). Do not run hosted + ECS together.
4. After deploy, logs should show `closed other bot sessions` and **no** repeating 409 errors.

Quick Telegram probe (from a machine with `.env`):

```bash
curl -sS -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":\"$TELEGRAM_GROUP_ID\",\"text\":\"probe\"}"
```

If that works but ECS orders still fail, the duplicate-runtime issue is almost certainly the cause.

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
2. Run locally (uses requester SDK key ≠ provider key). **Pass a real question** — no default/probe text:

```bash
cd agent
npm run a2a -- "Is maize flour price up in Nairobi this week?"
```

3. One Telegram message per order (standby preview with instructions; no duplicate task post).
4. Show terminal: negotiate → pay → delivery JSON.

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
