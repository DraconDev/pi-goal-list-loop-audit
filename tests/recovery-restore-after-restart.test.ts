// pi-goal-list-loop-audit — v0.34.63
// tests/recovery-restore-after-restart.test.ts
//
// The "dead countdown" incident (dracon-platform/web, 2026-08-07):
//   - 01:18:01Z a 429 wall parks the list item into durable recovery
//     (retryAt 01:33:01, attempts 1) and the hourly prompter schedules :00.
//   - 01:18:06Z the user quits pi → fresh process → blank "startup" (the
//     load barrier pends: session_waiting_for_load) → "resume".
//   - pi delivers the resumed session with a NEW SessionManager object, so
//     sameOwnerStart (identity) failed; the resume was silently DROPPED at
//     the foreign-session gate — no session_rebound, no probe at 01:33:01,
//     and the wall card kept a dead countdown forever.
//
// Contract: while THIS process is waiting on the load barrier
// (initialSessionLoadPending set by a blank startup), a lifecycle
// session_start from the same workspace carrying the same session identity
// IS that load completing — the gate must accept it, restore the recovery
// probe timer, and the probe must actually fire. A lifecycle start with a
// DIFFERENT session id stays refused (subagent/foreign protection intact).
//
// Co-residency: this file fires session_start AND session_shutdown (like
// stale-self-heal.test.ts); afterEach resets the module-level owner/stale
// flags, the pi knobs, and the global autoResume setting.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { seedGoal, seedState, MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const pi = new MockPi();
activate(pi.api);

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

/** A file-backed-looking main host session manager (no getSessionFile:
 * simulates pi delivering the resumed manager before its session file is
 * set — the incident shape the file-backed check cannot see). */
function hostManager(id: string, messages: unknown[] | undefined): unknown {
  return {
    name: "main-session-manager",
    getSessionId: () => id,
    ...(messages !== undefined ? { buildSessionContext: () => ({ messages }) } : {}),
  };
}

function makeManagerCtx(cwd: string, sm: unknown): MockCtx {
  return makeMockCtx(cwd, { sessionManager: sm });
}

function readLedger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
}

function seedParkedGoal(cwd: string, retryAtMs: number): void {
  // seedState spreads extra keys into the state line; mainModelRecovery is
  // carried through the unknown of the value type via a cast below.
  const retryAt = new Date(retryAtMs).toISOString();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: retryAt,
      pauseReason: "main model recovery — retrying in 1s (main model quota: 429 rate limit: pi held the provider retry with no stream activity)",
    }),
    mainModelRecovery: {
      primary: "anthropic/mock-model",
      active: "anthropic/mock-model",
      attempted: ["anthropic/mock-model"],
      attempts: 1,
      reason: "main model quota: 429 rate limit",
      kind: "goal",
      firstFailureAt: new Date().toISOString(),
      autoRetryUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
      retryAt,
      pendingModelSwitch: "anthropic/mock-model",
    },
  } as unknown as Parameters<typeof seedState>[1]);
  __testOnlyLoadState(cwd);
}

function resetModuleState(): void {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
}

beforeEach(() => {
  resetModuleState();
  setGlobalAutoResume(true);
});

afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  resetModuleState();
});

async function waitFor(fn: () => boolean, ms = 2500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await tick(50);
  }
}

test("v0.34.63 — quit → blank startup → resume (new manager, same session id) restores the recovery probe", async () => {
  const cwd = tmpCwd();
  seedParkedGoal(cwd, Date.now() + 200);

  const owner = makeMockCtx(cwd, { sessionManager: hostManager("sess-main", undefined) });
  await pi.fire("session_shutdown", { reason: "quit" }, owner);
  assert.match(readLedger(cwd), /"session_shutdown".*"quit"/);

  // Fresh pi process: blank startup (no conversation yet) — the load barrier pends.
  const blank = makeManagerCtx(cwd, hostManager("sess-main", []));
  await pi.fire("session_start", { reason: "startup" }, blank);
  assert.match(readLedger(cwd), /session_waiting_for_load/, "blank startup pends the load barrier");

  // The user resumes: pi delivers a NEW SessionManager object for the SAME
  // session (same id, conversation now loaded, no getSessionFile yet).
  const resume = makeManagerCtx(cwd, hostManager("sess-main", [{ role: "user", content: "hi" }]));
  await pi.fire("session_start", { reason: "resume" }, resume);
  const l = readLedger(cwd);
  assert.match(l, /"session_rebound".*"resume"/, "the resume is NOT dropped at the foreign gate");
  const notifies = (resume.ui as unknown as { notifies: Array<{ message: string }> }).notifies;
  assert.ok(
    notifies.some((n) => n.message.includes("Restored main-model recovery (goal)")),
    `recovery restore notify: ${notifies.map((n) => n.message.slice(0, 60)).join(" | ")}`,
  );

  // The restored probe timer actually fires (the incident's dead countdown).
  await waitFor(() => readLedger(cwd).includes("main_model_probe"));
  assert.match(readLedger(cwd), /main_model_probe/, "the probe runs after the restored timer");
});

test("blank restart paints the durable list objective, recovery owner, and next action before transcript load", async () => {
  const cwd = tmpCwd();
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  seedState(cwd, {
    goal: seedGoal({
      objective: "visible parked list objective",
      status: "paused",
      policy: "list",
      pauseKind: "wait",
      pauseResumeAt: retryAt,
      pauseReason: "main model recovery — provider wall",
      pauseSuggestedAction: "The saved item remains safe; /list resume retries immediately.",
    }),
    list: [{ id: "queued-next", objective: "next durable list item", addedAt: new Date().toISOString() }],
    mainModelRecovery: {
      primary: "anthropic/mock-model",
      active: "anthropic/mock-model",
      attempted: ["anthropic/mock-model"],
      attempts: 1,
      reason: "main model recovery — provider wall",
      kind: "goal",
      retryAt,
    },
  } as unknown as Parameters<typeof seedState>[1]);

  const blank = makeManagerCtx(cwd, hostManager("visible-session", []));
  await pi.fire("session_start", { reason: "startup" }, blank);
  const status = blank.ui.statuses["pi-glla"] ?? "";
  const widget = ((blank.ui.widgets["pi-glla"] as string[] | undefined) ?? []).join("\\n");
  assert.match(widget, /visible parked list objective/, "the current objective is visible during blank startup");
  assert.match(widget, /list item/, "the restored artifact is identified as a list item");
  assert.match(widget, /owner: main-model recovery/, "the recovery owner is rendered from durable state");
  assert.match(widget, /next: retrying automatically/, "the next transition is rendered from durable recovery state");
  // v0.38.31: recovery-timer waits end at the auto-retry row — the generic
  // suggested-action tail is gone (owner + next above carry the facts).
  assert.doesNotMatch(widget, /remains safe/, "no generic boilerplate tail on the wait card");
  assert.match(status, /main-model recovery/, "the status bar also names the recovery owner");
});

test("v0.34.63 — a lifecycle start with a DIFFERENT session id stays refused while the barrier pends", async () => {
  const cwd = tmpCwd();
  seedParkedGoal(cwd, Date.now() + 200);

  const owner = makeMockCtx(cwd, { sessionManager: hostManager("sess-main", undefined) });
  await pi.fire("session_shutdown", { reason: "quit" }, owner);
  const blank = makeManagerCtx(cwd, hostManager("sess-main", []));
  await pi.fire("session_start", { reason: "startup" }, blank);
  assert.match(readLedger(cwd), /session_waiting_for_load/);

  // A same-workspace lifecycle event from a DIFFERENT session (e.g. a
  // worker, or the user resuming another session file) must not steal the
  // parked plane: no rebind, no restore, no probe.
  const stranger = makeManagerCtx(cwd, hostManager("sess-other", [{ role: "user", content: "hi" }]));
  await pi.fire("session_start", { reason: "resume" }, stranger);
  const l = readLedger(cwd);
  assert.doesNotMatch(l, /"session_rebound".*"resume"/, "foreign lifecycle start is refused");
  await tick(500);
  assert.doesNotMatch(readLedger(cwd), /main_model_probe/, "no probe is armed for the refused session");
});

test("v0.34.63 — source guard: the barrier-completing resume gate is wired before the foreign-session return", () => {
  const SRC = readGoalRuntimeSource();
  assert.match(SRC, /const barrierAwaitingLoadedSession = initialSessionLoadPending && lifecycleSignal;/);
  assert.match(SRC, /resumeCompletesLoad = barrierAwaitingLoadedSession/);
  // v0.38.83: the gate moved verbatim into admitSessionStart, where refusal
  // returns null (the caller returns). The wired condition is unchanged.
  assert.match(SRC, /if \(foreignRecordedSession && !hostLifecycleStart && !resumeCompletesLoad\) return( null)?;/);
  assert.match(SRC, /sameSessionIdentity\(ctx\.sessionManager, recordedOwner\)/);
});
