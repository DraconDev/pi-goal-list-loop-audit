// pi-goal-list-loop-audit — v0.39.x
// tests/decision-auto-select.test.ts
//
// Operator request: "we want a feature to auto select recommended answer after
// a longer delay so we dont get stuck in case we are thrown an odd question".
//
// The contract this file pins:
//   1. OFF BY DEFAULT. With no `decisionAutoSelectMinutes` configured, a
//      decision pause waits forever — nothing is adopted, nothing is smoked
//      away by a stale timer.
//   2. The RECOMMENDED option is adopted after the configured delay, and the
//      adoption is observable: ledgered (`decision_auto_select_adopted`) and
//      recorded on the goal's `autoDefaultLog` (the recap's assumption source).
//   3. Only continue-work answers are adopted. A recommendation that cancels,
//      accepts-and-archives, tweaks the objective, pauses, clears a queue, or
//      amends the verification contract keeps waiting for the operator —
//      ledgered once as `decision_auto_select_refused`.
//   4. The clock runs from the PAUSE EPISODE (`pauseDecidedAt`), not from any
//      later state touch: a counter bump must not restart the fuse.
//   5. Both surfaces agree: the `/goal decide` picker carries the host
//      countdown, and the heartbeat backstop adopts a pause whose popup never
//      opened (headless, popup off, Escape, restart).
//   6. The manual supervisor pause (`/glla pause`) and the load hold freeze the
//      clock exactly as they freeze every other automatic dispatch.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import {
  __testOnlyHeartbeatTickRaw,
  __testOnlyResetDecisionAutoSelect,
  __testOnlyResetOverdueWaitBackstop,
  __testOnlyResetZombieRunWatchdog,
} from "../extensions/goal-heartbeat.js";
import { readState, type Goal, type State } from "../extensions/goal-loop-core.js";
import { buildWidgetLines, type DisplayTheme } from "../extensions/goal-loop-display.js";
import {
  DECISION_AUTO_SELECT_DEFAULT_MINUTES,
  classifyAutoSelectOption,
  decisionAutoSelectAdoptable,
  decisionAutoSelectCardLine,
  decisionAutoSelectCountdownMs,
  decisionAutoSelectDue,
  decisionAutoSelectRemainingMs,
  decisionOptionText,
  resolveDecisionAutoSelectMinutes,
  type AutoSelectGoalRecord,
} from "../extensions/decision-auto-select.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager-decision-auto-select" };

type GoalView = {
  status: string;
  pauseKind?: string;
  pauseOptions?: string[];
  pauseRecommended?: number;
  pauseDecidedAt?: string;
  autoDefaultLog?: Array<{ at: string; reason: string; chosen: string; options: string[] }>;
  pauseContractAmendment?: unknown;
};

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value?: Record<string, unknown> });
}

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false, ...extra }));
}

async function boot(cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetDecisionAutoSelect();
  __testOnlyResetOverdueWaitBackstop();
  __testOnlyResetZombieRunWatchdog();
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal" }), list: [], loop: null });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick();
  return ctx;
}

/** An already-parked decision pause with the given recommendation age. */
function seedParkedDecision(
  minutesAgo: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const decidedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return seedGoal({
    status: "paused",
    pauseKind: "decision",
    pauseReason: "two viable architectures — the user picks",
    pauseOptions: ["Fix the gap, then continue (/goal resume)", "Tweak the objective — /goal tweak <new text>", "Cancel the goal (/goal cancel)"],
    pauseRecommended: 1,
    pauseDecidedAt: decidedAt,
    updatedAt: decidedAt,
    ...overrides,
  });
}

afterEach(() => {
  setSettings({});
  __testOnlyResetDecisionAutoSelect();
  __testOnlyResetOverdueWaitBackstop();
  __testOnlyResetZombieRunWatchdog();
});

// ---------------------------------------------------------------------------
// The classifier — which recommendations may be adopted without a person
// ---------------------------------------------------------------------------

test("only continue-work recommendations are adoptable", () => {
  for (const label of [
    "Fix the disapproval gap, then continue (/goal resume)",
    "Resume the goal (/goal resume)",
    "Continue with the next queued item (/list next)",
    "Resume this list item (/list resume)",
    "Resume the loop (/loop resume)",
    // A prose option is what the picker steers to the agent before resuming.
    "Surgical Done when: clause",
    "Deliver the missing polish",
  ]) {
    assert.equal(classifyAutoSelectOption(label).adoptable, true, `adoptable: ${label}`);
  }
});

test("reserved answers are never adopted, whatever the agent recommends", () => {
  for (const label of [
    "Cancel the goal (/goal cancel)",
    "Accept with follow-ups — archive complete, route findings to /list (/goal accept)",
    'Tweak the objective — /goal tweak "do B instead"',
    "Pause the active goal (/goal pause)",
    "Clear the queue (/list clear)",
    "Drop this item (/list remove)",
    "Stop the loop (/loop stop)",
    "Finish the loop (/loop finish)",
    "Wipe glla state (/glla wipe)",
    "Pick a different auditor model in /glla settings, then /goal resume",
  ]) {
    const verdict = classifyAutoSelectOption(label);
    assert.equal(verdict.adoptable, false, `must stay parked: ${label}`);
    assert.ok(!verdict.adoptable && verdict.reason.length > 0, "a refusal explains itself");
  }
});

test("the picker's display suffix does not change the classification", () => {
  assert.equal(decisionOptionText("Resume (/goal resume)  (recommended)"), "Resume (/goal resume)");
  assert.equal(classifyAutoSelectOption("Resume (/goal resume)  (recommended)").adoptable, true);
  assert.equal(classifyAutoSelectOption("Cancel (/goal cancel)  (recommended)").adoptable, false);
  assert.deepEqual(classifyAutoSelectOption(""), { adoptable: false, reason: "the option text was empty" });
});

// ---------------------------------------------------------------------------
// The clock — off by default, armed per setting, measured from the episode
// ---------------------------------------------------------------------------

test("the delay is unset by default and rejects junk values", () => {
  assert.equal(resolveDecisionAutoSelectMinutes(undefined), undefined, "unset = never");
  assert.equal(resolveDecisionAutoSelectMinutes(0), undefined, "0 minutes would answer before anyone could read it");
  assert.equal(resolveDecisionAutoSelectMinutes(-5), undefined);
  assert.equal(resolveDecisionAutoSelectMinutes(1.5), undefined);
  assert.equal(resolveDecisionAutoSelectMinutes("10"), undefined);
  assert.equal(resolveDecisionAutoSelectMinutes(DECISION_AUTO_SELECT_DEFAULT_MINUTES + 1), 11);
  assert.equal(resolveDecisionAutoSelectMinutes(DECISION_AUTO_SELECT_DEFAULT_MINUTES), 10);
});

test("the clock is off unless configured — a parked decision resumes nothing", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({}); // no decisionAutoSelectMinutes
    __testOnlyResetOwnerSession();
    seedState(cwd, { goal: seedParkedDecision(120), list: [], loop: null });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();
    __testOnlyHeartbeatTickRaw();
    await tick();
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "unset = the pause waits for the operator forever");
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_due").length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the fuse measures from pauseDecidedAt, and a later touch does not restart it", () => {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const goal = {
    status: "paused",
    pauseKind: "decision",
    pauseOptions: ["Continue (/goal resume)"],
    pauseRecommended: 1,
    pauseDecidedAt: since,
    updatedAt: new Date().toISOString(), // a later touch
  } as AutoSelectGoalRecord;
  assert.equal(decisionAutoSelectDue(goal, 10, Date.now()), true, "30m > 10m from the episode start");
  assert.equal(decisionAutoSelectDue(goal, 60, Date.now()), false, "60m fuse still has 30m to run");
  const remaining = decisionAutoSelectRemainingMs(goal, 60, Date.now());
  assert.ok(remaining !== undefined && remaining > 29 * 60_000, `remaining uses the episode stamp: ${remaining}`);
  assert.equal(decisionAutoSelectCountdownMs(goal, 10, Date.now()), 5_000, "a due decision keeps a short readable countdown");
});

test("an ineligible recommendation has no clock at all", () => {
  const goal = {
    status: "paused",
    pauseKind: "decision",
    pauseOptions: ["Cancel the goal (/goal cancel)"],
    pauseRecommended: 1,
    pauseDecidedAt: new Date(Date.now() - 600 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  } as AutoSelectGoalRecord;
  assert.equal(decisionAutoSelectAdoptable(goal, 10, Date.now()), false, "cancel is never auto-adopted");
  assert.equal(decisionAutoSelectDue(goal, 10, Date.now()), true, "but the operator's clock still expired — that is reported once");
  assert.equal(decisionAutoSelectCardLine(goal, 10, Date.now()), undefined, "and the card makes no promise");
  const continueGoal = { ...goal, pauseOptions: ["Continue (/goal resume)"], pauseRecommended: 1 };
  assert.equal(
    decisionAutoSelectCardLine(continueGoal, 10, Date.now()),
    "auto-answers with option 1 now unless you decide first",
  );
});

test("a contract amendment never gets a clock, even with a plain command inside", () => {
  const amendment = {
    baseContract: "1. run npm test",
    baseRevision: 0,
    amendment: { itemNumber: 1, command: "npm run test:unit", proposedContract: "1. run npm run test:unit", kind: "safe", changeKind: "substantive-amendment", originalItem: "1. run npm test", proposedItem: "1. run npm run test:unit" },
  };
  const goal = {
    status: "paused",
    pauseKind: "decision",
    pauseOptions: ["Accept — apply the amendment (/goal resume)"],
    pauseRecommended: 1,
    pauseContractAmendment: amendment,
    pauseDecidedAt: new Date(Date.now() - 600 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  } as AutoSelectGoalRecord;
  assert.equal(decisionAutoSelectAdoptable(goal, 5, Date.now()), false, "criteria changes need a person");
  assert.equal(decisionAutoSelectCardLine(goal, 5, Date.now()), undefined, "and the card promises nothing");
});

// ---------------------------------------------------------------------------
// The surfaces — picker countdown + heartbeat backstop
// ---------------------------------------------------------------------------

test("the /goal decide picker carries the host countdown when the clock is armed", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({ decisionAutoSelectMinutes: 30 });
    __testOnlyResetOwnerSession();
    seedState(cwd, {
      goal: seedGoal({
        status: "paused",
        pauseKind: "decision",
        pauseReason: "which architecture",
        pauseOptions: ["Continue (/goal resume)", "Cancel the goal (/goal cancel)"],
        pauseRecommended: 1,
      }),
      list: [],
      loop: null,
    });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();
    const ui = (ctx as unknown as { ui: { selectImpl?: unknown } }).ui;
    let seen: { timeout?: number } | undefined;
    (ui as { selectImpl?: (t: string, o: string[], opts?: { timeout?: number }) => Promise<string | undefined> }).selectImpl = (t, o, opts) => {
      seen = opts;
      return Promise.resolve(o[1]); // pick "Cancel" as the operator would
    };
    const decidedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    // Rewrite the newest state snapshot so the loaded goal carries the stamp
    // the clock measures from.
    const ledgerFile = path.join(cwd, ".pi-glla", "active.jsonl");
    const lines = fs.readFileSync(ledgerFile, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]!) as { type?: string; value?: { goal?: Record<string, unknown> } };
      if (entry.type !== "state" || !entry.value?.goal) continue;
      entry.value.goal.pauseDecidedAt = decidedAt;
      entry.value.goal.updatedAt = decidedAt;
      lines[i] = JSON.stringify(entry);
      break;
    }
    fs.writeFileSync(ledgerFile, lines.join("\n") + "\n");
    const reloaded = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, reloaded);
    await tick();
    (reloaded as unknown as { ui: { selectImpl?: unknown } }).ui.selectImpl = (ui as { selectImpl?: unknown }).selectImpl;
    await pi.command("goal", "decide", reloaded);
    await tick();
    assert.ok(seen?.timeout, "the picker received a countdown");
    assert.ok((seen!.timeout as number) <= 20 * 60_000 && (seen!.timeout as number) > 19 * 60_000,
      `~20m left of the 30m fuse: ${seen!.timeout}`);
    const g = readState(cwd).goal as GoalView;
    assert.ok(!g || g.status === "aborted", "the operator's own Cancel pick still runs");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an Escape BEFORE the deadline leaves the pause alone (no adoption)", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({ decisionAutoSelectMinutes: 30 });
    __testOnlyResetOwnerSession();
    seedState(cwd, { goal: seedParkedDecision(1), list: [], loop: null });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();
    await pi.command("goal", "decide", ctx); // mock select → undefined = Escape
    await tick();
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "a deliberate Escape is not consent to adopt");
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_adopted").length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the heartbeat adopts the recommended continue-work option when nobody answered", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({ decisionAutoSelectMinutes: 10 });
    __testOnlyResetOwnerSession();
    seedState(cwd, { goal: seedParkedDecision(25), list: [], loop: null });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();

    __testOnlyHeartbeatTickRaw();
    await tick(50);

    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active", "the recommended continue-work answer resumed the goal");
    assert.equal(g.pauseKind, undefined, "the pause fields cleared exactly as a pick would clear them");
    const adopted = ledger(cwd).filter((e) => e.type === "decision_auto_select_adopted");
    assert.equal(adopted.length, 1, "the assumption is durable, not implied");
    assert.equal(adopted[0]!.value?.shape, "command");
    assert.match(String(adopted[0]!.value?.chosen), /continue/i);
    // The recap's assumption source survives the resume (autoDefaultLog is
    // goal state, not pause state).
    const after = readState(cwd).goal as GoalView;
    assert.ok(after.autoDefaultLog && after.autoDefaultLog.length === 1, "the adoption is on the assumption log");
    assert.match(after.autoDefaultLog![0]!.chosen, /continue/i);
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_due").length, 1, "one clock fire");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a reserved recommendation stays parked and is refused once, not every tick", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({ decisionAutoSelectMinutes: 10 });
    __testOnlyResetOwnerSession();
    seedState(cwd, {
      goal: seedParkedDecision(25, {
        pauseOptions: ["Accept with follow-ups (/goal accept)", "Cancel the goal (/goal cancel)"],
        pauseRecommended: 1,
      }),
      list: [],
      loop: null,
    });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();

    __testOnlyHeartbeatTickRaw();
    await tick(50);
    __testOnlyHeartbeatTickRaw();
    await tick(50);

    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "accept-and-archive must never happen without a person");
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_adopted").length, 0);
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_refused").length, 1, "said once per episode");
    assert.ok(ledger(cwd).some((e) => e.type === "decision_auto_select_refused" && /ends, rewrites, or parks/.test(String(e.value?.reason))),
      "the refusal names the real reason instead of a generic message");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the manual supervisor pause freezes the clock", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({ decisionAutoSelectMinutes: 10 });
    __testOnlyResetOwnerSession();
    seedState(cwd, { goal: seedParkedDecision(25), list: [], loop: null });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();
    // /glla pause: the user asked for a hands-off window.
    const { state } = await import("../extensions/goal-state.js");
    state.supervisorPausedAt = Date.now();

    __testOnlyHeartbeatTickRaw();
    await tick(50);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "a hands-off window is not an absence to fill");
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_adopted").length, 0);
    state.supervisorPausedAt = undefined;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the card states the clock plainly, as the decision block's closer", () => {
  const goal = {
    id: "g",
    objective: "objective",
    status: "paused",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 1_000, tokensLimit: 0 },
    createdAt: "2026-11-18T11:00:00Z",
    updatedAt: "2026-11-18T11:59:00Z",
    pauseKind: "decision",
    pauseReason: "pick one",
    pauseSuggestedAction: "Pick one.",
    pauseOptions: ["Continue (/goal resume)", "Cancel the goal (/goal cancel)"],
    pauseRecommended: 1,
    pauseDecidedAt: "2026-11-18T11:50:00Z",
  } as unknown as Goal;
  const state = { goal, list: [] } as State;
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as DisplayTheme;
  const NOW = Date.parse("2026-11-18T12:00:00Z");
  const line = decisionAutoSelectCardLine(goal, 10, NOW);
  assert.ok(line, "the clock is armed and adoptable");
  const armed = buildWidgetLines(state, null, NOW, theme, 100, { decisionAutoSelectLine: line })!;
  assert.match(armed.at(-1)!, /^└─ /, "the promise closes the decision block");
  assert.match(armed.at(-1)!, /auto-answers with option 1/, "it names WHICH recommended option answers");
  // Without the line (clock off, or a recommendation that may not be adopted)
  // the card promises nothing.
  const unarmed = buildWidgetLines(state, null, NOW, theme, 100, {})!;
  assert.doesNotMatch(unarmed.join("\n"), /auto-answers/, "no clock, no promise");
  assert.match(unarmed.at(-1)!, /^└─ /, "the options still close the block");
});

test("a delivery failure stays parked and is ledgered instead of retried forever", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({ decisionAutoSelectMinutes: 10 });
    __testOnlyResetOwnerSession();
    // A prose recommendation: the picker delivers it to the agent and then
    // resumes, which is exactly the path a dead send surface breaks.
    seedState(cwd, {
      goal: seedParkedDecision(25, { pauseOptions: ["Surgical Done when: clause", "Cancel the goal (/goal cancel)"], pauseRecommended: 1 }),
      list: [],
      loop: null,
    });
    const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();
    // A stale send surface: safeSteerUser refuses and cannot resume.
    pi.sendMessageError = new Error("This extension's context is stale after session replacement or reload");
    __testOnlyHeartbeatTickRaw();
    await tick(50);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "the work is still parked — nothing was pretended");
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_adopted").length, 0);
    assert.equal(ledger(cwd).filter((e) => e.type === "decision_auto_select_delivery_failed").length, 1,
      "the failed delivery is named, not hidden");
  } finally {
    pi.sendMessageError = null;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the pause write stamps pauseDecidedAt so the clock has an episode start", async () => {
  const cwd = tmpCwd();
  try {
    setSettings({});
    const ctx = await boot(cwd);
    await pi.runTool("pause_goal", {
      reason: "which architecture",
      kind: "decision",
      options: ["Continue (/goal resume)", "Cancel the goal (/goal cancel)"],
      recommended: 1,
      interruption: { reason: "missing-input", evidence: "The two architectures are both viable; choosing one is the user's missing input" },
    }, ctx);
    await tick();
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused");
    assert.equal(g.pauseKind, "decision");
    assert.ok(g.pauseDecidedAt, "the episode start is durable");
    assert.ok(Math.abs(Date.now() - Date.parse(g.pauseDecidedAt!)) < 60_000, "stamped now, not invented");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
