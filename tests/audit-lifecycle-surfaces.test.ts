// pi-goal-list-loop-audit — v0.38.99
// tests/audit-lifecycle-surfaces.test.ts
//
// The two things a durable lifecycle is worthless without:
//
//  1. the MAIN path (an ordinary `complete_goal`) records `running` +
//     `lastActivityAt` in durable state — the recovery path did, the main path
//     did not, so "running with last activity" only ever reached the ledger on
//     a retry; and
//  2. the durable phase is AUTHORITATIVE over an incompatible in-process
//     progress snapshot on every user-facing surface (widget card, status
//     line, `/goal status`), so a settling approval can never be rendered as
//     "awaiting completion review".

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { auditLifecycleProjection } from "../extensions/audit-lifecycle.ts";
import { buildStatusText, buildWidgetLines } from "../extensions/goal-loop-display.js";
import { readState, type Goal, type State } from "../extensions/goal-loop-core.ts";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const SUMMARY = "Outcome: shipped.\nChanged: one file.\nEvidence: test.\nTests: bun test pass.\nUnresolved: none.\nNext: none.";

/** A worker that boots, emits real RPC events over a few polls (so the parent
 * observes a progress snapshot carrying `lastActivityAt`), and only then
 * settles with a verdict. */
function slowFakeAuditor(cwd: string, verdict: "approved" | "disapproved", holdMs: number): string {
  const binary = path.join(cwd, `fake-auditor-${verdict}.mjs`);
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", async (chunk) => {
  if (handled) return;
  handled = true;
  const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  // First event immediately: the worker is alive and the parent can stamp it.
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reading\\n" } });
  // Then hold long enough for the parent to poll and record the activity.
  await new Promise((r) => setTimeout(r, ${holdMs}));
  emit({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ${JSON.stringify(verdict === "approved" ? "<evidence>pinned</evidence>\\n<approved/>" : "## Required fixes\\n- fix it\\n<disapproved/>")} } });
  emit({ type: "agent_settled" });
});
`);
  fs.chmodSync(binary, 0o700);
  return binary;
}

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
});

// ---- 1. the main path records durable running activity ----

test("durable: an ordinary complete_goal records phase running + lastActivityAt before the verdict", async () => {
  const cwd = tmpCwd();
  const binary = slowFakeAuditor(cwd, "disapproved", 1_200);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = binary;
  const pi = new MockPi();
  activate(pi.api);
  const ctx: MockCtx = makeMockCtx(cwd, { sessionManager: { name: `durable-activity-${Date.now()}` } });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await pi.command("goal", "durable activity on the main path — done when pinned", ctx);
    await pi.runTool("complete_goal", { completionSummary: SUMMARY, verificationSummary: "pinned" }, ctx);

    // While the worker is alive the DURABLE claim must already say running and
    // carry the worker's own activity stamp. Sampling the ledger (not RAM) is
    // the point: a restart reads this, not the HUD.
    const deadline = Date.now() + 8_000;
    let seen: { phase?: string; lastActivityAt?: string } = {};
    while (Date.now() < deadline) {
      const claim = (readState(cwd).goal as { pendingCompletion?: { phase?: string; lastActivityAt?: string } } | null)?.pendingCompletion;
      if (claim?.phase === "running" && claim.lastActivityAt) { seen = claim; break; }
      await tick(60);
    }
    assert.equal(seen.phase, "running", "the main complete_goal path persists phase running");
    assert.ok(seen.lastActivityAt, "and the worker's own activity stamp — never a back-filled claim age");

    await tick(1_500);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"lastActivityAt"/, "the durable lifecycle evidence reaches the ledger");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    if (previous === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = previous;
  }
});

// ---- 2. the durable phase is authoritative on every surface ----

function stateFor(claim: Record<string, unknown>): State {
  return { goal: seedGoal({ status: "auditing", objective: "surface authority — done when pinned", pendingCompletion: claim }) as unknown as Goal, list: [], loop: null } as unknown as State;
}

/** A worker-complete snapshot — the exact progress object the auditor used to
 * let mask a durable phase. */
const COMPLETE_PROGRESS = { phase: "complete" as const, elapsedMs: 9_000, recentOutput: ["done"], toolCalls: [], unmatchedToolStarts: 0, unmatchedToolEnds: 0, lastActivityAt: NOW - 5_000 };

test("durable phase beats a worker-complete snapshot on the widget card and the status line", () => {
  for (const [phase, expected] of [["starting", /starting/], ["settling", /settling/]] as const) {
    const state = stateFor({ at: "2026-09-25T11:00:00.000Z", phase, startedAt: "2026-09-25T11:00:00.000Z", lastActivityAt: "2026-09-25T11:30:00.000Z" });
    const lines = (buildWidgetLines(state, COMPLETE_PROGRESS, NOW) ?? []).join("\n");
    assert.match(lines, expected, `widget names the durable ${phase} phase`);
    assert.ok(!/auditor: awaiting completion review/.test(lines), `a worker-complete snapshot must not rename the durable ${phase} phase`);
    const status = buildStatusText(state, COMPLETE_PROGRESS, NOW) ?? "";
    assert.match(status, expected, `status line names the durable ${phase} phase`);
    assert.ok(!/awaiting completion review/.test(status), `status line must not claim ${phase} is awaiting review`);
  }
});

test("a live worker still refines a running claim (the HUD stays the richer truth)", () => {
  const state = stateFor({ at: "2026-09-25T11:00:00.000Z", phase: "running", lastActivityAt: "2026-09-25T11:59:30.000Z" });
  const lines = (buildWidgetLines(state, { ...COMPLETE_PROGRESS, phase: "tool_executing", currentTool: "grep", lastActivityAt: NOW - 20_000 }, NOW) ?? []).join("\n");
  assert.match(lines, /tool: grep/, "a live worker keeps naming the current tool");
  assert.match(lines, /last progress 20s ago/, "and its live progress age");
});

test("durable phase with no live worker says so, and names the durable age", () => {
  const state = stateFor({ at: "2026-09-25T11:00:00.000Z", phase: "starting", startedAt: "2026-09-25T11:59:55.000Z" });
  const lines = (buildWidgetLines(state, null, NOW) ?? []).join("\n");
  assert.match(lines, /auditor: starting/, "a claim that has never reported is starting");
  assert.match(lines, /no worker event/, "and says it has no worker event");
});

test("the durable projection is the single source for all three surfaces", () => {
  const claim = { at: "2026-09-25T11:00:00.000Z", phase: "recovery-pending", recoveryAt: "2026-09-25T11:55:00.000Z" };
  const projection = auditLifecycleProjection(claim, { now: NOW })!;
  assert.equal(projection.state, "recovery-needed");
  const lines = (buildWidgetLines(stateFor(claim), null, NOW) ?? []).join("\n");
  assert.ok(lines.includes(projection.label), "the widget uses the projection's label");
  assert.match(lines, /parked 5m 00s ago/, "and the projection's park age");
});
