// pi-goal-list-loop-audit — v0.35.50
// tests/same-process-successor-resume.test.ts
//
// note.md Now #2: session-start auto-resume asymmetry. A SAME-PROCESS
// successor (pi replaced its session without dying: shutdown recorded in
// the owner sidecar with a non-quit reason, previous pid === current pid)
// is mid-flight continuity — the v0.35.23 loop branch already resumes held
// loops on that consent, but a plain ACTIVE goal held ("restored on session
// load — held for explicit resume") and a parked completion-audit claim
// stayed parked. From the user's seat: after the session replacement the
// list kept going while the goal sat "awaiting first turn". This pins the
// unified consent: goals and stored auditor claims resume under the same
// same-process-successor consent loops already get. Different-pid crash
// successors and cold loads still hold for an explicit decision.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { seedGoal, seedState, tmpCwd, tick, MockPi, makeMockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Seed the owner sidecar the way a same-process session replacement leaves
 * it: shutdown recorded (non-quit), SAME pid as this process, generation
 * bumped. No session-handoff.json marker — the marker-absent corner where
 * rebind/handoff consents are both false but the loop branch resumed via
 * sameProcessSuccessorResume. */
function writeSameProcessSuccessorSidecar(cwd: string): void {
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "session-owner.json"), JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
    generation: 7,
    ownerSessionId: "pre-replacement-session",
    shutdownReason: "reload",
  }));
}

function newPi(): MockPi {
  const pi = new MockPi();
  activate(pi.api);
  return pi;
}

async function successorBoot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, {
    sessionManager: { name: `successor-${Date.now()}-${Math.random()}`, getSessionId: () => "successor-session-id" },
  });
  await pi.fire("session_start", { reason: "resume" }, ctx);
  await tick(150);
  await tick(150);
  return ctx;
}

test("same-process successor resumes a held ACTIVE goal — the list/goal asymmetry fix", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({})); // stock install: autoResume unset (HOLD)
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", status: "active", objective: "mid-flight goal — done when the successor continues it" }),
  });
  writeSameProcessSuccessorSidecar(cwd);
  const pi = newPi();
  await successorBoot(pi, cwd);

  const after = readState(cwd);
  assert.equal(after.goal?.status, "active", "the goal is NOT held — a same-process successor is mid-flight continuity");
  assert.equal(after.goal?.interruptedAt, undefined, "no stale interrupt marker survives the consented resume");
  assert.ok(
    ledger(cwd).some((e) => e.type === "goal_continuation_sent" || e.type === "continuation_dispatch_prepared"),
    "the main thread's continuation was scheduled on session start",
  );
  assert.ok(pi.sent.length > 0 || pi.userMessages.length > 0, "the resumed goal actually dispatched work");
});

test("same-process successor auto-retries a parked completion-audit claim — auditor consent parity", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      policy: "goal",
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "completion audit blocked — no verdict",
      objective: "goal whose verdict never landed",
      pendingCompletion: {
        at: new Date().toISOString(),
        completionSummary: "claimed complete",
        attemptId: "attempt-successor-retry",
        phase: "recovery-pending",
        recoveryAt: new Date().toISOString(),
        recoveryReason: "session_start:blank-load",
      },
    }),
  });
  writeSameProcessSuccessorSidecar(cwd);
  const pi = newPi();
  await successorBoot(pi, cwd);

  // The stored claim got its one bounded automatic retry: the durable
  // one-shot fence event must be in the ledger (vacuous "pause reason
  // changed" passes are not proof — the fence IS the consent evidence).
  const events = ledger(cwd).map((e) => e.type);
  assert.ok(
    events.includes("audit_recovery_auto_retry_claimed"),
    `the parked claim received the same-process successor consent (events tail: ${events.slice(-8).join(",")})`,
  );
});

test("different-pid crash successor still HOLDS the goal — the cold-load law stands", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", status: "active", objective: "cold-load goal stays held" }),
  });
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "session-owner.json"), JSON.stringify({
    pid: 999999, // a DIFFERENT process died — this is a cold load
    at: new Date().toISOString(),
    generation: 7,
    ownerSessionId: "dead-session",
  }));
  const pi = newPi();
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, {
    sessionManager: { name: `cold-${Date.now()}`, getSessionId: () => "cold-session-id" },
  });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(150);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.goal?.status, "paused", "a different-pid crash successor holds like any cold load");
  assert.match(String(after.goal?.pauseReason ?? ""), /held for explicit resume/i);
  assert.equal(pi.sent.length, 0, "no dispatch fires from a cold load");
});
