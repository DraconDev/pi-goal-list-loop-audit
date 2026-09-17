import { test } from "node:test";
import * as assert from "node:assert/strict";
import { resolveAuditorThinkingLevel } from "../extensions/auditor-thinking.js";

const model = (over: Record<string, unknown> = {}): any => ({ reasoning: true, ...over });

test("supported requested level is used verbatim", () => {
  assert.equal(resolveAuditorThinkingLevel(model(), "high"), "high");
  assert.equal(resolveAuditorThinkingLevel(model(), "max"), "max");
});

test("unsupported xhigh/max fall downwards; mapped nulls are skipped", () => {
  assert.equal(resolveAuditorThinkingLevel(model({ thinkingLevelMap: { xhigh: null, max: null } }), "max"), "high");
  assert.equal(resolveAuditorThinkingLevel(model({ thinkingLevelMap: { high: null } }), "high"), "medium");
  assert.equal(resolveAuditorThinkingLevel(model({ thinkingLevelMap: { max: undefined } }), "max"), "high");
});

test("non-reasoning and unknown requests degrade safely", () => {
  assert.equal(resolveAuditorThinkingLevel(model({ reasoning: false }), "max"), "off");
  assert.equal(resolveAuditorThinkingLevel(undefined, "high"), "off");
  assert.equal(resolveAuditorThinkingLevel(model(), "nonsense"), "high");
});
