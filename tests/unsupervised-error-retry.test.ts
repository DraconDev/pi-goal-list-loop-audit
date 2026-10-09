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
  pi.modelSelections.length = 0;
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


async function failoverOrdinaryRequest(prompt: string): Promise<MockCtx> {
  const ctx = await boot();
  // Handoff tests deliberately select the immediate-rotation policy; the
  // default same-model phase is tested separately before this helper.
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ mainModelFallbacks: ["provider/backup"], mainModelSameModelRetries: 0 }));
  (ctx as any).modelRegistry = { find: (provider: string, id: string) => ({ provider, id, reasoning: true }), hasConfiguredAuth: () => true };
  await pi.fire("before_agent_start", { prompt, systemPrompt: "Original instructions" }, ctx);
  await pi.fire("agent_end", errTurn("503 Service temporarily unavailable"), ctx);
  assert.deepEqual(pi.modelSelections.map((m: any) => `${m.provider}/${m.id}`), ["provider/backup"]);
  (ctx as any).model = { provider: "provider", id: "backup" };
  return ctx;
}

test("fallback continues an interrupted ordinary task after settlement with the original request", async () => {
  const ctx = await failoverOrdinaryRequest("Implement the export action and verify round-trip data");
  assert.equal(sentRetries().length, 0, "do not enqueue before the failed run settles");
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 1);
  const retry = sentRetries()[0]!;
  assert.match(String(retry.message.content), /Implement the export action and verify round-trip data/);
  assert.match(String(retry.message.content), /Do not repeat successful actions/);
  assert.match(String(retry.message.content), /model change does not finish or replace the task/);
  assert.deepEqual(retry.options, { triggerTurn: true, deliverAs: "followUp" });
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 1, "repeated settlement must not duplicate the handoff");
});

test("fallback handoff waits for idle and does not override a user abort", async () => {
  const ctx = await failoverOrdinaryRequest("Continue investigating the saved blockers");
  ctx.isIdle = () => false;
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 0);
  ctx.isIdle = () => true;
  ctx.hasPendingMessages = () => true;
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 0);
  ctx.hasPendingMessages = () => false;
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, ctx);
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 0, "Escape is not permission to restart the interrupted request");
});

test("a successful core retry consumes fallback recovery without a duplicate handoff", async () => {
  const ctx = await failoverOrdinaryRequest("Finish the current task");
  await pi.fire("agent_end", cleanTurn(), ctx);
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 0);
});


test("fallback send failure preserves the pending handoff and retries the same request on fresh settlement", async () => {
  const ctx = await failoverOrdinaryRequest("Finish the positioning probe already in progress");
  pi.sendMessageError = new Error("host could not enqueue");
  try {
    await pi.fire("agent_settled", {}, ctx);
    assert.equal(sentRetries().length, 0);
    assert.ok(ctx.ui.matching("continuation could not be sent").length);
  } finally { pi.sendMessageError = null; }
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 1);
  assert.match(String(sentRetries()[0]!.message.content), /Finish the positioning probe already in progress/);
});

test("long interrupted requests use a bounded handoff without growing nested retry prompts", async () => {
  const ctx = await failoverOrdinaryRequest("Start the requested work. " + "request details ".repeat(600) + "Preserve the final acceptance criteria.");
  await pi.fire("agent_settled", {}, ctx);
  const content = String(sentRetries()[0]!.message.content);
  assert.ok(content.length < 6000);
  assert.match(content, /Start the requested work/);
  assert.match(content, /Preserve the final acceptance criteria/);
  assert.match(content, /read the complete original request in conversation/);
});


test("exhausted ordinary fallback chain uses backoff instead of another immediate switch handoff", async () => {
  const ctx = await failoverOrdinaryRequest("Finish the saved export task");
  __testOnlySetUnsupervisedErrorRetryDelay(150);
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 1);
  await pi.fire("agent_end", errTurn("503 Service temporarily unavailable"), ctx);
  await pi.fire("agent_settled", {}, ctx);
  assert.equal(sentRetries().length, 1, "no model was selected this time; settlement must not immediately resend");
  assert.ok(ledger().some(e => e.type === "unsupervised_error_retry_scheduled"), "ordinary exhaustion has a real retry owner");
  await tick(300);
  assert.equal(sentRetries().length, 2, "the passive failover episode must not suppress its retry timer");
  assert.match(String(sentRetries()[1]!.message.content), /Finish the saved export task/);
});


test("ordinary exhaustion retry respects a supervisor pause introduced while waiting", async () => {
  const ctx = await failoverOrdinaryRequest("Keep investigating the current task");
  __testOnlySetUnsupervisedErrorRetryDelay(100);
  await pi.fire("agent_settled", {}, ctx);
  await pi.fire("agent_end", errTurn("503 Service temporarily unavailable"), ctx);
  await pi.command("glla", "pause", ctx);
  await tick(250);
  assert.equal(sentRetries().length, 1, "freeze prevents the pending ordinary retry");
});

test("authentication failure after ordinary chain exhaustion does not become a blind handoff", async () => {
  const ctx = await failoverOrdinaryRequest("Finish the authorized task");
  __testOnlySetUnsupervisedErrorRetryDelay(40);
  await pi.fire("agent_settled", {}, ctx);
  await pi.fire("agent_end", errTurn("HTTP 401 invalid API key"), ctx);
  await pi.fire("agent_settled", {}, ctx);
  await tick(150);
  assert.equal(sentRetries().length, 1);
  assert.ok(ledger().some(e => e.type === "unsupervised_error_retry_refused" && e.value.reason === "auth"));
});
