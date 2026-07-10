import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeLlmAnswer } from "../src/utils/llmFallback.js";

test("humanizeLlmAnswer collapses to a single clean line", () => {
  assert.equal(
    humanizeLlmAnswer("  Yes,  prices\nrose  in Nairobi  "),
    "Yes, prices rose in Nairobi",
  );
  assert.equal(humanizeLlmAnswer('"Slightly colder today"'), "Slightly colder today");
});
