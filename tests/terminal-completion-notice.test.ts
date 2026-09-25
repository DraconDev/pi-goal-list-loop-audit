import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  resetContinuationDispatchState,
  sendTerminalCompletionNotice,
} from "../extensions/goal-continuation.js";
import {
  __testOnlyResetZombieAutoRetry,
} from "../extensions/loops/goal-activation.js";
import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { MockPi, makeMockCtx, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

// v0.38.18 track 3 (junk-runner stale waiting-verdict): the detached
// verifier settles asynchronously with only a toast for closure, so the
// transcript's last word stays "the verdict will be applied
// asynchronously" and a later "how are we looking" re-reports the stale
// wait even though the goal is archived. The terminal notice delivers the
// `✓ done` brief INTO the conversation as a followUp turn — exactly once
// per goal, goal-null-safe.

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = {
  name: "main-session-manager",
  entries: [] as any[],
  file: "",
  getBranch() { return this.entries; },
  getSessionFile() { return this.file; },
};
const originalSend = pi.api.sendMessage.bind(pi.api);
pi.api.sendMessage = (message, options) => {
  originalSend(message, options);
  if (options?.triggerTurn === false) {
    const entry = { type: "custom_message", id: String(MAIN_SM.entries.length), ...message };
    MAIN_SM.entries.push(entry);
    fs.appendFileSync(MAIN_SM.file, JSON.stringify(entry) + "\n");
  }
};
const HOOKS_SRC = fs.readFileSync(
  new URL("../extensions/loops/goal-auditor-hooks.ts", import.meta.url),
  "utf-8",
);

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function freshSession(cwd: string): Promise<MockCtx> {
  MAIN_SM.entries = [];
  MAIN_SM.file = path.join(cwd, "session.jsonl");
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

let currentCtx: MockCtx | null = null;

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  resetContinuationDispatchState(tmpCwd());
});

afterEach(async () => {
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  if (currentCtx) {
    resetContinuationDispatchState(currentCtx.cwd);
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("v0.38.18 terminal notice: the done brief lands in the conversation exactly once", async () => {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;

  const sendsBefore = pi.sent.length;
  const first = sendTerminalCompletionNotice(ctx as never, {
    goalId: "20260904162433-qm4iq0",
    outcome: "audit pass closed — suite green",
    details: ["Evidence: 5744 tests green."],
  });
  assert.equal(first, true, "the first notice dispatches");
  assert.equal(pi.sent.length, sendsBefore + 1, "one followUp turn carries the closure");
  const sentText = JSON.stringify(pi.sent[pi.sent.length - 1]);
  assert.match(sentText, /✓ done — audit pass closed/);
  assert.equal(pi.sent.at(-1)?.message.display, true);
  assert.deepEqual(pi.sent.at(-1)?.options, { triggerTurn: false });
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "terminal_completion_notice_sent").length, 1);

  // A second settle for the same goal (retry, duplicate callback, reload
  // replay) must not wake the session again.
  const second = sendTerminalCompletionNotice(ctx as never, {
    goalId: "20260904162433-qm4iq0",
    outcome: "audit pass closed — suite green",
    details: ["Evidence: 5744 tests green."],
  });
  assert.equal(second, true, "already persisted is a valid outbox acknowledgement");
  assert.equal(pi.sent.length, sendsBefore + 1, "no second turn is started");
  assert.equal(readLedger(cwd).filter((e) => e.type === "terminal_completion_notice_sent").length, 2);

  // A different goal gets its own notice.
  const third = sendTerminalCompletionNotice(ctx as never, {
    goalId: "20260904162433-other",
    outcome: "other goal done",
    details: [],
  });
  assert.equal(third, true);
  assert.equal(pi.sent.length, sendsBefore + 2);
});

test("v0.38.18 source: the detached-approval branch closes the transcript", () => {
  // v0.38.99: the call lives in the shared settlement driver, whose
  // context parameter is `ctx`.
  assert.match(HOOKS_SRC, /sendTerminalCompletionNotice\(ctx, \{/);
  assert.match(HOOKS_SRC, /replayUndeliveredApprovalRenders/);
});

test("audit-2026-09-06: a stale-generation notice never fires into the successor session", async () => {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  const sendsBefore = pi.sent.length;
  // A verdict produced under an older generation (handoff/reload since)
  // must not inject its `✓ done` turn into the successor's unrelated work.
  const stale = sendTerminalCompletionNotice(ctx as never, {
    goalId: "20260906120000-stale1",
    generation: 2 ** 31,
    outcome: "stale verdict",
    details: [],
  });
  assert.equal(stale, false, "stale generation refused");
  assert.equal(pi.sent.length, sendsBefore, "no turn started in the successor session");
  assert.match(JSON.stringify(readLedger(cwd)), /"terminal_completion_notice_stale_generation"/);
  // The refusal is not a fire-once consumption: the current generation
  // may still deliver for the same goal.
  const fresh = sendTerminalCompletionNotice(ctx as never, {
    goalId: "20260906120000-stale1",
    outcome: "stale verdict",
    details: [],
  });
  assert.equal(fresh, true, "current generation still delivers");
  assert.equal(pi.sent.length, sendsBefore + 1);
});
