// Public Pi session_compact_failed lifecycle classification.
// A failed attempt is not automatically terminal: willRetry is authoritative.

import assert from "node:assert/strict";
import test from "node:test";

import { classifyCompactionFailure } from "../extensions/compaction-failure.js";

test("host-owned retry and cancellation outrank diagnostic text", () => {
  assert.equal(classifyCompactionFailure({
    willRetry: true,
    errorMessage: "generation hit the token cap and the summary is incomplete",
  }).kind, "retry-owned");
  assert.equal(classifyCompactionFailure({
    aborted: true,
    willRetry: true,
  }).kind, "retry-owned");
  assert.equal(classifyCompactionFailure({
    aborted: true,
    errorMessage: "context window exceeded",
  }).kind, "aborted");
  assert.equal(classifyCompactionFailure({
    fromExtension: true,
    errorMessage: "context window exceeded",
  }).kind, "from-extension");
});

test("output-cap and incomplete-summary diagnostics are not context overflow", () => {
  const cases = [
    "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete",
    "Context overflow recovery failed: summary incomplete",
    "summarization output-token limit reached (stopReason=length)",
  ];
  for (const errorMessage of cases) {
    assert.equal(classifyCompactionFailure({ errorMessage }).kind, "summarization-length", errorMessage);
  }
});

test("only explicit prompt/context-window overflow can rotate the session model", () => {
  const cases = [
    "Context overflow recovery failed: maximum context length is 200000 tokens",
    "Auto-compaction failed: prompt too large for the model context window",
    "Compaction request failed: input tokens exceed the model limit",
  ];
  for (const errorMessage of cases) {
    assert.equal(classifyCompactionFailure({ errorMessage }).kind, "context-overflow", errorMessage);
  }
});

test("unknown and generic threshold failures stay terminal without a model claim", () => {
  assert.equal(classifyCompactionFailure({ reason: "threshold", errorMessage: "provider returned 503" }).kind, "other-terminal");
  assert.equal(classifyCompactionFailure({ reason: "manual" }).kind, "other-terminal");
});
