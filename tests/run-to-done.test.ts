// pi-goal-list-loop-audit — v0.38.73 run-to-done mode.
//
// Draft up front, then carry the goal to completion without supervised
// pauses: draft-time user consent (shown in the Confirm dialog — the
// Confirm IS the consent) grants per-goal session auto-resume plus
// immediate decision auto-default. Hard stops still park: audit/error
// caps (no TODO conversion), provider outage, user abort. The auditor is
// never skipped; blocked-on-external pauses still park.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import activate, {
  __testOnlyLastConfirmDialog,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { buildStatusText } from "../extensions/goal-loop-display.js";
import { HELD_ON_RESTORE } from "../extensions/goal-loop-forever.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

type GoalView = {
  status: string;
  runToDone?: boolean;
  midRunDecisionCount?: number;
  autoDefaultLog?: Array<{ at: string; reason: string; chosen: string; options: string[] }>;
};

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, ...extra }));
}

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
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
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `run-to-done-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function shutdown(pi: MockPi, ctx: MockCtx): Promise<void> {
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
}

async function enterGoalDrafting(pi: MockPi, ctx: MockCtx): Promise<void> {
  await pi.command("goal", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
}

test("run-to-done: draft consent sets the flag, shows the notice, ledgers consent", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd);
  try {
    await enterGoalDrafting(pi, ctx);
    ctx.ui.customImpl = async () => "Yes";
    const res = await pi.runTool("propose_goal_draft", {
      objective: "run-to-done objective — done when pinned",
      verificationContract: "pinned",
      runToDone: true,
    }, ctx) as { content: Array<{ text: string }> };
    assert.match(res.content[0]!.text, /activated/, "draft confirmed and activated");
    const dialog = __testOnlyLastConfirmDialog();
    assert.match(dialog?.body ?? "", /RUN TO DONE/, "the Confirm dialog names the mode — the Confirm is the consent");
    assert.match(dialog?.body ?? "", /hard stop/, "hard stops are disclosed before consent");
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.runToDone, true, "consent is durable on the goal");
    assert.ok(ledgerTypes(cwd).includes("run_to_done_consented"), "consent is ledgered");
  } finally {
    await shutdown(pi, ctx);
  }
});

test("run-to-done: drafts without the flag stay supervised", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd);
  try {
    await enterGoalDrafting(pi, ctx);
    ctx.ui.customImpl = async () => "Yes";
    await pi.runTool("propose_goal_draft", {
      objective: "supervised objective — done when pinned",
      verificationContract: "pinned",
    }, ctx);
    assert.doesNotMatch(__testOnlyLastConfirmDialog()?.body ?? "", /RUN TO DONE/);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.runToDone, undefined, "absent flag means supervised");
    assert.ok(!ledgerTypes(cwd).includes("run_to_done_consented"));
  } finally {
    await shutdown(pi, ctx);
  }
});

test("run-to-done: batch drafts refuse the flag instead of dropping it", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd);
  try {
    await pi.command("list", "", ctx);
    await pi.fire("message_start", { message: { role: "user" } }, ctx);
    await pi.fire("message_start", { message: { role: "user" } }, ctx);
    const res = await pi.runTool("propose_goal_draft", {
      objective: "batch summary",
      items: ["first queued item — done when pinned"],
      runToDone: true,
    }, ctx) as { content: Array<{ text: string }> };
    assert.match(res.content[0]!.text, /single-goal only/, "refused with guidance, not silently dropped");
    assert.equal(readState(cwd).goal, null, "nothing activated");
  } finally {
    await shutdown(pi, ctx);
  }
});

test("run-to-done: decisions auto-default immediately with no budget set", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd, { goal: seedGoal({ status: "active", policy: "goal", runToDone: true }) });
  try {
    const res = await pi.runTool("pause_goal", {
      reason: "choose the build strategy",
      suggestedAction: "Pick an option to continue.",
      kind: "decision",
      options: ["rebuild from scratch", "patch the existing build"],
      recommended: 2,
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active", "run-to-done never pauses for decisions");
    assert.equal(g.midRunDecisionCount, 1, "the durable counter still advances");
    assert.equal(g.autoDefaultLog?.length, 1);
    assert.equal(g.autoDefaultLog![0]!.chosen, "patch the existing build");
    assert.match(res.content[0]!.text, /Run-to-done decision/);
    assert.match(res.content[0]!.text, /Left out/i);
    assert.ok(ledgerTypes(cwd).includes("run_to_done_auto_default"));
    assert.ok(!ledgerTypes(cwd).includes("decision_budget_auto_default"), "distinct event from the budget path");
  } finally {
    await shutdown(pi, ctx);
  }
});

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

type AuditState = { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;

const R1 = "## Required fixes\n- R1-GAP: first disapproval\n<disapproved/>";
const R2 = "## Required fixes\n- R2-GAP: second disapproval\n<disapproved/>";

test("run-to-done: the audit cap parks instead of converting to TODOs", async () => {
  setSettings({ aggressiveMode: true, auditCap: 2 });
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R1);
  const { pi, ctx } = await boot(cwd, { goal: seedGoal({ status: "active", policy: "goal", runToDone: true }) });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Round one claim.", verificationSummary: "e1." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as AuditState;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
    });
    process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R2);
    await pi.runTool("complete_goal", { completionSummary: "Round two claim.", verificationSummary: "e2." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as AuditState;
      return !goal?.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 2;
    });
    const g = readState(cwd).goal as GoalView & { pauseReason?: string };
    assert.equal(g.status, "paused", "the cap is a hard stop under run-to-done");
    assert.match(g.pauseReason ?? "", /cap 2/);
    assert.ok(ledgerTypes(cwd).includes("goal_paused"), "cap park is ledgered");
    assert.ok(!ledgerTypes(cwd).includes("audit_cap_keep_going"), "no TODO conversion under run-to-done");
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});

test("run-to-done: aggressive cap conversion is preserved without the flag", async () => {
  // autoResume:true is the OLD consent (releases the auditor surface after
  // cold restore); the flag test above proves the NEW consent does the same.
  setSettings({ aggressiveMode: true, auditCap: 2, autoResume: true });
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R1);
  const { pi, ctx } = await boot(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Round one claim.", verificationSummary: "e1." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as AuditState;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
    });
    process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R2);
    await pi.runTool("complete_goal", { completionSummary: "Round two claim.", verificationSummary: "e2." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as AuditState;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 2;
    });
    assert.ok(ledgerTypes(cwd).includes("audit_cap_keep_going"), "aggressive default untouched");
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});

test("run-to-done: session start resumes held work without global autoResume; blocked parks stay parked", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd, {
    goal: seedGoal({ status: "paused", pauseKind: "blocked", pauseReason: "waiting on user input", runToDone: true }),
    loop: seedLoop({ active: false, stopReason: HELD_ON_RESTORE }),
  });
  try {
    await tick(200);
    const types = ledgerTypes(cwd);
    assert.ok(types.includes("loop_auto_resumed_on_restore"), "held loop resumes on per-goal consent");
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "blocked-on-external still parks — missing input is a hard-stop-class dependency");
  } finally {
    await shutdown(pi, ctx);
  }
});

test("run-to-done: held work stays held without the flag or global consent", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd, {
    goal: seedGoal({ status: "paused", pauseKind: "blocked", pauseReason: "waiting on user input" }),
    loop: seedLoop({ active: false, stopReason: HELD_ON_RESTORE }),
  });
  try {
    await tick(200);
    assert.ok(!ledgerTypes(cwd).includes("loop_auto_resumed_on_restore"), "no consent, no resume");
  } finally {
    await shutdown(pi, ctx);
  }
});

test("run-to-done: the status line names the mode", () => {
  const flagged = buildStatusText({ goal: seedGoal({ status: "active", runToDone: true }) } as never, null);
  assert.match(flagged ?? "", /run to done/, "an auto-running goal must never look supervised");
  const plain = buildStatusText({ goal: seedGoal({ status: "active" }) } as never, null);
  assert.doesNotMatch(plain ?? "", /run to done/);
});
