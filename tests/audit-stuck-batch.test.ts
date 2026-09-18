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
