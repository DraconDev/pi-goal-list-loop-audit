// pi-goal-list-loop-audit — mid-run interruption budget with auto-default fallback.
//
// Antigravity port (survey 2026-09-19): Antigravity's no-mid-run-questions
// trick is structural — the run cannot block on a human — while GLLA's is
// rhetorical (the continuation prompt says don't ask). Pins:
//   1. With `decisionPauseBudget: N`, the first N agent-authored decision
//      pauses behave exactly as today (paused + picker).
//   2. The (N+1)-th decision pause does NOT pause: the goal stays active,
//      the recommended option is adopted as a logged assumption, and the
//      agent is told to record it in its completion recap's Left out.
//   3. Without the setting, legacy behavior is untouched (every decision
//      pauses).

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

type GoalView = {
  status: string;
  pauseKind?: string;
  midRunDecisionCount?: number;
  autoDefaultLog?: Array<{ at: string; reason: string; chosen: string; options: string[] }>;
};

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(
    GLOBAL_SETTINGS_PATH,
    JSON.stringify({ autoResume: true, aggressiveMode: false, ...extra }),
  );
}

async function activeBoot(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `decision-budget-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function decisionPause(pi: MockPi, ctx: MockCtx, reason: string) {
  return await pi.runTool("pause_goal", {
    reason,
    suggestedAction: "Pick an option to continue.",
    kind: "decision",
    options: ["rebuild from scratch", "patch the existing build"],
    recommended: 2,
  }, ctx) as { content: Array<{ text: string }> };
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  setSettings({});
});

test("decision budget: in-budget pauses behave as today, over-budget auto-defaults without pausing", async () => {
  const cwd = tmpCwd();
  setSettings({ decisionPauseBudget: 1 });
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await decisionPause(pi, ctx, "choose the build strategy");
    let g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "first decision (in budget) pauses");
    assert.equal(g.midRunDecisionCount, 1);

    await pi.runTool("resume_goal", { reason: "user picked patch; continuing" }, ctx);
    g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active");

    const res = await decisionPause(pi, ctx, "choose the build strategy again");
    g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active", "over-budget decision must NOT pause");
    assert.equal(g.midRunDecisionCount, 2);
    assert.equal(g.autoDefaultLog?.length, 1);
    assert.equal(g.autoDefaultLog![0]!.chosen, "patch the existing build");
    assert.match(res.content[0]!.text, /budget/i, "the agent is told the budget is exhausted");
    assert.match(res.content[0]!.text, /patch the existing build/, "the adopted default is named");
    assert.match(res.content[0]!.text, /Left out/i, "the assumption is routed to the recap");
    assert.ok(ledgerTypes(cwd).includes("decision_budget_auto_default"), "the auto-default is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("decision budget: unset budget keeps legacy pause-every-time behavior", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await decisionPause(pi, ctx, "first choice");
    let g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused");
    await pi.runTool("resume_goal", { reason: "user chose; continuing" }, ctx);
    await decisionPause(pi, ctx, "second choice");
    g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "no budget: every decision pauses");
    assert.ok(!ledgerTypes(cwd).includes("decision_budget_auto_default"), "no auto-default without a budget");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
