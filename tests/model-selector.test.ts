// tests/model-selector.test.ts
//
// Scope-aware model-fallback selector (v0.34.115) — pure policy walker
// that composes main-model-recovery.ts. Mirrors the test style of
// main-model-recovery.test.ts (node:test + node:assert/strict, descriptive
// single-test cases, deterministic fixtures).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ModelSelector,
  type ModelFallbackEvent,
  type ModelScope,
  type SelectResult,
} from "../extensions/model-selector.ts";
import {
  classifyMainModelFailure,
  mainModelFailureDelayMs,
  nextUntriedModelRef,
} from "../extensions/main-model-recovery.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SESSION: ModelScope = { kind: "session" };
const EXPLORE: ModelScope = { kind: "subagent", agentName: "Explore" };

interface FakeDeps {
  chain: string[];
  /** Map of ref -> model object. Missing refs resolve to undefined. */
  resolve: Map<string, any>;
  /** Set of forbidden refs. */
  forbidden: Set<string>;
  /** Recorded events, in walk order. */
  events: ModelFallbackEvent[];
}

function makeDeps(opts: { chain?: string[]; resolve?: Record<string, any>; forbidden?: string[] } = {}): FakeDeps {
  return {
    chain: opts.chain ?? [],
    resolve: new Map(Object.entries(opts.resolve ?? {})),
    forbidden: new Set(opts.forbidden ?? []),
    events: [],
  };
}

function makeSelector(deps: FakeDeps): ModelSelector {
  return new ModelSelector({
    getChain: (scope) => deps.chain,
    resolve: (ref) => deps.resolve.get(ref),
    isForbidden: (ref) => deps.forbidden.has(ref),
    record: (event) => deps.events.push(event),
  });
}

/* ------------------------------------------------------------------ */
/* chainFor / selectNext — passthrough to the chain + nextUntriedModelRef */
/* ------------------------------------------------------------------ */

test("chainFor returns the configured chain for a scope", () => {
  const deps = makeDeps({ chain: ["openai/a", "openrouter/b", "anthropic/c"] });
  const sel = makeSelector(deps);
  assert.deepEqual(sel.chainFor(SESSION), ["openai/a", "openrouter/b", "anthropic/c"]);
  // chainFor is a passthrough — same instance, no transformation:
  assert.equal(sel.chainFor(EXPLORE), sel.chainFor(SESSION));
});

test("selectNext walks the chain in order and skips current + attempted", () => {
  const deps = makeDeps({ chain: ["a/1", "b/2", "c/3", "d/4"] });
  const sel = makeSelector(deps);
  assert.equal(sel.selectNext(SESSION, undefined, []), "a/1");
  assert.equal(sel.selectNext(SESSION, "a/1", []), "b/2");
  assert.equal(sel.selectNext(SESSION, "a/1", ["a/1", "b/2"]), "c/3");
  assert.equal(sel.selectNext(SESSION, "a/1", ["a/1", "b/2", "c/3", "d/4"]), undefined);
  // Empty chain -> undefined:
  const empty = makeSelector(makeDeps({ chain: [] }));
  assert.equal(empty.selectNext(SESSION, undefined, []), undefined);
});

/* ------------------------------------------------------------------ */
/* selectNextValid — happy path                                       */
/* ------------------------------------------------------------------ */

test("selectNextValid returns the first registered, non-forbidden ref in chain order", () => {
  const deps = makeDeps({
    chain: ["openai/a", "openrouter/b", "anthropic/c"],
    resolve: { "openai/a": { provider: "openai", id: "a" }, "openrouter/b": { provider: "openrouter", id: "b" }, "anthropic/c": { provider: "anthropic", id: "c" } },
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, "previous/x", []);
  assert.deepEqual(result, { ref: "openai/a", model: { provider: "openai", id: "a" } });
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0]!.reason, "ok");
  assert.equal(deps.events[0]!.toRef, "openai/a");
  assert.equal(deps.events[0]!.fromRef, "previous/x");
  assert.deepEqual(sel.lastVisitedRefs, ["openai/a"]);
});

/* ------------------------------------------------------------------ */
/* selectNextValid — attempted dedupe                                  */
/* ------------------------------------------------------------------ */

test("selectNextValid skips refs already in the attempted list", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2", "c/3"],
    resolve: { "a/1": "A", "b/2": "B", "c/3": "C" },
  });
  const sel = makeSelector(deps);
  // 'a/1' and 'b/2' are in attempted; the next valid ref is c/3.
  const result = sel.selectNextValid(SESSION, undefined, ["a/1", "b/2"]);
  assert.equal("ref" in result && result.ref, "c/3");
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0]!.toRef, "c/3");
});

test("selectNextValid also skips current when it would otherwise be a candidate", () => {
  // 'b/2' is the current model; the walker should not return it. The first
  // valid ref in chain order that is not current and not in attempted is
  // 'c/3'. (nextUntriedModelRef already enforces this.)
  const deps = makeDeps({
    chain: ["a/1", "b/2", "c/3"],
    resolve: { "a/1": "A", "b/2": "B", "c/3": "C" },
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, "b/2", ["a/1"]);
  assert.equal("ref" in result && result.ref, "c/3");
});

test("selectNextValid does not mutate the caller's attempted list", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2"],
    resolve: { "a/1": "A", "b/2": "B" },
  });
  const sel = makeSelector(deps);
  const caller: string[] = [];
  sel.selectNextValid(SESSION, undefined, caller);
  assert.deepEqual(caller, []);
  // ...even after a walk with forbidden/unregistered rejections:
  const deps2 = makeDeps({
    chain: ["x/1", "y/2", "z/3"],
    resolve: { "z/3": "Z" },
    forbidden: ["y/2"],
  });
  const sel2 = makeSelector(deps2);
  const caller2: string[] = [];
  sel2.selectNextValid(SESSION, undefined, caller2);
  assert.deepEqual(caller2, []);
});

/* ------------------------------------------------------------------ */
/* selectNextValid — forbidden walk                                   */
/* ------------------------------------------------------------------ */

test("selectNextValid skips forbidden refs and records each rejection", () => {
  // forbidden refs at the front of the chain force the walker past them.
  const deps = makeDeps({
    chain: ["forbidden/1", "forbidden/2", "openai/ok"],
    resolve: { "forbidden/1": "F1", "forbidden/2": "F2", "openai/ok": "OK" },
    forbidden: ["forbidden/1", "forbidden/2"],
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, undefined, []);
  assert.equal("ref" in result && result.ref, "openai/ok");
  assert.equal(deps.events.length, 3);
  assert.deepEqual(deps.events.map((e) => e.reason), ["forbidden", "forbidden", "ok"]);
  assert.deepEqual(deps.events.map((e) => e.toRef), ["forbidden/1", "forbidden/2", "openai/ok"]);
  assert.deepEqual(sel.lastVisitedRefs, ["forbidden/1", "forbidden/2", "openai/ok"]);
});

test("selectNextValid records forbidden rejections until a valid ref is found", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2", "c/3"],
    resolve: { "c/3": "C" },
    forbidden: ["a/1", "b/2"],
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, undefined, []);
  assert.equal("ref" in result && result.ref, "c/3");
  assert.equal(deps.events.length, 3);
  assert.deepEqual(deps.events.map((e) => e.reason), ["forbidden", "forbidden", "ok"]);
  assert.deepEqual(deps.events.map((e) => e.toRef), ["a/1", "b/2", "c/3"]);
});

/* ------------------------------------------------------------------ */
/* selectNextValid — unregistered walk                                */
/* ------------------------------------------------------------------ */

test("selectNextValid skips refs missing from the resolver and records each rejection", () => {
  // The chain has unregistered refs flanking the one valid entry. The
  // walker should record an "unregistered" event for each, then pick the
  // valid one in the middle. After the pick, the trailing unregistered
  // ref is NOT visited (the walker returned early on the hit).
  const deps = makeDeps({
    chain: ["missing/1", "openai/ok", "missing/3"],
    resolve: { "openai/ok": "OK" },
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, undefined, []);
  assert.equal("ref" in result && result.ref, "openai/ok");
  assert.equal(deps.events.length, 2);
  assert.deepEqual(deps.events.map((e) => e.reason), ["unregistered", "ok"]);
  assert.equal(deps.events[0]!.toRef, "missing/1");
  assert.equal(deps.events[1]!.toRef, "openai/ok");
  assert.deepEqual(sel.lastVisitedRefs, ["missing/1", "openai/ok"]);
});

test("selectNextValid records forbidden before unregistered when both fail", () => {
  // 'a/1' is forbidden; 'b/2' is unregistered; 'c/3' is valid.
  const deps = makeDeps({
    chain: ["a/1", "b/2", "c/3"],
    resolve: { "c/3": "C" },
    forbidden: ["a/1"],
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, undefined, []);
  assert.equal("ref" in result && result.ref, "c/3");
  assert.deepEqual(deps.events.map((e) => e.reason), ["forbidden", "unregistered", "ok"]);
});

/* ------------------------------------------------------------------ */
/* selectNextValid — exhaustion                                       */
/* ------------------------------------------------------------------ */

test("selectNextValid returns reason=exhausted when the chain runs out", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2"],
    resolve: { "a/1": "A", "b/2": "B" },
  });
  const sel = makeSelector(deps);
  const result: SelectResult = sel.selectNextValid(SESSION, undefined, ["a/1", "b/2"]);
  assert.deepEqual(result, { reason: "exhausted" });
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0]!.reason, "exhausted");
  assert.equal(deps.events[0]!.toRef, undefined);
});

test("selectNextValid returns exhausted when every ref is forbidden", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2"],
    resolve: { "a/1": "A", "b/2": "B" },
    forbidden: ["a/1", "b/2"],
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, undefined, []);
  assert.deepEqual(result, { reason: "exhausted" });
  assert.equal(deps.events.length, 3);
  assert.deepEqual(deps.events.map((e) => e.reason), ["forbidden", "forbidden", "exhausted"]);
});

test("selectNextValid returns exhausted on an empty chain", () => {
  const deps = makeDeps({ chain: [] });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, "current/x", []);
  assert.deepEqual(result, { reason: "exhausted" });
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0]!.reason, "exhausted");
  // fromRef rides through even when the chain is empty:
  assert.equal(deps.events[0]!.fromRef, "current/x");
});

/* ------------------------------------------------------------------ */
/* record semantics                                                    */
/* ------------------------------------------------------------------ */

test("selectNextValid records one event per ref visited plus a final outcome", () => {
  // 4 refs in chain, 2 rejected (1 forbidden + 1 unregistered), 1 ok; the
  // 4th never gets visited because the walker wins on the 3rd. Total
  // events: 3 (1 forbidden + 1 unregistered + 1 ok).
  const deps = makeDeps({
    chain: ["a/1", "b/2", "c/3", "d/4"],
    resolve: { "c/3": "C", "d/4": "D" },
    forbidden: ["a/1"],
  });
  const sel = makeSelector(deps);
  sel.selectNextValid(SESSION, undefined, []);
  assert.equal(deps.events.length, 3);
  assert.equal(deps.events[2]!.reason, "ok");
  // Every event carries the scope tag:
  for (const ev of deps.events) assert.deepEqual(ev.scope, SESSION);
});

test("selectNextValid tags subagent scope on every recorded event", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2"],
    resolve: { "b/2": "B" },
    forbidden: ["a/1"],
  });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(EXPLORE, undefined, []);
  assert.equal("ref" in result && result.ref, "b/2");
  assert.equal(deps.events.length, 2);
  assert.deepEqual(deps.events[0]!.scope, EXPLORE);
  assert.deepEqual(deps.events[1]!.scope, EXPLORE);
  assert.equal(deps.events[0]!.scope.kind, "subagent");
  if (deps.events[0]!.scope.kind === "subagent") {
    assert.equal(deps.events[0]!.scope.agentName, "Explore");
  }
});

test("selectNextValid does not throw when no recorder is supplied", () => {
  // No record fn on deps — optional chaining in the selector must be a
  // no-op. Also exercises the chain-exhausted branch.
  const sel = new ModelSelector({
    getChain: () => ["a/1", "b/2"],
    resolve: () => undefined,
    isForbidden: () => false,
  });
  const result = sel.selectNextValid(SESSION, undefined, ["a/1", "b/2"]);
  assert.deepEqual(result, { reason: "exhausted" });
});

/* ------------------------------------------------------------------ */
/* canUseRef                                                           */
/* ------------------------------------------------------------------ */

test("canUseRef is true only when a ref is not forbidden and resolves", () => {
  const deps = makeDeps({
    chain: ["a/1", "b/2"],
    resolve: { "a/1": "A", "b/2": "B" },
    forbidden: ["a/1"],
  });
  const sel = makeSelector(deps);
  assert.equal(sel.canUseRef("a/1"), false); // forbidden
  assert.equal(sel.canUseRef("b/2"), true);  // resolves, not forbidden
  assert.equal(sel.canUseRef("c/3"), false); // not in resolver
  // a ref that is both forbidden and unregistered: still false.
  const deps2 = makeDeps({ chain: ["a/1"], resolve: {}, forbidden: ["a/1"] });
  assert.equal(makeSelector(deps2).canUseRef("a/1"), false);
});

/* ------------------------------------------------------------------ */
/* classifyFailure — scope-agnostic                                   */
/* ------------------------------------------------------------------ */

test("classifyFailure is scope-agnostic — same input returns same output for any scope", () => {
  const sel = makeSelector(makeDeps());
  const a = sel.classifyFailure(SESSION, "429 rate limit: pi held the provider retry");
  const b = sel.classifyFailure(EXPLORE, "429 rate limit: pi held the provider retry");
  assert.deepEqual(a, b);
  // And it matches the raw classifier — the scope tag does NOT appear in
  // the failure (it rides in the record payload only):
  assert.equal(a.kind, classifyMainModelFailure("429 rate limit: pi held the provider retry").kind);
  // Non-recoverable short-circuits the same way for every scope:
  assert.equal(sel.classifyFailure(SESSION, "user aborted").kind, "non-recoverable");
  assert.equal(sel.classifyFailure(EXPLORE, "user aborted").kind, "non-recoverable");
  // Empty input -> unknown for any scope:
  assert.equal(sel.classifyFailure(SESSION, undefined).kind, "unknown");
});

/* ------------------------------------------------------------------ */
/* retryDelayMs — same as mainModelFailureDelayMs                     */
/* ------------------------------------------------------------------ */

test("retryDelayMs returns the same value as mainModelFailureDelayMs (default base)", () => {
  const sel = makeSelector(makeDeps());
  const failure = classifyMainModelFailure("429 rate limit; retry in 2 hours");
  const attempt = 3;
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  const fromSel = sel.retryDelayMs(SESSION, failure, attempt, nowMs);
  const fromRaw = mainModelFailureDelayMs(failure, attempt, 15, nowMs);
  assert.equal(fromSel, fromRaw);
  // v0.38.105: an upstream reset hint outranks the eager first-retry quantum —
  // the hint is the provider telling us when it will accept requests again.
  // The eager 5s remains for every failure WITHOUT a hint.
  assert.equal(sel.retryDelayMs(SESSION, failure, 1, nowMs), 2 * 60 * 60_000, "attempt 1 honors the named reset");
  const hintless = classifyMainModelFailure("the provider closed the stream");
  assert.equal(sel.retryDelayMs(SESSION, hintless, 1, nowMs), 5_000, "a hintless first failure is still eager");
  // Scope does not change the outcome (currently scope-agnostic):
  assert.equal(sel.retryDelayMs(EXPLORE, failure, attempt, nowMs), fromSel);
  // Default nowMs is also wired:
  assert.equal(typeof sel.retryDelayMs(SESSION, failure, 1), "number");
});

test("audit 2026-09-06: retryDelayMs honors the injected retry base minutes", () => {
  const failure = classifyMainModelFailure("429 rate limit; retry in 2 hours");
  const attempt = 3;
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  const withBase = new ModelSelector({
    getChain: () => [],
    resolve: () => undefined,
    isForbidden: () => false,
    retryBaseMinutes: 30,
  });
  assert.equal(
    withBase.retryDelayMs(SESSION, failure, attempt, nowMs),
    mainModelFailureDelayMs(failure, attempt, 30, nowMs),
  );
  // Junk base falls back to the legacy 15m default, never NaN/throw.
  const withJunk = new ModelSelector({
    getChain: () => [],
    resolve: () => undefined,
    isForbidden: () => false,
    retryBaseMinutes: Number.NaN,
  });
  assert.equal(
    withJunk.retryDelayMs(SESSION, failure, attempt, nowMs),
    mainModelFailureDelayMs(failure, attempt, 15, nowMs),
  );
});

/* ------------------------------------------------------------------ */
/* Composition: selectNextValid composes nextUntriedModelRef exactly  */
/* ------------------------------------------------------------------ */

test("selectNextValid composes nextUntriedModelRef — manual loop yields the same answer", () => {
  // Build a long chain with mixed forbidden + unregistered entries, then
  // assert the selector's pick is identical to a manual loop using
  // nextUntriedModelRef + the same gate logic.
  const chain = ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6"];
  const resolve: Record<string, any> = { "b/2": "B", "d/4": "D", "f/6": "F" };
  const forbidden = new Set(["c/3", "e/5"]);
  const attempted = ["a/1"];

  const deps = makeDeps({ chain, resolve, forbidden: Array.from(forbidden) });
  const sel = makeSelector(deps);
  const result = sel.selectNextValid(SESSION, "a/1", attempted);
  // a/1 is current + attempted, skip.
  // b/2 resolves -> pick. (Walked: b/2 ok.)
  assert.equal("ref" in result && result.ref, "b/2");

  // Manual reference: walk via nextUntriedModelRef + the gate, same order.
  const tried = attempted.slice();
  let ref: string | undefined;
  let picked: { ref: string; model: any } | undefined;
  const manualEvents: Array<{ ref: string; reason: string }> = [];
  for (;;) {
    ref = nextUntriedModelRef("a/1", chain, tried);
    if (ref === undefined) break;
    tried.push(ref);
    if (forbidden.has(ref)) { manualEvents.push({ ref, reason: "forbidden" }); continue; }
    const model = resolve[ref];
    if (model === undefined) { manualEvents.push({ ref, reason: "unregistered" }); continue; }
    manualEvents.push({ ref, reason: "ok" });
    picked = { ref, model };
    break;
  }
  assert.deepEqual(picked, { ref: "b/2", model: "B" });
  // The walk order matches:
  assert.equal(manualEvents[0]!.reason, "ok");
  assert.equal(manualEvents[0]!.ref, "b/2");
});
