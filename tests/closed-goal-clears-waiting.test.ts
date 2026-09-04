import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  auditorDisplayPhase,
  buildStatusText,
  buildWidgetLines,
} from "../extensions/goal-loop-display.js";
import {
  __testOnlyResetZombieAutoRetry,
  __testOnlySetZombieRetryMaxAttempts,
} from "../extensions/loops/goal-activation.js";
import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, type MockCtx } from "./harness/mock-pi.js";
import { DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS } from "../extensions/goal-loop-backoff.js";

// v0.38.19 track 3 (junk-runner stale waiting-verdict, auditor-required):
// awaiting-verdict is a LIVE claim — worker done, verdict not yet applied.
// A closed goal can never be waiting: the verdict landed or the claim died
// with the archive. The phase projector must not resurrect the wait from a
// stale progress object handed in after the close.

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return ctx;
}

let currentCtx: MockCtx | null = null;

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  __testOnlySetZombieRetryMaxAttempts(DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS);
});

afterEach(async () => {
  __testOnlySetZombieRetryMaxAttempts(null);
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  if (currentCtx) {
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("v0.38.19 live auditing still projects awaiting-verdict (no live-path regression)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", objective: "live audit objective — done when pinned" }),
  });
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  const goal = (readState(cwd).goal as Record<string, unknown> | null)!;
  assert.ok(goal, "the seeded goal loads");

  // The live claim window: status auditing, worker finished, verdict owed.
  const auditing = {
    ...goal,
    status: "auditing",
    pendingCompletion: { at: new Date().toISOString(), phase: "running", attemptId: "attempt-1" },
  } as never;
  const phase = auditorDisplayPhase(auditing, { phase: "complete", lastActivityAt: Date.now() } as never, Date.now());
  assert.equal(phase, "awaiting-verdict");
});

test("v0.38.19 a closed goal clears awaiting-verdict even with a stale complete progress", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", objective: "close-me objective — done when pinned" }),
  });
  const ctx = await freshSession(cwd);
  currentCtx = ctx;

  // Real close through the command surface: cancel archives (aborted),
  // strips the claim, drops the ephemeral projection.
  await pi.command("goal", "cancel", ctx);
  assert.equal(readState(cwd).goal, null);
  assert.ok(readLedger(cwd).some((e) => e.type === "goal_archived"), "the close is durable");

  // A stale worker-complete snapshot arriving after the close (late
  // callback while SIGTERM settles, old object held by a caller) must not
  // resurrect the wait for either terminal status.
  const staleProgress = { phase: "complete", lastActivityAt: Date.now() - 60_000 } as never;
  for (const status of ["complete", "aborted"] as const) {
    const closed = { ...(seedGoal({ policy: "goal", objective: "x" }) as object), status, pendingCompletion: undefined } as never;
    assert.notEqual(
      auditorDisplayPhase(closed, staleProgress, Date.now()),
      "awaiting-verdict",
      `a ${status} goal never waits for a verdict`,
    );
  }

  // A pre-archive snapshot that still carries a running claim must not
  // project the wait either (the archive strips it; this guards readers of
  // the pre-close snapshot after the close).
  const preCloseSnapshot = {
    ...(seedGoal({ policy: "goal", objective: "x" }) as object),
    status: "complete",
    pendingCompletion: { at: new Date().toISOString(), phase: "running", attemptId: "attempt-1" },
  } as never;
  assert.notEqual(auditorDisplayPhase(preCloseSnapshot, null, Date.now()), "awaiting-verdict");

  // Post-archive renders carry no verdict wait: goal null + even a stale
  // progress object handed to the renderers stays silent.
  const state = readState(cwd);
  const statusText = buildStatusText(state as never, staleProgress, Date.now());
  assert.ok(!statusText || !/awaiting verdict/i.test(statusText), "status text never waits after close");
  const widget = buildWidgetLines(state as never, staleProgress, Date.now());
  const widgetText = (widget ?? []).join("\n");
  assert.ok(!/awaiting verdict|waiting for detached verdict/i.test(widgetText), "widget never waits after close");
});
