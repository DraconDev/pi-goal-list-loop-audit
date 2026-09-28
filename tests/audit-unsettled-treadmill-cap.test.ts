// pi-goal-list-loop-audit — v0.38.110 audit-treadmill convergence, part 2.
// tests/audit-unsettled-treadmill-cap.test.ts
//
// The v0.38.107 hard cap counts `disapproved` rounds only. Two branches
// re-activate the goal without disapproving it, so they sat outside the cap
// entirely and could cycle forever:
//
//   1. the regression shield (auditor approved, evidence contract unmet) —
//      its history row is `approved: true, disapproved: false`;
//   2. an aggressive IMPOSSIBLE(partial) verdict — `impossible: true,
//      disapproved: false`.
//
// Both are the same shape as the hellhunter treadmill v0.38.107 bounded: the
// goal is re-continued round after round with no cap, no ledger counter, and
// no user-visible stop. countTrailingComparableDisapprovals returns 0 for
// both, so the existing cap is structurally blind to them.
//
// The fix counts every trailing round that failed to SETTLE the goal, across
// all verdict classes (countTrailingUnsettledRounds), and additionally stops
// an alternating primary/fallback ladder from re-baselining the comparable
// streak to 1 forever.
//
// Pins:
//   1. countTrailingUnsettledRounds counts disapprovals, shield blocks and
//      impossibles; an approval and an infra error both break the streak;
//      mechanical pre-audit gate rows stay transparent;
//   2. the regression-shield branch pauses at the hard cap (this is the
//      behavioural proof — it fails against the pre-fix source);
//   3. the IMPOSSIBLE(partial) aggressive branch pauses at the hard cap;
//   4. a grader-alternating streak still trips the cap (trailingStreakGrader-
//      Stable had no production caller before this pass).

import { test, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import {
  readState,
  countTrailingUnsettledRounds,
  countTrailingComparableDisapprovals,
  trailingStreakGraderStable,
  type AuditVerdict,
} from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function setSettings(extra: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: true, ...extra }));
}

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

type GoalView = {
  status?: string;
  pauseReason?: string;
  pauseKind?: string;
  pauseOptions?: string[];
  pendingCompletion?: unknown;
  auditHistory?: AuditVerdict[];
};

const at = (minsAgo: number): string => new Date(Date.now() - minsAgo * 60_000).toISOString();

function verdict(over: Partial<AuditVerdict> & { approved: boolean; disapproved: boolean }): AuditVerdict {
  return { at: at(1), model: "anthropic/mock-model", ...over };
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
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `unsettled-cap-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

async function shutdown(pi: MockPi, ctx: MockCtx): Promise<void> {
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000, label = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`.trim());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function writeFakeAuditor(cwd: string, report: string): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node\nlet input = "";\nlet handled = false;\nprocess.stdin.on("data", async (chunk) => {\n  input += chunk;\n  if (handled || !input.includes("\\n")) return;\n  handled = true;\n  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");\n  const report = ${JSON.stringify(report)};\n  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });\n  emit({ type: "tool_execution_end", toolCallId: "fake-read" });\n  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });\n  emit({ type: "agent_settled" });\n});\n`);
  fs.chmodSync(script, 0o700);
  return script;
}

describe("countTrailingUnsettledRounds — all verdict classes", () => {
  test("counts disapprovals, and an approval breaks the streak", () => {
    const history = [
      verdict({ approved: false, disapproved: true }),
      verdict({ approved: false, disapproved: true }),
      verdict({ approved: true, disapproved: false }),
    ];
    assert.equal(countTrailingUnsettledRounds(history), 0, "a settled approval ends the treadmill");
  });

  test("counts a regression-shield block, which the disapproval cap cannot see", () => {
    const history = [
      verdict({ approved: false, disapproved: true }),
      verdict({ approved: true, disapproved: false, regressionShieldPassed: false, regressionShieldMissing: ["item 1"] }),
      verdict({ approved: true, disapproved: false, regressionShieldPassed: false, regressionShieldMissing: ["item 1"] }),
    ];
    assert.equal(countTrailingComparableDisapprovals(history), 0, "the v0.38.107 cap sees nothing here");
    assert.equal(countTrailingUnsettledRounds(history), 3, "the disapproval plus both shield blocks are unsettled rounds");
  });

  test("counts an IMPOSSIBLE(partial) verdict", () => {
    const history = [
      verdict({ approved: false, disapproved: false, impossible: true, impossibleReason: "needs a GPU" }),
      verdict({ approved: false, disapproved: false, impossible: true, impossibleReason: "needs a GPU" }),
      verdict({ approved: false, disapproved: false, impossible: true, impossibleReason: "needs a GPU" }),
    ];
    assert.equal(countTrailingComparableDisapprovals(history), 0);
    assert.equal(countTrailingUnsettledRounds(history), 3);
  });

  test("an infra error is transparent; a clean approval of a shielded round is NOT", () => {
    const withInfra = [
      verdict({ approved: true, disapproved: false }),
      verdict({ approved: false, disapproved: false, error: "Agent stopped with error" }),
      verdict({ approved: false, disapproved: true }),
    ];
    assert.equal(countTrailingUnsettledRounds(withInfra), 1, "the infra row does not count and does not break the streak");

    const cleanApproval = [verdict({ approved: true, disapproved: false, regressionShieldPassed: true })];
    assert.equal(countTrailingUnsettledRounds(cleanApproval), 0, "a real approval settles the goal");
  });

  test("a mechanical pre-audit gate row stays transparent", () => {
    const history = [
      verdict({ approved: false, disapproved: true }),
      verdict({ approved: false, disapproved: true, model: "deterministic-pre-audit" }),
    ];
    assert.equal(countTrailingUnsettledRounds(history), 1, "a failing contract command is not the auditor disagreeing");
  });
});

describe("grader alternation no longer defeats the hard cap", () => {
  test("an alternating primary/fallback streak is detected as unstable", () => {
    const history = [
      verdict({ approved: false, disapproved: true, model: "a/primary" }),
      verdict({ approved: false, disapproved: true, model: "b/fallback" }),
      verdict({ approved: false, disapproved: true, model: "a/primary" }),
      verdict({ approved: false, disapproved: true, model: "b/fallback" }),
    ];
    assert.equal(trailingStreakGraderStable(history), false, "the guard reports the streak is measuring noise");
    assert.equal(countTrailingComparableDisapprovals(history), 1, "which is exactly how the cap was defeated");
    assert.equal(countTrailingUnsettledRounds(history), 4, "the all-classes count is not fooled by the alternation");
  });

  test("a single-grader streak is still reported stable", () => {
    const history = [
      verdict({ approved: false, disapproved: true, model: "a/primary" }),
      verdict({ approved: false, disapproved: true, model: "a/primary" }),
    ];
    assert.equal(trailingStreakGraderStable(history), true);
  });
});

describe("regression shield — the branch the cap could not see", () => {
  // Behavioural proof: the goal is parked at the hard cap with a history full
  // of shield blocks. Against the pre-fix source this round is re-continued
  // (status active, no pause) because the cap only ever counted disapproved.
  test("shield blocks pause at the hard cap instead of re-continuing forever", { timeout: 120_000 }, async () => {
    setSettings({ aggressiveMode: true, auditCap: 2, auditCapHard: 2, autoResume: true });
    const cwd = tmpCwd();
    const grader = "anthropic/mock-model";
    const priors: AuditVerdict[] = [0, 1].map((i) => verdict({
      at: at((10 - i) * 5),
      approved: true,
      disapproved: false,
      model: grader,
      regressionShieldPassed: false,
      regressionShieldMissing: ["item 1"],
      report: "Looks right but the evidence block never quotes item 1.",
    }));
    seedState(cwd, {
      goal: seedGoal({
        status: "paused",
        policy: "goal",
        objective: "shield treadmill goal",
        completionSummary: "Outcome: shipped. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
        verificationSummary: "e1.",
        verificationContract: "<evidence>1. item 1</evidence>",
        auditHistory: priors,
        // A seeded parked claim is what drives the DETACHED settlement — the
        // path where the v0.38.107 cap actually lives. resume_goal re-fires it.
        pendingCompletion: {
          at: new Date().toISOString(),
          phase: "recovery-pending",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          attemptId: "shield-cap-attempt",
          completionSummary: "Outcome: shipped. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
          verificationSummary: "e1.",
        },
        pauseKind: "blocked",
        pauseReason: "seeded parked claim with shield-block priors",
      }),
    });

    const previousBinary = process.env.GLLA_PI_BINARY;
    // An approval whose evidence block does not quote the contract item.
    process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "Looks fine.\n<approved/>");
    const { pi, ctx } = await boot(cwd);
    try {
      await pi.runTool("resume_goal", { reason: "retry the stored claim" }, ctx);
      await waitUntil(() => {
        const goal = readState(cwd).goal as GoalView | null;
        return !!goal && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= priors.length + 1;
      }, 40_000, "shield-block round");
      const g = readState(cwd).goal as GoalView;
      assert.equal(g.status, "paused", "the shield treadmill stops instead of re-continuing");
      assert.match(g.pauseReason ?? "", /hard cap 2/, `pauseReason=${g.pauseReason}`);
      assert.equal(g.pauseKind, "decision");
      assert.ok((g.pauseOptions ?? [])[0]?.includes("Accept with follow-ups"), `options=${JSON.stringify(g.pauseOptions)}`);
      assert.ok(ledgerTypes(cwd).includes("goal_paused"), "the cap park is ledgered");
    } finally {
      if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
      else process.env.GLLA_PI_BINARY = previousBinary;
      await shutdown(pi, ctx);
    }
  });
});
