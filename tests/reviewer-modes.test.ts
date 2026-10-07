// pi-goal-list-loop-audit — v0.26.2
// tests/reviewer-modes.test.ts
//
// Reviewer modes + the auto-loop cascade: default (Confirm-gated),
// auto (everything actionable becomes /list items, zero Confirms),
// report (report + notify only). Plus improvement-class extraction
// and the auto-mode refire-window relaxation for list-complete.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_REVIEWER_CONFIG,
  classifyFindingText,
  resolveReviewerConfig,
  reviewerMenuOptions,
  runReviewer,
  type ReviewerDeps,
} from "../extensions/reviewer.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC_GOAL = readGoalRuntimeSource();
const SRC_CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2

function mkDeps(cwd: string, over: Partial<ReviewerDeps> = {}) {
  const calls = { enqueued: [] as string[][], proposed: [] as string[], notified: [] as string[], ledgered: [] as string[] };
  const deps: ReviewerDeps = {
    cwd,
    nowMs: Date.parse("2026-07-26T12:00:00Z"),
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

const GOAL_SRC = { kind: "goal" as const, goalId: "g1", objective: "audit screens", terminal: "goal-complete" };
const LIST_SRC = { kind: "list" as const, goalId: "g9", objective: "last item", terminal: "goal-complete" };
const AUTO = { ...resolveReviewerConfig(), mode: "auto" as const };
const REPORT = undefined; // v0.27.9: legacy alias — `report` mode was removed in 0.27.9 (4-mode set: off | on | auto | aggressive). Kept as undefined so any stale references fail loudly.

test("E4: a failed proposal send is NOT counted or reported (phantom-reviewer hole closed)", () => {
  // goal.ts's proposeGoal callback returns false when sendUserMessage throws
  // (stale handle etc.) and notifies loudly. The reviewer must not count it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-e4-"));
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "audit", text: "We should rewrite the schema to normalize events." }],
    proposeGoal: () => false,
  });
  const out = runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(out.proposed, 0, "a failed send never counts as proposed — the '(N /goal proposed)' notify can no longer lie");
  assert.equal(calls.proposed.length, 0, "the false-returning mock recorded no successful delivery");
});

test("E4: clean-completion branch also gates on delivery — default AND aggressive modes", () => {
  // The 0.28.8 disapproval: fire-audit-on-clean incremented proposed++
  // unconditionally in two of four branches. Both must gate on the boolean.
  for (const mode of ["on", "aggressive"] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-e4-clean-"));
    const { deps } = mkDeps(dir, {
      sources: [{ name: "archive", text: "All done. Tests pass." }], // clean — no findings
      proposeGoal: () => false,
    });
    const out = runReviewer({ ...resolveReviewerConfig(), mode, cascade: [...resolveReviewerConfig().cascade, "fire-audit-on-clean" as const] }, GOAL_SRC, deps);
    assert.equal(out.fired, true);
    assert.equal(out.proposed, 0, `${mode} mode: failed clean-completion proposal never counts`);
  }
});

test("auto mode: architectural findings enqueue to /list — proposeGoal NEVER called", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "audit", text: "We should rewrite the schema to normalize events." }],
  });
  const out = runReviewer(AUTO, GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(calls.proposed.length, 0, "auto mode never proposes (no Confirm)");
  assert.equal(calls.enqueued.length, 1);
  assert.match(calls.enqueued[0]![0]!, /rewrite the schema/);
});

test("auto mode: clean completion enqueues the audit as a /list item (no Confirm)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, { sources: [{ name: "archive", text: "All done. Tests pass." }] });
  const out = runReviewer({ ...AUTO, cascade: [...AUTO.cascade, "fire-audit-on-clean" as const] }, GOAL_SRC, deps);
  assert.equal(out.report!.cascadeStep, "fire-audit-on-clean");
  assert.equal(calls.proposed.length, 0);
  assert.equal(calls.enqueued.length, 1);
  assert.match(calls.enqueued[0]![0]!, /regression scan/i);
});

test("report mode: REMOVED in 0.27.9 (the 4-mode set `off | on | auto | aggressive` has no report branch)", () => {
  // The 5-mode set `off | default | auto | aggressive | report` was
  // re-shaped in 0.27.9 to the contract-mandated 4-mode set. The
  // legacy `report` mode (write the report + notify only, no cascade)
  // was dropped. This empty test exists to anchor the deletion so a
  // future refactor doesn't quietly re-add a `report` mode.
  const src = fs.readFileSync("extensions/reviewer.ts", "utf-8");
  assert.doesNotMatch(src, /cascadeStep = "report-only"/);
});

test("improvement-class extraction: 'consider adding X' / 'could be improved' enqueue without Confirm", () => {
  assert.equal(classifyFindingText("consider adding a retry queue for failed jobs"), "refactor");
  assert.equal(classifyFindingText("the startup path could be improved a lot"), "refactor");
  assert.equal(classifyFindingText("nice to have: dark mode for the HUD"), "refactor");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, { sources: [{ name: "archive", text: "consider adding a retry queue for failed jobs" }] });
  runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.proposed.length, 0);
});

test("auto mode: refire window skipped for list-complete, enforced for goal-complete and in default mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const now = Date.parse("2026-07-26T12:00:00Z");
  const recent = [{ type: "reviewer_fired", at: new Date(now - 60_000).toISOString() }];
  // auto + list-complete → fires despite the recent fire:
  const a = runReviewer(AUTO, LIST_SRC, mkDeps(dir, { ledgerEntries: recent }).deps);
  assert.equal(a.fired, true, "auto mode list-complete ignores the refire window");
  // auto + goal-complete → still suppressed:
  const b = runReviewer(AUTO, GOAL_SRC, mkDeps(dir, { ledgerEntries: recent }).deps);
  assert.equal(b.fired, false, "auto mode goal-complete still respects the window");
  // default + list-complete → suppressed:
  const c = runReviewer(resolveReviewerConfig(), LIST_SRC, mkDeps(dir, { ledgerEntries: recent }).deps);
  assert.equal(c.fired, false, "default mode list-complete respects the window");
});

test("auto mode: the per-day cap still bounds everything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const entries = Array.from({ length: 20 }, (_, i) => ({ type: "reviewer_fired", at: `2026-07-26T${String(i).padStart(2, "0")}:00:00Z` }));
  const { deps } = mkDeps(dir, { ledgerEntries: entries, nowMs: Date.parse("2026-07-26T23:30:00Z") });
  const out = runReviewer(AUTO, LIST_SRC, deps);
  assert.equal(out.fired, false);
  assert.match(out.suppressedReason!, /daily postaudit cap/);
});

test("menu: Mode option lists the 4 modes (off, on, auto, aggressive)", () => {
  const def = reviewerMenuOptions(DEFAULT_REVIEWER_CONFIG);
  assert.match(def[1]!, /Mode — on/);
  assert.match(def[1]!, /auto = auto-loop/);
  assert.match(def[1]!, /aggressive = auto \+ relaunch/);
  assert.match(def[1]!, /off = silenced/);
  assert.doesNotMatch(def[1]!, /report/);
  const off = reviewerMenuOptions({ ...DEFAULT_REVIEWER_CONFIG, mode: "off" });
  assert.match(off[1]!, /Mode — off/);
  // the goal.ts handler cycles through 4 modes (off → on → auto → aggressive → off)
  assert.match(SRC_CMDS, /order: Array<"off" \| "on" \| "auto" \| "aggressive"> = \["off", "on", "auto", "aggressive"\]/);
});

test("/review accepts all 4 modes and rejects unknown modes", () => {
  assert.match(SRC_CMDS, /const validModes = \["off", "on", "auto", "aggressive"\] as const/);
  assert.match(SRC_CMDS, /Unknown mode "\$\{modeArg\}" — use off \| on \| auto \| aggressive\./);
  assert.match(SRC_CMDS, /\{ manual: true, mode \}\)/);
});

test("config: mode defaults to 'on' and merges from project settings", () => {
  assert.equal(DEFAULT_REVIEWER_CONFIG.mode, "on");
  assert.equal(resolveReviewerConfig({ mode: "auto" }).mode, "auto");
  assert.equal(resolveReviewerConfig({ mode: "off" }).mode, "off");
  assert.equal(resolveReviewerConfig({ mode: "aggressive" }).mode, "aggressive");
  assert.equal(resolveReviewerConfig().mode, "on");
});

test("config: legacy 'default' and 'report' modes auto-migrate to 'on'", () => {
  // v0.27.9: existing settings files with the old 5-mode values should not
  // silently fall back to defaults — they map to 'on'.
  assert.equal(resolveReviewerConfig({ mode: "default" as any }).mode, "on");
  assert.equal(resolveReviewerConfig({ mode: "report" as any }).mode, "on");
});

test("report-mode test removed: the 4-mode postaudit surface (`off | on | auto | aggressive`) has no report branch anymore (0.27.9)", () => {
  // The legacy 5-mode set (`off | default | auto | aggressive | report`) was
  // re-shaped to the contract-mandated 4-mode set in 0.27.9: `default` →
  // `on`, `report` dropped entirely. This test exists so a future audit
  // doesn't try to re-add a `report` mode silently — the surface is fixed
  // by contract.
  const src = fs.readFileSync("extensions/reviewer.ts", "utf-8");
  assert.match(src, /export type ReviewerMode = "off" \| "on" \| "auto" \| "aggressive";/);
  assert.doesNotMatch(src, /mode === "report"/);
  assert.doesNotMatch(src, /mode: "report"/);
});

test("off mode: reviewer NEVER fires (equivalent to enabled=false, exposed via postaudit menu)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-off-"));
  const cfg = { ...resolveReviewerConfig(), mode: "off" as const };
  // Should also fire when the source has findings (only enabled=false would skip)
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "audit", text: "We should rewrite the schema to normalize events." }],
  });
  const out = runReviewer(cfg, GOAL_SRC, deps);
  assert.equal(out.fired, false);
  assert.match(out.suppressedReason!, /off/);
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.proposed.length, 0);
});

test("aggressive mode: architectural findings enqueue AND the first one relaunches as /goal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-aggr-"));
  const cfg = { ...resolveReviewerConfig(), mode: "aggressive" as const };
  const { deps, calls } = mkDeps(dir, {
    sources: [
      { name: "audit", text: "We should rewrite the schema to normalize events." },
      { name: "audit", text: "Architectural redesign: split the orchestrator into separate command and queue layers." },
    ],
  });
  const out = runReviewer(cfg, GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.enqueued[0]!.length, 2, "both architectural findings enqueued");
  assert.equal(calls.proposed.length, 1, "first architectural finding relaunched as /goal");
  assert.match(out.cascadeStep!, /aggressive-relaunch/);
});

test("aggressive mode: clean completion → relaunch audit /goal (no Confirm)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-aggr-clean-"));
  const cfg = { ...resolveReviewerConfig(), mode: "aggressive" as const, cascade: [...resolveReviewerConfig().cascade, "fire-audit-on-clean" as const] };
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "archive", text: "Goal completed cleanly. No findings." }],
  });
  const out = runReviewer(cfg, GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(calls.proposed.length, 1, "regression scan relaunched as /goal");
  assert.match(calls.proposed[0]!, /Post-completion regression scan/);
  assert.equal(calls.enqueued.length, 0, "aggressive clean does NOT enqueue — it relaunches");
  assert.match(out.cascadeStep!, /aggressive-relaunch/);
});

test("goal.ts fireReviewer opts.mode now accepts the 4-mode ReviewerMode union", () => {
  assert.match(
    SRC_GOAL,
    /opts:\s*\{\s*manual\?\s*:\s*boolean;\s*mode\?\s*:\s*"off"\s*\|\s*"on"\s*\|\s*"auto"\s*\|\s*"aggressive"\s*\}\s*=\s*\{\}/,
    "fireReviewer's mode type widened to the 4-mode union",
  );
});
