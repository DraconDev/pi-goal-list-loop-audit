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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";

// Field 2026-09-29: this file pointed the mock ctx at the repo root with
// ledger recording on, so every suite run appended ~13 model_fallback_select
// events (including the ghost/nope-9000 fixture ref) to the real
// .pi-glla/active.jsonl. Resolution is cwd-independent; tests use a
// throwaway dir.
function scratchCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-ladder-"));
}

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
    cwd: scratchCwd(),
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
    cwd: scratchCwd(),
  } as any;
  const r = resolveAuditorModel(bare, undefined, undefined, true);
  assert.equal(r.model, undefined);
  assert.match(r.error ?? "", /no session model and no auditorModel configured/);
});

// v0.38.103 — a cap must count comparable rounds.
//
// Field 2026-09-27 (hellhunter): the trailing streak read as 8 disapprovals,
// but three were `deterministic-pre-audit` — the mechanical fast-fail gate, not
// a judgment. A gate failing says nothing about whether the auditor is
// unconvinced, so counting it as a round of disagreement is two kinds of
// evidence added together.

import {
  countTrailingDisapprovals,
  countTrailingComparableDisapprovals,
  trailingStreakGraderStable,
  MECHANICAL_PRE_AUDIT_MODEL,
  type AuditVerdict,
} from "../extensions/goal-loop-core.ts";

const LLM = "openrouter/stealth/space-bunny-alpha";
const LUNA = "openai-codex/gpt-5.6-luna";
const LLL_PLACEHOLDER = "minimax/MiniMax-M3";

function round(model: string, disapproved = true, extra: Partial<AuditVerdict> = {}): AuditVerdict {
  return { at: "2026-09-27T00:00:00.000Z", approved: !disapproved, disapproved, model, report: "r", ...extra };
}

test("v0.38.103 a mechanical fast-fail verdict is not an auditor round", () => {
  const history = [round(LLM), round(MECHANICAL_PRE_AUDIT_MODEL), round(LLM), round(MECHANICAL_PRE_AUDIT_MODEL), round(LLM)];
  assert.equal(countTrailingDisapprovals(history), 5, "the raw counter sees five disapprovals");
  assert.equal(countTrailingComparableDisapprovals(history), 3, "only three were an auditor judging");
});

test("v0.38.103 the streak passes THROUGH a mechanical gate rather than stopping", () => {
  // hellhunter's shape: LLM, mechanical, LLM, mechanical, LLM. The comparable
  // streak is 3, not 1 — a gate in the middle must not break the run.
  const history = [round(LLM), round(MECHANICAL_PRE_AUDIT_MODEL), round(LLM), round(MECHANICAL_PRE_AUDIT_MODEL), round(LLM)];
  assert.equal(countTrailingComparableDisapprovals(history), 3);
});

test("v0.38.103 an approval still ends the comparable streak", () => {
  const history = [round(LLM), round(LLM), round(LLM, false)];
  assert.equal(countTrailingComparableDisapprovals(history), 0);
});

test("v0.38.103 infrastructure entries stay transparent", () => {
  const history = [
    round(LLM),
    { at: "2026-09-27T00:00:00.000Z", approved: false, disapproved: false, model: LLM, report: undefined, error: "Auditor stalled — no session activity for 10m" },
    round(LLM),
  ];
  assert.equal(countTrailingComparableDisapprovals(history), 2, "an infra entry is not a verdict");
});

test("v0.38.103 a grader fallback RE-BASELINES the streak instead of pinning", () => {
  // The user's correction, implemented: we must NOT pin. When a pinned
  // auditor dies we have to fall back or the goal can never be audited. What
  // we must not do is count the dead grader's rounds as evidence against its
  // replacement — they were judged to a different standard.
  //
  // So a fallback starts the new auditor's streak at 1, and the old rounds
  // stay in the history for the trail without counting toward the cap.
  const mixed = [round(LLM), round(LLM), round(LUNA), round(LUNA)];
  assert.equal(countTrailingComparableDisapprovals(mixed), 2, "only LUNA's two rounds count");
  assert.equal(countTrailingDisapprovals(mixed), 4, "the raw history still holds all four");

  // Needing the cap to still fire is the point: enough post-fallback rounds
  // build a new streak, and a short one never trips it.
  const longAfterFallback = [round(LLM), round(LLM), round(LLL_PLACEHOLDER)];
  assert.equal(countTrailingComparableDisapprovals(longAfterFallback), 1);

  const single = [round(LLM), round(LLM), round(LLM)];
  assert.equal(trailingStreakGraderStable(single), true, "one grader throughout is comparable");
  assert.equal(countTrailingComparableDisapprovals(single), 3);

  // A mechanical gate does not make the streak mixed — it is transparent.
  const withGate = [round(LLM), round(MECHANICAL_PRE_AUDIT_MODEL), round(LLM)];
  assert.equal(trailingStreakGraderStable(withGate), true);
  assert.equal(countTrailingComparableDisapprovals(withGate), 2);
});

// v0.38.103 — gate the falsification round on the rework streak.
//
// The challenge round is a SECOND adversarial pass whose purpose is to find
// what round 1 missed. Run repeatedly against an already-iterated goal it
// manufactures a fresh objection every round by construction instead of
// closing the previous ones — the amplifier behind the observed 13/13 and
// 20/20 streaks. It earns its keep against a near-miss, not against a goal on
// its fifth rework.

import { AUDITOR_CHALLENGE_STREAK_LIMIT } from "../extensions/goal-loop-auditor-process.ts";
import type { Goal } from "../extensions/goal-loop-core.ts";

test("v0.38.103 the challenge-round limit is a small, finite number", () => {
  assert.equal(AUDITOR_CHALLENGE_STREAK_LIMIT, 2, "two reworks is where the second pass has paid for itself");
  assert.ok(AUDITOR_CHALLENGE_STREAK_LIMIT > 0, "the challenge round still runs on a first-round near-miss");
});

test("v0.38.103 streak counting is what the challenge gate reads", () => {
  // The gate reads the SAME comparable counter the cap uses, so a goal held up
  // by mechanical gates does not silently lose its falsification pass.
  const LLM2 = "openrouter/stealth/space-bunny-alpha";
  const history = [
    { at: "t", approved: false, disapproved: true, model: LLM2, report: "a" },
    { at: "t", approved: false, disapproved: true, model: LLM2, report: "b" },
  ];
  assert.equal(countTrailingComparableDisapprovals(history as any), AUDITOR_CHALLENGE_STREAK_LIMIT);

  // Gates in the middle stay transparent, so they do not buy back a pass.
  const withGates = [
    { at: "t", approved: false, disapproved: true, model: MECHANICAL_PRE_AUDIT_MODEL, report: "g" },
    ...(history as any),
  ];
  assert.equal(countTrailingComparableDisapprovals(withGates), AUDITOR_CHALLENGE_STREAK_LIMIT);
});

test("ladder tests never write to the repo ledger: no ctx cwd points at process.cwd()", () => {
  // Regression for the 2026-09-29 pollution (578+ model_fallback_select events
  // in .pi-glla/active.jsonl from suite runs). Recording is on in these tests,
  // so a repo-root cwd writes fixture refs into the production goal ledger.
  const src = fs.readFileSync(new URL(import.meta.url).pathname, "utf-8");
  assert.doesNotMatch(src, /cwd:\s*process\.cwd\(\)/, "use scratchCwd(), not the repo root");
});
