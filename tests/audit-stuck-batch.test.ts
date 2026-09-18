// tests/audit-stuck-batch.test.ts
//
// Audit-stuck batch (goal 20260918115619-bqw4v6): an auditor retry loop
// that can never land a verdict must terminate visibly instead of spinning
// forever. Field evidence: screenshots 124541 (dead-model spin),
// 124544 (resume/probe deadlock), 124536 (queue pile-up).

import { test } from "node:test";
import * as assert from "node:assert/strict";

import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import {
  isUnresolvableAuditorModelRefError,
  filterEvictedAuditorRefs,
  AUDITOR_IDENTICAL_FAILURE_PARK_THRESHOLD,
  trackAuditorIdenticalFailure,
  readState,
} from "../extensions/goal-loop-core.ts";
import {
  runAuditorFallbackWithPolicy,
  type AuditorFallbackCandidate,
  type GoalAuditorResult,
} from "../extensions/goal-loop-auditor-process.ts";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

function result(overrides: Partial<GoalAuditorResult> = {}): GoalAuditorResult {
  return {
    approved: false,
    disapproved: false,
    output: "",
    model: "test/model",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 124541: dead-model spin — "Model not found" must evict, never re-arm verbatim.
// ---------------------------------------------------------------------------

test("124541: model-not-found shapes are unresolvable auditor refs", () => {
  assert.equal(isUnresolvableAuditorModelRefError("Model not found: agnes/agnes-3.0-flash"), true);
  assert.equal(isUnresolvableAuditorModelRefError("model not found"), true);
  assert.equal(isUnresolvableAuditorModelRefError("no available model matching 'agnes/old'"), true);
  assert.equal(isUnresolvableAuditorModelRefError("no configured auth for provider p"), true);
  assert.equal(isUnresolvableAuditorModelRefError("503 upstream unavailable"), false);
  assert.equal(isUnresolvableAuditorModelRefError("Auditor stalled — no progress in 5m"), false);
  assert.equal(isUnresolvableAuditorModelRefError(undefined), false);
});

test("124541: walker does not spend the same-ref retry on an unresolvable ref", async () => {
  const candidates: AuditorFallbackCandidate[] = [
    { ref: "agnes/agnes-3.0-flash", model: { provider: "agnes", id: "agnes-3.0-flash" }, via: "setting" },
    { ref: "test/live", model: { provider: "test", id: "live" }, via: "fallback-pin" },
  ];
  const calls: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
    const ref = candidate.ref!;
    calls.push(ref);
    return ref === "agnes/agnes-3.0-flash"
      ? result({ error: "Model not found: agnes/agnes-3.0-flash", model: ref })
      : result({ approved: true, model: ref });
  }, {
    retryBaseMinutes: 1,
    sleep: async () => {},
    shouldRetry: () => true,
  });
  assert.equal(outcome.result.approved, true, "the live fallback lands the verdict");
  assert.deepEqual(
    calls.filter((ref) => ref === "agnes/agnes-3.0-flash"),
    ["agnes/agnes-3.0-flash"],
    "the dead ref is attempted exactly once — no same-ref retry burn",
  );
  assert.equal(outcome.retriedOnce, false, "skipping the doomed retry is not a retry");
});

async function bootToolPi(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetAuditorSurface();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `audit-stuck-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

// ---------------------------------------------------------------------------
// 124544: resume/probe deadlock — resume_goal must run the pending recovery
// probe inline, never bounce the turn to a user-typed /list resume.
// ---------------------------------------------------------------------------

test("124544: resume_goal probes pending main-model recovery inline, no user bounce", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "paused", policy: "list", pauseKind: "wait", pauseReason: "auditor retry" }),
    mainModelRecovery: {
      primary: "test/primary",
      active: "test/primary",
      attempted: ["test/primary"],
      attempts: 1,
      reason: "provider recovery",
      kind: "goal",
      retryAt: Date.now() + 3600_000,
      pendingModelSwitch: "test/primary",
    },
  } as unknown as Parameters<typeof seedState>[1]);
  const { pi, ctx } = await bootToolPi(cwd);
  try {
    const result = await pi.runTool("resume_goal", { reason: "user said go" }, ctx) as { content: Array<{ text: string }> };
    assert.doesNotMatch(result.content[0]!.text, /ask the user to run/, "never bounces the turn to a user-typed command");
    assert.doesNotMatch(result.content[0]!.text, /\/list resume/, "no /list resume round-trip");
    await tick(120);
    assert.equal(readState(cwd).goal?.status, "active", "the resume completes in this turn");
    assert.ok(
      ledgerTypes(cwd).includes("main_model_probe_retriggered"),
      "the pending recovery probe is re-fired inline with via agent-resume",
    );
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

// ---------------------------------------------------------------------------
// N consecutive identical infra failures park blocked-with-action, naming the
// dead chain — the loop terminates visibly instead of re-arming forever.
// ---------------------------------------------------------------------------

test("identical infra failures count toward a bounded identical-park threshold", () => {
  assert.equal(AUDITOR_IDENTICAL_FAILURE_PARK_THRESHOLD, 3);
  assert.deepEqual(trackAuditorIdenticalFailure({}, "provider:fp-a"), {
    auditorLastFailureFingerprint: "provider:fp-a",
    auditorConsecutiveIdenticalFailures: 1,
    identicalParkDue: false,
  });
  assert.deepEqual(
    trackAuditorIdenticalFailure({ auditorLastFailureFingerprint: "provider:fp-a", auditorConsecutiveIdenticalFailures: 1 }, "provider:fp-a"),
    { auditorLastFailureFingerprint: "provider:fp-a", auditorConsecutiveIdenticalFailures: 2, identicalParkDue: false },
  );
  assert.deepEqual(
    trackAuditorIdenticalFailure({ auditorLastFailureFingerprint: "provider:fp-a", auditorConsecutiveIdenticalFailures: 2 }, "provider:fp-a"),
    { auditorLastFailureFingerprint: "provider:fp-a", auditorConsecutiveIdenticalFailures: 3, identicalParkDue: true },
  );
  assert.deepEqual(
    trackAuditorIdenticalFailure({ auditorLastFailureFingerprint: "provider:fp-a", auditorConsecutiveIdenticalFailures: 2 }, "provider:fp-b"),
    { auditorLastFailureFingerprint: "provider:fp-b", auditorConsecutiveIdenticalFailures: 1, identicalParkDue: false },
    "a different failure restarts the streak",
  );
});

test("identical-failure counters survive a state round-trip sanitized", () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pendingCompletion: {
        at: new Date().toISOString(),
        phase: "retry-waiting",
        auditorLastFailureFingerprint: "provider:fp-a",
        auditorConsecutiveIdenticalFailures: 2,
        auditorEvictedRefs: ["agnes/agnes-3.0-flash"],
      },
    }),
  } as unknown as Parameters<typeof seedState>[1]);
  const claim = readState(cwd).goal?.pendingCompletion;
  assert.equal(claim?.auditorLastFailureFingerprint, "provider:fp-a");
  assert.equal(claim?.auditorConsecutiveIdenticalFailures, 2);
  assert.deepEqual(claim?.auditorEvictedRefs, ["agnes/agnes-3.0-flash"]);
});

// ---------------------------------------------------------------------------
// 124536: queued pile-up behind a parked head. While parked, re-adding an
// objective that is already queued coalesces (no pile-up growth), and the
// hourly auditor backstop stands down on a terminal identical-park block.
// ---------------------------------------------------------------------------

function identicalParkedHead(): Record<string, unknown> {
  return seedGoal({
    status: "paused",
    policy: "list",
    pauseKind: "blocked",
    pauseReason: "auditor blocked: 3 identical infra failures (provider error) · chain: agnes/agnes-3.0-flash",
    pauseSuggestedAction: "The completion claim is stored.",
    pendingCompletion: {
      at: new Date().toISOString(),
      phase: "recovery-pending",
      completionSummary: "Stored fixture claim",
      verificationSummary: "Fixture only",
      auditorFallbackExhausted: true,
      auditorLastFailureFingerprint: "provider:fp-a",
      auditorConsecutiveIdenticalFailures: 3,
    },
  });
}

test("splitParkedQueueDuplicates coalesces queued + batch-internal duplicates", async () => {
  const { splitParkedQueueDuplicates } = await import("../extensions/goal-commands.js");
  assert.deepEqual(splitParkedQueueDuplicates([], ["x"]), { fresh: [], coalesced: [] });
  const split = splitParkedQueueDuplicates(
    ["Refactor the widget harness — Done when: tests pass", "refactor the WIDGET harness — Done when: tests pass", "New thing — Done when: merged"],
    ["Refactor the widget harness"],
  );
  assert.deepEqual(split.coalesced.length, 2, "queued + batch-internal duplicates both coalesce");
  assert.deepEqual(split.fresh, ["New thing — Done when: merged"]);
  assert.deepEqual(
    splitParkedQueueDuplicates(["New thing — Done when: merged"], ["Other"]).fresh,
    ["New thing — Done when: merged"],
    "distinct work always queues",
  );
});

test("124536: re-adding a queued objective while parked coalesces, no pile-up", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: identicalParkedHead(),
    list: [{ id: "queued-1", objective: "Refactor the widget harness", addedAt: new Date().toISOString() }],
  } as unknown as Parameters<typeof seedState>[1]);
  const { pi, ctx } = await bootToolPi(cwd);
  try {
    assert.equal(readState(cwd).list?.length, 1, "seed holds one queued item");
    await pi.command("list", "add Refactor the widget harness — Done when: tests pass", ctx);
    await tick(120);
    assert.equal(readState(cwd).list?.length, 1, "the duplicate coalesces instead of piling");
    assert.ok(
      ledgerTypes(cwd).includes("list_parked_duplicate_coalesced"),
      "the coalesce is ledgered",
    );
    assert.equal(readState(cwd).goal?.status, "paused", "the parked head is untouched");
    await pi.command("list", "add Ship the release notes — Done when: published", ctx);
    await tick(120);
    assert.equal(readState(cwd).list?.length, 2, "distinct work still queues behind the parked head");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("124536: hourly auditor backstop stands down on an identical-parked head", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: identicalParkedHead() } as unknown as Parameters<typeof seedState>[1]);
  const { pi, ctx } = await bootToolPi(cwd);
  try {
    const { fireHourlyProbe } = await import("../extensions/goal-recovery.js");
    await fireHourlyProbe(ctx);
    await tick(120);
    const types = ledgerTypes(cwd);
    assert.ok(!types.includes("hourly_probe_auditor_backstop"), "no backstop retry fires into a terminal block");
    assert.ok(!types.includes("audit_started"), "no auditor episode launches");
    assert.equal(readState(cwd).goal?.status, "paused");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("124541: re-seed filters evicted refs so the next episode starts live", () => {
  const configured = ["agnes/agnes-3.0-flash", "test/live", "test/other"];
  assert.deepEqual(
    filterEvictedAuditorRefs(configured, ["agnes/agnes-3.0-flash"]),
    ["test/live", "test/other"],
  );
  assert.deepEqual(
    filterEvictedAuditorRefs(configured, ["AGNES/AGNES-3.0-FLASH"]),
    ["test/live", "test/other"],
    "eviction matches case-insensitively like the walker cursor",
  );
  assert.deepEqual(filterEvictedAuditorRefs(configured, undefined), configured);
  assert.deepEqual(filterEvictedAuditorRefs(configured, []), configured);
});
