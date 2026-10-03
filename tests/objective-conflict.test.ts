import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyLoadState } from "../extensions/loops/goal.js";
import { updateWholeObjectiveFromConflict } from "../extensions/goal-commands.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

function events(cwd: string) {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function boot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `objective-conflict-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120); return ctx;
}
afterEach(() => { __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

test("C7: declining the conflict confirm ends the update — no retry re-prompt", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "original objective" }) });
  __testOnlyLoadState(cwd);
  let inputCalls = 0, confirmCalls = 0;
  ctx.ui.inputImpl = async () => { inputCalls++; return undefined; };
  ctx.ui.confirmImpl = async () => { confirmCalls++; return false; };
  try {
    const ok = await updateWholeObjectiveFromConflict(ctx as unknown as ExtensionContext, "replacement objective", "goal");
    assert.equal(ok, false);
    assert.equal(confirmCalls, 1, "the proposal confirm ran once");
    assert.equal(inputCalls, 0, "no interactive re-prompt after the explicit decline");
    assert.equal(events(cwd).filter(e => e.type === "objective_conflict_update_retry").length, 0, "no retry ledger after cancel");
    assert.equal(readState(cwd).goal?.objective, "original objective");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("C7 control: accepting the conflict confirm applies the whole-objective update", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "original objective" }) });
  __testOnlyLoadState(cwd);
  ctx.ui.confirmImpl = async () => true;
  try {
    const ok = await updateWholeObjectiveFromConflict(ctx as unknown as ExtensionContext, "replacement objective", "goal");
    assert.equal(ok, true);
    assert.equal(readState(cwd).goal?.objective, "replacement objective");
    assert.equal(events(cwd).filter(e => e.type === "goal_tweaked").length, 1);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
