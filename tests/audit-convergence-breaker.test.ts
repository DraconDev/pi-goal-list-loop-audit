// pi-goal-list-loop-audit — v0.38.103 audit-treadmill convergence.
// tests/audit-convergence-breaker.test.ts
//
// A streak of disapprovals that raises a FRESH objection every round is the
// audit treadmill, not convergence: each round burns evidence runs that
// deepen host load, which manufactures the next round's flakes. Pins:
// (1) the hard cap pauses even under aggressive keep-going; (2) cap pauses
// offer accept-with-followups first; (3) required-fix severity tags parse
// strictly; (4) the brief mandates the tags.

import { test, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState, AUDIT_CAP_HARD_DEFAULT, extractRequiredFixSeverities } from "../extensions/goal-loop-core.js";
import { normalizeLoadedSettings, THINKING_LEVELS } from "../extensions/goal-settings.js";
import { buildSettingsRows } from "../extensions/settings-menu.js";
import { buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, ...extra }));
}

function ledgerEntries(cwd: string): Array<{ type: string; value?: any }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value?: any });
}

function ledgerTypes(cwd: string): string[] {
  return ledgerEntries(cwd).map((e) => e.type);
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
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `convergence-breaker-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function shutdown(pi: MockPi, ctx: MockCtx): Promise<void> {
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
}

function writeFakeAuditor(cwd: string, report: string): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node\nlet input = "";\nlet handled = false;\nprocess.stdin.on("data", async (chunk) => {\n  input += chunk;\n  if (handled || !input.includes("\\n")) return;\n  handled = true;\n  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");\n  const report = ${JSON.stringify(report)};\n  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });\n  emit({ type: "tool_execution_end", toolCallId: "fake-read" });\n  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });\n  emit({ type: "agent_settled" });\n});\n`);
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

type GoalView = {
  status?: string;
  pauseReason?: string;
  pauseKind?: string;
  pauseOptions?: string[];
  pauseRecommended?: number;
  pendingCompletion?: unknown;
  auditHistory?: unknown[];
};

const R1 = "First look.\n## Required fixes\n1. [HIGH] Fix the tombstone guard so a tab never treats its own delete as foreign\n<disapproved/>";
const R2 = "Second look.\n## Required fixes\n1. [LOW] Reattach the doc comment to the item it describes\n<disapproved/>";

async function driveTwoDisapprovals(cwd: string): Promise<void> {
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R1);
  const { pi, ctx } = await boot(cwd, { goal: seedGoal({ status: "active", policy: "goal" }) });
  try {
    await pi.runTool("complete_goal", { completionSummary: "Round one claim.", verificationSummary: "e1." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as GoalView | null;
      return !!goal && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
    });
    if ((readState(cwd).goal as GoalView | null)?.status === "paused") return;
    process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R2);
    await pi.runTool("complete_goal", { completionSummary: "Round two claim.", verificationSummary: "e2." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as GoalView | null;
      return !!goal && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 2;
    });
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await shutdown(pi, ctx);
  }
}

describe("audit-convergence-breaker — hard cap", () => {
  // autoResume:true releases the seeded goal after cold session_start
  // (run-to-done.test.ts: the OLD consent) — without it the goal holds and
  // complete_goal never reaches the auditor.
  test("hard cap pauses even under aggressive keep-going", async () => {
    setSettings({ aggressiveMode: true, auditCapHard: 2, autoResume: true });
    const cwd = tmpCwd();
    await driveTwoDisapprovals(cwd);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused", "hard cap binds aggressive mode");
    assert.match(g.pauseReason ?? "", /hard cap 2/);
    assert.equal(g.pauseKind, "decision");
    assert.ok((g.pauseOptions ?? [])[0]?.includes("Accept with follow-ups"), `options=${JSON.stringify(g.pauseOptions)}`);
    assert.equal(g.pauseRecommended, 1);
    assert.ok(ledgerTypes(cwd).includes("goal_paused"), "hard-cap park is ledgered");
    assert.ok(!ledgerTypes(cwd).includes("audit_cap_keep_going"), "no TODO conversion at the hard cap");
  });

  test("below the hard cap, aggressive keep-going is preserved", async () => {
    setSettings({ aggressiveMode: true, auditCap: 2, auditCapHard: 5, autoResume: true });
    const cwd = tmpCwd();
    await driveTwoDisapprovals(cwd);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "active", "soft cap still converts to TODOs under aggressive");
    assert.ok(ledgerTypes(cwd).includes("audit_cap_keep_going"), "soft-cap conversion untouched");
  });

  // v0.38.107: the field never settles inline — real audits land minutes or
  // hours after complete_goal returned AUDIT PENDING, through the detached
  // retry driver. The v0.38.103 ceiling was wired only into the inline path,
  // so aggressive mode ground forever (hellhunter 12, junk-runner 9). This
  // drives the detached path: a parked claim with 7 comparable priors,
  // re-fired via resume_goal, must pause at the 8th disapproval.
  test("hard cap binds the detached settlement path", async () => {
    setSettings({ aggressiveMode: true, auditCap: 2, auditCapHard: 8, autoResume: true });
    const cwd = tmpCwd();
    const grader = "anthropic/mock-model"; // MockPi session model ref
    const objections = [
      "Rebuild the tombstone index before the next sweep",
      "Bound the ledger read to the last segment",
      "Rename the ambiguous gate flag",
      "Pin the retry budget in the contract",
      "Split the oversized render helper",
      "Document the fallback chain order",
      "Cap the evidence excerpt length",
    ];
    const priors = objections.map((fix, i) => ({
      at: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
      approved: false,
      disapproved: true,
      model: grader,
      revision: 0,
      regressionShieldPassed: true,
      durationMs: 5_000,
      report: `Round ${i + 1}.\n## Required fixes\n1. [MED] ${fix}\n<disapproved/>`,
    }));
    seedState(cwd, {
      goal: seedGoal({
        status: "paused",
        policy: "goal",
        objective: "detached treadmill goal",
        completionSummary: "Outcome: shipped. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
        auditHistory: priors,
        pendingCompletion: {
          at: new Date().toISOString(),
          phase: "recovery-pending",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          attemptId: "detached-cap-attempt",
          completionSummary: "Outcome: shipped. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
          verificationSummary: "e1.",
        },
        pauseKind: "blocked",
        pauseReason: "seeded parked claim with seven priors",
      }),
    });
    const previousBinary = process.env.GLLA_PI_BINARY;
    process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "Eighth look.\n## Required fixes\n1. [HIGH] Quarantine the flaky gate before release\n<disapproved/>");
    const { pi, ctx } = await boot(cwd);
    try {
      await pi.runTool("resume_goal", { reason: "retry the stored claim" }, ctx);
      await waitUntil(() => {
        const goal = readState(cwd).goal as GoalView | null;
        return !!goal && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 8;
      });
      const g = readState(cwd).goal as GoalView;
      const models = (g.auditHistory ?? []).map((e: any) => e.model);
      assert.equal(g.status, "paused", `detached 8th disapproval pauses; models=${JSON.stringify(models)}`);
      assert.match(g.pauseReason ?? "", /hard cap 8/);
      assert.equal(g.pauseKind, "decision");
      assert.ok((g.pauseOptions ?? [])[0]?.includes("Accept with follow-ups"), `options=${JSON.stringify(g.pauseOptions)}`);
      assert.equal(g.pauseRecommended, 1);
      assert.ok(ledgerTypes(cwd).includes("goal_paused"), "detached hard-cap park is ledgered");
      assert.ok(!ledgerTypes(cwd).includes("audit_cap_keep_going"), "no TODO conversion at the hard cap");
    } finally {
      if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
      else process.env.GLLA_PI_BINARY = previousBinary;
      await shutdown(pi, ctx);
    }
  });

  test("soft-cap pause offers accept-with-followups first", async () => {
    setSettings({ aggressiveMode: false, auditCap: 2, autoResume: true });
    const cwd = tmpCwd();
    await driveTwoDisapprovals(cwd);
    const g = readState(cwd).goal as GoalView;
    assert.equal(g.status, "paused");
    assert.ok((g.pauseOptions ?? [])[0]?.includes("(/goal accept)"), `options=${JSON.stringify(g.pauseOptions)}`);
    assert.equal(g.pauseRecommended, 1);
  });

  test("severity census lands on the objections ledger event", async () => {
    setSettings({ aggressiveMode: false, auditCap: 10, autoResume: true });
    const cwd = tmpCwd();
    await driveTwoDisapprovals(cwd);
    const todos = ledgerEntries(cwd).filter((e) => e.type === "audit_objections_todo");
    assert.ok(todos.length >= 2, "one todo event per disapproval");
    assert.deepEqual(todos[0]!.value.severityCounts, { high: 1, med: 0, low: 0, untagged: 0 });
    assert.deepEqual(todos[1]!.value.severityCounts, { high: 0, med: 0, low: 1, untagged: 0 });
  });
});

describe("audit-convergence-breaker — severity extraction", () => {
  test("tags parse per item; missing section yields nothing", () => {
    const fixes = extractRequiredFixSeverities(
      "Report.\n## Required fixes\n1. [HIGH] Fix the guard\n- [MED] Bound the read\n3. [LOW] Move the comment\n<disapproved/>",
    );
    assert.deepEqual(fixes.map((f) => f.severity), ["HIGH", "MED", "LOW"]);
    assert.deepEqual(extractRequiredFixSeverities("no fixes section\n<approved/>"), []);
  });

  test("only leading tags count; buried tags and bare items are untagged", () => {
    const fixes = extractRequiredFixSeverities(
      "## Required fixes\n1. Fix the [LOW] thing honestly\n2. No tag at all here\n3. [HIGH] Real tag\n## Outside Scope\n1. [LOW] Out of section\n",
    );
    assert.deepEqual(fixes.map((f) => f.severity), [null, null, "HIGH"]);
  });

  test("auditor brief mandates severity tags", () => {
    const goal = seedGoal({ objective: "fix bug", verificationContract: "one" });
    const prompt = buildGoalAuditorPrompt(goal as any, "claim", "verify");
    assert.match(prompt, /\[HIGH\].*\[MED\].*\[LOW\]/s);
    assert.match(prompt, /Severity honesty/);
  });
});

describe("audit-convergence-breaker — settings", () => {
  test("hard-cap default is 8 (soft 5 + three grace rounds)", () => {
    assert.equal(AUDIT_CAP_HARD_DEFAULT, 8);
  });

  test("normalize keeps valid values, drops garbage", () => {
    assert.equal(normalizeLoadedSettings({ auditCapHard: 3 } as any).auditCapHard, 3);
    assert.equal(normalizeLoadedSettings({ auditCapHard: -1 } as any).auditCapHard, undefined);
    assert.equal(normalizeLoadedSettings({ auditCapHard: 1.5 } as any).auditCapHard, undefined);
    assert.equal(normalizeLoadedSettings({ mechanicalLoadScale: false } as any).mechanicalLoadScale, false);
    assert.equal(normalizeLoadedSettings({ mechanicalLoadScale: "yes" } as any).mechanicalLoadScale, undefined);
    assert.equal(normalizeLoadedSettings({} as any).mechanicalLoadScale, undefined, "unset = default-on via !== false");
  });

  test("v0.38.105: mainModelRetryMinutes and auditFeedbackChars drop junk instead of displaying a dead value", () => {
    // Both are SETTINGS_KEYS members, so provenance, the menu and the headless
    // /glla row render whatever the file carries — while the RUNTIME guard
    // (Number.isFinite(base) && base > 0 / Number.isInteger && >= 0) silently
    // substituted its default. A quoted "30" is the likeliest hand-edit.
    assert.equal(normalizeLoadedSettings({ mainModelRetryMinutes: 30 } as any).mainModelRetryMinutes, 30);
    for (const junk of ["30", 0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      assert.equal(
        normalizeLoadedSettings({ mainModelRetryMinutes: junk } as any).mainModelRetryMinutes,
        undefined,
        `mainModelRetryMinutes must drop ${JSON.stringify(junk)}`,
      );
    }
    assert.equal(normalizeLoadedSettings({ auditFeedbackChars: 0 } as any).auditFeedbackChars, 0, "0 is the legal 'no tail' value");
    assert.equal(normalizeLoadedSettings({ auditFeedbackChars: 4000 } as any).auditFeedbackChars, 4000);
    for (const junk of ["2000", -1, 1.5, Number.NaN, null, []]) {
      assert.equal(
        normalizeLoadedSettings({ auditFeedbackChars: junk } as any).auditFeedbackChars,
        undefined,
        `auditFeedbackChars must drop ${JSON.stringify(junk)}`,
      );
    }
  });

  test("v0.38.105: drafter/auditor thinking levels are pruned against the one ladder", () => {
    for (const level of THINKING_LEVELS) {
      assert.equal(normalizeLoadedSettings({ drafterThinkingLevel: level } as any).drafterThinkingLevel, level);
      assert.equal(normalizeLoadedSettings({ auditorThinkingLevel: level } as any).auditorThinkingLevel, level);
    }
    for (const junk of ["turbo", "OFF", "", 3, null, {}]) {
      assert.equal(
        normalizeLoadedSettings({ drafterThinkingLevel: junk } as any).drafterThinkingLevel,
        undefined,
        `drafterThinkingLevel must drop ${JSON.stringify(junk)}`,
      );
      assert.equal(
        normalizeLoadedSettings({ auditorThinkingLevel: junk } as any).auditorThinkingLevel,
        undefined,
        `auditorThinkingLevel must drop ${JSON.stringify(junk)}`,
      );
    }
    // The per-agent override map keeps using the same ladder.
    assert.equal(
      (normalizeLoadedSettings({ subagentThinkingOverrides: { Explore: "turbo", Plan: "high" } } as any).subagentThinkingOverrides as any).Explore,
      undefined,
    );
  });

  test("menu rows exist for both keys", () => {
    const rows = buildSettingsRows({} as any, {});
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("auditCapHard"), "hard-cap row present");
    assert.ok(ids.includes("mechanicalLoadScale"), "load-scale row present");
  });
});
