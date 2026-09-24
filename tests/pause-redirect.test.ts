// pi-goal-list-loop-audit — pause_goal redirect: park the goal, work the interruption now.
//
// Field incident (dracon-platform 2026-09-23, Screenshot_20260923_121949):
// the user interrupted an active audit goal with a new task ("can we get to
// this first" + two Gmail links). The agent parked via pause_goal, whose
// contract (v0.35.15) aborts the turn and orders "do NOT continue working" —
// so the redirect never started and the user had to nudge ("go") to get any
// movement. Rule: pause_goal accepts redirect="<the user's new request>",
// which parks the goal WITHOUT aborting the turn; the result orders the
// redirect worked in the same turn. Plain pauses keep the abort.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function activeBoot(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `pause-redirect-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("redirect parks the goal but keeps the turn alive for the user's new task", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    let aborted = false;
    (ctx as unknown as { abort: () => void }).abort = () => { aborted = true; };
    const res = await pi.runTool("pause_goal", {
      reason: "User redirected to two Gmail inbox links before finishing the audit ledger close-out",
      suggestedAction: "/goal resume to finish the audit",
      kind: "blocked",
      redirect: "open the two Gmail links and report back",
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as { status: string };
    assert.equal(g.status, "paused", "the goal parks");
    assert.equal(aborted, false, "the turn is NOT aborted — the redirect runs now");
    const types = ledgerTypes(cwd);
    assert.ok(types.includes("pause_goal_redirect"), "the redirect park is ledgered distinctly");
    assert.ok(!types.includes("pause_goal_aborted_turn"), "no abort event for a redirect park");
    assert.match(res.content[0]!.text, /same turn/i, "the result orders same-turn work");
    assert.match(res.content[0]!.text, /two Gmail links/, "the result echoes the redirect");
    assert.doesNotMatch(res.content[0]!.text, /do NOT continue working/, "no stop order on a redirect");
    const reminder = pi.sent.find((entry) => entry.message.customType === "glla-action-reminder");
    assert.equal(reminder?.message.display, true, "redirect gets a prominent reminder card");
    assert.match(String(reminder?.message.content), /Goal safely parked — handling your new request now/);
    assert.match(String(reminder?.message.content), /open the two Gmail links/);
    assert.match(String(reminder?.message.content), /saved goal is held while the current turn handles the new request/);
    assert.doesNotMatch(String(reminder?.message.content), /this turn stopped/);
    assert.equal((reminder?.message as { details?: { parkState?: string } } | undefined)?.details?.parkState, "redirect");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("control: a plain pause still aborts the turn (v0.35.15 contract)", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    let aborted = false;
    (ctx as unknown as { abort: () => void }).abort = () => { aborted = true; };
    const res = await pi.runTool("pause_goal", {
      reason: "blocked on user input with no redirect",
      kind: "blocked",
    }, ctx) as { content: Array<{ text: string }> };
    assert.equal(aborted, true, "a plain pause still aborts the turn");
    assert.ok(ledgerTypes(cwd).includes("pause_goal_aborted_turn"), "the abort is ledgered");
    assert.match(res.content[0]!.text, /do NOT continue working/, "the stop order stands");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
