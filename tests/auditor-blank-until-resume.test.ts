// pi-goal-list-loop-audit — blank-until-resume auditor-surface tests
//
// The durable objective/status projection remains visible after a cold load,
// while a previous auditor report stays out of newly built model context and
// feedback UI until a continuation consent path is admitted.

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import {
  __testOnlyResetAuditorSurface,
  auditorSurfaceSuppressed,
  releaseAuditorSurface,
  suppressAuditorSurfaceAfterColdRestore,
} from "../extensions/loops/goal-auditor-surface.js";
import { continuationPrompt } from "../extensions/goal-continuation.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { readState, type Goal, type State } from "../extensions/goal-loop-core.js";
import { invalidateHostSession, makeMockCtx, MockPi, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const AUDIT_REPORT = "Required fixes: keep the objective visible, but do not resume it silently.";

function goalWithAudit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return seedGoal({
    objective: "visible unfinished objective — done when pinned",
    status: "active",
    autoContinue: true,
    pendingTasks: ["stale auditor task that must wait for resume"],
    auditHistory: [{
      at: new Date(Date.now() - 60_000).toISOString(),
      approved: false,
      disapproved: true,
      impossible: false,
      regressionShieldPassed: true,
      revision: 0,
      report: `<disapproved>\n${AUDIT_REPORT}\n</disapproved>`,
    }],
    ...overrides,
  });
}

function widgetText(state: State): string {
  return (buildWidgetLines(state) ?? []).join("\n");
}

async function boot(pi: MockPi, cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `blank-auditor-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return ctx;
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("cold auditor gate hides only the report, not the durable objective UI", () => {
  const goal = goalWithAudit({ status: "active", interruptedAt: new Date().toISOString(), pauseReason: "auditor disapproved — fix the gap" }) as unknown as Goal;
  const state = { goal, list: [], loop: null } as unknown as State;

  suppressAuditorSurfaceAfterColdRestore();
  const hiddenWidget = widgetText(state);
  const hiddenPrompt = continuationPrompt(goal);
  assert.match(hiddenWidget, /visible unfinished objective/, "objective remains visible");
  assert.doesNotMatch(hiddenWidget, /Required fixes/, "old report is not painted");
  assert.doesNotMatch(hiddenPrompt, /LATEST AUDITOR/, "old auditor block is not injected");
  assert.doesNotMatch(hiddenPrompt, /AUDITOR TODO LIST/, "old auditor TODOs are not injected");
  assert.doesNotMatch(hiddenPrompt, /resume it silently/, "old report text is not injected");

  releaseAuditorSurface();
  assert.match(widgetText(state), /Required fixes/, "report returns after consent");
  assert.match(continuationPrompt(goal), /LATEST AUDITOR/, "continuation sees the report after consent");
  assert.match(continuationPrompt(goal), /AUDITOR TODO LIST/, "continuation sees durable auditor TODOs after consent");
});

test("cold restore shows the objective and sends nothing until explicit resume", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  try {
    seedState(cwd, {
      goal: goalWithAudit(),
      list: [{ id: "waiting-1", objective: "queued follow-up", addedAt: new Date().toISOString() }],
    });
    const pi = new MockPi();
    activate(pi.api);
    const ctx = await boot(pi, cwd);
    const after = readState(cwd);
    const visible = JSON.stringify(ctx.ui.widgets) + JSON.stringify(ctx.ui.notifies);

    assert.match(visible, /visible unfinished objective/, "cold restore projects the objective");
    assert.match(visible, /held on restore|waiting|resume/i, "cold restore explains the consent boundary");
    assert.doesNotMatch(visible, /resume it silently/, "cold restore does not paint the old report");
    assert.equal(pi.sent.length, 0, "cold restore sends no continuation");
    assert.equal(pi.userMessages.length, 0, "cold restore injects no user message");
    assert.doesNotMatch(continuationPrompt(after.goal as Goal), /LATEST AUDITOR/, "cold restore prompt is report-free");

    await pi.command("goal", "resume", ctx);
    await tick(150);
    assert.match(continuationPrompt(readState(cwd).goal as Goal), /LATEST AUDITOR/, "explicit resume restores report context");
    assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "explicit resume can dispatch");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejected stale /goal resume leaves the auditor surface suppressed", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  try {
    seedState(cwd, {
      goal: goalWithAudit({
        status: "paused",
        pauseKind: "blocked",
        pauseReason: "auditor disapproved — fix the gap",
        pauseSuggestedAction: "/goal resume after fixing the gap",
      }),
      mainModelRecovery: {
        primary: "anthropic/mock-model",
        active: "anthropic/mock-model",
        attempted: ["anthropic/mock-model"],
        attempts: 1,
        reason: "provider recovery",
        manualResumeRequired: true,
        resumeCurrent: true,
        kind: "goal",
      },
    } as unknown as Parameters<typeof seedState>[1]);
    const pi = new MockPi();
    activate(pi.api);
    const ctx = await boot(pi, cwd);
    invalidateHostSession(pi, ctx);

    await pi.command("goal", "resume", ctx);

    assert.equal(auditorSurfaceSuppressed(), true, "stale resume cannot grant auditor-context consent");
    assert.doesNotMatch(continuationPrompt(readState(cwd).goal as Goal), /LATEST AUDITOR/, "stale resume does not expose the old report");
    assert.equal(pi.sent.length, 0, "stale resume sends no continuation");
    assert.match(readState(cwd).goal?.interruptedReason ?? "", /resumed in a stale session/, "durable stale-resume recovery marker remains");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit /goal resume releases the auditor surface for admitted main-model recovery", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  try {
    seedState(cwd, {
      goal: goalWithAudit({
        status: "paused",
        pauseKind: "wait",
        pauseReason: "provider recovery waiting for an explicit resume",
        pauseSuggestedAction: "/goal resume to retry the main model",
      }),
      mainModelRecovery: {
        primary: "anthropic/mock-model",
        active: "anthropic/mock-model",
        attempted: ["anthropic/mock-model"],
        attempts: 1,
        reason: "provider recovery",
        manualResumeRequired: true,
        resumeCurrent: true,
        kind: "goal",
      },
    } as unknown as Parameters<typeof seedState>[1]);
    const pi = new MockPi();
    activate(pi.api);
    const ctx = await boot(pi, cwd);

    await pi.command("goal", "resume", ctx);
    await tick(40);

    assert.equal(auditorSurfaceSuppressed(), false, "admitted main-model recovery resume grants auditor-context consent");
    assert.match(continuationPrompt(readState(cwd).goal as Goal), /LATEST AUDITOR/, "recovery resume restores the old report context");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("configured auto-resume is continuation consent and restores auditor context", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  try {
    seedState(cwd, { goal: goalWithAudit() });
    const pi = new MockPi();
    activate(pi.api);
    await boot(pi, cwd);
    assert.match(continuationPrompt(readState(cwd).goal as Goal), /LATEST AUDITOR/, "auto-resume restores report context");
    await tick(150);
    assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "auto-resume dispatches after consent");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
