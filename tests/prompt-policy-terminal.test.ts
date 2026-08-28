// Focused prompt-policy regression. Uses only classifyMainModelFailure /
// requiresMainModelRecovery / isMainModelFallbackFailure so a git-archive
// snapshot of origin/main can run it without the later helper export.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  requiresMainModelRecovery,
} from "../extensions/main-model-recovery.js";

const TERMINAL = [
  "Codex error event: invalid prompt",
  "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt",
  "content_filter",
  "prompt_filter: blocked",
  "safety_filter triggered",
  "content_policy_violation",
  "usage policy violation",
  "safety policy violation",
  "prompt blocked",
  "The prompt was rejected due to content safety",
  "request refused by the usage policy",
  "HTTP 403 content_filter",
  "500 prompt blocked",
];

const RECOVERABLE = [
  "prompt-policy",
  "project-policy: use bun test",
  "project-policy violation",
  "invalid prompt",
  "invalid_prompt",
  "the policy is documented in AGENTS.md",
  "HTTP 403 forbidden",
  "HTTP 500 upstream",
  "503 temporarily unavailable",
  "first-token timeout",
  "HTTP 429 Too Many Requests",
  "rate limit reached",
  "mysterious provider prose with no hint",
];

test("verified prompt-policy refusals are non-recoverable and skip main-model recovery", () => {
  for (const raw of TERMINAL) {
    const failure = classifyMainModelFailure(raw);
    assert.equal(failure.kind, "non-recoverable", raw);
    assert.equal(failure.nonRecoverableReason, "prompt-policy", raw);
    assert.equal(requiresMainModelRecovery(failure), false, raw);
    assert.equal(isMainModelFallbackFailure(failure), false, raw);
  }
});

test("project-policy, stray invalid-prompt, and ordinary provider failures stay recoverable", () => {
  for (const raw of RECOVERABLE) {
    const failure = classifyMainModelFailure(raw);
    assert.notEqual(failure.nonRecoverableReason, "prompt-policy", raw);
    assert.equal(requiresMainModelRecovery(failure), true, raw);
    assert.equal(isMainModelFallbackFailure(failure), true, raw);
  }
});
