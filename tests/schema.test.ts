import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryRequestSchema } from "../src/types/index.js";

test("accepts a valid human request without caller_id", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Is the cost of living rising in Nairobi?",
    max_price: 0.05,
    caller_type: "human",
  });
  assert.equal(result.success, true);
});

test("requires caller_id for agent (A2A) callers", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Q?",
    max_price: 0.05,
    caller_type: "agent",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.includes("caller_id")));
  }
});

test("accepts an agent request with caller_id", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Q?",
    max_price: 0.05,
    caller_type: "agent",
    caller_id: "did:croo:agent:abc",
  });
  assert.equal(result.success, true);
});

test("rejects empty query", () => {
  const result = QueryRequestSchema.safeParse({
    query: "",
    max_price: 0.05,
    caller_type: "human",
  });
  assert.equal(result.success, false);
});

test("rejects negative price", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Q?",
    max_price: -1,
    caller_type: "human",
  });
  assert.equal(result.success, false);
});

test("rejects unknown caller_type", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Q?",
    max_price: 0.05,
    caller_type: "robot",
  });
  assert.equal(result.success, false);
});

test("strips unknown top-level keys (lenient for CROO interop)", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Q?",
    max_price: 0.05,
    caller_type: "human",
    injected: "nope",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal("injected" in result.data, false);
  }
});

test("rejects unknown keys inside strict context object", () => {
  const result = QueryRequestSchema.safeParse({
    query: "Q?",
    max_price: 0.05,
    caller_type: "human",
    context: { source: "a2a", bogus: 1 },
  });
  assert.equal(result.success, false);
});
