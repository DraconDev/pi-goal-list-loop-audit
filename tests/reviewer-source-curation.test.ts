// pi-goal-list-loop-audit — v0.26.4
// tests/reviewer-source-curation.test.ts
//
// Source curation: the 0.26.3 completion produced ANOTHER junk review
// (4 false "architectural" findings) — all meta-artifacts mined from the
// APPROVED audit report (the executor's own completion claims) and from
// backticked code spans. Regex guards lose the arms race against
// meta-text; the fix is curating WHAT gets scanned.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildReviewerSources,
  classifyFindingText,
  curateAuditReviewSources,
  extractFindings,
  stripCodeSpans,
  resolveReviewerConfig,
  runReviewer,
  type ReviewerDeps,
} from "../extensions/reviewer.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC_GOAL = readGoalRuntimeSource();

// The exact 4 junk findings from the 0.26.3 misfire:
const LIVE_FALSE_POSITIVES = [
  '4. **Vocabulary skip**: `REVIEWER_VOCAB` regex present covering all specified terms plus `problems/(improvements|architectural)`.',
  '{ class: "architectural", re: /\\brewrite\\b|new dependency|schema change|\\bredesign\\b/i },',
  "'Docs: CHANGELOG `[0.26.2]` entry and INSTALL.md reviewer mode matrix ... problems/architectural/clean) ...',",
  '\'47:test("auto mode: architectural findings enqueue to /list — proposeGoal NEVER called", ...\',',
];

test("stripCodeSpans removes fenced blocks and inline spans", () => {
  const text = ' prose `const x = rewrite();` more\n```ts\n{ class: "architectural", re: /rewrite/ }\n```\ntail';
  const out = stripCodeSpans(text);
  assert.ok(!out.includes("rewrite"), "code content gone");
  assert.ok(!out.includes("architectural"));
  assert.ok(out.includes("prose") && out.includes("tail"), "prose survives");
});

test("the 4 junk lines from the 0.26.3 misfire extract NOTHING through the curated pipeline", () => {
  const findings = extractFindings([{ name: "audit", text: LIVE_FALSE_POSITIVES.join("\n") }], 10);
  assert.deepEqual(findings, []);
});

test("brace-led and quote-led lines are code-ish, never findings", () => {
  assert.equal(classifyFindingText('{ class: "architectural", re: /\\brewrite\\b|new dependency|schema change/ },'), undefined);
  assert.equal(classifyFindingText('  ["rewrite the parser", "schema change"],'), undefined);
  assert.equal(classifyFindingText("'we should rewrite the schema',"), undefined);
  assert.equal(classifyFindingText('"requires a schema change in the ledger",'), undefined);
});

test("fireReviewer only mines disapproved/error audit reports, never approved ones", () => {
  assert.match(SRC_GOAL, /curateAuditReviewSources\(readAuditLogForGoal\(ctx\.cwd, source\.goalId\), source\.goalId\)\.map\(/);
  assert.match(SRC_GOAL, /APPROVED audit report is the executor's\n    \/\/ own completion claims/);
  assert.match(SRC_GOAL, /automatic postaudit must not mine the archive's Objective/);
});

test("v0.35.72: postaudit proposal counts only when safeSteerUser delivers", () => {
  const callback = SRC_GOAL.slice(SRC_GOAL.indexOf("proposeGoal: (objective, reason)"), SRC_GOAL.indexOf("notify: (message, level)", SRC_GOAL.indexOf("proposeGoal: (objective, reason)")));
  assert.match(callback, /const delivered = safeSteerUser/);
  assert.match(callback, /return delivered;/);
});

test("automatic postaudit excludes archived objective/contract metadata; manual review retains it", () => {
  const archive = [
    "## Objective",
    "Implement safe automatic recovery; fix the reviewer regression.",
    "## Verification contract",
    "bun test passes sequentially; duplicate protections are covered.",
  ].join("\\n");
  assert.deepEqual(buildReviewerSources(archive, [], false), [], "automatic clean review has no archive metadata source");
  assert.deepEqual(buildReviewerSources(archive, ["## Required fixes\\n- fix the broken retry"], false), [
    { name: "audit", text: "## Required fixes\\n- fix the broken retry" },
  ]);
  assert.deepEqual(buildReviewerSources(archive, [], true), [{ name: "archive", text: archive }], "manual review may inspect the archive");
});

test("a DISAPPROVED report's required-fixes extract as findings; an APPROVED meta-report is inert", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-curate-"));
  const approvedMeta = "## Verification\n1. `REVIEWER_VOCAB` regex present covering problems/(improvements|architectural) — PASS.\n2. `{ class: \"architectural\", re: /rewrite|schema change/ }` present — PASS.";
  const disapprovedReal = "## Required fixes\n- TODO: the retry backoff is broken — it retries immediately.\n- consider adding a timeout to the auditor spawn";
  // Approved meta-report: zero findings (spans stripped, vocab guarded).
  const meta = extractFindings([{ name: "audit", text: approvedMeta }], 10);
  assert.deepEqual(meta, [], "approved meta-report yields nothing");
  // Disapproved report: the real findings come through.
  const real = extractFindings([{ name: "audit", text: disapprovedReal }], 10);
  assert.equal(real.length, 2);
  assert.equal(real[0]!.class, "bug");
  assert.equal(real[1]!.class, "refactor");
  // And through runReviewer end-to-end:
  const calls = { enqueued: [] as string[][], proposed: [] as string[] };
  const deps: ReviewerDeps = {
    cwd: dir,
    nowMs: Date.parse("2026-07-26T14:00:00Z"),
    ledgerEntries: [],
    sources: [
      { name: "audit", text: approvedMeta },
      { name: "audit", text: disapprovedReal },
    ],
    enqueueListItems: (o) => { calls.enqueued.push(o); return o.length; },
    proposeGoal: (g) => { calls.proposed.push(g); return true; },
    notify: () => {},
    ledger: () => {},
  };
  const out = runReviewer(resolveReviewerConfig(), { kind: "goal", goalId: "g1", objective: "ship 0.26.4", terminal: "goal-complete" }, deps);
  assert.equal(out.enqueued, 2);
  assert.equal(calls.proposed.length, 0);
});

test("superseded-disapproval curation: a disapproval answered by a later approval is NOT re-mined", () => {
  // v0.34.61 (field-observed 2026-08-06): goal lhy6nt round-1 DISAPPROVED
  // → round-2 APPROVED. The reviewer mined the round-1 disapproval report
  // verbatim ("The gate and both apply sites exist...", section headings,
  // numbered narrative lines) into 3 junk /list items and cascade-activated
  // one. A disapproval superseded by a later approval is ANSWERED work —
  // its required fixes were exactly what the approval verified.
  const goalLog = [
    { goalId: "g-r1", verdict: "disapproved", report: "## Required fixes\n- TODO: fix the pinned gap", at: "2026-08-06T10:00:00Z" },
    { goalId: "g-r1", verdict: "approved", report: "<approved/>", at: "2026-08-06T11:00:00Z" },
  ];
  assert.deepEqual(curateAuditReviewSources(goalLog, "g-r1"), [], "approval supersedes — zero audit sources");

  // A disapproval that is still the LAST verdict stays mineable (goal
  // ended on it: aborted/paused, work still open).
  const openLog = [
    { goalId: "g-r1", verdict: "disapproved", report: "## Required fixes\n- TODO: fix the pinned gap", at: "2026-08-06T10:00:00Z" },
  ];
  const mined = curateAuditReviewSources(openLog, "g-r1");
  assert.equal(mined.length, 1);
  assert.match(mined[0]!.report, /Required fixes/);

  // Error verdicts behave like disapprovals when still the last verdict.
  const errLog = [{ goalId: "g-r1", verdict: "error", report: "auditor infra failure", at: "2026-08-06T10:00:00Z" }];
  assert.equal(curateAuditReviewSources(errLog, "g-r1").length, 1);
  assert.deepEqual(curateAuditReviewSources(errLog, "g-other"), [], "other goals' entries never mined");

  // Two disapprovals then approval: ALL superseded.
  const multi = [
    { goalId: "g-r1", verdict: "disapproved", report: "first", at: "2026-08-06T09:00:00Z" },
    { goalId: "g-r1", verdict: "disapproved", report: "second", at: "2026-08-06T09:30:00Z" },
    { goalId: "g-r1", verdict: "approved", report: "<approved/>", at: "2026-08-06T11:00:00Z" },
  ];
  assert.deepEqual(curateAuditReviewSources(multi, "g-r1"), [], "all prior disapprovals superseded by the approval");
});

test("real prose findings still classify after curation", () => {
  assert.equal(classifyFindingText("we should rewrite the event schema to normalize it"), "architectural");
  assert.equal(classifyFindingText("TODO: the retry backoff is broken"), "bug");
  assert.equal(classifyFindingText("consider adding a timeout to the spawn"), "refactor");
});
