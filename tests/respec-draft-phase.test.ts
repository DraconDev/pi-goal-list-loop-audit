import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyLoadState } from "../extensions/loops/goal.js";
import { runLoopTick, clearLoopTimer } from "../extensions/goal-loop.js";
import { readState } from "../extensions/goal-loop-core.js";
import { respecTarget, respecDraftReady } from "../extensions/goal-loop-forever.js";
import { MockPi, makeMockCtx, tmpCwd, tick, seedState } from "./harness/mock-pi.js";

afterEach(() => { clearLoopTimer(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });
const SPEC = "# Project\n\n## Rules\nRespect the project instructions.\n\n## Architecture\nObserved entry points and state.\n";

test("missing-spec respec dispatches a durable dedicated draft and gates reconciliation", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-draft" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); await tick(100);
    const draft = pi.sent.find(s => s.message.content?.includes("[RESPEC BIG DRAFT]"));
    assert.ok(draft, "the route actually sends the dedicated drafting prompt");
    assert.match(draft.message.content!, /\[LOOP ITERATION 1\]/, "dispatch acknowledgement retains its loop marker");
    assert.doesNotMatch(draft.message.content!, /Then make \*\*ONE\*\* concrete/);
    assert.equal(readState(cwd).loop?.respecPhase, "draft");
    clearLoopTimer();
    const file = path.join(cwd, "SPEC.md"); fs.writeFileSync(file, SPEC);
    const turn = (text: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    await runLoopTick(ctx as unknown as ExtensionContext, turn("Research checkpoint; still drafting.")); clearLoopTimer();
    assert.equal(readState(cwd).loop?.respecPhase, "draft", "a partial file is not a phase handoff");
    fs.writeFileSync(file, "# Project\n\n## Rules\n\n## Architecture\nPartial\n");
    await runLoopTick(ctx as unknown as ExtensionContext, turn("[RESPEC DRAFT COMPLETE]")); clearLoopTimer();
    assert.equal(readState(cwd).loop?.respecPhase, "draft", "an empty Rules section cannot hand off");
    fs.writeFileSync(file, SPEC);
    await runLoopTick(ctx as unknown as ExtensionContext, turn("[RESPEC DRAFT COMPLETE]")); clearLoopTimer();
    assert.equal(readState(cwd).loop?.respecPhase, "reconcile");
    assert.equal(readState(cwd).loop?.target, respecTarget("SPEC.md"));
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("legacy bootstrap loops recover into the draft phase, including an existing partial spec", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-legacy" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    const specFile = path.join(cwd, "SPEC.md"); fs.writeFileSync(specFile, SPEC);
    seedState(cwd, { goal: null, loop: { target: respecTarget("SPEC.md", { bootstrapping: true }),
      specFile, active: false, stopReason: "held: restored in a fresh session", iteration: 32, maxIterations: 0, plateauWindow: 5, stallCount: 0,
      bestValue: null, lastValue: null, history: [], startedAt: new Date().toISOString() } });
    __testOnlyLoadState(cwd);
    await pi.command("loop", "resume", ctx); await tick(100);
    assert.equal(readState(cwd).loop?.respecPhase, "draft");
    assert.ok(pi.sent.some(s => s.message.content?.includes("[RESPEC BIG DRAFT]")));
    assert.equal(readState(cwd).loop?.iteration, 32, "recovery preserves the run");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("respec with an existing spec retains immediate reconciliation", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  fs.writeFileSync(path.join(cwd, "SPEC.md"), SPEC);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-existing" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); await tick(100);
    assert.equal(readState(cwd).loop?.respecPhase, undefined);
    assert.equal(readState(cwd).loop?.target, respecTarget("SPEC.md"));
    assert.ok(!pi.sent.some(s => s.message.content?.includes("[RESPEC BIG DRAFT]")));
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("a draft completion marker cannot substitute for a missing or empty spec", () => {
  const file = path.join(tmpCwd(), "SPEC.md");
  assert.equal(respecDraftReady(file, "[RESPEC DRAFT COMPLETE]"), false);
  fs.writeFileSync(file, SPEC);
  assert.equal(respecDraftReady(file, "checkpoint"), false);
  assert.equal(respecDraftReady(file, "[RESPEC DRAFT COMPLETE]"), true);
});
