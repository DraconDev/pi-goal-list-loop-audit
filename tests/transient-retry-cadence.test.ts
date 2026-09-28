// pi-goal-list-loop-audit — v0.38.109 transient aggressive retry.
//
// Operator direction 2026-09-28: most errors are transient, so the main lane
// AND the subagent lane retry them eagerly instead of parking behind the
// 15m-base wall ladder. Pins:
//   1. Transient-kind failures (5xx/timeout/network) and empty responses get
//      TRANSIENT_EAGER_ATTEMPTS 5s probes, then a short ladder (1m base,
//      30m cap) — never the wall ladder.
//   2. Walls keep the historical cadence: billing/auth/unknown/hintless
//      quota ladder as before; an explicit upstream reset hint still
//      outranks everything including the eager window.
//   3. Recovery probes (diagnostic text only) use the kind-aware delay —
//      this is what parked our own repo goal 300m on 7 empty responses.
//   4. A failed subagent that reads transient nudges the parent to
//      re-dispatch immediately (ledger + notify); aborts, auth/billing,
//      and opaque exits stay silent; the nudge fires once per run.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  classifyMainModelFailure,
  isEagerRetryFailure,
  mainModelFailureDelayMs,
  probeRetryDelayMs,
  transientRetryDelayMs,
  TRANSIENT_EAGER_ATTEMPTS,
  TRANSIENT_LADDER_BASE_MINUTES,
  TRANSIENT_LADDER_CAP_MINUTES,
} from "../extensions/main-model-recovery.js";
import {
  describeSubagentTerminal,
  observeCurrentSubagentTerminal,
  subagentTerminalAlreadyRecorded,
  __testOnlyClearSubagentHangProbes,
} from "../extensions/goal-heartbeat.js";

const nowMs = Date.parse("2026-09-28T12:00:00Z");
const transient = (raw: string) => classifyMainModelFailure(raw);

afterEach(() => {
  __testOnlyClearSubagentHangProbes();
});

test("transient weather hammers: 10 eager probes through the real classifier", () => {
  for (const raw of [
    "503 Service Unavailable",
    "upstream timeout after 30s",
    "fetch failed: socket hangup",
    "Provider returned an empty response",
  ]) {
    const f = transient(raw);
    assert.ok(isEagerRetryFailure(f), `${raw} must read eager`);
    for (let attempt = 1; attempt <= TRANSIENT_EAGER_ATTEMPTS; attempt++) {
      assert.equal(mainModelFailureDelayMs(f, attempt, 15, nowMs), 5_000, `${raw} attempt ${attempt}`);
    }
  }
});

test("post-eager transient ladder: 1m base doubling to the 30m cap", () => {
  assert.equal(TRANSIENT_LADDER_BASE_MINUTES, 1);
  assert.equal(TRANSIENT_LADDER_CAP_MINUTES, 30);
  const f = transient("503 Service Unavailable");
  assert.equal(mainModelFailureDelayMs(f, 11, 15, nowMs), 60_000, "attempt 11 is rung 1");
  assert.equal(mainModelFailureDelayMs(f, 12, 15, nowMs), 120_000);
  assert.equal(mainModelFailureDelayMs(f, 13, 15, nowMs), 240_000);
  assert.equal(mainModelFailureDelayMs(f, 15, 15, nowMs), 16 * 60_000);
  assert.equal(mainModelFailureDelayMs(f, 16, 15, nowMs), 30 * 60_000, "32m clamps to the 30m cap");
  assert.equal(mainModelFailureDelayMs(f, 40, 15, nowMs), 30 * 60_000, "stays capped, never parks for hours");
  assert.equal(transientRetryDelayMs(11, 60), 60_000, "a configured 60m base does not slow transient");
  assert.equal(transientRetryDelayMs(11, 0.5), 30_000, "a sub-1m configured base is honored");
});

test("walls keep the historical ladder; a reset hint outranks the eager window", () => {
  for (const raw of ["insufficient credits — buy credits", "401 invalid API key", "mysterious prose"]) {
    assert.equal(mainModelFailureDelayMs(transient(raw), 2, 15, nowMs), 30 * 60_000, raw);
  }
  assert.equal(mainModelFailureDelayMs(transient("429 usage limit"), 2, 15, nowMs), 30 * 60_000, "hintless quota still ladders");
  const hinted = transient("503 rate limit exceeded, retry in 300 seconds");
  assert.equal(hinted.kind, "transient");
  assert.equal(mainModelFailureDelayMs(hinted, 2, 15, nowMs), 300_000, "an explicit reset hint beats eager even for transient");
});

test("recovery probes use the kind-aware delay (the 300m park)", () => {
  // Our own repo goal: 7 empty responses parked 300m on the blind ladder.
  assert.equal(probeRetryDelayMs("Provider returned an empty response", 7, 15, nowMs), 5_000);
  assert.equal(probeRetryDelayMs("503 upstream overloaded", 2, 15, nowMs), 5_000);
  assert.equal(probeRetryDelayMs("", 2, 15, nowMs), 30 * 60_000, "no signal keeps the historical ladder");
  assert.equal(probeRetryDelayMs(undefined, 2, 15, nowMs), 30 * 60_000);
  assert.equal(probeRetryDelayMs("insufficient credits", 2, 15, nowMs), 30 * 60_000, "walls keep the ladder");
});

test("describeSubagentTerminal: transient text is eager, walls and aborts are not", () => {
  const failed = { id: "run-transient", agent: "scout", hasError: true, error: "upstream timeout after 30s" };
  const d = describeSubagentTerminal(failed)!;
  assert.equal(d.failed, true);
  assert.equal(d.kind, "transient");
  assert.equal(d.eager, true);
  assert.equal(d.agent, "scout");

  const empty = describeSubagentTerminal({ id: "run-empty", hasError: true, message: "Provider returned an empty response" })!;
  assert.equal(empty.eager, true, "empty blip without kind is still eager");

  const oom = describeSubagentTerminal({ id: "run-oom", exitCode: 137 })!;
  assert.equal(oom.failed, true);
  assert.equal(oom.kind, "transient");
  assert.equal(oom.eager, true, "OOM under load reads transient even textless");

  const sigterm = describeSubagentTerminal({ id: "run-term", exitCode: 143 })!;
  assert.equal(sigterm.failed, true);
  assert.equal(sigterm.eager, false, "SIGTERM may be the user's Esc — never nag");

  const abort = describeSubagentTerminal({ id: "run-abort", hasError: true, error: "turn aborted: user interrupt" })!;
  assert.equal(abort.eager, false, "user aborts stay silent");

  const auth = describeSubagentTerminal({ id: "run-auth", hasError: true, error: "401 invalid API key" })!;
  assert.equal(auth.eager, false, "auth walls are not re-dispatch prompts");

  const opaque = describeSubagentTerminal({ id: "run-opaque", hasError: true })!;
  assert.equal(opaque.failed, true);
  assert.equal(opaque.kind, "unknown");
  assert.equal(opaque.eager, false);

  const clean = describeSubagentTerminal({ id: "run-clean", exitCode: 0 })!;
  assert.equal(clean.failed, false);
  assert.equal(clean.eager, false);

  assert.equal(describeSubagentTerminal({}), undefined, "no record id, no decision");

  const long = describeSubagentTerminal({ id: "run-long", hasError: true, error: `boom: ${"x".repeat(500)}` })!;
  assert.ok(long.detail.length <= 160, `detail bounded, got ${long.detail.length}`);
});

test("subagentTerminalAlreadyRecorded: the nudge fires once per run", () => {
  const id = `run-dup-${Date.now()}`;
  const data = { id, hasError: true, error: "fetch failed" };
  assert.equal(subagentTerminalAlreadyRecorded(data), false);
  observeCurrentSubagentTerminal(data);
  assert.equal(subagentTerminalAlreadyRecorded(data), true);
  assert.equal(subagentTerminalAlreadyRecorded({}), true, "no id records nothing");
});

test("wiring: the process-terminal handler ledger-nudges eager child failures", () => {
  const activation = fs.readFileSync("extensions/loops/goal-activation.ts", "utf-8");
  assert.match(activation, /describeSubagentTerminal\(data\)/, "the handler reads the retry decision");
  assert.match(activation, /subagent_terminal_failure/, "failed terminals are ledgered");
  assert.match(activation, /safe to re-dispatch now/, "transient children nudge the parent");
  assert.match(
    activation,
    /if \(terminal\.eager && supervised\)/,
    "the notify fires only for eager failures on supervised work",
  );
});

test("wiring: recovery probes route through the kind-aware delay", () => {
  const recovery = fs.readFileSync("extensions/goal-recovery.ts", "utf-8");
  const sites = recovery.split("probeRetryDelayMs(").length - 1;
  assert.equal(sites, 3, `three probe scheduling sites, got ${sites}`);
  assert.match(recovery, /probeRetryDelayMs\(next\.providerErrorDiagnostic/);
  assert.match(recovery, /probeRetryDelayMs\(recovery\.providerErrorDiagnostic/);
});
