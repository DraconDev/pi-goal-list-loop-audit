import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyLoadState } from "../extensions/loops/goal.js";
import { runLoopTick, clearLoopTimer, loopPrompt, scheduleLoopTick } from "../extensions/goal-loop.js";
import { readState } from "../extensions/goal-loop-core.js";
import { respecTarget, respecDraftReady, respecSpecComplete } from "../extensions/goal-loop-forever.js";
import { MockPi, makeMockCtx, tmpCwd, tick, seedState } from "./harness/mock-pi.js";

afterEach(() => { clearLoopTimer(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });
const SPEC = "# Project\n\n## Rules\nRespect the project instructions.\n\n## Architecture\nObserved entry points and state.\n";

async function restoreLegacyDraft(cwd: string, ctx: ReturnType<typeof makeMockCtx>) {
  seedState(cwd, { goal: null, loop: { target: "Draft the comprehensive SPEC.md from the current codebase before reconciliation", specFile: path.join(cwd, "SPEC.md"), respecPhase: "draft",
    active: true, iteration: 0, maxIterations: 0, plateauWindow: 5, stallCount: 0,
    bestValue: null, lastValue: null, history: [], startedAt: new Date().toISOString() } });
  __testOnlyLoadState(cwd);
  scheduleLoopTick(ctx as unknown as ExtensionContext);
}

test("restored legacy missing-spec loop dispatches its dedicated draft and gates reconciliation", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-draft" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await restoreLegacyDraft(cwd, ctx); await tick(100);
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

test("respec with an existing spec drafts intended requirements before building", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  fs.writeFileSync(path.join(cwd, "SPEC.md"), SPEC);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-existing" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); await tick(100);
    assert.equal(readState(cwd).loop?.respecPhase, undefined);
    assert.equal(readState(cwd).loop?.builder?.phase, "drafting");
    assert.equal(readState(cwd).loop?.specFile, path.join(cwd, "SPEC.md"));
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

test("active legacy bootstrap loop recovers into draft on its next tick", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-active-legacy" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    const specFile = path.join(cwd, "SPEC.md");
    // No SPEC.md on disk: the field case (iter 30, 2h32m, still no spec).
    seedState(cwd, { goal: null, loop: { target: respecTarget("SPEC.md", { bootstrapping: true }),
      specFile, active: true, iteration: 30, maxIterations: 0, plateauWindow: 5, stallCount: 0,
      bestValue: null, lastValue: null, history: [], startedAt: new Date().toISOString() } });
    __testOnlyLoadState(cwd);
    pi.sent.length = 0;
    const turn = (text: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    await runLoopTick(ctx as unknown as ExtensionContext, turn("Still researching the codebase."));
    await tick(150);
    clearLoopTimer();
    assert.equal(readState(cwd).loop?.respecPhase, "draft", "active legacy loop enters draft phase");
    assert.ok(pi.sent.some(s => s.message.content?.includes("[RESPEC BIG DRAFT]")), "next dispatch uses the dedicated draft prompt");
    assert.ok((readState(cwd).loop?.iteration ?? 0) >= 30, "recovery preserves the run history");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("respec with a structurally incomplete spec enters draft instead of reconciling", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  fs.writeFileSync(path.join(cwd, "SPEC.md"), "# Project\n\n## Rules\n\n");
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-partial" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); await tick(100);
    assert.equal(readState(cwd).loop?.respecPhase, "draft", "partial spec is finished first");
    assert.ok(pi.sent.some(s => s.message.content?.includes("[RESPEC BIG DRAFT]")));
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("sticky handoff: marker one turn, finished spec the next, still reconciles", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-sticky" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); await tick(100);
    const specFile = path.join(cwd, "SPEC.md");
    const turn = (text: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    // Turn N: agent declares done early with only a partial spec on disk.
    fs.writeFileSync(specFile, "# Project\n\n## Rules\n\n");
    await runLoopTick(ctx as unknown as ExtensionContext, turn("[RESPEC DRAFT COMPLETE]"));
    await tick(100); clearLoopTimer();
    assert.equal(readState(cwd).loop?.respecPhase, "draft", "partial spec cannot hand off");
    assert.equal(readState(cwd).loop?.respecMarkerSeen, true, "early marker is remembered");
    // Turn N+1: agent finishes the spec without re-emitting the marker.
    fs.writeFileSync(specFile, SPEC);
    await runLoopTick(ctx as unknown as ExtensionContext, turn("Finished the Architecture section."));
    await tick(100); clearLoopTimer();
    assert.equal(readState(cwd).loop?.respecPhase, "reconcile", "sticky marker plus late spec hands off");
    assert.equal(readState(cwd).loop?.respecMarkerSeen, undefined, "marker clears on handoff");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("draft prompt carries the stuck-ladder intervention note", () => {
  const loop = {
    target: "Draft the comprehensive SPEC.md", specFile: path.join(tmpCwd(), "SPEC.md"),
    respecPhase: "draft", active: true, iteration: 3, maxIterations: 0,
    plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null,
    history: [], startedAt: new Date().toISOString(),
  } as unknown as import("../extensions/goal-loop-forever.ts").LoopState;
  const prompt = loopPrompt(loop, "", "", "", "INTERVENTION-PROBE: vary coverage");
  assert.ok(prompt.includes("[RESPEC BIG DRAFT]"), "draft branch taken");
  assert.ok(prompt.includes("INTERVENTION-PROBE: vary coverage"), "intervention survives into the draft prompt");
  assert.ok(!prompt.includes("${INTERVENTION_NOTE}"), "placeholder is replaced");
  const quiet = loopPrompt(loop, "", "", "", "");
  assert.ok(!quiet.includes("${INTERVENTION_NOTE}"), "empty note leaves no placeholder");
});

test("draft phase without a spec file degrades instead of throwing", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-corrupt" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    // Corrupt/hand-migrated state: draft phase but no specFile.
    seedState(cwd, { goal: null, loop: { target: "Draft the comprehensive SPEC.md", specFile: undefined, respecPhase: "draft",
      active: true, iteration: 3, maxIterations: 0, plateauWindow: 5, stallCount: 0,
      bestValue: null, lastValue: null, history: [], startedAt: new Date().toISOString() } });
    __testOnlyLoadState(cwd);
    pi.sent.length = 0;
    const turn = (text: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    await runLoopTick(ctx as unknown as ExtensionContext, turn("Working."));
    await tick(150);
    clearLoopTimer();
    assert.ok(pi.sent.length > 0, "dispatch still fires");
    assert.ok(pi.sent.every(s => !s.message.content?.includes("[RESPEC BIG DRAFT]")), "no draft prompt without a target file");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("respecSpecComplete: title plus nonempty Rules plus another section", () => {
  const dir = tmpCwd(), file = path.join(dir, "SPEC.md");
  assert.equal(respecSpecComplete(file), false, "missing file is incomplete");
  fs.writeFileSync(file, "");
  assert.equal(respecSpecComplete(file), false, "empty file is incomplete");
  fs.writeFileSync(file, "# Project\n\n## Rules\n\n");
  assert.equal(respecSpecComplete(file), false, "empty Rules is incomplete");
  fs.writeFileSync(file, "# Project\n\n## Rules\nBe good.\n");
  assert.equal(respecSpecComplete(file), false, "Rules-only is incomplete");
  fs.writeFileSync(file, SPEC);
  assert.equal(respecSpecComplete(file), true, "title plus Rules plus Architecture is complete");
});
