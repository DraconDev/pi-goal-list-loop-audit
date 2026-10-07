// v0.38.104 (field: neonbreak, Screenshot 20260928 174457): the continuation
// lane's unacknowledged-turn-start path was a permanent dead end.
//
//   "continuation was accepted, but pi did not start a turn"
//   "automatic re-sends are stopped · /list resume to retry once"
//   list item · interrupted · total 26m 00s
//
// The main lane re-probes through the same class of stall; the continuation
// lane demanded a human. It now self-heals on a bounded, slowing cadence and
// only parks for real when the budget is spent.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlySetContinuationRetryBackoff,
  __testOnlySetContinuationStartTimeout,
} from "../extensions/loops/goal.js";
import {
  CONTINUATION_START_SELF_HEAL_MAX_MS,
  CONTINUATION_START_SELF_HEAL_MAX_PROBES,
  CONTINUATION_START_SELF_HEAL_MIN_MS,
  clearContinuationStartSelfHeal,
  __testOnlySetContinuationStartSelfHealDelay,
  __testOnlySetContinuationStartSelfHealMaxProbes,
  continuationStartSelfHealDelayMs,
  resetContinuationDispatchState,
} from "../extensions/goal-continuation.js";
import { state } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

let lastCwd = "";

function ledgerText(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  } catch {
    return "";
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the continuation self-heal state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function context(cwd: string, name: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: { name } });
}

afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  resetContinuationDispatchState(lastCwd);
  clearContinuationStartSelfHeal();
  __testOnlySetContinuationStartSelfHealDelay(null);
  __testOnlySetContinuationStartSelfHealMaxProbes(CONTINUATION_START_SELF_HEAL_MAX_PROBES);
  __testOnlySetContinuationStartTimeout(null);
  __testOnlySetContinuationRetryBackoff(null);
  pi.sent.length = 0;
});

test("v0.38.104: the self-heal cadence is bounded on both sides", () => {
  assert.equal(continuationStartSelfHealDelayMs(0), CONTINUATION_START_SELF_HEAL_MIN_MS, "the first probe is quick enough to matter");
  assert.equal(continuationStartSelfHealDelayMs(1), 2 * CONTINUATION_START_SELF_HEAL_MIN_MS, "then it doubles");
  assert.equal(continuationStartSelfHealDelayMs(99), CONTINUATION_START_SELF_HEAL_MAX_MS, "and it is capped — no 30×/hour polling");
  assert.equal(continuationStartSelfHealDelayMs(-3), CONTINUATION_START_SELF_HEAL_MIN_MS, "a negative index floors");
  assert.ok(CONTINUATION_START_SELF_HEAL_MAX_PROBES > 0, "the probe budget is a real bound");
});

test("v0.38.104: an unacknowledged turn start self-heals instead of demanding a human", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(250);
  __testOnlySetContinuationRetryBackoff(250);
  const cwd = tmpCwd();
  lastCwd = cwd;
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  const ctx = context(cwd, `self-heal-${Date.now()}-${Math.random()}`);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("goal", "self-healing retry target — done when pinned", ctx);
    await tick();
    // No turn-start proof is ever fired here, so the watchdog runs: one
    // automatic retry, then the unacknowledged settlement.
    await waitUntil(() => ledgerText(cwd).includes("continuation_start_unacknowledged"), 10_000);
    assert.equal(pi.sent.length, 2, "the one automatic retry still happened — no storm");

    // The dead end is gone: the lane arms a self-heal instead of stopping.
    const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
    assert.ok(fs.existsSync(sidecar), "the dispatch sidecar exists for the settle to re-drive");
    const record = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json"), "utf8")) as { phase?: string };
    assert.equal(record.phase, "unacknowledged", "the claim is settled, not lost");

    // The operator is told the truth: paused, but self-healing.
    const notices = ctx.ui.notifies.map((n) => n.message).join("\n");
    assert.match(notices, /re-probes itself/i, "the warning names the self-heal instead of promising to stop");
    assert.doesNotMatch(notices, /Automatic re-sends are stopped/i, "the dead-end promise is gone");

    // Source pin for the wiring: an unacknowledged settle must arm the
    // self-heal, and a turn-start proof must clear it.
    const src = fs.readFileSync(path.join(__dirname, "..", "extensions", "goal-continuation.ts"), "utf8");
    const settle = src.slice(src.indexOf("function dispatchStartUnacknowledged"), src.indexOf("function armContinuationStartWatchdog"));
    assert.match(settle, /armContinuationStartSelfHeal\(ctx, record\)/, "the settle arms the self-heal");
    const acked = src.slice(src.indexOf("export function dispatchStartAcknowledged"));
    assert.match(acked.slice(0, 2_400), /clearContinuationStartSelfHeal\(\)/, "a turn-start proof clears the self-heal and resets the budget");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

for (const lane of ["goal", "loop"] as const) {
  test(`${lane} self-heal timer actually redispatches the settled lane and acknowledges recovery`, async () => {
    __testOnlySetContinuationStartTimeout(80);
    __testOnlySetContinuationRetryBackoff(80);
    __testOnlySetContinuationStartSelfHealDelay(120);
    lastCwd = tmpCwd();
    fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
    const ctx = context(lastCwd, `timer-${lane}-${Math.random()}`);
    await pi.fire("session_start", { reason: "startup" }, ctx);
    try {
      await pi.command(lane, lane === "loop" ? "start bounded self-heal target" : "bounded self-heal target — done when pinned", ctx);
      await waitUntil(() => ledgerText(lastCwd).includes("continuation_start_unacknowledged"));
      if (lane === "loop") {
        assert.equal(state.loop?.active, false, "timeout parks this loop");
        assert.match(ctx.ui.notifies.map(n => n.message).join("\n"), /\/loop resume/);
      }
      await waitUntil(() => pi.sent.length >= 3);
      assert.equal(pi.sent.length, 3, "exactly one fresh dispatch follows the retry pair");
      assert.match(ledgerText(lastCwd), /continuation_start_self_heal_fired/);
      assert.doesNotMatch(ledgerText(lastCwd), /continuation_start_self_heal_cancelled/);
      if (lane === "loop") assert.equal(state.loop?.active, true, "only the timeout park is lifted");
      await pi.fire("agent_start", {}, ctx);
      const record = ledgerText(lastCwd);
      assert.match(record, /continuation_start_acknowledged/);
      const sent = pi.sent.length;
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(pi.sent.length, sent, "turn proof cancels further watchdog/self-heal sends");
    } finally {
      await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    }
  });
}

for (const lane of ["goal", "loop"] as const) {
  test(`${lane} self-heal never revives a replaced goal or deliberately stopped loop`, async () => {
    __testOnlySetContinuationStartTimeout(80);
    __testOnlySetContinuationRetryBackoff(80);
    __testOnlySetContinuationStartSelfHealDelay(120);
    lastCwd = tmpCwd();
    fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
    const ctx = context(lastCwd, `cancel-${lane}-${Math.random()}`);
    await pi.fire("session_start", { reason: "startup" }, ctx);
    try {
      await pi.command(lane, lane === "loop" ? "start cancelled self-heal target" : "cancelled self-heal target — done when pinned", ctx);
      await waitUntil(() => ledgerText(lastCwd).includes("continuation_start_unacknowledged"));
      if (lane === "goal") state.goal = { ...state.goal!, id: "replacement" };
      else state.loop = { ...state.loop!, active: false, stopReason: "user stopped" };
      const sent = pi.sent.length;
      await waitUntil(() => ledgerText(lastCwd).includes("continuation_start_self_heal_cancelled"));
      assert.equal(pi.sent.length, sent);
      if (lane === "loop") assert.equal(state.loop?.stopReason, "user stopped");
      else assert.equal(state.goal?.id, "replacement");
    } finally {
      await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    }
  });
}

// v0.38.104: the reset was gated on `continuationStartSelfHealTimer` being
// live. Both terminal paths null the timer WITHOUT clearing the counter —
// the exhaustion branch and the "lane moved on" cancel — so after the first
// episode spent its budget the counter stayed pinned at the max. The next
// stuck episode then armed at the longest delay and immediately reported an
// already-spent budget with ZERO re-probes, killing the lane's automatic
// recovery for the rest of the session and blaming a budget spent on a
// long-resolved episode.
test("v0.38.104: a turn-start proof resets the budget even when no timer is armed", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "extensions", "goal-continuation.ts"), "utf8");
  const acked = src.slice(src.indexOf("export function dispatchStartAcknowledged"), src.indexOf("export function releaseContinuationDispatchStandDown"));
  const block = acked;

  // The reset must not sit behind a "timer is live" guard — that guard is
  // exactly what made the reset unreachable after an exhaustion.
  assert.doesNotMatch(
    block,
    /if \(continuationStartSelfHealTimer\) \{\s*\n\s*appendLedger\([^;]*\);\s*\n\s*clearContinuationStartSelfHeal\(\);\s*\n\s*\}/,
    "the budget reset must not be conditional on an armed timer",
  );
  assert.match(
    block,
    /continuationStartSelfHealProbes > 0[\s\S]{0,200}clearContinuationStartSelfHeal\(\)/,
    "an exhausted counter (timer already null) is still reset on a turn-start proof",
  );
  assert.ok(
    block.indexOf("continuationStartSelfHealProbes > 0") !== -1 && block.indexOf("continuationStartSelfHealProbes > 0") < block.indexOf("clearContinuationStartSelfHeal()"),
    "the exhausted-counter check must gate the reset call, not follow it",
  );

  // And the two paths that null the timer must leave the counter consistent:
  // the exhaustion branch is the one that strands it.
  const arm = src.slice(src.indexOf("function armContinuationStartSelfHeal"), src.indexOf("function armContinuationStartWatchdog"));
  assert.match(
    arm,
    /continuationStartSelfHealTimer = null;[\s\S]*probe > continuationStartSelfHealMaxProbes/,
    "exhaustion still nulls the timer first — which is why the reset must not depend on it",
  );
});
