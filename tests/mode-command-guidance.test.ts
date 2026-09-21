// pi-goal-list-loop-audit — v0.34.51
// tests/mode-command-guidance.test.ts
//
// Pins the "centralize mode-aware pause, tweak, and resume commands" goal
// (20260805064515-ha8se5): generated auditor, stall, continuation, and pause
// guidance must render `/goal ...` for standalone goals and `/list ...` for
// list items — with regression tests at three levels:
//   1. source pins — no hardcoded `/goal <cmd>` literals left in generated
//      guidance strings (goal.ts), mode-aware widget strings (display.ts);
//   2. behavioral — `/list pause` on a list-policy item notifies with
//      "/list resume to continue" while `/goal pause` says "/goal resume";
//   3. widget — the wait countdown and no-verdict fallback render the
//      mode-correct resume command.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession(); // release the shared owner claim so later/parallel files are unaffected
});

const GOAL_SRC = readGoalRuntimeSource();
const LOOP_SRC = fs.readFileSync("extensions/goal-loop.ts", "utf-8");
const GUIDANCE_SRC = `${GOAL_SRC}\n${LOOP_SRC}`;
const RECOVERY_SRC = fs.readFileSync("extensions/goal-recovery.ts", "utf-8"); // decomposition step 3 (v0.34.111)
const DISPLAY_SRC = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
const CORE_SRC = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession(); // behavioral-orchestrator's owner claim precedes this file (shared process)
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

const NOW = Date.parse("2026-07-21T12:00:00Z");
function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260721120000-abcdef",
    objective: "Create x.txt containing ok",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-07-21T11:57:00Z",
    updatedAt: "2026-07-21T11:57:00Z",
    ...overrides,
  };
}

// ---- level 1: source pins ----

test("mode-aware helpers exist and route by policy", () => {
  assert.match(CORE_SRC, /export function workCommandRoot\(mode: Policy \| "loop" \| undefined\)/);
  assert.match(CORE_SRC, /export function workCommand\(/);
  assert.match(GOAL_SRC, /const activeGoalSurfaceCommand = \(command: string\): string => workCommand\(state\.goal\?\.policy, command\);/);
  assert.match(GOAL_SRC, /const activeGoalStatusCommand = \(\): string => state\.goal\?\.policy === "list" \? `\$\{activeGoalRoot\(\)\} show` : `\$\{activeGoalRoot\(\)\} status`;/);
});

test("no hardcoded /goal <cmd> literals remain in generated guidance (goal.ts)", () => {
  // Generated guidance = strings attached to notifications, pause actions,
  // tool texts, and status lines. Routing literals (command parsing,
  // mode-aware ternaries, ledger `via:` values) are intentionally excluded.
  // Allowed: deliberate SURFACE MAPS that enumerate every surface's real
  // commands (tool vocabulary descriptions, the /glla status deep map) —
  // these are cross-surface references, not active-surface guidance.
  // v0.38.85: timeline joined the /goal subcommand enumeration.
  const SURFACE_MAP = [/deep: \/goal status/, /\/list remove N/, /status\|timeline\|pause\|resume\|cancel\|tweak/, /\/goal resume, \/list resume, or \/loop resume/];
  // v0.34.108: the scan used to skip lines without a guidance trigger token
  // (pauseSuggestedAction / notify( / lines.push / text: / description:),
  // so a literal parked on a `const resumeCmd = ...` assignment line escaped
  // the pin (the 2026-08-08 audit's top finding). Assignment lines that feed
  // a later guidance string are guidance too — scan them as well.
  const hard: string[] = [];
  for (const [i, raw] of GOAL_SRC.split("\n").entries()) {
    const s = raw.trim();
    if (s.startsWith("//") || s.startsWith("*")) continue;
    if (!/(pauseSuggestedAction|notify\(|lines\.push|text:|description:)/.test(raw)
        && !/^\s*(const|let) \w+ = .*["`]\/(goal|list|loop) /.test(raw)) continue;
    if (/["`][^"`]*\/goal (pause|resume|tweak|cancel|decide|status)/.test(raw)) {
      if (SURFACE_MAP.some((re) => re.test(raw))) continue;
      hard.push(`${i + 1}: ${s.slice(0, 120)}`);
    }
  }
  assert.deepEqual(hard, [], "hardcoded /goal guidance literals");
  // The helper is actually used across all four command kinds.
  for (const cmd of ["pause", "resume", "tweak", "cancel", "decide"]) {
    assert.ok(GUIDANCE_SRC.includes(`activeGoalSurfaceCommand("${cmd}")`), `${cmd} guidance is interpolated`);
  }
  assert.ok(fs.readFileSync("extensions/goal-commands.ts", "utf-8").includes("const noun = goalNoun()"), "abort guidance captures the policy before closing the slot");
  assert.ok(GOAL_SRC.includes("activeGoalStatusCommand()"), "status guidance is interpolated");
});

test("loop-policy recovery guidance interpolates recoverySurfaceCommand (v0.34.108)", () => {
  // v0.34.108: the main-model-recovery paths park a METRIC LOOP too — a loop
  // resumed through "/goal resume" would be wrong. The helper keys off the
  // loop kind explicitly; no hardcoded /loop resume literal may appear on
  // const-assignment lines (the audit's const-line blind spot) — loop-only
  // contexts (no mode ambiguity) may keep their literals.
  assert.match(GOAL_SRC, /const recoverySurfaceCommand = \(kind: "goal" \| "loop", command: string\): string =>/);
  // decomposition step 3 (v0.34.111): two of the recovery paths moved to
  // goal-recovery.ts — count uses across both files.
  const uses = (GOAL_SRC.match(/recoverySurfaceCommand\([^)]*\)/g) ?? []).length
    + (RECOVERY_SRC.match(/recoverySurfaceCommand\([^)]*\)/g) ?? []).length;
  assert.ok(uses >= 4, `expected >=4 recoverySurfaceCommand uses, got ${uses}`);
  const hard: string[] = [];
  for (const [i, raw] of GOAL_SRC.split("\n").entries()) {
    const s = raw.trim();
    if (s.startsWith("//") || s.startsWith("*")) continue;
    if (!/^const .* = .*["`]\/loop resume/.test(raw)) continue;
    if (/\/goal resume, \/list resume, or \/loop resume/.test(raw)) continue; // cross-surface enumeration
    hard.push(`${i + 1}: ${s.slice(0, 120)}`);
  }
  assert.deepEqual(hard, [], "hardcoded /loop resume literals on const lines in goal.ts");
});

test("widget resume hints are mode-aware ternaries (display.ts)", () => {
  const ternaries = DISPLAY_SRC.match(/isList \? "\/list resume" : "\/goal resume"/g) ?? [];
  // v0.34.64: the wait-countdown ternary was removed (the auto-retrying line
  // owns the wait now, no manual nudge); interrupted-card hint + no-verdict
  // fallback remain.
  assert.ok(ternaries.length >= 2, `expected >=2 mode-aware resume ternaries, got ${ternaries.length}`);
});

// ---- level 2: behavioral (pause guidance) ----

test("goal-policy pause notifies with /goal resume", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  // v0.35.23: opt into load-time automation so the boot emits no load-hold
  // card — this test pins PAUSE guidance, not load behavior.
  fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({ autoResume: true }));
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active" }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  await pi.command("goal", "pause", ctx);
  assert.ok(ctx.ui.matching("/goal resume to continue").length >= 1, "goal pause says /goal resume");
  assert.equal(ctx.ui.matching("/list resume").length, 0, "goal pause must not say /list resume");
});

test("list-policy pause notifies with /list resume", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({ autoResume: true }));
  seedState(cwd, {
    goal: seedGoal({ policy: "list", status: "active", objective: "list item one — done when pinned" }),
    list: [{ id: "w1", objective: "waiting item", addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  await pi.command("list", "pause", ctx);
  assert.ok(ctx.ui.matching("/list resume to continue").length >= 1, "list pause says /list resume");
  assert.equal(ctx.ui.matching("/goal resume").length, 0, "list pause must not say /goal resume");
});

// ---- level 3: widget rendering ----

test("widget wait countdown is uniform auto-retrying (no manual resume hint — v0.34.64)", () => {
  // v0.34.64: the wait card no longer nudges "or /goal resume now" — the
  // auto-retrying line owns the wait (autoResume:true honors "keep going";
  // the recovery-cleared path un-parks when the condition resolves). Both
  // goal and list cards show the same uniform countdown.
  const base = {
    status: "paused" as const,
    pauseReason: "waiting for provider window",
    pauseKind: "wait" as const,
    pauseResumeAt: new Date(NOW + 60_000).toISOString(),
    recoveryEpisodeKey: "test:supervised-countdown",
    autoResume: true,
  };
  const goalCard = buildWidgetLines({ goal: goalOf(base) }, null, NOW)!;
  assert.ok(goalCard.some((l) => l.includes("auto-retrying") && l.includes("next probe in")), `goal card: ${goalCard.join("\n")}`);
  assert.ok(!goalCard.some((l) => l.includes("resume now")), "no manual resume nudge on the wait card");
  const listCard = buildWidgetLines({ goal: goalOf({ ...base, policy: "list" }) }, null, NOW)!;
  assert.ok(listCard.some((l) => l.includes("auto-retrying") && l.includes("next probe in")), `list card: ${listCard.join("\n")}`);
  assert.ok(!listCard.some((l) => l.includes("/goal resume now")), "list card must not say /goal resume now");
});

test("widget no-verdict fallback action is mode-aware", () => {
  const base = {
    status: "paused" as const,
    pauseReason: "completion audit blocked — no verdict",
    pauseSuggestedAction: undefined,
    pauseKind: "blocked" as const,
    pendingCompletion: {
      completionSummary: "claim",
      at: new Date(NOW - 5_000).toISOString(),
      phase: "recovery-pending" as const,
    },
  };
  const goalCard = buildWidgetLines({ goal: goalOf(base) }, null, NOW)!;
  assert.ok(goalCard.some((l) => l.includes("/goal resume starts exactly one fresh auditor")), `goal fallback: ${goalCard.join("\n")}`);
  const listCard = buildWidgetLines({ goal: goalOf({ ...base, policy: "list" }) }, null, NOW)!;
  assert.ok(listCard.some((l) => l.includes("/list resume starts exactly one fresh auditor")), `list fallback: ${listCard.join("\n")}`);
  assert.ok(!listCard.some((l) => l.includes("/goal resume starts exactly one fresh auditor")), "list fallback must not say /goal resume");
});
