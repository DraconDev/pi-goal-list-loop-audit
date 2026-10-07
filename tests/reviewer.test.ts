// pi-goal-list-loop-audit — v0.26.0
// tests/reviewer.test.ts
//
// The Reviewer (post-completion follow-up enqueuer) — contract items
// 1-12: fire gates, leverage classification, cascade, runaway prevention,
// day cap, manual invocation, menu surface, no /loop triggering.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_REVIEWER_CONFIG,
  classifyFindingText,
  extractFindings,
  resolveReviewerConfig,
  reviewerFiredRecently,
  reviewerMenuOptions,
  reviewsToday,
  runReviewer,
  type ReviewerDeps,
} from "../extensions/reviewer.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

function mkDeps(cwd: string, over: Partial<ReviewerDeps> = {}) {
  const calls = { enqueued: [] as string[][], proposed: [] as string[], notified: [] as string[], ledgered: [] as string[] };
  const deps: ReviewerDeps = {
    cwd,
    nowMs: Date.parse("2026-07-25T12:00:00Z"),
    ledgerEntries: [],
    sources: [],
    enqueueListItems: (objs) => { calls.enqueued.push(objs); return objs.length; },
    proposeGoal: (obj) => { calls.proposed.push(obj); return true; },
    notify: (m) => calls.notified.push(m),
    ledger: (t) => calls.ledgered.push(t),
    ...over,
  };
  return { deps, calls };
}

const GOAL_SRC = { kind: "goal" as const, goalId: "g1", objective: "audit the screens", terminal: "goal-complete" };
const LIST_SRC = { kind: "list" as const, goalId: "g9", objective: "last list item", terminal: "goal-complete" };

test("fires on goal-complete + list-complete; NOT on aborted/paused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const cfg = resolveReviewerConfig();
  assert.equal(runReviewer(cfg, GOAL_SRC, mkDeps(dir).deps).fired, true);
  assert.equal(runReviewer(cfg, LIST_SRC, mkDeps(dir).deps).fired, true);
  assert.equal(runReviewer(cfg, { ...GOAL_SRC, terminal: "goal-aborted" }, mkDeps(dir).deps).fired, false);
  assert.equal(runReviewer(cfg, { ...GOAL_SRC, terminal: "goal-paused" }, mkDeps(dir).deps).fired, false);
  // Disabled config suppresses:
  assert.equal(runReviewer({ ...cfg, enabled: false }, GOAL_SRC, mkDeps(dir).deps).fired, false);
});

test("leverage: bug/TODO findings enqueue to /list WITHOUT any Confirm (no proposeGoal)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "archive", text: "Done.\nTODO: fix the null deref in parser.ts\nFIXME: broken cache key\nAll good otherwise." }],
  });
  const out = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(out.enqueued, 2);
  assert.deepEqual(calls.enqueued[0], ["TODO: fix the null deref in parser.ts", "FIXME: broken cache key"]);
  assert.equal(calls.proposed.length, 0, "bug-class never proposes a /goal (no Confirm)");
  assert.equal(out.report!.cascadeStep, "convert-findings-to-list");
});

test("architectural findings are proposed as /goal (Confirm path)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "audit", text: "Looks fine.\nWe should rewrite the schema to normalize events." }],
  });
  const out = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(calls.proposed.length, 1);
  assert.match(calls.proposed[0]!, /rewrite the schema/);
  assert.equal(calls.enqueued.length, 0, "architectural never auto-enqueues");
});

test("classification order: strategic > architectural > bug > refactor", () => {
  assert.equal(classifyFindingText("should we deprecate the old API?"), "strategic");
  assert.equal(classifyFindingText("we should rewrite this broken schema"), "architectural");
  assert.equal(classifyFindingText("TODO: refactor foo"), "bug"); // contract item 7's example
  assert.equal(classifyFindingText("this is duplicated in three places"), "refactor");
  assert.equal(classifyFindingText("all tests pass"), undefined);
  assert.equal(classifyFindingText("short"), undefined);
});

test("clean completion fires the audit step; strategic-only notifies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const { deps, calls } = mkDeps(dir, { sources: [{ name: "archive", text: "Everything done. All tests pass." }] });
  const out = runReviewer({ ...resolveReviewerConfig(), cascade: [...resolveReviewerConfig().cascade, "fire-audit-on-clean" as const] }, GOAL_SRC, deps);
  assert.equal(out.report!.cascadeStep, "fire-audit-on-clean");
  assert.equal(calls.proposed.length, 1);
  assert.match(calls.proposed[0]!, /regression scan/i);
  // Strategic-only: notify, no enqueue, no audit:
  const { deps: deps2, calls: calls2 } = mkDeps(dir, { sources: [{ name: "audit", text: "should we ship this to users?" }] });
  const out2 = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps2);
  assert.equal(out2.enqueued, 0);
  assert.equal(calls2.proposed.length, 0);
  assert.ok(calls2.notified.some((m) => /strategic/i.test(m)));
});

test("runaway prevention: a reviewer fire in the last 5 minutes suppresses re-firing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const now = Date.parse("2026-07-25T12:00:00Z");
  const entries = [{ type: "reviewer_fired", at: new Date(now - 2 * 60_000).toISOString() }];
  assert.equal(reviewerFiredRecently(entries, 5 * 60_000, now), true);
  assert.equal(reviewerFiredRecently([{ type: "reviewer_fired", at: new Date(now - 10 * 60_000).toISOString() }], 5 * 60_000, now), false);
  const { deps, calls } = mkDeps(dir, { ledgerEntries: entries });
  const out = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(out.fired, false);
  assert.match(out.suppressedReason!, /runaway|5 minutes/);
  assert.ok(calls.ledgered.includes("reviewer_suppressed"));
});

test("per-day cap: the 21st fire is suppressed with a ledger entry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const day = "2026-07-25";
  const entries = Array.from({ length: 20 }, (_, i) => ({ type: "reviewer_fired", at: `${day}T${String(i).padStart(2, "0")}:00:00Z` }));
  assert.equal(reviewsToday(entries, Date.parse(`${day}T23:30:00Z`)), 20);
  const { deps, calls } = mkDeps(dir, { ledgerEntries: entries, nowMs: Date.parse(`${day}T23:30:00Z`) });
  const out = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(out.fired, false);
  assert.match(out.suppressedReason!, /daily postaudit cap/);
  assert.ok(calls.ledgered.includes("reviewer_suppressed"));
});

test("manual /review bypasses the trigger gates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const cfg = { ...resolveReviewerConfig(), enabled: false }; // disabled!
  const entries = [{ type: "reviewer_fired", at: "2026-07-25T11:58:00Z" }]; // inside window!
  const { deps } = mkDeps(dir, { manual: true, ledgerEntries: entries, sources: [{ name: "archive", text: "TODO: one more fix" }] });
  const out = runReviewer(cfg, GOAL_SRC, deps);
  assert.equal(out.fired, true, "manual bypasses enabled + refire window");
  assert.equal(out.enqueued, 1);
});

test("review report written to .pi-glla/reviews/<goal-id>-<timestamp>.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  const { deps } = mkDeps(dir, { sources: [{ name: "archive", text: "TODO: fix parser\nWe should rewrite the schema" }] });
  const out = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.ok(out.reportPath);
  assert.match(path.basename(out.reportPath!), /^g1-2026-07-25T12-00-00.*\.md$/);
  const md = fs.readFileSync(out.reportPath!, "utf-8");
  assert.match(md, /# Review — g1/);
  assert.match(md, /## Bug-class/);
  assert.match(md, /## Architectural-class/);
  assert.match(md, /TODO: fix parser/);
});

test("menu options reflect the config", () => {
  const opts = reviewerMenuOptions(DEFAULT_REVIEWER_CONFIG);
  // v0.35.4: the dead Leverage-mode row (leverageMode/confirmOn were never
  // branched on anywhere) is removed — 8 options + Done.
  assert.equal(opts.length, 8);
  assert.match(opts[0]!, /Enabled — ON/);
  assert.match(opts[1]!, /Mode — on/);
  assert.doesNotMatch(opts[2]!, /Leverage mode/);
  assert.match(opts[6]!, /Max reviews per day — 20/);
  const off = reviewerMenuOptions({ ...DEFAULT_REVIEWER_CONFIG, enabled: false, maxReviewsPerDay: 3 });
  assert.match(off[0]!, /Enabled — OFF/);
  assert.match(off[6]!, /— 3/);
});

test("no /loop triggering: the loop stop path never calls runReviewer", () => {
  const src = readGoalRuntimeSource();
  // cmdLoop/stop handlers must not reference the reviewer:
  const loopSection = src.slice(src.indexOf('pi.registerCommand("loop"'));
  assert.doesNotMatch(loopSection, /runReviewer|fireReviewer/);
});

test("config block: partial project settings merge over defaults", () => {
  const cfg = resolveReviewerConfig({ maxFindingsPerReview: 3, enabled: false });
  assert.equal(cfg.maxFindingsPerReview, 3);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxReviewsPerDay, 20); // default preserved
  assert.deepEqual(extractFindings([{ name: "x", text: "TODO: fix alpha\nTODO: fix beta\nTODO: fix gamma\nTODO: fix delta" }], 3).length, 3);
});

test("v0.28.16 duplicate-scan dedupe: completing a regression scan does NOT propose another scan (report-only)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-rev-"));
  // The 2026-07-28 cascade: scan 24ewt8 completed → proposed scan pii8tt →
  // pii8tt completed → proposed scan-of-pii8tt AGAIN. Normalized compare
  // (goal-ids stripped) catches it: the completed objective IS the proposal.
  const SCAN_SRC = {
    kind: "goal" as const,
    goalId: "20260728225553-pii8tt",
    objective: "Post-completion regression scan after 20260728224245-24ewt8 (regression-scan)",
    terminal: "goal-complete",
  };
  const { deps, calls } = mkDeps(dir, { sources: [{ name: "archive", text: "All green. 548 tests pass." }] });
  const out = runReviewer({ ...resolveReviewerConfig(), cascade: [...resolveReviewerConfig().cascade, "fire-audit-on-clean" as const] }, SCAN_SRC, deps);
  assert.equal(out.fired, true, "the review report still writes");
  assert.equal(out.proposed, 0, "no scan-of-a-scan proposal (on mode)");
  assert.equal(calls.proposed.length, 0);
  assert.equal(out.report!.cascadeStep, "duplicate-suppressed");
  assert.ok(calls.ledgered.includes("reviewer_suppressed"), "suppression is ledgered");
  // auto mode: the enqueue path is deduped too.
  const { deps: depsA, calls: callsA } = mkDeps(dir, { sources: [] });
  const outA = runReviewer({ ...resolveReviewerConfig(), mode: "auto", cascade: [...resolveReviewerConfig().cascade, "fire-audit-on-clean" as const] }, SCAN_SRC, depsA);
  assert.equal(outA.enqueued, 0, "no scan-of-a-scan enqueue (auto mode)");
  assert.equal(callsA.enqueued.length, 0);
  assert.equal(outA.report!.cascadeStep, "duplicate-suppressed");
  // A genuinely different follow-up still fires:
  const { deps: deps2, calls: calls2 } = mkDeps(dir, { sources: [] });
  const out2 = runReviewer({ ...resolveReviewerConfig(), cascade: [...resolveReviewerConfig().cascade, "fire-audit-on-clean" as const] }, { ...GOAL_SRC, objective: "ship the held-loop display fix" }, deps2);
  assert.equal(calls2.proposed.length, 1, "non-duplicate clean completion still proposes");
  assert.equal(out2.report!.cascadeStep, "fire-audit-on-clean");
});
