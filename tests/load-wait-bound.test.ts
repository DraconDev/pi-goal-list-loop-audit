// pi-goal-list-loop-audit — agent-authored waits are bounded and reevaluated.
//
// Field incident (Screenshot_20260917_153404): a goal paused for host load
// with "resume at or after 20:00" — a 4.5h sleep with zero reevaluation.
// Even an extreme load pause must be bounded: the wait is clamped to a
// one-hour horizon, the heartbeat overdue backstop re-dispatches at the cap,
// and the agent re-evaluates (still loaded → wait again, quiet → resume).
// A 4.5h wait becomes four hourly re-checks, never one blind sleep.

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

const HOUR_MS = 60 * 60 * 1000;

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function activeBoot(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `load-wait-${Date.now()}-${Math.random()}` } });
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

test("153404: a 4.5h load wait is clamped to the hourly horizon with a re-check notice", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    const before = Date.now();
    const res = await pi.runTool("pause_goal", {
      reason: "host heavily loaded (1-min load 43-55/16 cores), need a quiet-host rerun",
      suggestedAction: "Resume at or after 20:00 for the quiet-host production rerun",
      kind: "wait",
      resumeAt: new Date(before + 4.5 * HOUR_MS).toISOString(),
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as { status: string; pauseKind?: string; pauseResumeAt?: string };
    assert.equal(g.status, "paused");
    assert.equal(g.pauseKind, "wait");
    assert.ok(g.pauseResumeAt, "a wait still carries its resume time");
    const storedIn = Date.parse(g.pauseResumeAt!) - before;
    assert.ok(storedIn > 0 && storedIn <= HOUR_MS + 60_000,
      `the stored horizon re-fires within the hour (got ${(storedIn / 60000).toFixed(1)}m), never 4.5h out`);
    assert.match(res.content[0]!.text, /re-evaluat|re-check|bounded/i,
      "the agent is told the wait is bounded and will re-fire for reevaluation");
    assert.ok(ledgerTypes(cwd).includes("pause_wait_clamped"), "the clamp is ledgered with requested vs stored");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("153404: a short wait inside the horizon is stored as requested", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    const before = Date.now();
    const wanted = new Date(before + 30 * 60 * 1000).toISOString();
    await pi.runTool("pause_goal", {
      reason: "waiting on a short cooldown",
      kind: "wait",
      resumeAt: wanted,
    }, ctx);
    const g = readState(cwd).goal as { pauseResumeAt?: string };
    assert.equal(g.pauseResumeAt, wanted, "no clamp inside the horizon");
    assert.ok(!ledgerTypes(cwd).includes("pause_wait_clamped"), "no clamp ledger for an honest wait");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
