import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, OrchestratorError } from "../src/core/orchestrator.js";
import { taskStore } from "../src/utils/taskStore.js";
import type { ValidatorBot } from "../src/telegram/bot.js";

/**
 * Fake validator bot. On dispatch it optionally simulates a human reply by
 * resolving the pending task after a short delay — letting us dry-run the full
 * orchestration loop without Telegram.
 */
function fakeBot(opts: {
  answer?: string;
  confidence?: number;
  reply?: boolean;
  throwOnDispatch?: boolean;
}): ValidatorBot {
  return {
    hasEscrowPreview: () => false,
    clearEscrowPreview() {},
    async dispatchTask(taskId: string): Promise<number> {
      if (opts.throwOnDispatch) throw new Error("telegram down");
      if (opts.reply !== false) {
        setTimeout(() => {
          taskStore.resolveValidator({
            task_id: taskId,
            answer: opts.answer ?? "Yes, prices rose",
            confidence: opts.confidence ?? 0.9,
            validator_id: "999",
            raw_message: `${opts.answer ?? "Yes"} | ${opts.confidence ?? 0.9}`,
            received_at: new Date().toISOString(),
            message_id: 7,
          });
        }, 10);
      }
      return 7;
    },
  } as unknown as ValidatorBot;
}

test("handleQuery dispatches and resolves with a validator reply", async () => {
  const orch = new Orchestrator({
    bot: fakeBot({ answer: "Yes, significantly", confidence: 0.88 }),
    validatorTimeoutMs: 1000,
  });

  const { task, validator } = await orch.handleQuery({
    query: "Is the cost of living rising in Nairobi?",
    caller_type: "agent",
    caller_id: "did:croo:agent:abc",
    max_price: 0.05,
    order_id: "ord_x",
  });

  assert.equal(task.status, "VALIDATED");
  assert.equal(task.order_id, "ord_x");
  assert.equal(validator.answer, "Yes, significantly");
  assert.equal(validator.confidence, 0.88);
  assert.ok((task.latency_ms ?? 0) >= 0);
});

test("handleQuery throws NO_VALIDATOR_RESPONSE on timeout without LLM", async () => {
  const orch = new Orchestrator({
    bot: fakeBot({ reply: false }),
    validatorTimeoutMs: 30,
  });

  await assert.rejects(
    () =>
      orch.handleQuery({
        query: "Q?",
        caller_type: "human",
        max_price: 0.05,
      }),
    (err: unknown) => {
      if (!(err instanceof OrchestratorError)) return false;
      assert.equal(err.code, "NO_VALIDATOR_RESPONSE");
      return true;
    },
  );
});

test("handleQuery uses LLM fallback when configured and humans time out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "Yes, prices rose | 0.7" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const orch = new Orchestrator({
      bot: fakeBot({ reply: false }),
      validatorTimeoutMs: 30,
      llm: {
        enabled: true,
        baseUrl: "https://example.test/v1",
        apiKey: "test",
        model: "demo-model",
        confidence: 0.7,
      },
    });

    const { validator } = await orch.handleQuery({
      query: "Is maize up?",
      caller_type: "human",
      max_price: 0.05,
    });

    assert.equal(validator.answer, "Yes, prices rose");
    assert.equal(validator.confidence, 0.7);
    assert.equal(validator.validator_id, "llm:demo-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleQuery throws INTERNAL_ERROR when dispatch fails", async () => {
  const orch = new Orchestrator({
    bot: fakeBot({ throwOnDispatch: true }),
    validatorTimeoutMs: 1000,
  });

  await assert.rejects(
    () =>
      orch.handleQuery({
        query: "Q?",
        caller_type: "human",
        max_price: 0.05,
      }),
    (err: unknown) => {
      if (!(err instanceof OrchestratorError)) return false;
      assert.equal(err.code, "INTERNAL_ERROR");
      return true;
    },
  );
});

test("handleQuery reuses standby reply captured before order_paid", async () => {
  const now = new Date().toISOString();
  const bot = {
    consumeEscrowReply(orderId: string, taskId: string) {
      return {
        task_id: taskId,
        answer: "Captured from standby",
        confidence: 0.86,
        validator_id: "321",
        raw_message: "Captured from standby | 0.86",
        received_at: now,
        message_id: 17,
      };
    },
    clearEscrowPreview() {},
    async dispatchTask(): Promise<number> {
      throw new Error("dispatch should not happen when standby reply exists");
    },
  } as unknown as ValidatorBot;

  const orch = new Orchestrator({
    bot,
    validatorTimeoutMs: 1000,
  });

  const { task, validator } = await orch.handleQuery({
    query: "Q?",
    caller_type: "human",
    max_price: 0.05,
    order_id: "ord_standby",
  });

  assert.equal(task.status, "VALIDATED");
  assert.equal(validator.answer, "Captured from standby");
  assert.equal(task.latency_ms, 0);
});

test("handleQuery bridges standby reply stashed after wait registration starts", async () => {
  const now = new Date().toISOString();
  let consumeCalls = 0;
  const bot = {
    hasEscrowPreview: () => true,
    clearEscrowPreview() {},
    consumeEscrowReply(_orderId: string, taskId: string) {
      consumeCalls += 1;
      if (consumeCalls === 1) return null;
      return {
        task_id: taskId,
        answer: "Bridged late",
        confidence: 0.9,
        validator_id: "42",
        raw_message: "Bridged late | 0.9",
        received_at: now,
        message_id: 3,
      };
    },
    async dispatchTask(): Promise<number> {
      throw new Error("dispatch should not happen when standby preview exists");
    },
  } as unknown as ValidatorBot;

  const orch = new Orchestrator({ bot, validatorTimeoutMs: 1000 });
  const { task, validator } = await orch.handleQuery({
    query: "Is maize up?",
    caller_type: "agent",
    caller_id: "did:croo:agent:test",
    max_price: 0.1,
    order_id: "ord_bridge",
  });

  assert.equal(task.status, "VALIDATED");
  assert.equal(validator.answer, "Bridged late");
});

test("handleQuery skips duplicate task message when standby preview was sent", async () => {
  let dispatched = false;
  const bot = {
    hasEscrowPreview: () => true,
    consumeEscrowReply: () => null,
    clearEscrowPreview() {},
    async dispatchTask(): Promise<number> {
      dispatched = true;
      return 1;
    },
  } as unknown as ValidatorBot;

  const orch = new Orchestrator({ bot, validatorTimeoutMs: 20 });

  await assert.rejects(
    () =>
      orch.handleQuery({
        query: "Is maize flour up in Nairobi?",
        caller_type: "agent",
        caller_id: "did:croo:agent:test",
        max_price: 0.1,
        order_id: "ord_preview",
      }),
    (err: unknown) => err instanceof OrchestratorError,
  );
  assert.equal(dispatched, false);
});
