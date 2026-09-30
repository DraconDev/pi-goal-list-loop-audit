import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanaryBudget } from "../scripts/canary-budget.mjs";

test("canary bounds output and requests, removes tools, and preserves the caller payload", () => {
  const guard = createCanaryBudget();
  const original = { max_output_tokens: 10000, tools: [{ name: "complete_goal" }], tool_choice: "auto", input: "Reply OK" };
  const result = guard(original, { cost: { input: 1, output: 2 } });
  assert.equal(result.max_output_tokens, 32);
  assert.deepEqual(result.tools, []);
  assert.equal(result.tool_choice, undefined);
  assert.equal(original.max_output_tokens, 10000);
  assert.equal(original.tools.length, 1);
  assert.throws(() => guard(original, { cost: { input: 1, output: 2 } }), /exactly one provider request/);
});

test("canary refuses unsupported caps, unknown prices, oversized input, and excessive estimated spend before sending", () => {
  assert.throws(() => createCanaryBudget()({ input: "OK" }, { cost: { input: 1, output: 2 } }), /unsupported/);
  assert.throws(() => createCanaryBudget()({ max_tokens: 32 }, {}), /price metadata/);
  assert.throws(() => createCanaryBudget()({ max_tokens: 32, input: "x".repeat(10000) }, { cost: { input: 1, output: 2 } }), /payload exceeds/);
  assert.throws(() => createCanaryBudget({ maxUsd: 0.001 })({ max_tokens: 32 }, { cost: { input: 100, output: 200 } }), /exceeds budget/);
  assert.throws(() => createCanaryBudget({ maxOutputTokens: 1000 }), /invalid canary budget/);
});
