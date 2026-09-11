// pi-goal-list-loop-audit — atomic task batches + pending-task completion gate
//
// Contract: validate whole → verify → copy + apply → persist once. A rejected
// batch changes nothing; the complete_goal gate refuses claims with open
// committed tasks (naming them) before any auditor contact; recorded
// deferrals exempt.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { TaskList } from "../extensions/goal-loop-core.ts";
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
