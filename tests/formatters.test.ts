import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampConfidence,
  normalizeAnswer,
  buildSuccessResponse,
  buildErrorResponse,
  buildDeliveryPayload,
  hashString,
} from "../src/utils/formatters.js";
import type { Task, ValidatorResponse } from "../src/types/index.js";

function fixture(): { task: Task; validator: ValidatorResponse } {
  const now = new Date().toISOString();
  const task: Task = {
    task_id: "task_1",
    order_id: "ord_1",
    query: "Is the cost of living rising in Nairobi?",
    status: "VALIDATED",
    caller_type: "agent",
    caller_id: "did:croo:agent:abc",
    max_price: 0.05,
    created_at: now,
    updated_at: now,
    latency_ms: 1234,
  };
  const validator: ValidatorResponse = {
    task_id: "task_1",
    answer: "  Yes,   prices   rose  ",
    confidence: 0.91,
    validator_id: "555",
    raw_message: "Yes, prices rose | 0.91",
    received_at: now,
    message_id: 42,
  };
  return { task, validator };
}

test("clampConfidence bounds values to [0,1] and handles NaN", () => {
  assert.equal(clampConfidence(2), 1);
  assert.equal(clampConfidence(-1), 0);
  assert.equal(clampConfidence(0.42), 0.42);
  assert.equal(clampConfidence(Number.NaN), 0);
});

test("normalizeAnswer collapses whitespace and trims", () => {
  assert.equal(normalizeAnswer("  hello   world  "), "hello world");
});

test("buildSuccessResponse produces a strict, schema-shaped response", () => {
  const { task, validator } = fixture();
  const res = buildSuccessResponse(task, validator, {
    amount: "0.05",
    currency: "USDC",
    status: "settled",
    reference: "ord_1",
    settlement_tx: "0xdead",
  });

  assert.equal(res.status, "success");
  assert.equal(res.data.answer, "Yes, prices rose");
  assert.equal(res.data.confidence, 0.91);
  assert.equal(res.data.validators.length, 1);
  assert.equal(res.data.validators[0].id, "555");
  assert.equal(res.data.validators[0].platform, "telegram");
  assert.equal(res.data.metadata.task_id, "task_1");
  assert.equal(res.data.metadata.order_id, "ord_1");
  assert.equal(res.data.metadata.latency_ms, 1234);
  assert.equal(res.data.payment.status, "settled");
  assert.equal(res.data.payment.settlement_tx, "0xdead");
});

test("buildErrorResponse carries code, message and correlation ids", () => {
  const res = buildErrorResponse("NO_VALIDATOR_RESPONSE", "timeout", {
    task_id: "task_1",
    order_id: "ord_1",
  });
  assert.equal(res.status, "error");
  assert.equal(res.error.code, "NO_VALIDATOR_RESPONSE");
  assert.equal(res.error.task_id, "task_1");
  assert.equal(res.error.order_id, "ord_1");
});

test("buildDeliveryPayload is JSON-serializable and includes evidence", () => {
  const { task, validator } = fixture();
  const payload = buildDeliveryPayload(task, validator);
  const roundTrip = JSON.parse(JSON.stringify(payload));
  assert.equal(roundTrip.answer, "Yes, prices rose");
  assert.equal(roundTrip.confidence, 0.91);
  assert.equal(roundTrip.task_id, "task_1");
  assert.ok(roundTrip.evidence.raw_message_hash);
  assert.equal(roundTrip.evidence.message_id, 42);
});

test("hashString is deterministic and differs for different input", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
});
