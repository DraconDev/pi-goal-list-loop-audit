import { archiveCurrentGoal as settleGoal } from "../extensions/loops/goal-orchestrator.js";
// pi-goal-list-loop-audit — v0.36.0
// tests/list-stall-reproduction.test.ts
//
// Durable MockPi reproductions for the screenshot-shaped `LIST QUEUED` card.
// The card is evidence of a broken handoff when a completed standalone goal
// leaves a user-owned list waiting instead of starting it:
//
//   * a successful standalone completion hands off to an already-waiting list;
//   * explicit `/glla resume` starts a waiting-only list after a cold/legacy
//     boundary;
//   * a list-sourced completion promotes its successor through
//     `archiveCurrentGoal()` and records the settle window.
//
// These tests assert both state and ledger transitions so a future change
// cannot regress the list's start-to-finish execution contract.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { clearContinuationTimer } from "../extensions/goal-continuation.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { readState, writeQueueItemFile } from "../extensions/goal-loop-core.js";
import {
  MockPi,
  makeMockCtx,
  seedState,
  tick,
  tmpCwd,
} from "./harness/mock-pi.js";

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function resetRuntime(): void {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  clearContinuationTimer();
}

async function startSession(pi: MockPi, cwd: string) {
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `stall-repro-${cwd}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(20);
  return ctx;
}

test("completed standalone goal automatically hands off to the waiting list", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  resetRuntime();
  const ctx = await startSession(pi, cwd);

  await pi.command("goal", "standalone audit pass — done when archived", ctx);
  await tick(20);
  await pi.runTool("list_add", {
    items: [
      "queue one — done when pinned",
      "queue two — done when pinned",
      "queue three — done when pinned",
      "queue four — done when pinned",
    ],
  }, ctx);
  await tick(20);

  const before = readState(cwd);
  assert.equal(before.goal?.policy, "goal");
  assert.equal(before.goal?.status, "active");
  assert.equal(before.list?.length, 4);
  assert.match(ctx.ui.statuses["pi-glla"] ?? "", /4 queued/);
  assert.match(buildWidgetLines(before)?.join("\n") ?? "", /4 queued/);

  // This is the same terminal archive fence used after an approved detached
  // auditor result. A successful standalone goal must hand off to a list that
  // was already waiting; the user should not need to type `/list next`.
  const archiveCurrentGoal = settleGoal as (
    context: unknown,
    status: "complete",
    reason: string,
  ) => boolean;
  assert.equal(archiveCurrentGoal(ctx, "complete", "auditor approved"), true);
  await tick(20);

  const after = readState(cwd);
  assert.equal(after.goal?.policy, "list");
  assert.equal(after.goal?.status, "active");
  assert.equal(after.goal?.objective, "queue one — done when pinned");
  assert.equal(after.list?.length, 3);
  assert.match(buildWidgetLines(after)?.join("\n") ?? "", /queue one.*active|queue one/i);

  const types = ledgerTypes(cwd);
  assert.equal(types.filter((type) => type === "goal_created").length, 2, "the handoff creates exactly one successor goal");
  assert.equal(types.filter((type) => type === "goal_completion_list_handoff").length, 1);
  assert.ok(types.includes("list_completion_settle_armed"));
  clearContinuationTimer();
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("/glla resume starts a waiting-only list instead of reporting nothing", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  resetRuntime();
  const ctx = await startSession(pi, cwd);
  const waitingItem = {
    id: "resume-head",
    objective: "resume queued head — done when pinned",
    addedAt: new Date().toISOString(),
    queueOrder: 0,
  };
  assert.equal(writeQueueItemFile(cwd, waitingItem as never).wrote, true);
  assert.equal(readState(cwd).goal, null);
  await pi.command("glla", "resume", ctx);
  await tick(20);

  const after = readState(cwd);
  assert.equal(after.goal?.policy, "list");
  assert.equal(after.goal?.objective, "resume queued head — done when pinned");
  assert.equal(after.list?.length, 0);
  assert.ok(ledgerTypes(cwd).includes("list_queue_resume"));
  assert.equal(ctx.ui.matching("Nothing to resume").length, 0);
  clearContinuationTimer();
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("list-sourced completion promotes the successor and records the settle transition", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: null,
    list: [
      { id: "stall-repro-head", objective: "head list item — done when pinned", addedAt: new Date().toISOString(), queueOrder: 0 },
      { id: "stall-repro-tail", objective: "successor list item — done when pinned", addedAt: new Date().toISOString(), queueOrder: 1 },
    ],
  });
  resetRuntime();
  const ctx = await startSession(pi, cwd);

  await pi.command("list", "next", ctx);
  assert.equal(readState(cwd).goal?.objective, "head list item — done when pinned");
  assert.equal(readState(cwd).list?.length, 1);

  const archiveCurrentGoal = settleGoal as (
    context: unknown,
    status: "complete",
    reason: string,
  ) => boolean;
  assert.equal(archiveCurrentGoal(ctx, "complete", "auditor approved list item"), true);
  await tick(20);

  const after = readState(cwd);
  assert.equal(after.goal?.policy, "list");
  assert.equal(after.goal?.objective, "successor list item — done when pinned");
  assert.equal(after.goal?.status, "active");
  assert.equal(after.list?.length, 0);
  assert.ok(ledgerTypes(cwd).includes("list_completion_settle_armed"));
  clearContinuationTimer();
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});
