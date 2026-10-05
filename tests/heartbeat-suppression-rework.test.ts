// pi-goal-list-loop-audit — v0.26.6
// tests/heartbeat-suppression-rework.test.ts
//
// The 0.25.0 "recent ship (<5m)" heartbeat suppression was self-sustaining:
// lastShippedAtMs read .pi-glla/active.jsonl's mtime, and the heartbeat's
// own suppressed-tick ledger writes refreshed that mtime every 15s —
// suppression forever. Field-observed in darklord (2026-07-26): after a
// post-compaction goal_continuation_send_failed, 2,184 consecutive
// heartbeat_suppressed ticks over 9.1 HOURS while the finished list item
// ("settings-7") sat uncompleted and 16 queued items waited. Under an
// auto-committing daemon (dracon-sync, 1s watcher over 35 repos) the
// git-head term self-sustains the same way. The suppression is removed;
// the only legit window (in-flight completion audit) has a precise flag.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { lastShippedAtMs } from "../extensions/goal-loop-core.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC_GOAL = readGoalRuntimeSource();
const SRC_CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");

test("lastShippedAtMs ignores the state-file mtime (the self-sustaining term)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-ship-"));
  fs.mkdirSync(path.join(dir, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi-glla", "active.jsonl"), '{"type":"heartbeat_suppressed"}\n');
  // No git repo here → the mtime must NOT substitute for a ship:
  assert.equal(lastShippedAtMs(dir), null, "a fresh ledger write is not a ship");
});

test("lastShippedAtMs source has no active.jsonl mtime term", () => {
  const fn = SRC_CORE.slice(SRC_CORE.indexOf("export function lastShippedAtMs"), SRC_CORE.indexOf("export function lastShippedAtMs") + 1200);
  assert.ok(!fn.includes("statSync"), "mtime stat removed (the self-sustaining term)");
  assert.ok(fn.includes("git log -1 --format=%ct"), "git commit time still counts");
});

test("heartbeat never calls the suppression check; audit-in-flight flag guards the only real window", () => {
  assert.ok(!SRC_GOAL.includes("shouldSuppressHeartbeatForRecentShip({"), "suppression call removed");
  assert.match(SRC_GOAL, /let completionAuditInFlight = false;/);
  assert.match(SRC_GOAL, /if \(completionAuditInFlight\) return;/);
  // flag wraps the auditor call with finally-clear:
  assert.match(SRC_GOAL, /completionAuditInFlight = true;/);
  assert.match(SRC_GOAL, /\} finally \{[\s\S]{0,180}completionAuditInFlight = false;/);
});

test("the deprecated pure fn remains exported (API compat) but marked deprecated", () => {
  assert.match(SRC_CORE, /@deprecated v0\.26\.6: no longer called by the heartbeat/);
});

test("no heartbeat_suppressed ledger writes remain in the heartbeat path", () => {
  const tick = SRC_GOAL.slice(SRC_GOAL.indexOf("function heartbeatTick"), SRC_GOAL.indexOf("function startHeartbeat"));
  assert.ok(!tick.includes("heartbeat_suppressed"), "the suppressed-tick ledger write (the self-sustaining fuel) is gone");
});

test("project auditor dispatch is protected before counting failed main-session continuations", () => {
  const source = fs.readFileSync("extensions/goal-heartbeat.ts", "utf8");
  const guard = source.indexOf("if (respecBuilderAuditInFlight(ctx.cwd)) return;");
  const refire = source.indexOf('appendLedger(ctx.cwd, "heartbeat_refire"');
  assert.ok(guard >= 0 && refire > guard, "a live increment auditor owns the wait before stall escalation");
});
