// pi-goal-list-loop-audit — v0.38.103 auditor ladder discipline.
//
// Field 2026-09-27: with no auditor configured, resolveAuditorModel still built
// a chain and handed it to ModelSelector, which had nothing to select from and
// reported `exhausted` on every audit — 828 ledger events on neonbreak, 247 on
// hellhunter, 182 on doomtap — before falling through to the session model
// anyway. Pure per-round latency spent proving there was nothing to try.
//
// The policy the user asked for: the session model is always the last resort,
// an explicitly configured auditor is tried FIRST, and with nothing configured
// there is no ladder at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";

const session: any = { id: "space-bunny-alpha", provider: "openrouter", name: "space-bunny-alpha" };
const luna: any = { id: "gpt-5.6-luna", provider: "openai-codex", name: "gpt-5.6-luna" };
const mini: any = { id: "MiniMax-M3", provider: "minimax", name: "MiniMax-M3" };
const all = [session, luna, mini];

function ctx(model: any = session) {
  return {
    model,
    modelRegistry: {
      find: (p: string, m: string) => all.find((x) => x.provider === p && x.id === m),
      hasConfiguredAuth: () => true,
      getAvailable: () => all,
    },
    ui: { notify: () => {} },
    cwd: process.cwd(),
  } as any;
}

const ids = (r: any) => (r.fallbackModels ?? []).map((c: any) => c.model.id);

test("v0.38.103 nothing configured: session model, and NO ladder to exhaust", () => {
  const r = resolveAuditorModel(ctx(), undefined, undefined, true);
  assert.equal(r.model.id, "space-bunny-alpha");
  assert.equal(r.via, "session");
  assert.deepEqual(r.fallbackModels ?? [], [], "an empty chain is the bug: no refs, so nothing to walk");
  assert.equal(r.error, undefined, "a session model is always available, so this is not an error path");
});

test("v0.38.103 an explicit auditor is tried FIRST and the session model is the last resort", () => {
  const r = resolveAuditorModel(ctx(), "openai-codex/gpt-5.6-luna", "minimax/MiniMax-M3", true);
  assert.equal(r.model.id, "gpt-5.6-luna", "the configured choice wins the first attempt");
  assert.equal(r.via, "setting");
  assert.deepEqual(ids(r), ["MiniMax-M3", "space-bunny-alpha"], "configured fallbacks next, session model last");
});

test("v0.38.103 a configured auditor with no fallbacks still keeps the session model reachable", () => {
  const r = resolveAuditorModel(ctx(), "openai-codex/gpt-5.6-luna", undefined, true);
  assert.equal(r.model.id, "gpt-5.6-luna");
  assert.deepEqual(ids(r), ["space-bunny-alpha"], "session model remains the safety net");
});

test("v0.38.103 an unavailable primary escalates immediately and still ends at the session model", () => {
  // The ordering cost the user worried about ("if it fails it would take long
  // and longer for it to be retried") is bounded by resolution, not by a
  // timeout: a ref missing from the registry is rejected here, in
  // milliseconds, and the next candidate is used.
  const r = resolveAuditorModel(ctx(), "ghost/nope-9000", "openai-codex/gpt-5.6-luna", true);
  assert.equal(r.model.id, "gpt-5.6-luna", "the live ref is used, not the dead head of the chain");
  assert.equal(r.via, "fallback-pin");
  assert.deepEqual(ids(r), ["space-bunny-alpha"]);
});

test("v0.38.103 same-session-swap does not change the ordering contract", () => {
  for (const swap of [true, false]) {
    const r = resolveAuditorModel(ctx(), "openai-codex/gpt-5.6-luna", undefined, swap);
    assert.equal(r.model.id, "gpt-5.6-luna", `swap=${swap}: explicit auditor still first`);
    assert.deepEqual(ids(r), ["space-bunny-alpha"], `swap=${swap}: session model still last`);
  }
});

test("v0.38.103 an auditor pinned to the session model is the session model, with no invented ladder", () => {
  const r = resolveAuditorModel(ctx(), "openrouter/space-bunny-alpha", undefined, true);
  assert.equal(r.model.id, "space-bunny-alpha");
  assert.equal(r.via, "session");
  assert.deepEqual(r.fallbackModels ?? [], []);
});

test("v0.38.103 with no session model and nothing configured, the error stays actionable", () => {
  const bare = {
    model: undefined,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    cwd: process.cwd(),
  } as any;
  const r = resolveAuditorModel(bare, undefined, undefined, true);
  assert.equal(r.model, undefined);
  assert.match(r.error ?? "", /no session model and no auditorModel configured/);
});
