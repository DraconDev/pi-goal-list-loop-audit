// pi-goal-list-loop-audit — atomic task batches + pending-task completion gate
//
// Contract: validate whole → verify → copy + apply → persist once. A rejected
// batch changes nothing; the complete_goal gate refuses claims with open
// committed tasks (naming them) before any auditor contact; recorded
// deferrals exempt.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import type { TaskList } from "../extensions/goal-loop-core.ts";
import { readState } from "../extensions/goal-loop-core.js";
import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, type MockCtx } from "./harness/mock-pi.js";
import {
  applyValidatedBatch,
  collectOpenTasks,
  findTask,
  formatOpenTaskRefusal,
  validateTaskBatch,
  withTaskStatus,
} from "../extensions/task-batch.ts";

function batchFixture(): TaskList {
  return {
    version: 1,
    tasks: [
      { id: "1", title: "Map the surface", status: "complete" },
      {
        id: "2", title: "Implement the core", status: "in_progress",
        subtasks: [
          { id: "2.1", title: "Validate whole", status: "complete" },
          { id: "2.2", title: "Persist once", status: "pending" },
        ],
      },
      {
        id: "3", title: "Blocked upstream", status: "pending",
        deferred: { reason: "provider outage", followUp: "retry tomorrow", at: "2026-09-11T00:00:00.000Z" },
      },
    ],
  };
}

test("batch validation accepts a well-formed multi-update batch", () => {
  const tl = batchFixture();
  const res = validateTaskBatch(tl, [
    { id: "2", status: "complete" },
    { id: "2.2", status: "in_progress" },
  ]);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.entries.map((e) => [e.task.id, e.status]), [["2", "complete"], ["2.2", "in_progress"]]);
  }
});

test("batch validation rejects unknown ids naming the offender", () => {
  const res = validateTaskBatch(batchFixture(), [
    { id: "2", status: "complete" },
    { id: "9", status: "complete" },
  ]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /"9" not found/);
});

test("batch validation rejects duplicate ids and empty batches", () => {
  const dup = validateTaskBatch(batchFixture(), [
    { id: "2", status: "in_progress" },
    { id: "2", status: "complete" },
  ]);
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.error, /duplicate update for task "2"/);
  const empty = validateTaskBatch(batchFixture(), []);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /empty/);
});

test("batch apply copies: the input list object is never mutated", () => {
  const tl = batchFixture();
  const before = JSON.stringify(tl);
  const res = validateTaskBatch(tl, [{ id: "2", status: "complete" }]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const next = applyValidatedBatch(tl, res.entries);
  assert.equal(JSON.stringify(tl), before, "input untouched");
  assert.equal(findTask(tl, "2")!.status, "in_progress");
  assert.equal(findTask(next, "2")!.status, "complete");
  assert.notEqual(next, tl);
});

test("withTaskStatus replaces one status on a copy", () => {
  const tl = batchFixture();
  const next = withTaskStatus(tl, "2.2", "in_progress");
  assert.equal(findTask(tl, "2.2")!.status, "pending");
  assert.equal(findTask(next, "2.2")!.status, "in_progress");
  assert.throws(() => withTaskStatus(tl, "nope", "complete"), /not found/);
});

test("open-task collection skips complete and deferred tasks, keeps BFS order", () => {
  assert.deepEqual(collectOpenTasks(batchFixture()), [
    { id: "2", title: "Implement the core", status: "in_progress" },
    { id: "2.2", title: "Persist once", status: "pending" },
  ]);
});

test("refusal text names every open task with id, title, and status", () => {
  const text = formatOpenTaskRefusal(collectOpenTasks(batchFixture()));
  assert.match(text, /complete_goal REFUSED — 2 open committed tasks/);
  assert.match(text, /- 2: "Implement the core" \(in_progress\)/);
  assert.match(text, /- 2\.2: "Persist once" \(pending\)/);
  assert.match(text, /record_goal_judgment/);
  assert.match(text, /NOT sent to the auditor/);
});

// ---- update_task_batch through the real tool surface (MockPi) ----

const pi = new MockPi();
activate(pi.api);

// File hygiene: session_shutdown resets the module-global tool-registration
// flag. Without it, a later test FILE in the same process reuses the flag
// and its own MockPi never gets agent tools ("tool not registered").
let lastSession: { on: MockPi; ctx: MockCtx } | null = null;
// NOTE: the successor-plane reset lives in the LAST TEST below, not in an
// after() hook — hooks may execute in a different module realm than the
// tests under bun's per-file isolation, which would leave the next file's
// non-lifecycle session_start refused as foreign ("tool not registered").
afterEach(async () => {
  if (lastSession) {
    const s = lastSession;
    lastSession = null;
    try {
      await s.on.fire("session_shutdown", { reason: "quit" }, s.ctx);
    } catch (e) {
      // Cleanup only — test assertions already ran.
      void e;
    }
  }
});

function gllaCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: { name: "main-session-manager-task-batch" } });
}

function toolFixture(): TaskList {
  return {
    version: 1,
    tasks: [
      { id: "1", title: "First", status: "pending" },
      {
        id: "2", title: "Second", status: "in_progress",
        subtasks: [{ id: "2.1", title: "Second part one", status: "pending" }],
      },
      {
        id: "3", title: "Gated", status: "pending",
        verificationContract: "Done when `test -f /nonexistent-glla-batch-probe` passes",
      },
    ],
  };
}

async function batchHarness(startReason = "reload"): Promise<{ cwd: string; ctx: MockCtx }> {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetTerminalFlags();
  fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", taskList: toolFixture() }) });
  const ctx = gllaCtx(cwd);
  await pi.fire("session_start", { reason: startReason }, ctx);
  lastSession = { on: pi, ctx };
  return { cwd, ctx };
}

function taskStatuses(cwd: string): Record<string, string> {
  const goal = readState(cwd).goal as unknown as { taskList: TaskList };
  const out: Record<string, string> = {};
  const queue = [...goal.taskList.tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    out[t.id] = t.status;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return out;
}

test("batch tool applies several updates in one write and reports them", async () => {
  const { cwd, ctx } = await batchHarness();
  const res = await pi.runTool("update_task_batch", {
    updates: [{ id: "1", status: "in_progress" }, { id: "2.1", status: "complete" }],
  }, ctx);
  assert.match(res.content[0]!.text, /Task batch applied \(2\): 1 → in_progress, 2\.1 → complete\./);
  assert.deepEqual(taskStatuses(cwd), { "1": "in_progress", "2": "in_progress", "2.1": "complete", "3": "pending" });
});

test("batch tool rejects an unknown id with state byte-identical", async () => {
  const { cwd, ctx } = await batchHarness();
  const before = JSON.stringify((readState(cwd).goal as unknown as { taskList: TaskList }).taskList);
  const res = await pi.runTool("update_task_batch", {
    updates: [{ id: "1", status: "complete" }, { id: "9", status: "complete" }],
  }, ctx);
  assert.match(res.content[0]!.text, /task "9" not found/);
  assert.match(res.content[0]!.text, /No task was changed/);
  assert.equal(
    JSON.stringify((readState(cwd).goal as unknown as { taskList: TaskList }).taskList),
    before,
    "rejected batch persists nothing",
  );
});

test("batch milestone failure leaves the whole batch unapplied (mid-batch kill)", async () => {
  const { cwd, ctx } = await batchHarness();
  // Task 1 would verify cleanly (no contract); task 3 fails `test -f`.
  // Atomicity means task 1 must NOT land either.
  const res = await pi.runTool("update_task_batch", {
    updates: [{ id: "1", status: "complete" }, { id: "3", status: "complete" }],
  }, ctx);
  assert.match(res.content[0]!.text, /Task batch rejected/);
  assert.match(res.content[0]!.text, /Task 3 milestone verification FAILED/);
  assert.deepEqual(
    taskStatuses(cwd),
    { "1": "pending", "2": "in_progress", "2.1": "pending", "3": "pending" },
    "no partial application survives a mid-batch failure",
  );
});

test("single tools keep their pinned messages on the copy-swap path", async () => {
  const { cwd, ctx } = await batchHarness();
  const done = await pi.runTool("complete_task", { id: "2.1" }, ctx);
  assert.match(done.content[0]!.text, /Task 2\.1 marked complete\./);
  const moved = await pi.runTool("update_task_status", { id: "1", status: "in_progress" }, ctx);
  assert.match(moved.content[0]!.text, /Task 1 → in_progress/);
  const missing = await pi.runTool("complete_task", { id: "nope" }, ctx);
  assert.match(missing.content[0]!.text, /Task nope not found\./);
  assert.deepEqual(taskStatuses(cwd), { "1": "in_progress", "2": "in_progress", "2.1": "complete", "3": "pending" });
});

// ---- record_goal_judgment taskId: the recorded deferral behind the gate exemption ----

// record_goal_judgment and complete_goal only run on an ACTIVE goal owned
// by the calling session. Owner identity binds by object, so each test
// resets the owner claim, restores (held), and resumes explicitly — the
// honest user path. (Stale-flag resets are left out: they are irrelevant
// here and the owner reset alone determines the hold.)
async function activeHarness(): Promise<{ cwd: string; ctx: MockCtx; on: MockPi }> {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetTerminalFlags();
  const cwd = tmpCwd();
  fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({}));
  seedState(cwd, { goal: seedGoal({ status: "active", taskList: toolFixture() }) });
  const ctx = gllaCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await pi.command("goal", "resume", ctx);
  lastSession = { on: pi, ctx };
  return { cwd, ctx, on: pi };
}

function ledgerText(cwd: string): string {
  return fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8");
}

function taskById(cwd: string, id: string): Record<string, unknown> | null {
  const goal = readState(cwd).goal as unknown as { taskList: TaskList };
  const queue: Record<string, unknown>[] = [...(goal.taskList.tasks as unknown as Record<string, unknown>[])];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t["id"] === id) return t;
    const subs = t["subtasks"] as Record<string, unknown>[] | undefined;
    if (subs) queue.push(...subs);
  }
  return null;
}

test("deferred judgment with a real taskId stamps the exemption durably", async () => {
  const { cwd, ctx, on } = await activeHarness();
  const res = await on.runTool("record_goal_judgment", {
    choice: "deferred",
    reason: "provider outage blocks the gated step",
    followUp: "retry the gated step tomorrow",
    taskId: "3",
  }, ctx);
  assert.match(res.content[0]!.text, /Recorded durable-vs-defer judgment: deferred\./);
  assert.match(res.content[0]!.text, /Task 3 .+ exempt from the complete_goal pending-task gate/);
  const stamped = taskById(cwd, "3")!["deferred"] as Record<string, string>;
  assert.equal(stamped.reason, "provider outage blocks the gated step");
  assert.equal(stamped.followUp, "retry the gated step tomorrow");
  assert.ok(stamped.at, "stamp carries a timestamp");
  assert.match(ledgerText(cwd), /"durable_defer_choice"/);
  assert.match(ledgerText(cwd), /"taskId":"3"/);
});

test("judgment with an unknown taskId records nothing", async () => {
  const { cwd, ctx, on } = await activeHarness();
  const beforeLedger = ledgerText(cwd);
  const res = await on.runTool("record_goal_judgment", {
    choice: "deferred",
    reason: "blocked",
    followUp: "retry later",
    taskId: "99",
  }, ctx);
  assert.match(res.content[0]!.text, /No task "99"/);
  assert.match(res.content[0]!.text, /NOT recorded/);
  assert.equal(ledgerText(cwd), beforeLedger, "no ledger entry for a refused judgment");
});

test("inline judgment with a taskId is refused — no exemption by accident", async () => {
  const { cwd, ctx, on } = await activeHarness();
  const beforeLedger = ledgerText(cwd);
  const res = await on.runTool("record_goal_judgment", {
    choice: "inline",
    reason: "shipping the fix now",
    taskId: "1",
  }, ctx);
  assert.match(res.content[0]!.text, /only valid with choice=deferred/);
  assert.equal(taskById(cwd, "1")!["deferred"], undefined);
  assert.equal(ledgerText(cwd), beforeLedger, "no ledger entry for a refused judgment");
});

// ---- complete_goal pending-task gate: refuse early, name tasks, deferrals exempt ----

const CLAIM = {
  completionSummary: "Outcome: tasks done. Changed: code. Evidence: tests. Tests: bun test 14/14. Unresolved: none. Next: none.",
  verificationSummary: "task-atomicity-gate pins.",
};

test("claim with open committed tasks is refused naming each one, auditor untouched", async () => {
  const { cwd, ctx, on } = await activeHarness();
  const res = await on.runTool("complete_goal", CLAIM, ctx);
  const text = res.content[0]!.text;
  assert.match(text, /complete_goal REFUSED — 4 open committed tasks/);
  assert.match(text, /- 1: "First" \(pending\)/);
  assert.match(text, /- 2: "Second" \(in_progress\)/);
  assert.match(text, /- 2\.1: "Second part one" \(pending\)/);
  assert.match(text, /- 3: "Gated" \(pending\)/);
  assert.match(text, /NOT sent to the auditor/);
  assert.doesNotMatch(text, /AUDIT PENDING/);
  assert.deepEqual((res as unknown as { details?: unknown }).details, {});
  assert.match(ledgerText(cwd), /"complete_goal_tasks_refused"/);
  assert.match(ledgerText(cwd), /"id":"2\.1"/);
  assert.equal((readState(cwd).goal as unknown as { status: string }).status, "active");
});

test("claim passes the gate when open tasks are finished and the rest deferred", async () => {
  const { cwd, ctx, on } = await activeHarness();
  const batch = await on.runTool("update_task_batch", {
    updates: [
      { id: "1", status: "complete" },
      { id: "2", status: "complete" },
      { id: "2.1", status: "complete" },
    ],
  }, ctx);
  assert.match(batch.content[0]!.text, /Task batch applied \(3\)/);
  const defer = await on.runTool("record_goal_judgment", {
    choice: "deferred",
    reason: "external gate down",
    followUp: "retry the gated step next turn",
    taskId: "3",
  }, ctx);
  assert.match(defer.content[0]!.text, /exempt from the complete_goal pending-task gate/);
  const res = await on.runTool("complete_goal", CLAIM, ctx);
  assert.doesNotMatch(res.content[0]!.text, /complete_goal REFUSED/);
});

// MUST stay the last test in this file: null the process-wide ownership
// plane (live + dead owner, stale/terminal flags) so a successor test
// FILE's non-lifecycle session_start is admitted and its MockPi gets agent
// tools. session_shutdown alone is not enough — it preserves the dead
// owner, which the foreign-session gate refuses (observed as
// "tool not registered: record_goal_judgment" in the next file).
test("zzz successor-plane reset (file hygiene, keep last)", () => {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
});
