// Relentless auto-continue: length-exhaustion decisions (fields 162348).
// Red-first: decideLengthExhaustion does not exist yet. The question the
// field asked — compact hiccup vs over-context — is answered by routing on
// context heat: hot context means the prompt no longer fits the model, so
// rotate to a larger-context fallback (or defer to auto-compaction when no
// fallback exists); roomy context means the model will not chunk, so grant
// one fresh truncation budget and only then park for manual action.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { decideLengthExhaustion, LENGTH_EXHAUSTION_MAX_EPISODES, nextLengthExhaustionEpisode } from "../extensions/length-continue.js";

test("hot context with fallback refs rotates to a larger-context model", () => {
  assert.equal(
    decideLengthExhaustion({ contextPercent: 98.1, fallbackRefsAvailable: true }),
    "rotate-fallback",
  );
});

test("hot context at the 90% boundary still rotates", () => {
  assert.equal(
    decideLengthExhaustion({ contextPercent: 90, fallbackRefsAvailable: true }),
    "rotate-fallback",
  );
});

test("hot context without fallback refs defers to auto-compaction", () => {
  assert.equal(
    decideLengthExhaustion({ contextPercent: 98.1, fallbackRefsAvailable: false }),
    "compact-defer",
  );
});

test("roomy context grants one fresh budget, never an immediate manual park", () => {
  assert.equal(
    decideLengthExhaustion({ contextPercent: 45, fallbackRefsAvailable: true }),
    "fresh-budget",
  );
  assert.equal(
    decideLengthExhaustion({ contextPercent: 45, fallbackRefsAvailable: false }),
    "fresh-budget",
  );
});

test("exhaustion episodes: first wedge stays relentless, second parks", () => {
  assert.equal(LENGTH_EXHAUSTION_MAX_EPISODES, 2);
  assert.deepEqual(nextLengthExhaustionEpisode(0), { episodes: 1, parkNow: false });
  assert.deepEqual(nextLengthExhaustionEpisode(1), { episodes: 2, parkNow: true });
});

test("exhaustion episodes degrade garbage to a fresh first episode", () => {
  assert.deepEqual(nextLengthExhaustionEpisode(Number.NaN), { episodes: 1, parkNow: false });
  assert.deepEqual(nextLengthExhaustionEpisode(-5), { episodes: 1, parkNow: false });
test("unknown context heat degrades to fresh-budget, never rotate", () => {
  // Without a heat reading we cannot prove the prompt needs a bigger
  // model — rotating blind would burn the fallback chain for nothing.
  assert.equal(
    decideLengthExhaustion({ contextPercent: undefined, fallbackRefsAvailable: true }),
    "fresh-budget",
  );
  assert.equal(
    decideLengthExhaustion({ contextPercent: Number.NaN, fallbackRefsAvailable: true }),
    "fresh-budget",
  );
});
