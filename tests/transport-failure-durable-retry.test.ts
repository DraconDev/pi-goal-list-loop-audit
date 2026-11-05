// pi-goal-list-loop-audit — v0.39.63
// tests/transport-failure-durable-retry.test.ts
//
// Field 2026-11-05 (Screenshot_20261105_172401 + note.md): the operator asked
// for aggressive retry on `Error: Connection error.`, `Error: Request timed
// out.` and `Error: 429 "Rate limit exceeded"`.
//
// Two of the three already worked. `Connection error.` did NOT, and the split
// was invisible because it lives between TWO predicates that disagree:
//
//   isEagerRetryFailure        -> true   (the live lane DID retry it, 13x at
//                                         the 5s eager quantum, per the
//                                         operator's own journal)
//   isRecoverableProviderError -> false  (so every durable lane refused it)
//
// The durable gate is what feeds `classifyCompactionFailure`, the parked-claim
// and recovery-wait restore paths, and `auditorRetryPlan`. With it false, one
// dropped connection parked the goal `blocked` as
// `compaction failure: Error: Connection error.` with no `retryAt` at all —
// a dead goal for the most retryable failure there is.
//
// The defect was vocabulary, not policy: the classifier's transient branch
// listed `network|fetch failed|socket|econn|gateway|upstream` and missed the
// exact wording pi's own SDKs emit (APIConnectionError → "Connection error.",
// undici → "Failed to fetch" / "premature close", DNS → "EAI_AGAIN").
//
// These pins are the agreement between the two predicates, not the wording of
// either regex: any transport failure the live lane is willing to hammer must
// also be one the durable lanes are willing to wait on.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import {
  classifyMainModelFailure,
  isEagerRetryFailure,
  isRecoverableProviderError,
  PERSISTENT_PROVIDER_RETRY_MS,
} from "../extensions/main-model-recovery.js";
import { classifyCompactionFailure } from "../extensions/compaction-failure.js";
import { auditorRetryPlan } from "../extensions/loops/goal-auditor-hooks.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const settingsBefore = fs.readFileSync(settingsPath, "utf8");
const sessions: { pi: MockPi; ctx: ReturnType<typeof makeMockCtx> }[] = [];
afterEach(async () => {
  for (const { pi, ctx } of sessions.splice(0)) await pi.fire("session_shutdown", { reason: "test" }, ctx);
  fs.writeFileSync(settingsPath, settingsBefore);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
});

/** Every transport message the classifier must recognize, including the exact
 * strings from the operator's note and journal plus the SDK wordings that
 * share the defect. */
const TRANSPORT_FAILURES = [
  // the report itself
  "Error: Connection error.",
  "Error: Request timed out.",
  // pi's SDK surfaces
  "Connection error.",
  "The connection was lost",
  "The connection was reset",
  "connection reset by peer",
  "Connection refused",
  "connection closed before message completed",
  "connection terminated unexpectedly",
  // fetch/undici surfaces
  "fetch failed",
  "Failed to fetch",
  "premature close",
  "other side closed",
  "UND_ERR_SOCKET",
  "write EPIPE",
  "socket hang up",
  "stream ended without a finish event",
  // DNS surfaces
  "EAI_AGAIN",
  "getaddrinfo ENOTFOUND api.example.com",
  "ECONNRESET",
  "Unable to connect to the provider",
];

test("v0.39.63 every transport failure classifies transient, not unknown", () => {
  for (const raw of TRANSPORT_FAILURES) {
    assert.equal(classifyMainModelFailure(raw).kind, "transient", raw);
  }
});

test("v0.39.63 the durable gate and the eager gate agree on transport failures", () => {
  // This is the regression itself: the live lane retried `Connection error.`
  // 13 times while the durable lanes refused to arm ANY retry for it. One
  // predicate saying yes and the other saying no is the bug.
  for (const raw of TRANSPORT_FAILURES) {
    const failure = classifyMainModelFailure(raw);
    assert.equal(isEagerRetryFailure(failure), true, `${raw} stays eagerly retried by the live lane`);
    assert.equal(isRecoverableProviderError(raw), true, `${raw} must reach the durable lanes too`);
    assert.equal(classifyCompactionFailure({ errorMessage: raw, willRetry: false }).kind, "provider-recovery",
      `${raw} must not park a compaction failure as a blocked manual pause`);
  }
});

test("v0.39.63 an empty provider response also gains durable authority", () => {
  // v0.38.104 taught the live lane that an empty completion clears on the
  // immediate retry, and the auditor lane already files it as a provider
  // failure — but the durable gate listed only positive kinds, so the same
  // glitch got a 5s eager retry and then no durable wake at all.
  for (const raw of [
    "Provider returned an empty response",
    "Error: Provider returned an empty response",
    "the provider returned an empty completion",
  ]) {
    assert.equal(isEagerRetryFailure(classifyMainModelFailure(raw)), true, raw);
    assert.equal(isRecoverableProviderError(raw), true, `${raw} is a provider glitch the durable lanes must wait on`);
    assert.equal(classifyCompactionFailure({ errorMessage: raw, willRetry: false }).kind, "provider-recovery", raw);
  }
});

test("v0.39.63 the widening is vocabulary only — refusals are unchanged", () => {
  // Failing open on bare `unknown` would have been the wrong seam: these are
  // unclassified for good reason and are pinned to their own owners by
  // tests/rework-round-scope.test.ts and the abort/context suites.
  for (const raw of [
    "auditor produced no verdict marker",
    "auditor worker exited without an atomic result",
    "auditor produced no output",
    "worker exited without a verdict",
  ]) {
    assert.equal(classifyMainModelFailure(raw).kind, "unknown", raw);
    assert.equal(isRecoverableProviderError(raw), false, `${raw} must keep the no-verdict path`);
    assert.equal(classifyCompactionFailure({ errorMessage: raw, willRetry: false }).kind, "other-terminal", raw);
  }
  for (const raw of ["user aborted", "turn aborted: user interrupt", "This operation was aborted"]) {
    assert.equal(isRecoverableProviderError(raw), false, `${raw} is a user abort, not a provider outage`);
  }
  // Context overflow owns compaction, not retry; a deterministic 400 cannot
  // succeed on an identical retry.
  assert.equal(isRecoverableProviderError('400: {"message":"maximum context length is 1048576 tokens"}'), false);
  assert.equal(classifyCompactionFailure({ errorMessage: '400: {"message":"maximum context length is 1048576 tokens"}', willRetry: false }).kind, "context-overflow");
  assert.equal(isRecoverableProviderError('BadRequestError: Image count 12 exceeds limit 4. "code":"400"'), false);
  // Ordinary prose must not become a provider outage.
  for (const raw of ["connection pool exhausted (style guide note)", "expected an empty array, got 3 items", "Error: kablam"]) {
    assert.notEqual(classifyMainModelFailure(raw).kind, "transient", raw);
  }
});

test("v0.39.63 a transport compaction failure arms a durable wait instead of a blocked park", async () => {
  // The field behaviour, through the real extension: the same three strings
  // the operator reported. Before the fix, `Connection error.` produced
  // pauseKind=blocked with no mainModelRecovery at all.
  for (const raw of ["Error: Connection error.", "Error: Request timed out."]) {
    const cwd = tmpCwd();
    fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: true, aggressiveMode: false, mainModelFallbacks: [] }));
    seedState(cwd, { goal: seedGoal({ status: "active", objective: `Survive ${raw}` }) });
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
    const pi = new MockPi(); activate(pi.api);
    const ctx = makeMockCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, ctx);
    sessions.push({ pi, ctx });
    const before = Date.now();
    await pi.fire("session_compact_failed", { errorMessage: raw, willRetry: false }, ctx);
    const state = readState(cwd);
    assert.equal(state.goal?.status, "paused", raw);
    assert.equal(state.goal?.pauseKind, "wait", `${raw} must not become a manual blocked park`);
    assert.equal(state.goal?.pauseSource, "system", raw);
    assert.ok(state.mainModelRecovery?.retryAt, `${raw} keeps a durable due time`);
    assert.ok(Date.parse(state.mainModelRecovery!.retryAt!) > before, `${raw} schedules a future retry`);
    assert.equal(state.goal?.pauseResumeAt, state.mainModelRecovery?.retryAt, `${raw} pause and recovery agree`);
    for (const { pi: p, ctx: c } of sessions.splice(0)) await p.fire("session_shutdown", { reason: "test" }, c);
  }
});

test("v0.39.63 a transport provider failure keeps the audit claim on the unlimited retry lane", () => {
  // The detached-auditor plan uses the same gate. A connection blip must not
  // cap the retry at the conservative 24h horizon while a 429 would not.
  for (const raw of ["Error: Connection error.", "Provider returned an empty response"]) {
    const plan = auditorRetryPlan({
      at: "2020-01-01T00:00:00.000Z", retryAttempts: 10000,
      retryUntil: "2020-01-02T00:00:00.000Z", providerErrorDiagnostic: raw,
    });
    assert.equal(plan.unbounded, true, `${raw} must keep the persistent retry envelope`);
    assert.equal(plan.automatic, true, raw);
    assert.equal(plan.retryAfterSec * 1000, PERSISTENT_PROVIDER_RETRY_MS, raw);
  }
});
