import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/utils/taskStore.js";
import type { Task, ValidatorResponse } from "../src/types/index.js";

function makeTask(id: string): Task {
  const now = new Date().toISOString();
  return {
    task_id: id,
    query: "Q?",
    status: "CREATED",
    caller_type: "human",
    max_price: 0.05,
    created_at: now,
    updated_at: now,
  };
}

function makeResponse(id: string): ValidatorResponse {
  return {
    task_id: id,
    answer: "yes",
    confidence: 0.8,
    validator_id: "1",
    raw_message: "yes | 0.8",
    received_at: new Date().toISOString(),
    message_id: 1,
  };
}

test("create/get/has track task records", () => {
  const store = new TaskStore();
  assert.equal(store.has("t1"), false);
  store.create(makeTask("t1"));
  assert.equal(store.has("t1"), true);
  assert.equal(store.get("t1")?.query, "Q?");
});

test("update patches fields and bumps updated_at", () => {
  const store = new TaskStore();
  store.create(makeTask("t1"));
  const before = store.get("t1")!.updated_at;
  const updated = store.update("t1", { status: "DISPATCHED" });
  assert.equal(updated?.status, "DISPATCHED");
  assert.ok(updated!.updated_at >= before);
});

test("update on missing task returns undefined", () => {
  const store = new TaskStore();
  assert.equal(store.update("nope", { status: "FAILED" }), undefined);
});

test("waitForValidator resolves when a matching response arrives", async () => {
  const store = new TaskStore();
  store.create(makeTask("t1"));
  const pending = store.waitForValidator("t1", 1000);
  setTimeout(() => {
    const delivered = store.resolveValidator(makeResponse("t1"));
    assert.equal(delivered, true);
  }, 10);
  const resolved = await pending;
  assert.equal(resolved.answer, "yes");
  assert.equal(resolved.confidence, 0.8);
});

test("waitForValidator rejects on timeout", async () => {
  const store = new TaskStore();
  store.create(makeTask("t2"));
  await assert.rejects(
    () => store.waitForValidator("t2", 30),
    /VALIDATOR_TIMEOUT/,
  );
});

test("resolveValidator returns false when nothing is waiting", () => {
  const store = new TaskStore();
  assert.equal(store.resolveValidator(makeResponse("ghost")), false);
});
