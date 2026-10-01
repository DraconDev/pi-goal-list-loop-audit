// pi-goal-list-loop-audit — v0.34.74
// tests/interrupt-didnt-continue.test.ts
//
// Field incident (Screenshot_20260807_100610, junk-runner): "interrupt
// didn't continue" — after a mid-audit quit, the recovery audit's verdict
// was spuriously REFUSED and the goal/list went silent for 7.5h instead of
// continuing. Root cause chain (ledger-verified, see
// audit/INTERRUPT-DIDNT-CONTINUE-2026-08-07.md):
//
//   1. 01:44:00 user quit mid-audit → audit_recovery_pending
//      "session_shutdown:quit" → goal paused.
//   2. 01:44:08 restart recovery dispatched a fresh detached audit.
//   3. 01:47:25 the fresh verdict was REFUSED as stale — but the goal's
//      revision was NEVER set (undefined) while the auditor captured 0.
//      The v0.34.61 guard compared raw `undefined !== 0` → spurious
//      refusal (the warning even DISPLAYS "revision is 0 but the auditor
//      captured 0" — both zero).
//   4. The refusal cleared the claim but left status `auditing`; the
//      re-scheduled continuation was silently dropped because
//      isActionableGoal() (sendContinuation's gate) requires active.
//   5. 01:47:36 the heartbeat stranded-audit recovery parked the goal
//      paused/blocked "completion audit interrupted — no verdict".
//   6. No auto-resume → 7.5h of silence → manual /list resume at 09:06.
//
// Fixes (v0.34.74):
//   A. The refusal guard now uses the canonical normalized check
//      isGoalRevisionCurrent (undefined → 0 on both sides) instead of the
//      raw `state.goal.revision !== result.goalRevision.revision`.
//   B. The refusal branch restores status "active" (it clears the claim)
//      so the scheduled continuation actually sends and the loop keeps
//      driving instead of stranding into a blocked pause.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  captureGoalRevision,
  isGoalRevisionCurrent,
  bumpGoalRevision,
  type Goal,
} from "../extensions/goal-loop-core.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260806215307-4irtlm",
    objective: "test goal",
    status: "active",
    policy: "goal",
    autoContinue: true,
    verificationContract: "",
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── (a) Fix A — the incident case: never-set revision vs captured 0 ─────

test("FIX A: a never-set revision (undefined) + captured 0 is CURRENT, not stale", () => {
  // The exact incident: goal 20260806215307-4irtlm had NO revision field
  // (rev=None throughout the ledger); the auditor captured {revision: 0}.
  const goal = makeGoal({}); // revision absent → undefined
  assert.equal(goal.revision, undefined, "incident goal had no revision");
  const token = captureGoalRevision(goal); // normalizes undefined → 0
  assert.equal(token?.revision, 0);
  assert.equal(isGoalRevisionCurrent(token, goal), true, "0 === 0 — the verdict must apply");
});

test("FIX A: captured 0 against a genuinely bumped goal is still refused", () => {
  const goal = makeGoal({ revision: 0 });
  const bumped = bumpGoalRevision(goal); // 0 → 1
  const token = captureGoalRevision(goal);
  assert.equal(isGoalRevisionCurrent(token, bumped), false, "the contract moved — refuse");
});

test("FIX A: equal non-zero revisions stay current; bumps refuse", () => {
  const goal = makeGoal({ revision: 3 });
  assert.equal(isGoalRevisionCurrent(captureGoalRevision(goal), goal), true, "3 === 3");
  const bumped = bumpGoalRevision(bumpGoalRevision(goal)); // 3 → 5
  assert.equal(isGoalRevisionCurrent(captureGoalRevision(goal), bumped), false, "3 !== 5");
});

// ── (b) source pins — the guard and the refusal branch ──────────────────

test("FIX A pin: the refusal guard uses isGoalRevisionCurrent, not raw !== on undefined", () => {
  const src = readGoalRuntimeSource();
  const guardLine = src.split("\n").find((l) => l.includes("result.goalRevision &&"));
  assert.ok(guardLine, "the guard line exists");
  assert.match(guardLine!, /!isGoalRevisionCurrent\(result\.goalRevision, state\.goal\)/);
  assert.doesNotMatch(guardLine!, /state\.goal\.revision !== result\.goalRevision\.revision/, "raw comparison must be gone");
});

test("FIX B pin: the refusal branch restores status active so the loop continues", () => {
  const src = readGoalRuntimeSource();
  const refusalIdx = src.indexOf("stale_revision_refused");
  assert.ok(refusalIdx > 0, "refusal branch exists");
  const tail = src.slice(refusalIdx, refusalIdx + 2600);
  assert.match(tail, /updateGoal\(\{ \.\.\.\(state\.goal\?\.status === "auditing" \? \{ status: "active" \} : \{\}\), pendingCompletion: undefined \}, liveCtx\)/);
  assert.match(tail, /continueCompletion\(liveCtx, true\)/, "the refusal still requests continuation");
  assert.match(src, /const continueCompletion = \(ctx: ExtensionContext, force: boolean\) => \{\s*if \(args\.continueWork !== false\) scheduleContinuation\(ctx, force\);/, "live continuations still schedule; a cold recovered verdict holds for consent");
});

test("behavior preserved: a GENUINE orphaned audit still parks with the same message", () => {
  // The stranded-audit recovery (heartbeat) must keep existing — it is the
  // correct backstop for real orphans (process death without recovery).
  const src = readGoalRuntimeSource();
  const hb = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
  assert.match(hb, /"completion audit interrupted — no verdict"/);
  assert.match(hb, /"stranded_audit_recovered"/);
  assert.match(src, /"stale_revision_refused"/);
});
