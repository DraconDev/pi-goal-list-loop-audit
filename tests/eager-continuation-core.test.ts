// pi-goal-list-loop-audit — v0.25.0
// tests/eager-continuation-core.test.ts
//
// Eager-continuation contract items 22/23/24/27: the pure helpers behind
// the keep-going branches, plus static source assertions pinning the
// branch wiring (the branches themselves live inline in complete_goal —
// no pi harness in this repo, per advisor the deterministic core is
// tested and the wiring is pinned by source-text checks).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  extractPendingTasks,
  classifyImpossibleReason,
  shouldSuppressHeartbeatForRecentShip,
} from "../extensions/goal-loop-core.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const goalSrc = readGoalRuntimeSource();

// ---- item 22: pendingTasks extraction ----

test("extractPendingTasks: pulls objection bullets, skips evidence (item 22)", () => {
  const report = [
    "Audit report:",
    "- `npm test` passes (262/262)",
    "- item 3 is MISSING from the deliverable",
    "1. The verification contract item 7 has no raw evidence",
    "2. FAIL: screen-audit-kingdom-2.test.ts was deleted",
    "- 4 files changed as expected",
  ].join("\n");
  const tasks = extractPendingTasks(report, 5);
  assert.equal(tasks.length, 3);
  assert.ok(tasks.some((t) => /MISSING/.test(t)));
  assert.ok(tasks.some((t) => /no raw evidence/.test(t)));
  assert.ok(tasks.some((t) => /deleted/.test(t)));
  assert.ok(!tasks.some((t) => /passes/.test(t)));
});

test("extractPendingTasks: caps at 5 and dedupes", () => {
  const report = Array.from({ length: 9 }, (_, i) => `- item ${i} is not done`).join("\n");
  const tasks = extractPendingTasks(report, 5);
  assert.equal(tasks.length, 5);
  assert.equal(new Set(tasks).size, tasks.length);
});

// ---- item 23: impossible classification ----

test("classifyImpossibleReason: partial vs full (item 23)", () => {
  assert.equal(classifyImpossibleReason("items 3 and 5 can never ship; the rest is fine"), "partial");
  assert.equal(classifyImpossibleReason("a partial subset is impossible"), "partial");
  assert.equal(classifyImpossibleReason("the objective contradicts itself"), "full");
  assert.equal(classifyImpossibleReason("the premise is factually wrong"), "full");
});

// ---- item 24: branch wiring (static) ----

test("audit-cap branch: aggressiveMode keeps ACTIVE + pendingTasks; OFF pauses (item 24 tests 1-2)", () => {
  // aggressive branch (v0.38.73: run-to-done goals are excepted — caps are
  // hard stops there, parked via the branch below; behaviorally pinned in
  // run-to-done.test.ts, not here)
  assert.match(goalSrc, /if \(effectiveCap\.aggressiveMode && state\.goal\?\.runToDone !== true\) \{/);
  assert.match(goalSrc, /pendingCompletion: undefined,\n\s+pendingTasks,\n\s+pauseReason: `auditor disapproved \$\{trailingDisapprovals\}× consecutively \(cap \$\{auditCap\}\) — aggressiveMode: continuing with TODOs`/);
  // non-aggressive path still pauses
  assert.match(goalSrc, /status: "paused",\n\s+auditHistory: history,\n\s+pendingCompletion: undefined,\n\s+pauseKind: "decision",[\s\S]{0,500}?pauseReason: `auditor disapproved \$\{trailingDisapprovals\}× consecutively \(cap \$\{auditCap\}\)`,/);
});

test("IMPOSSIBLE branch: aggressive partial continues, full terminalizes (item 24 tests 3-4)", () => {
  assert.match(goalSrc, /effectiveImp\.aggressiveMode && classifyImpossibleReason\(reason\) === "partial"/);
  assert.match(goalSrc, /impossible_partial_continue/);
  assert.match(goalSrc, /const terminalReason = `auditor impossible: \$\{reason\}`;/);
  assert.match(goalSrc, /terminalizeImpossibleGoal\(ctx, terminalReason, history\)/);
  assert.match(goalSrc, /goal_impossible_terminalized/);
});

// ---- item 27: heartbeat ship-suppression ----

test("shouldSuppressHeartbeatForRecentShip: recent ship suppresses, stale does not (item 27)", () => {
  const now = 1_000_000_000;
  assert.equal(shouldSuppressHeartbeatForRecentShip({ nowMs: now, lastShippedAtMs: now - 4 * 60_000 }), true);
  assert.equal(shouldSuppressHeartbeatForRecentShip({ nowMs: now, lastShippedAtMs: now - 6 * 60_000 }), false);
  assert.equal(shouldSuppressHeartbeatForRecentShip({ nowMs: now, lastShippedAtMs: null }), false);
});

test("heartbeat ship-suppression was removed in v0.26.6 (self-sustaining via ledger mtime)", () => {
  assert.ok(!goalSrc.includes("shouldSuppressHeartbeatForRecentShip({"), "heartbeat must not call the suppression check");
  assert.match(goalSrc, /if \(completionAuditInFlight\) return;/);
});
