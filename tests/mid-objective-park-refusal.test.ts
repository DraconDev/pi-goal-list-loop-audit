// pi-goal-list-loop-audit — mid-objective stops happen only on genuine blockers.
//
// Field incident (no screenshot — the 200751 transcript): a provider error
// engaged the 5-error brake (bounded retry armed), then the agent called
// pause_goal itself ("blocked — waiting for manual action ... do not resume
// unattended retries") mid-objective. The failure was recoverable and the
// envelope already owned it; the park added nothing but a hours-long stop.
// Rule: an agent error/blocked park while a bounded provider-recovery
// episode is armed is refused and routed back into the envelope. Decision
// pickers, time-gated waits, and blocked parks with no armed recovery
// (genuine blockers) are untouched, as is the user's own /goal pause path.

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

function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(
    GLOBAL_SETTINGS_PATH,
    JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }),
  );
}

/** Active goal with an ARMED error-brake episode (retry owns the failure). */
async function armedBoot(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  setGlobalAutoResume(true); // keep the seed ACTIVE past the restore gate
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, {
    goal: seedGoal({
      status: "active",
      policy: "goal",
      recoveryEpisodeKey: "test-episode:provider",
      errorBrakeStreak: 1,
      providerErrorDiagnostic: "provider exploded",
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `park-refusal-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function plainBoot(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  setGlobalAutoResume(true);
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `park-refusal-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  setGlobalAutoResume(false);
});

const FIELD_REASON = "Re-read the active goal after resync. The unresolved requirement remains controlled browser performance verification. Do not resume unattended retries until that prerequisite changes.";

test("200751-shape: blocked self-park while the brake retry is armed is refused, goal stays active", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await armedBoot(cwd);
  try {
    const res = await pi.runTool("pause_goal", {
      reason: FIELD_REASON,
      suggestedAction: "waiting for manual action",
      kind: "blocked",
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as { status: string };
    assert.equal(g.status, "active", "the park is refused — the armed envelope owns this failure");
    assert.match(res.content[0]!.text, /not parked|retry|envelope/i,
      "the agent is routed back into the bounded retry, not parked");
    assert.ok(ledgerTypes(cwd).includes("pause_refused_recovery_armed"), "the refusal is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("kind error and kind-unset parks are refused while armed", async () => {
  for (const params of [
    { reason: FIELD_REASON, kind: "error" },
    { reason: FIELD_REASON },
  ]) {
    const cwd = tmpCwd();
    const { pi, ctx } = await armedBoot(cwd);
    try {
      await pi.runTool("pause_goal", params, ctx);
      const g = readState(cwd).goal as { status: string };
      assert.equal(g.status, "active", `park refused for ${JSON.stringify(params)}`);
    } finally {
      await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    }
  }
});

test("decision picker while armed is still allowed (user deliberating)", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await armedBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "Choose a or b",
      kind: "decision",
      options: ["a", "b"],
      recommended: 1,
    }, ctx);
    const g = readState(cwd).goal as { status: string; pauseKind?: string };
    assert.equal(g.status, "paused", "decision pauses are genuine blockers");
    assert.equal(g.pauseKind, "decision");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("time-gated wait while armed is still allowed (bounded by the clamp)", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await armedBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "waiting on a short cooldown",
      kind: "wait",
      resumeAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, ctx);
    const g = readState(cwd).goal as { status: string };
    assert.equal(g.status, "paused", "waits are time-gated, not terminal parks");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("blocked park with no armed recovery is still allowed (genuine blocker)", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await plainBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "need the production API key before continuing",
      suggestedAction: "provide the key, then resume",
      kind: "blocked",
    }, ctx);
    const g = readState(cwd).goal as { status: string };
    assert.equal(g.status, "paused", "nothing owns this failure — the park stands");
    assert.ok(!ledgerTypes(cwd).includes("pause_refused_recovery_armed"), "no refusal ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
