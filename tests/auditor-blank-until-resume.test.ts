// pi-goal-list-loop-audit — blank-until-resume tests
//
// A genuinely fresh session (cold startup, no resume consent) must stay
// BLANK of the previous session's auditor result: no LATEST AUDITOR block in
// the injected continuation context, and no last-auditor TUI feedback paint.
// Durable state (auditHistory) stays on disk untouched; an explicit
// /goal resume in the new session re-surfaces the report from disk.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { replaceState } from "../extensions/goal-state.js";
import { readState, type Goal } from "../extensions/goal-loop-core.js";
import { continuationPrompt } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const GLOBAL_BACKUP = GLOBAL_SETTINGS_PATH + ".blank-resume-backup";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager-blank-resume" };

function ctxFor(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

function goalWithAudit(): Record<string, unknown> {
  return seedGoal({
    status: "paused",
    autoContinue: true,
    pauseKind: "blocked",
    pauseReason: "restored on session load — held for explicit resume",
    verificationContract: "done when the thing is done",
    auditHistory: [
      {
        at: new Date(Date.now() - 60_000).toISOString(),
        approved: false,
        disapproved: true,
        impossible: false,
        regressionShieldPassed: true,
        revision: 0,
        report: "<disapproved>\nRequired fixes:\n1. Ship the actual fix.\n</disapproved>",
      },
    ],
  });
}

let lastCtx: MockCtx;

async function coldBoot(cwd: string): Promise<MockCtx> {
  const ctx = ctxFor(cwd);
  lastCtx = ctx;
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return ctx;
}

afterEach(() => {
  try { fs.copyFileSync(GLOBAL_BACKUP, GLOBAL_SETTINGS_PATH); } catch { fs.rmSync(GLOBAL_SETTINGS_PATH, { force: true }); }
  fs.rmSync(GLOBAL_BACKUP, { force: true });
  __testOnlyResetAuditorSurface();
});

test("a cold fresh session with on-disk auditHistory does NOT inject LATEST AUDITOR until /goal resume", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  try {
    // Auto-resume OFF (the default): a cold load must hold, not continue.
    const raw = JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ ...raw, autoResume: undefined }));
    seedState(cwd, { goal: goalWithAudit() });

    await coldBoot(cwd);

    // Durable state unchanged on disk: auditHistory survives the boot.
    const loaded = readState(cwd) as { goal?: Goal };
    assert.ok(loaded.goal?.auditHistory?.length === 1, "auditHistory intact on disk");

    // Blank until resume: continuation context carries no auditor report…
    const promptBefore = continuationPrompt(loaded.goal!);
    assert.doesNotMatch(promptBefore, /LATEST AUDITOR/, "no LATEST AUDITOR block before resume");
    assert.doesNotMatch(promptBefore, /Ship the actual fix\./, "no report text before resume");
    // …and no last-auditor verdict line either.
    assert.doesNotMatch(promptBefore, /Last audit: DISAPPROVED/, "no last-audit verdict before resume");

    // Explicit resume in THIS session re-surfaces the report from disk.
    const resume = pi.commands.get("goal");
    assert.ok(resume, "/goal command registered");
    await resume!("resume", lastCtx);

    const after = readState(cwd) as { goal?: Goal };
    const promptAfter = continuationPrompt(after.goal ?? (loaded.goal as Goal));
    assert.match(promptAfter, /LATEST AUDITOR/, "LATEST AUDITOR available after explicit resume");
    assert.match(promptAfter, /Ship the actual fix\./, "report text available after explicit resume");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
