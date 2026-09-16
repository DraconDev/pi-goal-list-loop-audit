// pi-goal-list-loop-audit — agent-side resume_goal tool
//
// Field incident (Screenshot_20260916_090307, dracon-utilities): the goal was
// paused waiting on a manual action, the user waived the blocker in
// conversation ("ok tweak it"), and the agent tried complete_goal — which
// correctly refuses on a paused item. But the agent had no way to resume
// itself: resume was a user-only slash command, so the authorized next step
// bounced back to the user as a pointless `/goal resume` round-trip.
//
// Guard: resume_goal reactivates a paused goal/item the owning session holds
// (same admission as /goal resume, minus continuation scheduling — the live
// turn owns what happens next), ledgered via resume_goal. Everything it must
// not touch (live loops, supervisor freeze, pending main-model recovery,
// stale sessions, non-paused states) refuses with the real user command.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ledgerEntries(cwd: string): Array<{ type: string; via?: string; reason?: string }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; via?: string; reason?: string });
}

function pausedGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return seedGoal({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "blocked on the sudo-mode auth for the live demo",
    pauseSuggestedAction: "Complete the auth, then run /goal resume",
    ...overrides,
  });
}

async function boot(pi: MockPi, cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `resume-goal-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return ctx;
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("resume_goal reactivates a paused goal and clears every pause marker", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: pausedGoal() });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    assert.equal(readState(cwd).goal?.status, "paused", "blank startup holds the paused seed");
    const result = await pi.runTool("resume_goal", { reason: "user waived the live demo; will submit a tweaked claim" }, ctx) as {
      content: Array<{ text: string }>;
    };
    assert.match(result.content[0]!.text, /active again/, "the tool confirms reactivation");
    assert.match(result.content[0]!.text, /Continue working in THIS turn/, "the live turn owns what happens next");
    const after = readState(cwd).goal as unknown as Record<string, unknown>;
    assert.equal(after.status, "active");
    assert.equal(after.pauseReason, undefined);
    assert.equal(after.pauseSuggestedAction, undefined);
    assert.equal(after.pauseKind, undefined);
    assert.equal(after.pauseResumeAt, undefined);
    const resumed = ledgerEntries(cwd).filter((entry) => entry.type === "goal_resumed" && entry.via === "resume_goal");
    assert.equal(resumed.length, 1, "the agent resume is ledgered distinctly from a manual resume");
    assert.match(resumed[0]!.reason ?? "", /waived the live demo/, "the user authorization rides the ledger entry");
    assert.equal(ctx.ui.matching("Resumed goal").length, 1, "the resume is announced, not silent");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal on an already-active goal answers instead of churning state", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "already running — done when pinned" }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    const before = ledgerEntries(cwd).length;
    const result = await pi.runTool("resume_goal", {}, ctx) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /already active/, "no-op is named, not executed");
    assert.equal(readState(cwd).goal?.status, "active");
    assert.equal(ledgerEntries(cwd).length, before, "the no-op writes nothing");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal with no goal answers instead of swallowing the verb", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {});
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    const result = await pi.runTool("resume_goal", {}, ctx) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /No active goal/);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal refuses over a live loop (one-active-thing)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: pausedGoal(), loop: seedLoop() });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    const result = await pi.runTool("resume_goal", { reason: "user said go" }, ctx) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /\/loop stop/, "the refusal names the real unblock command");
    assert.equal(readState(cwd).goal?.status, "paused", "the pause is untouched");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal refuses while the supervisor is frozen", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: pausedGoal() });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await pi.command("glla", "pause", ctx);
    await tick();
    const result = await pi.runTool("resume_goal", { reason: "user said go" }, ctx) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /\/glla pause/, "the refusal names the freeze, and unfreezing stays user-typed");
    assert.equal(readState(cwd).goal?.status, "paused", "the pause is untouched");
  } finally {
    await pi.command("glla", "resume", ctx);
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal refuses while main-model recovery is pending", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: pausedGoal(),
    mainModelRecovery: {
      primary: "anthropic/mock-model",
      active: "anthropic/mock-model",
      attempted: ["anthropic/mock-model"],
      attempts: 1,
      reason: "provider recovery",
      kind: "goal",
      retryAt: Date.now() + 3600_000,
      pendingModelSwitch: "anthropic/mock-model",
    },
  } as unknown as Parameters<typeof seedState>[1]);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    const result = await pi.runTool("resume_goal", { reason: "user said go" }, ctx) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /Main-model recovery is pending/, "machinery-owned recovery keeps its own timers");
    assert.equal(readState(cwd).goal?.status, "paused", "the pause is untouched");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal refuses a terminal goal with the real recovery path", async () => {
  const cwd = tmpCwd();
  const goal = seedGoal({ status: "aborted", objective: "aborted objective — done when never" });
  fs.mkdirSync(path.join(cwd, ".pi-glla", "archive"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "archive", `${(goal as { id: string }).id}.md`), "**Status**: aborted\n");
  seedState(cwd, { goal });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    const result = await pi.runTool("resume_goal", {}, ctx) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /can't be resumed/, "terminal states stay terminal");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

// The screenshot regression: pause → resume_goal → complete_goal must flow
// with no `/goal resume` round-trip in between.
test("paused → resume_goal → complete_goal flows without a manual resume", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  const binary = path.join(cwd, "auditor.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"<evidence>tweaked claim read</evidence>\\n<approved/>"}});
emit({type:"agent_settled"});
}, 350); });`);
  fs.chmodSync(binary, 0o700);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = binary;
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await pi.command("goal", "tweak-flow objective — done when pinned", ctx);
    await tick();
    const paused = await pi.runTool("pause_goal", {
      reason: "blocked on the sudo-mode auth for the live demo",
      kind: "blocked",
      suggestedAction: "Complete the auth, then run /goal resume",
    }, ctx) as { content: Array<{ text: string }> };
    assert.match(paused.content[0]!.text, /Goal paused/);
    assert.equal(readState(cwd).goal?.status, "paused");

    const resumed = await pi.runTool("resume_goal", { reason: "user waived the live demo; submitting a tweaked claim" }, ctx) as {
      content: Array<{ text: string }>;
    };
    assert.match(resumed.content[0]!.text, /active again/);

    const summary = "Outcome: Tweaked.\nChanged: none.\nEvidence: waiver.\nTests: resume-goal-tool suite.\nUnresolved: none.\nNext: none.";
    const claimed = await pi.runTool("complete_goal", {
      completionSummary: summary,
      verificationSummary: "waiver pinned",
      newObjective: "tweak-flow objective without the live demo — done when pinned",
    }, ctx) as { content: Array<{ text: string }> };
    assert.doesNotMatch(claimed.content[0]!.text, /No active goal|is paused/, "the claim is accepted — no manual-resume round-trip");
    assert.match(claimed.content[0]!.text, /AUDIT PENDING — nonterminal/);
    assert.equal(readState(cwd).goal?.status, "auditing");
    const claimId = (readState(cwd).goal as { id: string }).id;
    const until = Date.now() + 10000;
    while (readState(cwd).goal !== null) {
      if (Date.now() > until) throw new Error("settlement timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "archive", `${claimId}.md`)), "the tweaked claim archives after the approving audit");
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resume_goal re-fires a stored completion claim through the agent origin", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  const binary = path.join(cwd, "auditor.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"<evidence>stored claim read</evidence>\\n<approved/>"}});
emit({type:"agent_settled"});
}, 350); });`);
  fs.chmodSync(binary, 0o700);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = binary;
  seedState(cwd, {
    goal: pausedGoal({
      objective: "stored-claim objective — done when pinned",
      pendingCompletion: {
        completionSummary: "Outcome: Stored.\nChanged: none.\nEvidence: stored.\nTests: none.\nUnresolved: none.\nNext: none.",
        verificationSummary: "stored evidence",
        at: new Date().toISOString(),
        phase: "retry-waiting",
        attemptId: "stored-claim-attempt",
      },
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    assert.equal(readState(cwd).goal?.status, "paused", "blank startup holds the paused claim");
    const result = await pi.runTool("resume_goal", { reason: "user asked for the audit retry now" }, ctx) as {
      content: Array<{ text: string }>;
    };
    assert.match(result.content[0]!.text, /detached auditor is now running/, "the claim re-fires instead of idling active");
    assert.equal(readState(cwd).goal?.status, "auditing", "the claim moves, not the agent turn");
    const entries = ledgerEntries(cwd);
    assert.ok(entries.some((entry) => entry.type === "goal_resumed" && entry.via === "resume_goal"), "the tool resume is ledgered");
    assert.ok(entries.some((entry) => entry.type === "goal_resumed" && entry.via === "agent-audit"), "the re-fired audit carries the agent origin");
    const until = Date.now() + 10000;
    while (readState(cwd).goal !== null) {
      if (Date.now() > until) throw new Error("settlement timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
