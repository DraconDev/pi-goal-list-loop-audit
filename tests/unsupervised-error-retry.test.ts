// pi-goal-list-loop-audit — v0.38.105
// tests/unsupervised-error-retry.test.ts
//
// Field 2026-09-30 (ai-auto-video screenshot): a provider error
// ("Provider returned an empty response") in a session with no active
// goal/loop/list ended the turn with nothing but a ledger line — the
// session idled at the prompt until the user noticed. Transient failures
// now retry on the uniform cadence; the carve-outs match the supervised
// lanes exactly (aborts/policy never, auth/billing/deterministic/overflow
// never blind-retry, quota sleeps).

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlyResetProcessState,
} from "../extensions/loops/goal.js";
import {
  __testOnlyResetUnsupervisedErrorRetry,
  __testOnlySetUnsupervisedErrorRetryDelay,
} from "../extensions/loops/goal-activation.js";
import { resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
let savedGlobalSettings: string | undefined;
let cwd = "";

beforeEach(() => {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetUnsupervisedErrorRetry();
  pi.sent.length = 0;
  try { savedGlobalSettings = fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf-8"); } catch { savedGlobalSettings = undefined; }
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
});

afterEach(() => {
  __testOnlyResetUnsupervisedErrorRetry();
  if (cwd) resetContinuationDispatchState(cwd);
  cwd = "";
  if (savedGlobalSettings === undefined) {
    try { fs.unlinkSync(GLOBAL_SETTINGS_PATH); } catch { /* never written */ }
  } else {
    fs.writeFileSync(GLOBAL_SETTINGS_PATH, savedGlobalSettings);
  }
});

async function boot(seeded?: Record<string, unknown>): Promise<MockCtx> {
  cwd = tmpCwd();
  if (seeded) seedState(cwd, seeded);
  const file = path.join(cwd, "session.jsonl");
  const ctx = makeMockCtx(cwd, { sessionManager: { getBranch: () => [], getSessionFile: () => file } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return ctx;
}

function errTurn(errorMessage: string) {
  return { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage }] };
}

function cleanTurn() {
  return { messages: [{ role: "assistant", content: [{ type: "text", text: "done, all good" }], stopReason: "end_turn" }] };
}

function ledger(): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value: Record<string, unknown> });
}

function sentRetries() {
  return pi.sent.filter((s) => (s.message as { customType?: string }).customType === "unsupervised-error-retry");
}

test("empty provider response with no goal schedules and dispatches a retry", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  const scheduled = ledger().find((e) => e.type === "unsupervised_error_retry_scheduled");
  assert.ok(scheduled, "the retry is scheduled");
  assert.equal(scheduled.value.attempt, 1);
  assert.ok(ctx.ui.matching("retrying automatically").length > 0, "attempt 1 notifies");
  await tick(150);
  assert.equal(sentRetries().length, 1, "one follow-up re-drives the turn");
  const only = sentRetries()[0];
  assert.ok(only);
  assert.deepEqual((only.options as { triggerTurn: boolean }).triggerTurn, true);
  assert.ok(ledger().some((e) => e.type === "unsupervised_error_retry_dispatched"), "dispatch is ledgered");
});

test("consecutive errors advance the streak; a clean turn clears it", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  const attempts = ledger()
    .filter((e) => e.type === "unsupervised_error_retry_scheduled")
    .map((e) => e.value.attempt);
  assert.deepEqual(attempts, [1, 2], "the streak advances across consecutive errors");
  await tick(150);
  assert.equal(sentRetries().length, 1, "the re-schedule replaces the pending timer, never double-sends");
  // A clean turn proves the provider answers: pending state dies with it.
  __testOnlySetUnsupervisedErrorRetryDelay(30);
  await pi.fire("agent_end", errTurn("socket hang up"), ctx);
  await pi.fire("agent_end", cleanTurn(), ctx);
  await tick(150);
  assert.equal(sentRetries().length, 1, "the clean turn cancelled the pending retry");
  await pi.fire("agent_end", errTurn("socket hang up"), ctx);
  const last = ledger().filter((e) => e.type === "unsupervised_error_retry_scheduled").at(-1)!;
  assert.equal(last.value.attempt, 1, "the streak restarts after a clean turn");
});

test("composite isolation clears a poisoned unsupervised retry streak, timer, and override", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(30_000);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  assert.equal(ledger().filter(e => e.type === "unsupervised_error_retry_scheduled").at(-1)?.value.attempt, 2);
  __testOnlyResetProcessState();
  const nextCtx = await boot();
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), nextCtx);
  const scheduled = ledger().find(e => e.type === "unsupervised_error_retry_scheduled");
  assert.equal(scheduled?.value.attempt, 1);
  assert.notEqual(scheduled?.value.delayMs, 30_000, "the test override cannot leak into a new fixture");
  assert.equal(sentRetries().length, 0, "the poisoned timer did not dispatch during reset");
});

test("user aborts never retry", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, ctx);
  await tick(150);
  assert.equal(sentRetries().length, 0);
  assert.ok(!ledger().some((e) => e.type === "unsupervised_error_retry_scheduled"));
});

test("policy refusals, auth, billing, and deterministic 400s refuse with a reason", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  const cases: Array<[string, string, RegExp | null]> = [
    ["codex error event: invalid prompt", "non-recoverable", null],
    ["401 invalid api key", "auth", /not retrying blindly/],
    ["insufficient credits — buy credits", "billing", /manual action needed/],
    ['BadRequestError: too many images. "code":"400"', "deterministic", /Switch model or trim/],
  ];
  for (const [raw, reason, notice] of cases) {
    await pi.fire("agent_end", errTurn(raw), ctx);
    const refused = ledger().filter((e) => e.type === "unsupervised_error_retry_refused").at(-1);
    assert.equal(refused?.value.reason, reason, raw);
    if (notice) assert.ok(ctx.ui.notifies.some((n) => notice.test(n.message)), `${reason} notifies: ${raw}`);
  }
  await tick(150);
  assert.equal(sentRetries().length, 0, "no carve-out ever dispatches");
  assert.ok(!ledger().some((e) => e.type === "unsupervised_error_retry_scheduled"));
});

test("context overflow compacts instead of retrying", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", errTurn("prompt too large for model"), ctx);
  const refused = ledger().filter((e) => e.type === "unsupervised_error_retry_refused").at(-1);
  assert.equal(refused?.value.reason, "context-overflow");
  assert.ok(ctx.ui.matching("compacting instead of retrying").length > 0);
  await tick(150);
  assert.equal(sentRetries().length, 0);
});

test("hinted quota sleeps until the provider reset; hintless quota ladders", async () => {
  const ctx = await boot();
  // No delay override: the scheduled delayMs must be the uniform cadence.
  await pi.fire("agent_end", errTurn("429 Too Many Requests — retry in 2 hours"), ctx);
  const hinted = ledger().filter((e) => e.type === "unsupervised_error_retry_scheduled").at(-1)!;
  assert.equal(hinted.value.delayMs, 2 * 60 * 60_000, "an explicit reset hint wins over eager");
  await pi.fire("agent_end", errTurn("429 usage limit"), ctx);
  const laddered = ledger().filter((e) => e.type === "unsupervised_error_retry_scheduled").at(-1)!;
  assert.equal(laddered.value.attempt, 2);
  assert.equal(laddered.value.delayMs, 30 * 60_000, "hintless quota climbs the wall ladder, never eager");
});

test("an active goal owns error turns — the unsupervised lane stays silent", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const ctx = await boot({ goal: seedGoal({ status: "active", objective: "supervised work — done when done" }) });
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  await tick(150);
  assert.ok(!ledger().some((e) => e.type.startsWith("unsupervised_error_retry_")), "supervised sessions never touch this lane");
  assert.equal(sentRetries().length, 0);
});

test("a load-held session refuses instead of promising a retry it cannot send", async () => {
  // Without autoResume the seeded goal loads load-held: supervisorPaused()
  // covers the hold, so scheduling refuses rather than notifying
  // "retrying automatically" and standing down at fire time.
  const ctx = await boot({ goal: seedGoal({ status: "active", objective: "held work — done when done" }) });
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", errTurn("Provider returned an empty response"), ctx);
  const refused = ledger().filter((e) => e.type === "unsupervised_error_retry_refused").at(-1);
  assert.equal(refused?.value.reason, "supervisor-paused");
  assert.ok(!ledger().some((e) => e.type === "unsupervised_error_retry_scheduled"));
  assert.ok(ctx.ui.matching("retrying automatically").length === 0, "no promise the hold cannot keep");
  await tick(150);
  assert.equal(sentRetries().length, 0);
});

test("a fresh turn stands down the pending retry", async () => {
  const ctx = await boot();
  __testOnlySetUnsupervisedErrorRetryDelay(30);
  await pi.fire("agent_end", errTurn("upstream unavailable"), ctx);
  assert.ok(ledger().some((e) => e.type === "unsupervised_error_retry_scheduled"));
  await pi.fire("turn_start", {}, ctx);
  await tick(150);
  assert.equal(sentRetries().length, 0, "the user's turn IS the retry");
});

test("a busy session at fire time stands down instead of double-driving", async () => {
  cwd = tmpCwd();
  const file = path.join(cwd, "session.jsonl");
  const busy = makeMockCtx(cwd, { sessionManager: { getBranch: () => [], getSessionFile: () => file }, pending: true });
  await pi.fire("session_start", { reason: "startup" }, busy);
  __testOnlySetUnsupervisedErrorRetryDelay(20);
  await pi.fire("agent_end", errTurn("fetch failed"), busy);
  await tick(150);
  assert.equal(sentRetries().length, 0, "pending user messages veto the dispatch");
});
