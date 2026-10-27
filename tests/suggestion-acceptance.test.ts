// pi-goal-list-loop-audit — suggestion acceptance (note.md #later 175739).
//
// A blocked/error pause carrying a concrete command is an implicit question
// with no accept path. pause_goal promotes it to an Accept-first decision so
// the existing card + picker + budget machinery carries it.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import {
  extractSuggestedCommand,
  suggestionAcceptancePromotion,
  readState,
  type Goal,
} from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

type GoalView = {
  status: string;
  pauseKind?: string;
  pauseOptions?: string[];
  pauseRecommended?: number;
  pauseSuggestedAction?: string;
  midRunDecisionCount?: number;
};

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(
    GLOBAL_SETTINGS_PATH,
    JSON.stringify({ autoResume: true, aggressiveMode: false, ...extra }),
  );
}

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function activeBoot(cwd: string, policy: "goal" | "list" = "goal", extra: Partial<Goal> = {}): Promise<{ pi: MockPi; ctx: MockCtx }> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy, ...extra }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `suggestion-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  setSettings({});
});

// ---- scheduled waits require an actual wake registration ----

for (const resumeAt of [undefined, "not-a-date"]) {
  test(`pause_goal rejects a wait with no valid wake deadline (${resumeAt ?? "missing"})`, async () => {
    const cwd = tmpCwd();
    setSettings({});
    const { pi, ctx } = await activeBoot(cwd);
    try {
      const result = await pi.runTool("pause_goal", {
        kind: "wait", reason: "Render is still running; check fresh progress later.",
        ...(resumeAt ? { resumeAt } : {}),
      }, ctx);
      assert.match(result.content.map(c => c.text).join("\n"), /No automatic wake was registered/);
      assert.equal(readState(cwd).goal?.status, "active", "invalid wait never parks the work");
      assert.equal(readState(cwd).goal?.pauseResumeAt, undefined);
    } finally {
      await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    }
  });
}

for (const failure of ["throw", "no-timer"] as const) {
  test(`pause_goal: heartbeat registration failure (${failure}) preserves the active checkpoint`, async () => {
    const cwd = tmpCwd();
    setSettings({});
    const { pi, ctx } = await activeBoot(cwd, "goal", {
      taskList: { version: 1, tasks: [{ id: "1", title: "Retained external-work checkpoint",
        status: "in_progress", subtasks: [] }] },
    });
    // Exercise real startHeartbeat through the registered pause_goal tool.
    // Reject its timer publication at the existing runtime boundary rather
    // than fabricate presentation evidence or replace the tool's registrar.
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "heartbeatTimer");
    assert.ok(descriptor, "the host exposes its timer registration boundary");
    const before = structuredClone(readState(cwd).goal);
    const sendsBefore = pi.sent.length;
    let attempted = 0;
    Object.defineProperty(globalThis, "heartbeatTimer", {
      configurable: true,
      get: () => null,
      set: (timer: NodeJS.Timeout | null) => {
        if (!timer) return;
        attempted++;
        clearTimeout(timer); // failed publication never leaves an orphan wake
        if (failure === "throw") throw new Error("fixture: heartbeat registration rejected");
        // Simulate a registrar returning without retaining a timer handle.
      },
    });
    try {
      const result = await pi.runTool("pause_goal", {
        kind: "wait", reason: "Inspect fresh external render evidence at the next bounded check.",
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
      }, ctx);
      assert.ok(attempted > 0, "real heartbeat registration was attempted");
      assert.ok("isError" in result);
      assert.equal(result.isError, true);
      assert.ok("details" in result);
      assert.deepEqual(result.details, { paused: false, wakeRegistered: false });
      const text = result.content.map(c => c.text).join("\n");
      assert.match(text, /Not paused: scheduled-check heartbeat registration failed/);
      assert.match(text, /No automatic wake was registered/);
      if (failure === "throw") assert.match(text, /fixture: heartbeat registration rejected/);
      assert.deepEqual(readState(cwd).goal, before, "the full durable checkpoint is unchanged");
      assert.equal(readState(cwd).goal?.pauseResumeAt, undefined);
      assert.equal(heartbeatTimer, null);
      await tick(30);
      assert.equal(pi.sent.length, sendsBefore, "no automatic-wake reminder or continuation was sent");
      assert.equal(ledgerTypes(cwd).includes("goal_paused"), false);
    } finally {
      Object.defineProperty(globalThis, "heartbeatTimer", descriptor);
      await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    }
  });
}

// ---- pure extraction ----

test("extractSuggestedCommand: screenshot-shaped tweak suggestion extracts the exact command", () => {
  const cmd = extractSuggestedCommand(
    'Run /goal tweak "Restore the original selective automatic Git LFS implementation." This changes scope explicitly.',
  );
  assert.equal(cmd, '/goal tweak "Restore the original selective automatic Git LFS implementation."');
});

test("extractSuggestedCommand: distinct non-decline commands extract cleanly", () => {
  assert.equal(extractSuggestedCommand("then run /loop stop; fix first"), "/loop stop");
  assert.equal(extractSuggestedCommand("inspect /list show for details"), "/list show");
  assert.equal(extractSuggestedCommand("Run /list next after fixing access."), "/list next");
});

test("extractSuggestedCommand: vague prose, bare verbs, and quoteless tweak yield nothing", () => {
  assert.equal(extractSuggestedCommand("Pick an option to continue."), undefined);
  assert.equal(extractSuggestedCommand(undefined), undefined);
  assert.equal(extractSuggestedCommand("run /goal to continue"), undefined);
  assert.equal(extractSuggestedCommand("run /goal tweak the objective"), undefined);
});

test("extractSuggestedCommand: resume/cancel-class suggestions stay plain pauses (no duplicate choice)", () => {
  // Accept would restate the built-in decline options — nothing distinct to accept.
  assert.equal(extractSuggestedCommand("/goal resume to continue"), undefined);
  assert.equal(extractSuggestedCommand("Run /list resume after fixing access."), undefined);
  assert.equal(extractSuggestedCommand("run /goal cancel now"), undefined);
  assert.equal(suggestionAcceptancePromotion("/goal resume to continue", "goal"), undefined);
});

test("extractSuggestedCommand: quoted resume/cancel stays a plain pause too", () => {
  assert.equal(extractSuggestedCommand('Run /goal resume "after X"'), undefined);
  assert.equal(extractSuggestedCommand('Run /goal cancel "now"'), undefined);
  assert.equal(suggestionAcceptancePromotion('Run /goal resume "after X"', "goal"), undefined);
  // Quoted non-decline verbs still extract.
  assert.equal(
    extractSuggestedCommand('Run /goal tweak "Fix X." after the window'),
    '/goal tweak "Fix X."',
  );
});

test("pause_goal: picking Accept delivers the decision and resumes — the agent runs the named command", async () => {
  // Challenger round 2: the picker cannot auto-execute a tweak (whitelist
  // is arg-free verbs only), so Accept travels the existing content-choice
  // convention — decision text steered to the agent turn + resume — like
  // every agent-authored decision option. This locks that flow end to end.
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "Scope repair is still blocked.",
      suggestedAction: 'Run /goal tweak "Restore the implementation objective."',
      kind: "blocked",
    }, ctx);
    ctx.ui.selectImpl = async (_title, options) => options.find((o) => o.startsWith("Request agent to run")) ?? options[0];
    await pi.command("goal", "decide", ctx);
    await tick(120);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active", "Accept resumes the goal");
    const steered = pi.userMessages.map((m) => m.message).join("\n");
    assert.match(steered, /Request agent to run \/goal tweak "Restore the implementation objective\."/, "the exact command reaches the agent turn");
    assert.match(steered, /continue on this path/, "the decision is framed as the path to continue");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("extractSuggestedCommand: ambiguous multi-command lines are never coin-flipped", () => {
  assert.equal(extractSuggestedCommand("maybe /goal resume or /goal cancel later"), undefined);
  assert.equal(extractSuggestedCommand('Run /goal tweak "A" or /goal cancel'), undefined);
  assert.equal(suggestionAcceptancePromotion("maybe /goal resume or /goal cancel later", "goal"), undefined);
});

test("extractSuggestedCommand: junk on line 1 does not hide a valid command on line 2", () => {
  assert.equal(
    extractSuggestedCommand("run /goal tweak the objective\nRun /list next to proceed"),
    "/list next",
  );
});

// ---- pure promotion shape ----

test("suggestionAcceptancePromotion: accept-first options use policy-correct verbs", () => {
  const goal = suggestionAcceptancePromotion('Run /goal tweak "Fix X."', "goal")!;
  assert.equal(goal.options.length, 3);
  assert.match(goal.options[0]!, /^Request agent to run \/goal tweak "Fix X\."\s*$/);
  assert.match(goal.options[1]!, /\/goal resume/);
  assert.match(goal.options[2]!, /\/goal cancel/);
  assert.equal(goal.recommended, 1);
  assert.equal(goal.unattendedDefault, 2, "unattended auto-default declines, never accepts");
  const list = suggestionAcceptancePromotion("Run /list next to proceed", "list")!;
  assert.match(list.options[0]!, /^Request agent to run \/list next\s*$/);
  assert.match(list.options[1]!, /\/list resume/);
  assert.equal(suggestionAcceptancePromotion("no command here", "goal"), undefined);
});

// ---- tool-level behavior ----

// v0.39.55 (field 2026-10-27): the card told the user to type a tweak whose
// replacement was cut off mid-word. A truncated quote can never extract, so
// the old path left it as raw text to hand-type. The promotion now offers the
// interactive editor instead — never the broken fragment.
const FIELD_TRUNCATED_TWEAK = `Run /goal tweak replacing this objective line "- Lane 1 Vera Vantel: genre darksynth, 15 tracks (~42 min)." with "- Lane 1 Vera Vantel: genres darksynth + darkw`;

test("suggestionAcceptancePromotion: a truncated tweak promotes to the interactive editor, not the fragment", () => {
  const goal = suggestionAcceptancePromotion(FIELD_TRUNCATED_TWEAK, "goal")!;
  assert.equal(goal.options.length, 3);
  assert.match(goal.options[0]!, /^Review the tweak in the interactive editor \(\/goal tweak\)\s*$/, "Accept opens the editor, never runs the fragment");
  assert.match(goal.options[1]!, /\/goal resume/);
  assert.match(goal.options[2]!, /\/goal cancel/);
  assert.equal(goal.recommended, 1);
  assert.equal(goal.unattendedDefault, 2, "unattended auto-default declines, never adopts");
  const list = suggestionAcceptancePromotion(FIELD_TRUNCATED_TWEAK.replace("/goal tweak", "/list tweak"), "list")!;
  assert.match(list.options[0]!, /^Review the tweak in the interactive editor \(\/list tweak\)\s*$/, "list policy uses the list editor");
  // A balanced prose-shaped tweak is NOT truncated — but it is also not an
  // extractable command, so it stays a plain pause (never an Accept of text
  // the user did not explicitly confirm line-by-line).
  assert.equal(
    suggestionAcceptancePromotion(`Run /goal tweak replacing this objective line "- A." with "- B."`, "goal"),
    undefined,
    "balanced prose is shown verbatim, never promoted",
  );
});

test("pause_goal: truncated tweak suggestion becomes an editor decision, not raw text to type", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "Scope text disagrees with the approved mix.",
      suggestedAction: FIELD_TRUNCATED_TWEAK,
      kind: "blocked",
    }, ctx);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused");
    assert.equal(g.pauseKind, "decision", "the untypeable text becomes a decision, not a typing chore");
    assert.equal(g.pauseOptions?.length, 3);
    assert.match(g.pauseOptions![0]!, /interactive editor \(\/goal tweak\)/);
    assert.equal(g.pauseRecommended, 1);
    assert.equal(g.midRunDecisionCount, 1, "the promotion counts against the mid-run budget");
    assert.match(g.pauseSuggestedAction!, /interactive editor/, "the card no longer carries the broken command");
    assert.doesNotMatch(g.pauseSuggestedAction!, /darkw/, "the fragment is gone from the card");
    assert.ok(ledgerTypes(cwd).includes("pause_suggestion_promoted_to_decision"), "the promotion is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: blocked pause with a concrete command lands as an Accept-first decision", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "Scope repair is still blocked: the continuation retains a checkpoint-only objective.",
      suggestedAction: 'Run /goal tweak "Restore the implementation objective." This changes scope explicitly.',
      kind: "blocked",
    }, ctx);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused");
    assert.equal(g.pauseKind, "decision");
    assert.equal(g.pauseOptions?.length, 3);
    assert.match(g.pauseOptions![0]!, /^Request agent to run \/goal tweak "Restore the implementation objective\."\s*$/);
    assert.equal(g.pauseRecommended, 1);
    assert.equal(g.midRunDecisionCount, 1, "the promotion counts against the mid-run budget");
    assert.match(g.pauseSuggestedAction!, /\/goal tweak/, "the exact command stays on the card");
    assert.ok(ledgerTypes(cwd).includes("pause_suggestion_promoted_to_decision"), "the promotion is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: list policy promotes with list verbs", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd, "list");
  try {
    await pi.runTool("pause_goal", {
      reason: "Item cannot proceed without a scope call.",
      suggestedAction: "Run /list next after fixing access.",
      kind: "error",
    }, ctx);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.pauseKind, "decision");
    assert.match(g.pauseOptions![0]!, /^Request agent to run \/list next\s*$/);
    assert.match(g.pauseOptions![1]!, /\/list resume/);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: vague suggestion stays a plain pause; explicit decisions pass through", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "Waiting on user input with no concrete fix.",
      suggestedAction: "Tell me how to proceed.",
      kind: "blocked",
    }, ctx);
    let g = readState(cwd).goal as GoalView;
    assert.equal(g.pauseKind, "blocked");
    assert.equal(g.pauseOptions, undefined);
    assert.equal(g.midRunDecisionCount ?? 0, 0, "no question asked, no budget spent");

    await pi.runTool("resume_goal", { reason: "user answered; continuing" }, ctx);
    await pi.runTool("pause_goal", {
      reason: "Genuine permission boundary: destructive deploy needs consent.",
      interruption: {reason:"unauthorized-irreversible-action",evidence:"The confirmed scope did not authorize destructive deployment"},
      suggestedAction: "Approve the deploy to continue.",
      kind: "decision",
      options: ["approve the deploy", "hold the deploy"],
      recommended: 1,
    }, ctx);
    g = readState(cwd).goal as GoalView;
    assert.equal(g.pauseKind, "decision");
    assert.deepEqual(g.pauseOptions, ["approve the deploy", "hold the deploy"]);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: unattended promotion declines the suggestion instead of auto-running it", async () => {
  const cwd = tmpCwd();
  setSettings({ decisionPauseBudget: 0 });
  const { pi, ctx } = await activeBoot(cwd);
  try {
    const res = await pi.runTool("pause_goal", {
      reason: "Blocked with a concrete fix available.",
      suggestedAction: 'Run /goal tweak "Restore the implementation objective." This changes scope explicitly.',
      kind: "blocked",
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as GoalView & { autoDefaultLog?: Array<{ chosen: string; promotionDeclined?: string }> };
    assert.equal(g.status, "active", "over-budget promotion auto-defaults instead of pausing");
    assert.match(res.content[0]!.text, /Continue without it/, "the run proceeds without the suggestion");
    assert.match(res.content[0]!.text, /was NOT run \(no user consent while unattended\)/, "consent refusal is explicit");
    assert.match(res.content[0]!.text, /Left out/i);
    assert.ok(!(res.content[0]!.text.includes("proceeding with the recommended default, option 1")), "Accept is not adopted");
    const entry = g.autoDefaultLog?.at(-1);
    assert.match(entry?.chosen ?? "", /Continue without it/, "the log records the decline");
    assert.match(entry?.promotionDeclined ?? "", /\/goal tweak/, "the declined command stays recoverable");
    assert.ok(ledgerTypes(cwd).includes("decision_budget_auto_default"), "the auto-default is ledgered");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: run-to-done never auto-runs a suggested scope change", async () => {
  const cwd = tmpCwd();
  setSettings({});
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal", runToDone: true }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `suggestion-rtd-${Date.now()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  try {
    const res = await pi.runTool("pause_goal", {
      reason: "Blocked with a concrete fix available.",
      suggestedAction: 'Run /goal tweak "Restore the implementation objective."',
      kind: "blocked",
    }, ctx) as { content: Array<{ text: string }> };
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active", "run-to-done keeps running");
    assert.match(res.content[0]!.text, /Continue without it/);
    assert.match(res.content[0]!.text, /was NOT run/);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: a wait carrying a suggestion stays a wait — no question asked", async () => {
  const cwd = tmpCwd();
  setSettings({});
  const { pi, ctx } = await activeBoot(cwd);
  try {
    await pi.runTool("pause_goal", {
      reason: "Waiting for the window; a tweak could also apply.",
      suggestedAction: 'Run /goal tweak "Restore the implementation objective."',
      kind: "wait",
      resumeAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }, ctx);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.pauseKind, "wait", "explicit waits are never promoted");
    assert.equal(g.pauseOptions, undefined, "no decision card, no question");
    assert.equal(g.midRunDecisionCount ?? 0, 0, "no budget spent");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("pause_goal: an explicit user hold (/glla pause) survives a command-carrying pause unchanged", async () => {
  const cwd = tmpCwd();
  setSettings({});
  // Seed the supervisor freeze BEFORE boot so it is in durable + memory state:
  // /glla pause freezes automation around an untouched active goal, released
  // only by an explicit /glla resume — a pause must never clear it.
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, {
    goal: seedGoal({ status: "active", policy: "goal" }),
    supervisorPausedAt: Date.now(),
  } as Parameters<typeof seedState>[1]);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `suggestion-hold-${Date.now()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  try {
    await pi.runTool("pause_goal", {
      reason: "Scope repair is still blocked.",
      suggestedAction: 'Run /goal tweak "Restore the implementation objective."',
      kind: "blocked",
    }, ctx);
    const after = readState(cwd) as unknown as { supervisorPausedAt?: number; goal: GoalView };
    assert.equal(typeof after.supervisorPausedAt, "number", "only an explicit /glla resume clears the user hold — never a pause");
    assert.equal(after.goal.pauseKind, undefined, "agent suggestions cannot overwrite the existing supervisor hold");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
