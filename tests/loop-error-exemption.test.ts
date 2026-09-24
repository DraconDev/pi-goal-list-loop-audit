// v0.29.19 — provider-error/user-abort turns must not feed loop stall/
// stuck/plateau accounting; audit plateau gate (open findings = the well
// isn't dry); resumable stop classes.
//
// Field case (2026-07-31, MiniMax token-plan 429 storm overnight): every
// fleet loop died on DEAD turns, not on the work — hegemon plateau-stopped
// at best 74 with 13 open findings, polis at best 46 with 3+, hellhunter
// stuck-stopped at iter 93. The v0.28.13/v0.29.4 exemptions only covered
// the goal nudge counter; the loop's own accounting counted 429 corpses.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetStaleFlag, __testOnlyResetOwnerSession, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { requiresMainModelRecovery } from "../extensions/main-model-recovery.js";
import { resetLengthContinue } from "../extensions/length-continue.js";
import { __testOnlyResetLengthExhaustionEpisodes } from "../extensions/loops/goal-activation.js";
import { readState } from "../extensions/goal-loop-core.js";
import { auditMeasureCmd, AUDIT_FINDINGS_REL } from "../extensions/goal-loop-forever.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedLoop, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession(); // release the claim so later files are unaffected
});

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession(); // behavioral-orchestrator's owner claim precedes this file
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

function errTurn() {
  return { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429: rate_limit_error" }] };
}
function abortTurn() {
  return { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "aborted" }] };
}
let workSeq = 0;
function workTurn() {
  // unique text per turn — identical narration trips the v0.24.0 repetition
  // detector ("same response 3+ times") before the plateau can fire.
  workSeq++;
  const words = ["inspect", "adjust", "verify", "tighten", "document", "measure"];
  const unique = `turn ${workSeq}: ${words[workSeq % 6] ?? "polish"} different aspect ${"abcxyz".charAt(workSeq % 6).repeat(workSeq % 5 + 1)}`;
  return { messages: [{ role: "assistant", content: [{ type: "text", text: `did ${unique} on the loop target` }], stopReason: "end_turn" }] };
}
async function fireWork(ctx: MockCtx): Promise<void> {
  await pi.fire("tool_call", {}, ctx);
  await pi.fire("agent_end", workTurn(), ctx);
  await tick();
}
function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
}
type LoopSnap = {
  active: boolean; iteration: number; stallCount: number; bestValue: number | null;
  stopReason?: string; consecutiveErrors?: number; consecutiveStuck?: number;
  auditPlateauReprieves?: number; auditReprieveNote?: string; kind?: string;
  completionSummary?: string;
};
function loop(cwd: string): LoopSnap {
  return readState(cwd).loop as LoopSnap;
}

function assertCompactLoopRecap(ctx: MockCtx): void {
  const recap = ctx.ui.notifies.find((notice) => notice.message.includes("Recap: Outcome:"));
  assert.ok(recap, `terminal loop notification includes a recap: ${ctx.ui.notifies.map((notice) => notice.message).join(" | ")}`);
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Unresolved:", "Next:"]) {
    assert.ok(recap!.message.includes(label), `terminal loop recap includes ${label}`);
  }
  assert.doesNotMatch(recap!.message, /Tests:/, "technical Tests stays out of the default loop recap");
}
/** Seed an ACTIVE loop that survives the session-restore gate. */
async function sessionWithLoop(cwd: string, overrides: Record<string, unknown>): Promise<MockCtx> {
  seedState(cwd, { loop: seedLoop(overrides) });
  setGlobalAutoResume(true); // restore gate auto-resumes the active loop
  return freshSession(cwd, "startup");
}

test("v0.29.19: provider-error turns are NOT iterations — no measure, no stall, no stuck; loop stays active", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74, stallCount: 2 });
  for (let i = 0; i < 3; i++) {
    await pi.fire("agent_end", errTurn(), ctx);
    await tick();
  }
  const l = loop(cwd);
  assert.equal(l.active, true, "loop survives error turns");
  assert.equal(l.iteration, 1, "error turns are not iterations");
  assert.equal(l.stallCount, 2, "stall count untouched by dead turns");
  assert.equal(l.consecutiveErrors, 3, "dead-turn streak tracked");
  const lg = ledger(cwd);
  assert.ok(lg.includes('"loop_turn_exempt_error"'), "exemption ledgered");
  assert.ok(!lg.includes('"loop_measured"'), "no measurement on dead turns");
  assert.ok(!lg.includes('"loop_stuck"'), "no stuck accounting on dead turns (hellhunter class)");
});

test("v0.35.x: repeated in-band provider tool output parks recovery without loop stuck accounting", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74 });
  const providerPane = {
    toolName: "bash",
    output: "HTTP 503 upstream unavailable",
    isError: false,
  };
  for (let turn = 0; turn < 6; turn++) {
    for (let i = 0; i < 3; i++) await pi.fire("tool_result", providerPane, ctx);
    await pi.fire("agent_end", workTurn(), ctx);
    await tick();
  }
  const l = loop(cwd);
  assert.equal(l.active, false, "the provider recovery envelope parks the loop");
  assert.match(l.stopReason ?? "", /^main model recovery — retrying in /);
  assert.equal(l.iteration, 1, "the in-band provider turn is not an iteration");
  assert.equal(l.stallCount, 0, "the in-band provider turn does not move plateau state");
  assert.ok(readState(cwd).mainModelRecovery, "main-model recovery is durable");
  const lg = ledger(cwd);
  assert.ok(lg.includes('"loop_in_band_provider_failure"'), "the repeated pane is ledgered");
  assert.ok(lg.includes('"loop_turn_exempt_error"'), "the turn uses the existing error exemption");
  assert.ok(!lg.includes('"loop_stuck"'), "the repeated provider pane never reaches stuck accounting");
});

test("explicit in-band prompt-policy refusal stops a loop on its first pane", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  const cwd = tmpCwd();
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74 });
  let aborts = 0;
  ctx.abort = () => { aborts++; };
  const sentBefore = pi.sent.length;
  try {
    await pi.fire("tool_result", {
      toolName: "bash",
      output: "HTTP 500 — Codex error event: invalid prompt",
      isError: false,
    }, ctx);
    await pi.fire("agent_end", {
      messages: [{ role: "assistant", content: [], stopReason: "end_turn" }],
    }, ctx);
    await tick(250);
    const l = loop(cwd);
    assert.equal(l.active, false, "the explicit policy pane stops the loop immediately");
    assert.match(l.stopReason ?? "", /policy violation/);
    assert.equal(l.iteration, 1, "policy refusal is not an iteration");
    assert.equal(readState(cwd).mainModelRecovery, undefined);
    assert.equal(aborts, 1, "the owning host turn is aborted once");
    assert.equal(pi.sent.length, sentBefore, "no automatic retry continuation is sent");
    const lg = ledger(cwd);
    assert.match(lg, /main_model_prompt_policy_terminal/);
    assert.doesNotMatch(lg, /main_model_recovery_wait/);
    assertCompactLoopRecap(ctx);
  } finally {
    __testOnlyResetTerminalFlags();
  }
});

test("v0.29.19: a real turn after errors clears the streak and measures normally", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  pi.execHandler = () => ({ code: 0, stdout: "74\n", stderr: "" });
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74 });
  await pi.fire("agent_end", errTurn(), ctx); await tick();
  await pi.fire("agent_end", errTurn(), ctx); await tick();
  assert.equal(loop(cwd).consecutiveErrors, 2);
  await fireWork(ctx);
  const l = loop(cwd);
  assert.equal(l.iteration, 2, "real turn measured as iteration 2");
  assert.equal(l.consecutiveErrors ?? 0, 0, "streak cleared by a real turn");
  assert.equal(l.stallCount, 1, "non-improving real turn counts the stall");
});

test("v0.35.x: recoverable provider failures use the same durable recovery envelope", () => {
  assert.equal(requiresMainModelRecovery({ kind: "rate-limit", raw: "429 too many requests" }), true);
  assert.equal(requiresMainModelRecovery({ kind: "transient", raw: "503 unavailable" }), true);
});

test("v0.34.31: extended quota errors enter durable main-model recovery", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74, iteration: 41 });
  for (let i = 0; i < 6; i++) {
    await pi.fire("agent_end", errTurn(), ctx);
    await tick();
  }
  const l = loop(cwd);
  assert.equal(l.active, false, "extended quota outage parks the loop safely");
  assert.match(l.stopReason ?? "", /^main model recovery — retrying in /, "honest recovery reason");
  assert.ok(readState(cwd).mainModelRecovery?.retryAt, "the next probe is durable");
  assert.equal(l.iteration, 41, "iteration preserved across recovery");
  // /loop resume probes the current model rather than abandoning the loop.
  await pi.command("loop", "resume", ctx);
  await tick();
  const r = loop(cwd);
  assert.equal(r.active, true, "manual resume starts one recovery probe");
  assert.equal(r.iteration, 41, "iteration preserved across resume");
});

test("v0.34.26: loop output-token exhaustion persists and notifies the compact recap", async () => {
  __testOnlyResetStaleFlag();
  resetLengthContinue();
  __testOnlyResetLengthExhaustionEpisodes();
  const cwd = tmpCwd();
  try {
    const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 1", direction: "max", bestValue: 1, lastValue: 1 });
    const lengthEnd = { messages: [{ role: "assistant", content: [{ type: "text", text: "partial loop artifact…" }], stopReason: "length" }] };
    for (let i = 0; i < 3; i++) {
      await pi.fire("agent_end", lengthEnd, ctx);
      await tick();
    }
    // v0.38.68 (relentless): episode 1 stays relentless — the loop keeps
    // running on a fresh truncation budget instead of stopping.
    await pi.fire("agent_end", lengthEnd, ctx);
    await tick();
    assert.equal(loop(cwd).active, true, "first exhaustion stays relentless — loop keeps running");
    // Episode 2 exhausts the fresh budget too — then the durable stop lands.
    for (let i = 0; i < 4; i++) {
      await pi.fire("agent_end", lengthEnd, ctx);
      await tick();
    }
    const l = loop(cwd);
    assert.equal(l.active, false, "the loop stops after repeated truncation");
    assert.match(l.stopReason ?? "", /output-token limit/);
    assertCompactLoopRecap(ctx);
  } finally {
    resetLengthContinue();
    __testOnlyResetLengthExhaustionEpisodes();
  }
});

test("v0.29.19: 3 consecutive user aborts stop the loop — user aborts mean STOP", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74 });
  await pi.fire("agent_end", abortTurn(), ctx); await tick();
  await pi.fire("agent_end", abortTurn(), ctx); await tick();
  assert.equal(loop(cwd).active, true, "2 aborts: loop continues (unchanged from before)");
  await pi.fire("agent_end", abortTurn(), ctx); await tick();
  const l = loop(cwd);
  assert.equal(l.active, false, "third abort stops the loop");
  assert.match(l.stopReason ?? "", /^stopped by user — 3 consecutive aborts/, "honest abort reason");
  assertCompactLoopRecap(ctx);
});

test("v0.29.19: audit plateau with OPEN findings stands down (reprieve), then stops honestly when reprieves run out", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, path.dirname(AUDIT_FINDINGS_REL)), { recursive: true });
  fs.writeFileSync(path.join(cwd, AUDIT_FINDINGS_REL), [
    "- [x] MED: closed thing — fixed in abc1234",
    "- [ ] HIGH: still open one",
    "- [ ] MED: still open two",
    "",
  ].join("\n"));
  // the real audit measure runs through the mock exec: 1 closed box.
  pi.execHandler = () => ({ code: 0, stdout: "1\n", stderr: "" });
  const ctx = await sessionWithLoop(cwd, {
    kind: "audit",
    measureCmd: auditMeasureCmd(),
    direction: "max",
    bestValue: 1,
    lastValue: 1,
    stallCount: 4,
    target: "audit target",
  });
  // measure reads 1 = best → stall 5 → plateau — but 2 boxes are OPEN:
  // the well isn't dry, the stop must stand down.
  await fireWork(ctx);
  let l = loop(cwd);
  assert.equal(l.active, true, "plateau stands down while findings are open");
  assert.equal(l.stallCount, 0, "stall reset by the reprieve");
  assert.equal(l.auditPlateauReprieves, 1, "reprieve counted");
  assert.ok((l.auditReprieveNote ?? "").includes("2 finding(s) still OPEN"), "one-shot shove armed");
  assert.ok(ledger(cwd).includes('"audit_plateau_reprieve"'), "reprieve ledgered");
  // burn the second reprieve + the final plateau (5 turns each):
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 5; i++) await fireWork(ctx);
  }
  l = loop(cwd);
  assert.equal(l.active, false, "third plateau stops the loop");
  assert.match(l.stopReason ?? "", /no closure in 5×3 iterations despite 2 open findings/, "honest blocked-named stop");
  assert.match(l.completionSummary ?? "", /no closure in 5×3 iterations despite 2 open findings/, "recap reflects the final honest reason, not the provisional plateau");
  assertCompactLoopRecap(ctx);
  // and the honest stop is resumable:
  await pi.command("loop", "resume", ctx);
  await tick();
  const r = loop(cwd);
  assert.equal(r.active, true, "resumed after the blocked-named stop");
  assert.equal(r.auditPlateauReprieves ?? 0, 0, "explicit resume re-arms reprieves");
  assert.equal(r.stallCount, 0, "explicit resume re-arms the stall window");
});

test("v0.29.20: a plain plateau stop is resumable (pre-gate false plateaus recover)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  pi.execHandler = () => ({ code: 0, stdout: "74\n", stderr: "" });
  const ctx = await sessionWithLoop(cwd, { measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74, stallCount: 4 });
  await fireWork(ctx); // stall 5 → plain plateau stop (non-audit loop)
  const l = loop(cwd);
  assert.equal(l.active, false);
  assert.match(l.stopReason ?? "", /^plateau — no improvement/);
  assertCompactLoopRecap(ctx);
  await pi.command("loop", "resume", ctx);
  await tick();
  const r = loop(cwd);
  assert.equal(r.active, true, "plateau-stopped loop resumed");
  assert.equal(r.stallCount, 0, "stall window re-armed");
});

test("v0.29.19: audit plateau with ZERO open findings stops normally — the well is dry", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, path.dirname(AUDIT_FINDINGS_REL)), { recursive: true });
  fs.writeFileSync(path.join(cwd, AUDIT_FINDINGS_REL), "- [x] MED: closed thing — fixed in abc1234\n");
  pi.execHandler = () => ({ code: 0, stdout: "1\n", stderr: "" });
  const ctx = await sessionWithLoop(cwd, {
    kind: "audit",
    measureCmd: auditMeasureCmd(),
    direction: "max",
    bestValue: 1,
    lastValue: 1,
    stallCount: 4,
    target: "audit target",
  });
  await fireWork(ctx);
  const l = loop(cwd);
  assert.equal(l.active, false, "dry well: plateau stop stands");
  assert.match(l.stopReason ?? "", /^plateau — no improvement in 5 consecutive iterations/, "standard plateau reason");
  assert.equal(l.auditPlateauReprieves ?? 0, 0, "no reprieve spent");
  assertCompactLoopRecap(ctx);
});
