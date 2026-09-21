// pi-goal-list-loop-audit — v0.38.80
// tests/auditor-challenge-record.test.ts
//
// The worker's challenge outcome (result.challenge: confirmed / flipped /
// not-applicable / skipped:*) must survive the parent boundary and land on
// the recorded AuditVerdict — otherwise /glla stats challenges reports on
// nothing. End-to-end through the real worker + parent settle path with a
// fake pi binary (run-to-done.test.ts harness): an approval earns a
// confirm round whose outcome is recorded; a disapproval stays
// single-round and records not-applicable. The approval case rides the
// regression-shield block so the goal (and its history) stays live
// instead of archiving.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, ...extra }));
}

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  setSettings({});
});

async function boot(cwd: string, seed?: Parameters<typeof seedState>[1]): Promise<{ pi: MockPi; ctx: MockCtx }> {
  if (seed) seedState(cwd, seed);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `challenge-record-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function shutdown(pi: MockPi, ctx: MockCtx): Promise<void> {
  try {
    await pi.fire("session_end", { reason: "test-teardown" }, ctx);
  } catch {
    /* teardown is best effort */
  }
  await tick(60);
}

function writeFakeAuditor(cwd: string, report: string): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = ${JSON.stringify(report)};
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
`);
  fs.chmodSync(script, 0o700);
  return script;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for detached-auditor state ${label}`.trim());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type HistoryVerdict = {
  approved?: boolean;
  disapproved?: boolean;
  regressionShieldPassed?: boolean;
  challenge?: string;
};

test("challenge-record: a confirmed approval records challenge=confirmed on the verdict", async () => {
  setSettings({});
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  // Evidence-free approval: the shield blocks (contract items uncited) so
  // the goal stays live and the verdict is assertable in place. The fake
  // pi emits the same approval for the challenge round's fresh session.
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "Looks good.\n<approved/>");
  const { pi, ctx } = await boot(cwd, {
    goal: seedGoal({
      status: "active",
      policy: "goal",
      verificationContract: "Done when:\n- artifact exists\n- tests pass",
    }),
  });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Claimed done.", verificationSummary: "e1." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return !!goal && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
    });
    const history = (readState(cwd).goal as { auditHistory?: HistoryVerdict[] }).auditHistory ?? [];
    assert.equal(history.length, 1);
    assert.equal(history[0]!.approved, true);
    assert.equal(history[0]!.regressionShieldPassed, false, "shield block keeps the verdict live for assertion");
    assert.equal(history[0]!.challenge, "confirmed", "the worker's falsification outcome survives the parent boundary");
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});

test("challenge-record: a single-round disapproval records challenge=not-applicable", async () => {
  setSettings({});
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "## Required fixes\n- gap\n<disapproved/>");
  const { pi, ctx } = await boot(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Claimed done.", verificationSummary: "e1." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
    });
    const history = (readState(cwd).goal as { auditHistory?: HistoryVerdict[] }).auditHistory ?? [];
    assert.equal(history.length, 1);
    assert.equal(history[0]!.disapproved, true);
    assert.equal(history[0]!.challenge, "not-applicable", "single-round verdicts record N/A, distinct from legacy-absent");
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});
