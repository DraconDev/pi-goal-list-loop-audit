// Issue #63: a fail-closed auditor-cursor park said only "could not be
// saved". Each refusing stage of updateGoal now records WHICH stage refused
// and the errno code, and the cursor wrapper snapshots that reason at refusal
// time so the park can ledger it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  goalStateTransactionPath,
  goalMdPath,
  lastGoalUpdateFailure,
  lastPersistenceFailure,
  noteGoalUpdateFailure,
  clearGoalUpdateFailure,
  describeGoalUpdateFailure,
  takeAuditorCursorRefusal,
  runPersistStep,
} from "../extensions/goal-loop-core.js";
import { state, replaceState, persistStateLine } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, tmpCwd, seedState } from "./harness/mock-pi.js";
import activate, { runDetachedCompletionWithFallback } from "../extensions/loops/goal.js";

const pi = new MockPi();
activate(pi.api);

const updateGoal = (patch: Record<string, unknown>, ctx: unknown): boolean =>
  (globalThis as unknown as { updateGoal: (patch: Record<string, unknown>, ctx: unknown) => boolean }).updateGoal(patch, ctx);

function seedLiveGoal(id: string): { cwd: string; ctx: never } {
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd) as never;
  const goal = {
    id, objective: "Diagnose persistence", policy: "goal" as const,
    status: "active" as const, autoContinue: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    usage: { tokensUsed: 0, tokensLimit: 0 },
  };
  seedState(cwd, { goal, list: [] });
  replaceState({ ...state, goal, list: [] } as typeof state);
  persistStateLine(cwd, state);
  return { cwd, ctx };
}

test("runPersistStep keeps the errno code of a thrown error", () => {
  runPersistStep("fixtureStep", () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });
  assert.equal(lastPersistenceFailure()?.what, "fixtureStep");
  assert.equal(lastPersistenceFailure()?.code, "ENOSPC");
  runPersistStep("fixtureStep", () => undefined);
});

test("a successful update leaves no failure record", () => {
  const { ctx } = seedLiveGoal("goal-diag-ok");
  noteGoalUpdateFailure("journal");
  assert.equal(updateGoal({ verificationSummary: "fine" }, ctx), true);
  assert.equal(lastGoalUpdateFailure(), null);
});

test("a refused transaction names the transaction stage", () => {
  const { cwd, ctx } = seedLiveGoal("goal-diag-txn");
  const txn = goalStateTransactionPath(cwd);
  fs.mkdirSync(txn);
  try {
    assert.equal(updateGoal({ verificationSummary: "blocked" }, ctx), false);
  } finally {
    fs.rmdirSync(txn);
  }
  const failure = lastGoalUpdateFailure();
  assert.equal(failure?.stage, "transaction");
  assert.equal(failure?.what, "writeGoalStateTransaction");
  assert.ok(failure?.code, "the errno code rides the record");
});

test("a refused journal append names the journal stage", () => {
  const { cwd, ctx } = seedLiveGoal("goal-diag-journal");
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  const mode = fs.statSync(file).mode;
  fs.chmodSync(file, mode & ~0o222);
  try {
    assert.equal(updateGoal({ verificationSummary: "blocked" }, ctx), false);
  } finally {
    fs.chmodSync(file, mode);
  }
  assert.equal(lastGoalUpdateFailure()?.stage, "journal");
});

test("an unwritable goal markdown names the markdown-write stage", () => {
  const { cwd, ctx } = seedLiveGoal("goal-diag-md");
  const md = goalMdPath(cwd, "goal-diag-md");
  fs.mkdirSync(path.dirname(md), { recursive: true });
  fs.rmSync(md, { force: true });
  fs.mkdirSync(md); // a directory where the markdown file should be
  try {
    assert.equal(updateGoal({ verificationSummary: "blocked" }, ctx), false);
  } finally {
    fs.rmSync(md, { recursive: true, force: true });
  }
  const failure = lastGoalUpdateFailure();
  assert.equal(failure?.stage, "markdown-write");
  assert.equal(failure?.code, "EISDIR");
});

test("a refused cursor callback snapshots its reason for exactly one park", async () => {
  clearGoalUpdateFailure();
  takeAuditorCursorRefusal();
  const outcome = await runDetachedCompletionWithFallback(
    [{ model: "provider/model", via: "test" }],
    async () => ({ approved: true, disapproved: false, output: "", model: "provider/model" }),
    {
      shouldRetry: () => true,
      onAttempt: () => {
        noteGoalUpdateFailure("journal", { what: "persistStateLine", error: "EIO: i/o error, write", code: "EIO" });
        return false;
      },
    },
  );
  assert.equal(outcome.result.error, "auditor recovery cursor persistence failed");
  // An intervening successful write must not erase the snapshot.
  clearGoalUpdateFailure();
  const refusal = takeAuditorCursorRefusal();
  assert.equal(refusal?.stage, "journal");
  assert.equal(refusal?.code, "EIO");
  assert.equal(describeGoalUpdateFailure(refusal), "journal: EIO");
  assert.equal(takeAuditorCursorRefusal(), null, "read-once");
});

test("a callback that refuses without writing is labelled, not blamed on a stale record", async () => {
  noteGoalUpdateFailure("transaction", { code: "ENOSPC" }); // stale, from an earlier write
  takeAuditorCursorRefusal();
  await runDetachedCompletionWithFallback(
    [{ model: "provider/model", via: "test" }],
    async () => ({ approved: true, disapproved: false, output: "", model: "provider/model" }),
    { shouldRetry: () => true, onAttempt: () => false },
  );
  assert.equal(takeAuditorCursorRefusal()?.stage, "refused-before-write");
  assert.equal(describeGoalUpdateFailure(null), "unknown stage");
});
