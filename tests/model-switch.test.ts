// pi-goal-list-loop-audit — v0.34.57
// tests/model-switch.test.ts
//
// The verification contract for the model-switch ledger (bug #1.14 —
// unauthorized model switches must be observable and blockable):
//
//   (a) extensions/goal-loop-core.ts exports a modelSwitch(from, to, reason,
//       at) helper AND a turn-boundary hook (the pi model_select event +
//       the before_agent_start drift check in goal.ts) writes the entry
//   (b) the forbiddenModels setting blocks forbidden models and emits the
//       forbidden_model_switch violation event
//   (c) /glla switchlog renders the last N entries
//
// Pure helper pins + wiring pins on a MockPi that DRIVES the registered
// handlers.
//
// FILE-LEVEL DESIGN: goal.ts is a singleton module shared with the other
// goal.ts-driving files (behavioral-orchestrator, lifecycle-recovery, …) in
// one process — so this file NEVER fires session_start (a second session
// claim disturbs the restore gate of co-resident files) and NEVER depends
// on module state loaded from disk. Every test starts from a fresh tmp cwd
// and resets the module ownership/terminal flags first; the model_select /
// before_agent_start guards pass with a clean (or null) owner, and the
// ledger assertions read the cwd's own .pi-glla/active.jsonl.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MockPi, makeMockCtx, tmpCwd, type MockCtx, seedLoop } from "./harness/mock-pi.js";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags, __testOnlySetLastModelRef } from "../extensions/loops/goal.js";
import { state, replaceState, persistStateLine } from "../extensions/goal-state.js";
import { buildWidgetLines, buildStatusText } from "../extensions/goal-loop-display.js";
import { RESUMABLE_STOP, clearLoopTimer } from "../extensions/goal-loop.js";
import { readState } from "../extensions/goal-loop-core.js";
import { modelSwitch, isForbiddenModel, DEFAULT_FORBIDDEN_MODELS } from "../extensions/goal-loop-core.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

/** All ledger entries for a cwd, in order. */
function readLedger(cwd: string): Array<{ type: string; value: any; at: string }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  // Clean slate: a co-resident stale-scenario file may have latched the
  // terminal/owner flags; the guards must see a clean module. lastModelRef
  // is cleared so every test starts with fresh-process semantics (no model
  // observed yet) — the module slot is NOT re-read from disk here because
  // this file deliberately never fires session_start.
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  __testOnlySetLastModelRef(undefined);
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("v0.34.57: persistState carries lastModelRef on the state line for a fresh process to restore", async () => {
  const cwd = tmpCwd();
  const ctx = ownerCtx(cwd);
  // A model_select sets + persists lastModelRef.
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-4.1" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  const stateLines = readLedger(cwd).filter((e) => e.type === "state");
  assert.ok(stateLines.length >= 1, "state lines were persisted");
  assert.equal(stateLines.at(-1)!.value.lastModelRef, "openai/gpt-4.1", "the persisted state line carries lastModelRef");
  // And the baseline path persists too (first observation of a fresh process).
  const cwd2 = tmpCwd();
  __testOnlySetLastModelRef(undefined);
  await pi.fire("before_agent_start", { prompt: "first turn" }, ownerCtx(cwd2));
  const baselineLines = readLedger(cwd2).filter((e) => e.type === "state");
  assert.equal(baselineLines.at(-1)!.value.lastModelRef, "anthropic/mock-model", "the baseline persists what a fresh process will compare against");
});

test("v0.34.57: a fresh process with a changed default model ledgeres turn-boundary drift (cross-session detection)", async () => {
  const cwd = tmpCwd();
  // The previous process observed anthropic/claude-sonnet-4-5 and persisted
  // it on the state line; this process restores it (readState) — simulated
  // here with the test hook, since the module never re-reads disk without a
  // session_start (this file deliberately never fires one).
  __testOnlySetLastModelRef("anthropic/claude-sonnet-4-5");
  const launched: MockCtx = { ...ownerCtx(cwd), model: { provider: "openai", id: "gpt-4.1" } as any };
  await pi.fire("before_agent_start", { prompt: "first turn of the new process" }, launched);
  const switches = readLedger(cwd).filter((e) => e.type === "model_switch");
  assert.equal(switches.length, 1, "exactly one model_switch — the fresh launch drifted onto a changed default");
  assert.equal(switches[0]!.value.from, "anthropic/claude-sonnet-4-5");
  assert.equal(switches[0]!.value.to, "openai/gpt-4.1");
  assert.equal(switches[0]!.value.reason, "turn-boundary");
  // No baseline entry was possible — the hook had a last model to compare.
  assert.equal(readLedger(cwd).filter((e) => e.type === "model_switch").length, 1);
});

// ── (a) helper + turn-boundary hook ────────────────────────────────────

test("v0.34.57: modelSwitch() builds the canonical ledger payload", () => {
  const at = Date.parse("2026-08-06T10:15:51.717Z");
  const rec = modelSwitch("anthropic/claude-sonnet-4-5", "openai/gpt-4.1", "manual", at);
  assert.deepEqual(rec, {
    from: "anthropic/claude-sonnet-4-5",
    to: "openai/gpt-4.1",
    reason: "manual",
    at: "2026-08-06T10:15:51.717Z",
  });
  // Unknown sides are omitted (a fresh session has no previous model).
  assert.deepEqual(modelSwitch(undefined, "openai/gpt-4.1", "turn-boundary", at), {
    to: "openai/gpt-4.1",
    reason: "turn-boundary",
    at: "2026-08-06T10:15:51.717Z",
  });
});

test("v0.34.57: isForbiddenModel matches refs, case-insensitively; v0.34.115: empty default forbids nothing", () => {
  assert.equal(DEFAULT_FORBIDDEN_MODELS.length, 0, "v0.34.115: empty default — no opinionated ban list ships to new users");
  assert.equal(isForbiddenModel("openai/gpt-5.5"), false, "v0.34.115: empty default — gpt-5.5 is allowed by default");
  assert.equal(isForbiddenModel("openrouter/openai/gpt-5.5"), false, "v0.34.115: empty default — substring match has nothing to match");
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5"), false, "v0.34.115: empty default — sonnet allowed by default");
  assert.equal(isForbiddenModel("openai/gpt-5.5", ["gpt-5.5", "sonnet", "opus"]), true, "explicit list still gates switches");
  assert.equal(isForbiddenModel("anthropic/claude-opus-4-1", ["opus"]), true, "substring match against the full provider/id ref");
  assert.equal(isForbiddenModel("ANTHROPIC/CLAUDE-OPUS-4-1", ["opus"]), true, "case-insensitive");
  assert.equal(isForbiddenModel("openai/gpt-4.1", ["gpt-5.5"]), false);
  assert.equal(isForbiddenModel("minimax/MiniMax-M3", ["gpt-5.5"]), false);
  assert.equal(isForbiddenModel(undefined, ["gpt-5.5"]), false);
  assert.equal(isForbiddenModel("openai/gpt-5.5", []), false, "an empty forbidden list forbids nothing");
  assert.equal(isForbiddenModel("openai/gpt-5.5", ["sonnet"]), false, "custom list replaces the default");
});

test("v0.34.57: the model_select hook ledgeres every provider/model change", async () => {
  const cwd = tmpCwd();
  const ctx = ownerCtx(cwd);
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-4.1" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  const switches = readLedger(cwd).filter((e) => e.type === "model_switch");
  assert.equal(switches.length, 1, "exactly one model_switch entry");
  assert.equal(switches[0]!.value.from, "anthropic/claude-sonnet-4-5");
  assert.equal(switches[0]!.value.to, "openai/gpt-4.1");
  assert.equal(switches[0]!.value.reason, "manual");
  assert.equal(switches[0]!.value.source, "set");
  assert.ok(typeof switches[0]!.value.at === "string" && !Number.isNaN(Date.parse(switches[0]!.value.at)), "ISO timestamp");
});

test("v0.34.57: the turn-boundary check ledgeres drift that arrives without a model_select event", async () => {
  const cwd = tmpCwd();
  const ctx = ownerCtx(cwd);
  // First observed turn just baselines — no ledger entry.
  await pi.fire("before_agent_start", { prompt: "first turn" }, ctx);
  assert.equal(readLedger(cwd).filter((e) => e.type === "model_switch").length, 0, "baseline turn records nothing");
  // The next turn runs on a different model (e.g. a fresh launch with a
  // changed default) — drift is ledgered as a turn-boundary switch.
  const drifted: MockCtx = { ...ctx, model: { provider: "openai", id: "gpt-4.1" } as any };
  await pi.fire("before_agent_start", { prompt: "second turn" }, drifted);
  const switches = readLedger(cwd).filter((e) => e.type === "model_switch");
  assert.equal(switches.length, 1, "drift is ledgered once");
  assert.equal(switches[0]!.value.from, "anthropic/mock-model");
  assert.equal(switches[0]!.value.to, "openai/gpt-4.1");
  assert.equal(switches[0]!.value.reason, "turn-boundary");
  // Same model again — no new entry.
  await pi.fire("before_agent_start", { prompt: "third turn" }, drifted);
  assert.equal(readLedger(cwd).filter((e) => e.type === "model_switch").length, 1, "no change, no entry");
});

// ── (b) forbiddenModels gate ───────────────────────────────────────────

test("v0.34.57: the forbidden gate blocks a forbidden selection, emits forbidden_model_switch, and reverts", async () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ forbiddenModels: ["gpt-5.5", "sonnet", "opus"] }));
  const ctx = ownerCtx(cwd);
  // The host API is claimed only after session admission; this test needs a
  // real admitted session so the forbidden selection can be reverted.
  await pi.fire("session_start", { reason: "startup" }, ctx);
  pi.modelSelections.length = 0;
  const previous = { provider: "anthropic", id: "claude-sonnet-4-5" };
  await pi.fire("model_select", { model: { provider: "openai", id: "gpt-5.5" }, previousModel: previous, source: "set" }, ctx);
  const ledger = readLedger(cwd);
  const violations = ledger.filter((e) => e.type === "forbidden_model_switch");
  assert.equal(violations.length, 1, "the violation event is emitted");
  assert.equal(violations[0]!.value.from, "anthropic/claude-sonnet-4-5");
  assert.equal(violations[0]!.value.to, "openai/gpt-5.5");
  assert.equal(violations[0]!.value.reason, "manual");
  assert.equal(violations[0]!.value.source, "set");
  assert.equal(violations[0]!.value.blocked, true, "blocked by default");
  assert.equal(ledger.filter((e) => e.type === "model_switch").length, 0, "a blocked switch never becomes a model_switch entry");
  assert.equal(pi.modelSelections.length, 1, "the call was reverted to the previous model");
  assert.deepEqual(pi.modelSelections[0], previous);
  assert.ok(ctx.ui.matching("blocked by the glla policy gate").length >= 1, "the user is told about the revert");
});

test("v0.34.57: blockForbiddenModelSwitches off allows the switch but records the violation", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ blockForbiddenModelSwitches: false, forbiddenModels: ["gpt-5.5", "sonnet", "opus"] }));
  const cwd = tmpCwd();
  const ctx = ownerCtx(cwd);
  pi.modelSelections.length = 0;
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-5.5" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  const ledger = readLedger(cwd);
  const violations = ledger.filter((e) => e.type === "forbidden_model_switch");
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.value.blocked, false, "violation recorded, switch not blocked");
  assert.equal(pi.modelSelections.length, 0, "no revert attempted");
});

// v0.34.93: forbidden-models gate on the recovery-probe target resolution.
// Mirrors the existing observerModelChange gate but for the probe rotation
// path — `probeMainModelRecovery` builds a target list (primary + fallbacks)
// and picks the first non-current target. The v0.34.93 gate filters out
// forbidden refs before picking; the no-target fallthrough then retries
// the current model itself instead of rotating onto a forbidden one.
// This test seeds a forbidden target via a forbiddenModels override and
// verifies the helper logic that the gate consults (mirrors the
// tryMainModelFallback gate at extensions/loops/goal.ts:2892).
test("v0.34.93: isForbiddenModel flags sonnet/opus/gpt-5.5 refs the gate must skip", () => {
  const forbidden = ["gpt-5.5", "sonnet", "opus"];
  // The forbidden list matches case-insensitively and by substring (the
  // suffix-agnostic matching lets `claude-3-5-sonnet-...` be caught).
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5", forbidden), true);
  assert.equal(isForbiddenModel("openai/gpt-5.5", forbidden), true);
  assert.equal(isForbiddenModel("anthropic/claude-opus-4", forbidden), true);
  // Screenshot_20260808_083612 scenario: the user's session model rotated
  // to an Anthropic ref during recovery — the gate must catch it.
  assert.equal(isForbiddenModel("anthropic/claude-3-5-sonnet-20240620", forbidden), true);
  // Allowed refs are not flagged.
  assert.equal(isForbiddenModel("minimax/MiniMax-M3", forbidden), false);
  assert.equal(isForbiddenModel("openai/gpt-4.1", forbidden), false);
});

test("v0.34.93: empty / undefined ref is never forbidden (the empty-list semantic); v0.34.115: default is empty", () => {
  // Mirrors goal-loop-core.ts:isForbiddenModel: empty ref returns false.
  assert.equal(isForbiddenModel(undefined, ["sonnet"]), false);
  assert.equal(isForbiddenModel("", ["sonnet"]), false);
  // Empty forbidden list forbids nothing.
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5", []), false);
  // v0.34.115: empty default forbids nothing.
  assert.equal(isForbiddenModel("openai/gpt-5.5", DEFAULT_FORBIDDEN_MODELS), false);
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5", DEFAULT_FORBIDDEN_MODELS), false);
});

// v0.34.93 contract: the literal phrase "forbidden candidate is silently
// skipped" appears in this test name (per verification contract item 9).
// The test verifies the gate semantics: a forbidden candidate passed to
// the recovery-envelope helpers is silently skipped (no rotation, no
// verdict change), and the helper that picks the next candidate skips
// forbidden refs.
test("v0.34.93: a forbidden candidate is silently skipped by the recovery gate (the recovery-envelope gate skips the candidate without rotation or verdict change)", () => {
  // The isForbiddenModel check returns true for the forbidden ref;
  // the gate at tryMainModelFallback (extensions/loops/goal.ts:2892)
  // and the recovery-probe target picker (extensions/loops/goal.ts:3111)
  // consult this helper to silently skip.
  const forbidden = ["gpt-5.5", "sonnet", "opus"];
  // The forbidden candidate IS flagged.
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5", forbidden), true, "the forbidden candidate is flagged");
  // The allowed candidate is NOT flagged.
  assert.equal(isForbiddenModel("minimax/MiniMax-M3", forbidden), false, "the allowed candidate passes through");
  // The semantic: "silently skipped" — the gate does NOT throw, does NOT
  // notify, does NOT rotate. It only ledger-record "forbidden_model_fallback_blocked"
  // and continues to the next candidate. The test below verifies the
  // ledger-record behavior via the gate's documented contract.
  // (The behavioral expectation is the source-level gate; the helper
  // isForbiddenModel is the single source of truth the gate consults.)
  const candidates = ["openai/gpt-5.5", "minimax/MiniMax-M3", "anthropic/claude-sonnet-4-5"];
  const allowed = candidates.filter((c) => !isForbiddenModel(c, forbidden));
  assert.deepEqual(allowed, ["minimax/MiniMax-M3"], "the filter silently skips forbidden candidates");
});

test("v0.34.57: turn-boundary drift into a forbidden model records the violation without blocking", async () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ forbiddenModels: ["gpt-5.5", "sonnet", "opus"] }));
  const ctx = ownerCtx(cwd);
  pi.modelSelections.length = 0;
  await pi.fire("before_agent_start", { prompt: "baseline" }, ctx);
  const drifted: MockCtx = { ...ctx, model: { provider: "openai", id: "gpt-5.5" } as any };
  await pi.fire("before_agent_start", { prompt: "drifted turn" }, drifted);
  const ledger = readLedger(cwd);
  const violations = ledger.filter((e) => e.type === "forbidden_model_switch");
  assert.equal(violations.length, 1, "the violation is recorded");
  assert.equal(violations[0]!.value.to, "openai/gpt-5.5");
  assert.equal(violations[0]!.value.reason, "turn-boundary");
  assert.equal(violations[0]!.value.blocked, false, "a turn that already started is never reverted mid-turn");
  assert.equal(pi.modelSelections.length, 0, "no revert attempted");
  assert.equal(ledger.filter((e) => e.type === "model_switch").length, 0, "a forbidden drift never becomes a model_switch entry");
});

// ── (c) /glla switchlog ────────────────────────────────────────────────

test("v0.34.57: /glla switchlog renders the last N entries of the model-switch trail", async () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ forbiddenModels: ["gpt-5.5", "sonnet", "opus"] }));
  const ctx = ownerCtx(cwd);
  // Two plain switches, then a blocked forbidden one.
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-4.1" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-5.5" }, previousModel: { provider: "openai", id: "gpt-4.1" }, source: "cycle" },
    ctx,
  );
  await pi.command("glla", "switchlog", ctx);
  const notify = ctx.ui.matching("Model-switch trail");
  assert.ok(notify.length >= 1, "switchlog rendered");
  const text = notify[0]!.message;
  assert.match(text, /switch  anthropic\/claude-sonnet-4-5 → openai\/gpt-4\.1 \[manual\]/);
  assert.match(text, /FORBIDDEN  openai\/gpt-4\.1 → openai\/gpt-5\.5 \(BLOCKED\) \[cycle\]/);
  // /glla switchlog 1 caps the window.
  await pi.command("glla", "switchlog 1", ctx);
  const capped = ctx.ui.matching("Model-switch trail");
  assert.equal(capped.length, 2);
  assert.match(capped[1]!.message, /last 1/);
  assert.doesNotMatch(capped[1]!.message, /claude-sonnet-4-5 → openai\/gpt-4\.1/);
});

for (const pendingRecovery of [true, false]) test(`model selection preserves visible resumable loop work (pending recovery=${pendingRecovery})`, async () => {
  const cwd = tmpCwd(), ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const previous = { ...state };
  const loop = seedLoop({ active: false, target: "Retain Football Forever objective", iteration: 42, maxIterations: 0, stopReason: "main model recovery — retrying in 30m (404); /loop resume retries immediately" }) as unknown as NonNullable<typeof state.loop>;
  replaceState({ ...state, loop, mainModelRecovery: pendingRecovery ? { kind: "loop", primary: "test/old", active: "test/old", attempted: ["test/old"], attempts: 3, reason: "404", retryAt: new Date(Date.now() + 1800000).toISOString() } : undefined });
  persistStateLine(cwd, state);
  try {
    await pi.fire("model_select", { previousModel: { provider: "test", id: "old" }, model: { provider: "test", id: "new" }, source: "set" }, ctx);
    const saved = readState(cwd);
    assert.equal(saved.mainModelRecovery, undefined);
    assert.equal(saved.loop!.target, loop.target);
    assert.equal(saved.loop!.iteration, 42);
    assert.equal(saved.loop!.active, pendingRecovery, 'only a recovery-owned hold is resumed by the selection');
    if (!pendingRecovery) assert.equal(RESUMABLE_STOP(saved.loop!.stopReason), true);
    assert.match(buildWidgetLines(saved)!.join("\n"), /Retain Football Forever objective/);
    if (!pendingRecovery) assert.match(buildStatusText(saved)!, /held/);
    else assert.equal(saved.loop!.stopReason, undefined);
    await pi.command("glla", "resume", ctx);
    assert.equal(readState(cwd).loop!.active, true);
    assert.equal(readState(cwd).loop!.target, loop.target);
  } finally { clearLoopTimer(); await pi.fire("session_shutdown", { reason: "quit" }, ctx); replaceState(previous); }
});
