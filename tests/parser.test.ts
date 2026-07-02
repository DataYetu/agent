import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseValidatorReply,
  extractTaskId,
  formatTaskMessage,
} from "../src/telegram/parser.js";

test("parses a well-formed reply", () => {
  assert.deepEqual(parseValidatorReply("Yes, prices rose | 0.9"), {
    answer: "Yes, prices rose",
    confidence: 0.9,
  });
});

test("splits on the first pipe; a pipe in the answer breaks parsing", () => {
  // The confidence segment becomes "b | 0.5", which is not numeric -> rejected.
  assert.equal(parseValidatorReply("a | b | 0.5"), null);
});

test("parses answers containing commas and punctuation", () => {
  assert.deepEqual(parseValidatorReply("Yes, rent & food are up | 0.75"), {
    answer: "Yes, rent & food are up",
    confidence: 0.75,
  });
});

test("rejects a reply with no delimiter", () => {
  assert.equal(parseValidatorReply("no pipe here"), null);
});

test("rejects an empty answer", () => {
  assert.equal(parseValidatorReply(" | 0.5"), null);
});

test("rejects out-of-range confidence", () => {
  assert.equal(parseValidatorReply("answer | 1.5"), null);
  assert.equal(parseValidatorReply("answer | -0.1"), null);
});

test("rejects non-numeric confidence", () => {
  assert.equal(parseValidatorReply("answer | high"), null);
});

test("accepts boundary confidence values", () => {
  assert.equal(parseValidatorReply("a | 0")?.confidence, 0);
  assert.equal(parseValidatorReply("a | 1")?.confidence, 1);
});

test("extractTaskId reads the TASK_ID from a task message", () => {
  const msg = formatTaskMessage("task_abc123", "Is cost of living rising?");
  assert.equal(extractTaskId(msg), "task_abc123");
});

test("extractTaskId returns null without a TASK_ID line", () => {
  assert.equal(extractTaskId("just some chatter"), null);
  assert.equal(extractTaskId(undefined), null);
});

test("formatTaskMessage embeds id, question and instructions", () => {
  const msg = formatTaskMessage("t1", "Q?");
  assert.match(msg, /TASK_ID: t1/);
  assert.match(msg, /Q\?/);
  assert.match(msg, /<answer> \| <confidence/);
});
