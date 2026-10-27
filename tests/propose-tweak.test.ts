// pi-goal-list-loop-audit — v0.39.55
//
// Field 2026-10-27: approving a tweak in free text ("we can do it") had no
// executable path — the agent could not apply the approved words, and the
// objective stayed stale while the turn resumed. propose_tweak closes that
// loop: it funnels approved text through the same cmdTweak adoption path as
// a typed /goal tweak (resolution, Confirm gate with exact old→new text,
// race rechecks). The Confirm dialog is the consent record — Cancel changes
// nothing — so the tool must only be called after explicit user approval.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { readState, GLLA_TOOL_NAMES, missingGllaTools } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}
afterEach(() => {
  setGlobalAutoResume(false);
  __testOnlyResetOwnerSession();
});

/** Active goal — the /goal tweak surface. */
async function goalTweakFixture(objective = "old goal objective — done when pinned") {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  return { cwd, ctx };
}

/** Paused list item — the /list tweak surface. */
async function listTweakFixture(objective = "old list objective") {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "list", status: "paused", objective, pauseReason: "paused by user" }),
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  return { cwd, ctx };
}

test("propose_tweak: confirmed approval applies the exact text", async () => {
  const { cwd, ctx } = await goalTweakFixture();
  let bodies: string[] = [];
  ctx.ui.confirmImpl = async (_t: string, body: string) => { bodies.push(body); return true; };
  const res = await pi.runTool("propose_tweak", {
    replacement: "new goal objective — done when pinned",
    mode: "goal",
  }, ctx);
  ctx.ui.confirmImpl = undefined;
  assert.equal(readState(cwd).goal?.objective, "new goal objective — done when pinned", "the approved text landed");
  assert.match(res.content[0]!.text, /applied/i, "the tool reports the apply");
  assert.ok(bodies.length > 0, "the Confirm gate opened");
  assert.match(bodies[bodies.length - 1]!, /old goal objective/, "the gate showed the old text");
  assert.match(bodies[bodies.length - 1]!, /new goal objective/, "the gate showed the new text");
});

test("propose_tweak: declining the Confirm changes nothing", async () => {
  const { cwd, ctx } = await goalTweakFixture();
  ctx.ui.confirmImpl = async () => false;
  const res = await pi.runTool("propose_tweak", {
    replacement: "new goal objective — done when pinned",
    mode: "goal",
  }, ctx);
  ctx.ui.confirmImpl = undefined;
  assert.equal(readState(cwd).goal?.objective, "old goal objective — done when pinned", "declined means unchanged");
  assert.match(res.content[0]!.text, /not applied/i, "the tool reports no change");
});

test("propose_tweak: list mode applies to a paused list item", async () => {
  const { cwd, ctx } = await listTweakFixture();
  ctx.ui.confirmImpl = async () => true;
  await pi.runTool("propose_tweak", { replacement: "new list objective", mode: "list" }, ctx);
  ctx.ui.confirmImpl = undefined;
  assert.equal(readState(cwd).goal?.objective, "new list objective", "the list item text landed");
});

test("propose_tweak: defaults to the active goal policy, refuses without a goal", async () => {
  const { cwd, ctx } = await goalTweakFixture();
  ctx.ui.confirmImpl = async () => true;
  // No mode passed: active goal policy (goal) is used.
  await pi.runTool("propose_tweak", { replacement: "new goal objective — done when pinned" }, ctx);
  ctx.ui.confirmImpl = undefined;
  assert.equal(readState(cwd).goal?.objective, "new goal objective — done when pinned", "default mode followed the active goal");
});

// v0.39.55 (audit 2026-10-27): the approval path only works while the tool
// is active. An external tool allowlist (modlist profile) can strip agent
// tools at session_start, and the self-heal only restores the names GLLA
// tracks — a new tool that is not tracked silently disappears, leaving the
// affirmative reply with no executable path again.
test("propose_tweak: the approval tool survives an external tool allowlist", () => {
  assert.ok(
    (GLLA_TOOL_NAMES as readonly string[]).includes("propose_tweak"),
    "the tool is tracked so the session_start self-heal restores it",
  );
  assert.ok(
    !missingGllaTools(["complete_goal", "pause_goal", "propose_tweak"]).includes("propose_tweak"),
    "an already-active tool is not reported missing",
  );
  assert.ok(
    missingGllaTools(["complete_goal"]).includes("propose_tweak"),
    "an allowlist that dropped it is healed",
  );
});
