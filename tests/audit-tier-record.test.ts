// pi-goal-list-loop-audit — v0.38.81
// tests/audit-tier-record.test.ts
//
// Risk-tiered auditing end-to-end (real worker + parent settle, fake pi):
// a small quiet claim audits light (single round, tier recorded), a
// spot-check rate of 1 forces full with the spot mark, draft-time
// fullAudit consent lands on the goal, batch/list drafts refuse the
// flag, and complete_goal requestFullAudit escalates one claim.
// Approvals ride the shield-blocked path so goals stay live.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyLastConfirmDialog,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, ...extra }));
}

function ledgerEntries(cwd: string): Array<{ type: string; value?: any }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value?: any });
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
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `tier-record-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function shutdown(pi: MockPi, ctx: MockCtx): Promise<void> {
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
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

// v0.38.99 (closure): loaded suites measured 31.8s against this 30s ceiling
// (the escalation path spawns a real worker: boot alone runs seconds). 45s
// restores the margin under the 60s runner cap; the assertions after the
// wait are unchanged, and a wedged audit still times out loudly.
async function waitUntil(predicate: () => boolean, timeoutMs = 45_000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for detached-auditor state ${label}`.trim());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function enterGoalDrafting(pi: MockPi, ctx: MockCtx): Promise<void> {
  await pi.command("goal", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
}

type HistoryVerdict = {
  approved?: boolean;
  disapproved?: boolean;
  regressionShieldPassed?: boolean;
  challenge?: string;
  auditTier?: string;
  spotCheck?: boolean;
};

const SMALL_TELEMETRY = { turns: 5, fileWrites: 3, bashCalls: 2 };
const QUIET_OBJECTIVE = "Fix the typo in the README header.";
const CONTRACT = "Done when:\n- artifact exists\n- tests pass";

async function settledHistory(cwd: string): Promise<HistoryVerdict[]> {
  await waitUntil(() => {
    const goal = readState(cwd).goal as { pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
    return !!goal && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
  });
  return (readState(cwd).goal as { auditHistory?: HistoryVerdict[] }).auditHistory ?? [];
}

test("tier-record: a small quiet claim audits light and records the tier", async () => {
  setSettings({ autoResume: true, auditSpotCheckRate: 0 });
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "Looks good.\n<approved/>");
  const { pi, ctx } = await boot(cwd, {
    goal: seedGoal({ status: "active", policy: "goal", objective: QUIET_OBJECTIVE, verificationContract: CONTRACT, telemetry: SMALL_TELEMETRY }),
  });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Outcome: fixed header.", verificationSummary: "Read it back." }, ctx);
    const history = await settledHistory(cwd);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.approved, true);
    assert.equal(history[0]!.auditTier, "light");
    assert.equal(history[0]!.challenge, "skipped: light-tier audit", "light tier runs single-round by policy");
    assert.equal(history[0]!.spotCheck, undefined);
    const decided = ledgerEntries(cwd).find((e) => e.type === "audit_tier_decided");
    assert.ok(decided, "the tier decision is ledgered");
    assert.equal(decided!.value?.tier, "light");
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});

test("tier-record: spot-check rate 1 forces full and marks the verdict", async () => {
  setSettings({ autoResume: true, auditSpotCheckRate: 1 });
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "Looks good.\n<approved/>");
  const { pi, ctx } = await boot(cwd, {
    goal: seedGoal({ status: "active", policy: "goal", objective: QUIET_OBJECTIVE, verificationContract: CONTRACT, telemetry: SMALL_TELEMETRY }),
  });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Outcome: fixed header.", verificationSummary: "Read it back." }, ctx);
    const history = await settledHistory(cwd);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.auditTier, "full");
    assert.equal(history[0]!.spotCheck, true);
    assert.equal(history[0]!.challenge, "confirmed", "a spot-check IS a full audit with a falsification round");
    const decided = ledgerEntries(cwd).find((e) => e.type === "audit_tier_decided");
    assert.equal(decided!.value?.tier, "full");
    assert.equal(decided!.value?.spotCheck, true);
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});

test("tier-record: complete_goal requestFullAudit escalates one claim", async () => {
  setSettings({ autoResume: true, auditSpotCheckRate: 0 });
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "Looks good.\n<approved/>");
  const { pi, ctx } = await boot(cwd, {
    goal: seedGoal({ status: "active", policy: "goal", objective: QUIET_OBJECTIVE, verificationContract: CONTRACT, telemetry: SMALL_TELEMETRY }),
  });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Outcome: fixed header.", verificationSummary: "Read it back.", requestFullAudit: true }, ctx);
    const history = await settledHistory(cwd);
    assert.equal(history[0]!.auditTier, "full", "the agent's check-me-carefully survives to dispatch");
    assert.equal(history[0]!.spotCheck, undefined, "an asked-for full audit is not a spot-check");
    const decided = ledgerEntries(cwd).find((e) => e.type === "audit_tier_decided");
    assert.ok((decided!.value?.reasons as string[]).some((r) => /agent requested full audit/.test(r)));
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
});

test("tier-record: draft consent sets fullAudit, shows the notice, ledgers consent", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd);
  try {
    await enterGoalDrafting(pi, ctx);
    ctx.ui.customImpl = async () => "Yes";
    const res = await pi.runTool("propose_goal_draft", {
      objective: "full-audit objective — done when pinned",
      verificationContract: "pinned",
      fullAudit: true,
    }, ctx) as { content: Array<{ text: string }> };
    assert.match(res.content[0]!.text, /activated/, "draft confirmed and activated");
    const dialog = __testOnlyLastConfirmDialog();
    assert.match(dialog?.body ?? "", /FULL AUDIT/, "the Confirm dialog names the mode — the Confirm is the consent");
    const g = readState(cwd).goal as { fullAudit?: boolean };
    assert.equal(g.fullAudit, true, "consent is durable on the goal");
    assert.ok(ledgerEntries(cwd).some((e) => e.type === "full_audit_consented"), "consent is ledgered");
  } finally {
    await shutdown(pi, ctx);
  }
});

test("tier-record: batch drafts refuse fullAudit instead of dropping it", async () => {
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
      fullAudit: true,
    }, ctx) as { content: Array<{ text: string }> };
    assert.match(res.content[0]!.text, /single-goal only/, "refused with guidance, not silently dropped");
    assert.equal(readState(cwd).goal, null, "nothing activated");
  } finally {
    await shutdown(pi, ctx);
  }
});

test("tier-record: single list drafts refuse fullAudit instead of dropping it", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await boot(cwd);
  try {
    await pi.command("list", "", ctx);
    await pi.fire("message_start", { message: { role: "user" } }, ctx);
    await pi.fire("message_start", { message: { role: "user" } }, ctx);
    const res = await pi.runTool("propose_goal_draft", {
      objective: "queued item — done when pinned",
      fullAudit: true,
    }, ctx) as { content: Array<{ text: string }> };
    assert.match(res.content[0]!.text, /single-goal only/, "refused with guidance, not silently dropped");
  } finally {
    await shutdown(pi, ctx);
  }
});
