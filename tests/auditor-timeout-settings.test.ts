// pi-goal-list-loop-audit — v0.37.0
// tests/auditor-timeout-settings.test.ts
//
// Behavioral coverage for the configurable + adaptive detached-auditor
// watchdog budgets:
//   (a) the pure escalation schedule (double per prior attempt, cap 4x),
//   (b) settings bounds clamping on load,
//   (c) the /glla editor (plain-ms and s/m/h duration input),
//   (d) settings-menu rows for both keys,
//   (e) env threading — the dispatch site's budgets reach the worker
//       process environment,
//   (f) the progress signature counting streamed report bytes,
//   (g) the quiet-phase exemption for an in-budget live tool,
//   (h) the durable claim preserving the escalation index across loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn as realSpawn } from "node:child_process";
import {
  AUDIT_JOB_CLEANUP_MIN_AGE_MS,
  AUDITOR_TIMEOUT_ESCALATION_MAX_STEPS,
  DEFAULT_AUDITOR_STALL_MS,
  DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  MAX_AUDIT_JOB_RETENTION_MS,
  MAX_AUDITOR_TOOL_TIMEOUT_MS,
  MIN_AUDITOR_STALL_MS,
  escalatedAuditorTimeout,
  progressSignature,
  runDetachedGoalCompletionAuditor,
} from "../extensions/goal-loop-auditor-process.ts";
import { auditorDisplayPhase } from "../extensions/goal-loop-display.ts";
import { readState } from "../extensions/goal-loop-core.ts";
import { globalSettingsPath, loadSettings } from "../extensions/goal-settings.ts";
import type { Settings } from "../extensions/goal-settings.ts";
import { buildSettingsRows } from "../extensions/settings-menu.ts";
import { handleSettingChoice } from "../extensions/loops/goal.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const GLOBAL_FILE = globalSettingsPath();
const ORIGINAL_GLOBAL = fs.existsSync(GLOBAL_FILE) ? fs.readFileSync(GLOBAL_FILE, "utf-8") : null;

function restoreGlobal(): void {
  if (ORIGINAL_GLOBAL === null) {
    try {
      fs.unlinkSync(GLOBAL_FILE);
    } catch {
      /* didn't exist */
    }
  } else {
    fs.writeFileSync(GLOBAL_FILE, ORIGINAL_GLOBAL);
  }
}

function readGlobal(): Record<string, unknown> {
  return fs.existsSync(GLOBAL_FILE) ? (JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf-8")) as Record<string, unknown>) : {};
}

function withTmpCwd<T>(fn: (cwd: string) => T): T {
  const cwd = tmpCwd();
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const goal = {
  id: "test-auditor-timeout-settings",
  objective: "prove the timeout settings thread end-to-end",
  status: "active" as const,
  policy: "goal" as const,
  verificationContract: "Done when:\n- the verdict lands",
  autoContinue: false,
  usage: { tokensUsed: 0, tokensLimit: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("v0.37.0: escalatedAuditorTimeout doubles per prior attempt and saturates at 4x base", () => {
  const base = 300_000;
  assert.equal(escalatedAuditorTimeout(base, 0), base);
  assert.equal(escalatedAuditorTimeout(base, 1), base * 2);
  assert.equal(escalatedAuditorTimeout(base, 2), base * 4);
  assert.equal(escalatedAuditorTimeout(base, 3), base * 4, "saturates after the max doublings");
  assert.equal(escalatedAuditorTimeout(base, 99), base * 4, "saturates regardless of attempt count");
  assert.equal(AUDITOR_TIMEOUT_ESCALATION_MAX_STEPS, 2);
  let previous = 0;
  for (let i = 0; i <= 10; i++) {
    const v = escalatedAuditorTimeout(base, i);
    assert.ok(v >= previous, `monotonic non-decreasing at step ${i}`);
    previous = v;
  }
  // Defensive guards: a corrupt index must not produce a zero or negative budget.
  assert.equal(escalatedAuditorTimeout(Number.NaN, 1), DEFAULT_AUDITOR_TOOL_TIMEOUT_MS * 2, "non-finite base falls back to the default");
  assert.equal(escalatedAuditorTimeout(base, Number.NaN), base, "non-finite index means zero doublings");
});

test("v0.37.0: auditor timeout settings clamp into bounds on load", () => {
  withTmpCwd((cwd) => {
    const existing = ORIGINAL_GLOBAL ? (JSON.parse(ORIGINAL_GLOBAL) as Record<string, unknown>) : {};
    try {
      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ ...existing, auditorToolTimeoutMs: 999_999_999_999, auditorStallMs: -5 }));
      const high = loadSettings(cwd);
      assert.equal(high.auditorToolTimeoutMs, MAX_AUDITOR_TOOL_TIMEOUT_MS, "ceiling clamps the tool budget");
      assert.equal(high.auditorStallMs, MIN_AUDITOR_STALL_MS, "floor clamps the stall budget");

      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ ...existing, auditorToolTimeoutMs: 900_000, auditorStallMs: 1_800_000 }));
      const ok = loadSettings(cwd);
      assert.equal(ok.auditorToolTimeoutMs, 900_000, "in-range values survive untouched");
      assert.equal(ok.auditorStallMs, 1_800_000);

      fs.writeFileSync(GLOBAL_FILE, JSON.stringify(existing));
      const defaults = loadSettings(cwd);
      assert.equal(defaults.auditorToolTimeoutMs, DEFAULT_AUDITOR_TOOL_TIMEOUT_MS);
      assert.equal(defaults.auditorStallMs, DEFAULT_AUDITOR_STALL_MS);
    } finally {
      restoreGlobal();
    }
  });
});

test("v0.37.0: /glla editor accepts plain-ms and s/m/h duration input for both keys", async () => {
  // Drive the real editor against the real global file (snapshotted above).
  const ctx = makeMockCtx(tmpCwd());
  try {
    ctx.ui.inputImpl = async () => "15m";
    await handleSettingChoice("auditorToolTimeoutMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorToolTimeoutMs, 900_000, "duration string normalizes to ms");

    ctx.ui.inputImpl = async () => "2h";
    await handleSettingChoice("auditorStallMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorStallMs, 7_200_000);

    ctx.ui.inputImpl = async () => "300000";
    await handleSettingChoice("auditorToolTimeoutMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorToolTimeoutMs, 300_000, "plain integer ms is accepted verbatim");

    ctx.ui.inputImpl = async () => "1s";
    await handleSettingChoice("auditorToolTimeoutMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorToolTimeoutMs, 300_000, "out-of-range input leaves the previous value");

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("auditorToolTimeoutMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorToolTimeoutMs, undefined, "empty clears back to the default");
  } finally {
    restoreGlobal();
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("v0.37.0: settings menu exposes both auditor timeout rows in the auditor section", () => {
  const rows = buildSettingsRows({ auditorToolTimeoutMs: 900_000, auditorStallMs: 1_800_000 } as Settings, {});
  const toolRow = rows.find((r) => r.id === "auditorToolTimeoutMs");
  const stallRow = rows.find((r) => r.id === "auditorStallMs");
  assert.ok(toolRow, "auditorToolTimeoutMs row exists");
  assert.ok(stallRow, "auditorStallMs row exists");
  assert.equal(toolRow!.section, "auditor");
  assert.equal(stallRow!.section, "auditor");
  assert.match(toolRow!.valueText, /15m base · ×2 per retry · cap 4×/);
  assert.match(stallRow!.valueText, /30m base · ×2 per retry · cap 4×/);
});

test("v0.37.0: dispatch env reaches the worker process so parent and worker budgets agree", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-auditor-env-"));
  try {
    const worker = path.join(dir, "env-worker.mjs");
    await writeFile(worker, `process.exit(0);`);
    let seenEnv: NodeJS.ProcessEnv | undefined;
    await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: worker,
        attemptId: () => "attempt-env-thread",
        pollIntervalMs: 10,
        firstEventTimeoutMs: 5_000,
        heartbeatNoProgressMs: 60_000,
        toolTimeoutMs: 1_234_567,
        spawn: ((command: string, args: string[], opts: unknown) => {
          seenEnv = (opts as { env?: NodeJS.ProcessEnv })?.env;
          return realSpawn(command, args, opts as never);
        }) as typeof realSpawn,
        env: {
          GLLA_AUDITOR_TOOL_TIMEOUT_MS: "1234567",
          GLLA_AUDITOR_STALL_MS: "2469135",
        },
      },
    });
    assert.ok(seenEnv, "the worker was spawned");
    assert.equal(seenEnv.GLLA_AUDITOR_TOOL_TIMEOUT_MS, "1234567");
    assert.equal(seenEnv.GLLA_AUDITOR_STALL_MS, "2469135");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.37.0: progress signature counts streamed report bytes", () => {
  const base = {
    protocolVersion: 1,
    attemptId: "a",
    requestHash: "h",
    phase: "thinking" as const,
    elapsedMs: 1_000,
    recentOutput: ["x"],
    toolCalls: [],
  };
  assert.notEqual(
    progressSignature({ ...base, reportBytes: 10 }),
    progressSignature({ ...base, reportBytes: 11 }),
    "a growing byte counter changes the signature — an actively generating model is live progress",
  );
  assert.equal(
    progressSignature({ ...base, reportBytes: 10 }),
    progressSignature({ ...base, reportBytes: 10 }),
    "identical telemetry yields an identical signature",
  );
});

test("v0.37.0: an in-budget live tool exempts the audit card from the quiet phase", () => {
  const now = Date.now();
  const silentFourMinutesAgo = now - 4 * 60_000;
  const audit = {
    currentTool: "grep",
    currentToolStartedAt: silentFourMinutesAgo,
    lastActivityAt: silentFourMinutesAgo,
    toolTimeoutMs: 20 * 60_000,
  };
  assert.equal(auditorDisplayPhase(goal, { ...audit }, now), "running", "in-budget long tool is live progress, not quiet");
  assert.equal(auditorDisplayPhase(goal, { ...audit, toolTimeoutMs: 3 * 60_000 }, now), "quiet", "a tool PAST its budget stays quiet");
  assert.equal(auditorDisplayPhase(goal, { ...audit, toolTimeoutMs: undefined }, now), "quiet", "no budget fact keeps the legacy quiet behavior");
});

test("v0.37.0: durable claims preserve the timeout escalation index across loads", () => {
  withTmpCwd((cwd) => {
    const stateDir = path.join(cwd, ".pi-glla");
    fs.mkdirSync(stateDir, { recursive: true });
    const writeClaim = (escalation: unknown) => {
      const line = JSON.stringify({
        type: "state",
        value: {
          goal: {
            ...goal,
            pendingCompletion: {
              phase: "running",
              attemptId: "attempt-escalation",
              ...(escalation === undefined ? {} : { timeoutEscalation: escalation }),
            },
          },
          list: [],
          loop: null,
        },
        at: new Date().toISOString(),
      });
      fs.writeFileSync(path.join(stateDir, "active.jsonl"), `${line}\n`);
    };
    writeClaim(3);
    assert.equal(readState(cwd).goal?.pendingCompletion?.timeoutEscalation, 3, "a valid index round-trips");

    writeClaim(-1);
    assert.equal(readState(cwd).goal?.pendingCompletion?.timeoutEscalation, undefined, "negative corrupts to no escalation");

    writeClaim(101);
    assert.equal(readState(cwd).goal?.pendingCompletion?.timeoutEscalation, undefined, "astronomical corrupts to no escalation");

    writeClaim("3");
    assert.equal(readState(cwd).goal?.pendingCompletion?.timeoutEscalation, undefined, "a string index is not a number");
  });
});

test("v0.38.3: auditJobRetentionMs clamps into [0, 7d] on load", () => {
  withTmpCwd((cwd) => {
    const existing = ORIGINAL_GLOBAL ? (JSON.parse(ORIGINAL_GLOBAL) as Record<string, unknown>) : {};
    try {
      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ ...existing, auditJobRetentionMs: 999_999_999_999 }));
      const high = loadSettings(cwd);
      assert.equal(high.auditJobRetentionMs, MAX_AUDIT_JOB_RETENTION_MS, "ceiling clamps to 7 days");

      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ ...existing, auditJobRetentionMs: -5 }));
      const low = loadSettings(cwd);
      assert.equal(low.auditJobRetentionMs, 0, "negative clamps to 0 (immediate reap is legal)");

      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ ...existing, auditJobRetentionMs: 7_200_000 }));
      const ok = loadSettings(cwd);
      assert.equal(ok.auditJobRetentionMs, 7_200_000, "in-range value survives untouched");

      fs.writeFileSync(GLOBAL_FILE, JSON.stringify(existing));
      const defaults = loadSettings(cwd);
      assert.equal(defaults.auditJobRetentionMs, AUDIT_JOB_CLEANUP_MIN_AGE_MS, "missing key falls back to the legacy 15m threshold");
    } finally {
      restoreGlobal();
    }
  });
});

test("v0.38.3: /glla editor accepts duration input for auditJobRetentionMs (0 is legal)", async () => {
  // Drive the real editor against the real global file (snapshotted above).
  const ctx = makeMockCtx(tmpCwd());
  try {
    ctx.ui.inputImpl = async () => "2h";
    await handleSettingChoice("auditJobRetentionMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditJobRetentionMs, 7_200_000, "duration string normalizes to ms");

    ctx.ui.inputImpl = async () => "0";
    await handleSettingChoice("auditJobRetentionMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditJobRetentionMs, 0, "zero is a legal retention (reap immediately)");

    ctx.ui.inputImpl = async () => "999999999999";
    await handleSettingChoice("auditJobRetentionMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditJobRetentionMs, 0, "out-of-range input leaves the previous value");

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("auditJobRetentionMs", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditJobRetentionMs, undefined, "empty clears back to the default");
  } finally {
    restoreGlobal();
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("v0.38.3: settings menu exposes the audit job retention row in the auditor section", () => {
  const rows = buildSettingsRows({ auditJobRetentionMs: 900_000 } as Settings, {});
  const row = rows.find((r) => r.id === "auditJobRetentionMs");
  assert.ok(row, "auditJobRetentionMs row exists");
  assert.equal(row!.section, "auditor");
  assert.match(row!.valueText, /15m dead-dir window/);
});
