// Task-batch atomicity core (v0.38.48).
//
// The single-task tools used to mutate the live task list in place and then
// persist — a mid-batch kill (or a late verification failure) left partial
// state behind with no record of what was intended. This module is the whole
// mutation discipline:
//
//   validate whole (ids resolve, no duplicates) → verify milestones →
//   copy + apply → persist once.
//
// Everything here is pure except the injected verify/persist callbacks, so
// the contract is pinnable without a harness: a rejected batch returns the
// ORIGINAL list object untouched, and the tools persist exactly once.

import type { Task, TaskList } from "./goal-loop-core.js";

export type TaskStatus = "pending" | "in_progress" | "complete";

export interface TaskStatusUpdate {
  id: string;
  status: TaskStatus;
}

export interface ValidatedTaskUpdate {
  task: Task;
  status: TaskStatus;
}

export type BatchValidation =
  | { ok: true; entries: ValidatedTaskUpdate[] }
  | { ok: false; error: string };

/** Breadth-first search over top-level tasks and subtasks, in list order. */
export function findTask(taskList: TaskList, id: string): Task | null {
  const queue: Task[] = [...taskList.tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.id === id) return t;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return null;
}

/**
 * Validate the WHOLE batch before anything is verified, copied, or
 * persisted. Every id must resolve and appear exactly once; statuses must
 * be legal. Any failure names the offending entry and changes nothing.
 */
export function validateTaskBatch(
  taskList: TaskList,
  updates: TaskStatusUpdate[],
): BatchValidation {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, error: "Task batch is empty — pass at least one {id, status} update." };
  }
  const seen = new Set<string>();
  const entries: ValidatedTaskUpdate[] = [];
  for (const u of updates) {
    if (!u || typeof u.id !== "string" || !u.id) {
      return { ok: false, error: "Task batch rejected — every update needs a non-empty string id. No task was changed." };
    }
    if (u.status !== "pending" && u.status !== "in_progress" && u.status !== "complete") {
      return { ok: false, error: `Task batch rejected — update for \"${u.id}\" carries an illegal status ${JSON.stringify((u as { status: unknown }).status)}. No task was changed.` };
    }
    if (seen.has(u.id)) {
      return { ok: false, error: `Task batch rejected — duplicate update for task \"${u.id}\" in one batch (each task may appear once). No task was changed.` };
    }
    seen.add(u.id);
    const task = findTask(taskList, u.id);
    if (!task) {
      return { ok: false, error: `Task batch rejected — task \"${u.id}\" not found. No task was changed.` };
    }
    entries.push({ task, status: u.status });
  }
  return { ok: true, entries };
}

/**
 * Apply validated entries to a DEEP COPY. The input list is never mutated,
 * so a kill between copy and persist (or a persist failure) leaves the
 * caller's state object exactly as it was.
 */
export function applyValidatedBatch(
  taskList: TaskList,
  entries: ValidatedTaskUpdate[],
): TaskList {
  const next: TaskList = JSON.parse(JSON.stringify(taskList)) as TaskList;
  for (const e of entries) {
    const target = findTask(next, e.task.id);
    // Proven by validateTaskBatch against the same shape — a missing target
    // here would mean the list changed under us; fail loudly, never partial.
    if (!target) throw new Error(`Task batch apply failed — task \"${e.task.id}\" vanished mid-batch. No persist was attempted.`);
    target.status = e.status;
  }
  return next;
}

/** Copy with a single task's status replaced; the input list is untouched. */
export function withTaskStatus(
  taskList: TaskList,
  id: string,
  status: TaskStatus,
): TaskList {
  const task = findTask(taskList, id);
  if (!task) throw new Error(`withTaskStatus: task \"${id}\" not found.`);
  return applyValidatedBatch(taskList, [{ task, status }]);
}

export interface OpenTaskInfo {
  id: string;
  title: string;
  status: TaskStatus;
}

/**
 * Every committed task (top-level and subtask) still open, in list order.
 * Complete tasks and tasks carrying a recorded deferral are not open — a
 * deferral is an explicit durable-vs-defer judgment, not abandonment.
 */
export function collectOpenTasks(taskList: TaskList): OpenTaskInfo[] {
  const open: OpenTaskInfo[] = [];
  const queue: Task[] = [...taskList.tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.status !== "complete" && !t.deferred) {
      open.push({ id: t.id, title: t.title, status: t.status });
    }
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return open;
}

/** The refusal text for the complete_goal pending-task gate. Names every open task. */
export function formatOpenTaskRefusal(open: OpenTaskInfo[]): string {
  const lines = open.map((t) => `- ${t.id}: \"${t.title}\" (${t.status})`);
  return (
    `complete_goal REFUSED — ${open.length} open committed task${open.length === 1 ? " is" : "s are"} still unfinished:\n` +
    lines.join("\n") +
    `\n\nFinish them with complete_task or update_task_batch, or record an explicit ` +
    `deferral for a genuinely blocked item with record_goal_judgment ` +
    `(choice=\"deferred\", taskId=\"<id>\"). The claim was NOT sent to the auditor and no state changed.`
  );
}
