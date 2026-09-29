// pi-goal-list-loop-audit — quota-caused parks become monitored waits.
//
// Field incident (note.md Next, Screenshot_20260925_004412, ai-auto-music
// wave 11): MiniMax quota 0% + GMI 402 parked the goal kind=blocked with
// "waiting for manual action" although no user action existed — only a
// reset clock the user cannot hurry. A quota cause (the reason's own quota
// wording or fresh observed subagent-quota evidence) now reroutes the park
// to a supervised auto-retry wait: the card reads auto-retry and the
// due-wait backstop re-fires at the reset window.

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

function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(
    GLOBAL_SETTINGS_PATH,
    JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }),
  );
}

async function activeBoot(cwd: string, goalOverrides: Record<string, unknown> = {}): Promise<{ pi: MockPi; ctx: MockCtx }> {
  setGlobalAutoResume(true); // keep the seed ACTIVE past the restore gate
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal", ...goalOverrides }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `quota-reroute-${Date.now()}-${Math.random()}` } });
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

test("quota evidence: a subagent 429 tool error is recorded on the goal", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.fire("tool_result", {
      toolName: "subagent",
      isError: true,
      output: "subagent failed: 429 Too Many Requests — quota exhausted, retry after 300 seconds",
    }, ctx);
    await tick(50);
    const g = readState(cwd).goal as unknown as Record<string, unknown>;
    const ev = g.subagentQuotaEvidence as { signal: string; retryAfterSec: number; at: string } | undefined;
    assert.ok(ev, "quota evidence recorded");
    assert.equal(ev.signal, "rate-limit");
    assert.equal(ev.retryAfterSec, 300);
    assert.ok(ledgerTypes(cwd).includes("subagent_quota_signal"), "evidence is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("quota reroute: blocked park with fresh evidence becomes a supervised wait", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.fire("tool_result", {
      toolName: "subagent",
      isError: true,
      output: "402 insufficient credits — music model quota spent",
    }, ctx);
    await tick(50);
    const before = Date.now();
    const res = await pi.runTool("pause_goal", {
      reason: "provider error",
      suggestedAction: "wait for quota",
      kind: "blocked",
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as unknown as Record<string, unknown>;
    assert.equal(g.status, "paused");
    assert.equal(g.pauseKind, "wait", "quota-caused blocked park reroutes to wait");
    assert.ok(g.pauseResumeAt, "the wait carries a resume time");
    assert.ok(g.recoveryEpisodeKey, "the wait is supervised (auto-retry card)");
    assert.equal(g.subagentQuotaEvidence, undefined, "evidence is consumed, not reusable");
    const storedIn = Date.parse(g.pauseResumeAt as string) - before;
    assert.ok(storedIn > 0 && storedIn <= HOUR_MS + 60_000, `bounded horizon, got ${(storedIn / 60000).toFixed(1)}m`);
    assert.match(res.content[0]!.text, /rerouted to a monitored auto-retry wait/, "the agent is told what happened");
    assert.ok(ledgerTypes(cwd).includes("pause_quota_rerouted_to_wait"), "the reroute is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("quota reroute: quota wording in the reason needs no evidence", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd);
  try {
    const before = Date.now();
    await pi.runTool("pause_goal", {
      reason: "MiniMax Token Plan usage limit reached — 0% left, resets at the top of the hour",
      kind: "error",
    }, ctx);
    const g = readState(cwd).goal as unknown as Record<string, unknown>;
    assert.equal(g.pauseKind, "wait");
    assert.ok(g.pauseResumeAt, "hint-derived resume time stored");
    assert.ok((g.recoveryEpisodeKey as string).includes(":quota:"), "supervised under a quota episode");
    assert.ok(Date.parse(g.pauseResumeAt as string) - before <= HOUR_MS + 60_000, "clamped to the hourly horizon");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("quota reroute: ordinary and stale-evidence parks are untouched", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await activeBoot(cwd, {
    subagentQuotaEvidence: {
      signal: "rate-limit",
      retryAfterSec: 300,
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  });
  try {
    await pi.runTool("pause_goal", {
      reason: "waiting on user credential for the deploy gate",
      kind: "blocked",
    }, ctx);
    const g = readState(cwd).goal as unknown as Record<string, unknown>;
    assert.equal(g.pauseKind, "blocked", "non-quota parks keep their kind");
    assert.equal(g.pauseResumeAt, undefined, "no invented resume time");
    assert.equal(g.recoveryEpisodeKey, undefined, "no invented supervision");
    assert.ok(!ledgerTypes(cwd).includes("pause_quota_rerouted_to_wait"), "no reroute ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
