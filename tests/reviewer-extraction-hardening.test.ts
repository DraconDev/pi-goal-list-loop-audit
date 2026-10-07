// pi-goal-list-loop-audit — v0.26.3
// tests/reviewer-extraction-hardening.test.ts
//
// Live false-positive regression: the reviewer fired on the 0.26.2
// completion and matched 3 junk "architectural" findings (a test name,
// the INSTALL.md mode-matrix table row, and ship-doc prose) — every one
// a reviewer-vocabulary self-match. These tests pin the exact lines.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  classifyFindingText,
  cutAtClauseBoundary,
  extractFindings,
  resolveReviewerConfig,
  runReviewer,
  type ReviewerDeps,
} from "../extensions/reviewer.ts";

// The exact 3 junk findings from the live 0.26.2 review report:
const LIVE_FALSE_POSITIVES = [
  'Docs: CHANGELOG `[0.26.2]` entry and INSTALL.md reviewer mode matrix (default/auto/report × problems/architectural/clean) with auto-loop and safety description.',
  '47:test("auto mode: architectural findings enqueue to /list — proposeGoal NEVER called", ...',
  '| Mode | Problems / improvements found | Architectural | Clean completion |',
];

test("the 3 live false-positive lines extract NOTHING", () => {
  for (const line of LIVE_FALSE_POSITIVES) {
    assert.equal(classifyFindingText(line), undefined, `still matching: ${line.slice(0, 60)}`);
  }
});

test("code lines are skipped (test/it/assert/const/import/…)", () => {
  assert.equal(classifyFindingText('test("architectural rewrite happens here", () => {})'), undefined);
  assert.equal(classifyFindingText('  it("should rewrite the schema", ...)'), undefined);
  assert.equal(classifyFindingText('const rewrite = loadSchema("x");'), undefined);
  assert.equal(classifyFindingText('import { rewrite } from "./schema";'), undefined);
  assert.equal(classifyFindingText('assert.equal(rewriteCount, 3);'), undefined);
});

test("markdown table rows are skipped", () => {
  assert.equal(classifyFindingText("| rewrite | new dependency | schema change |"), undefined);
  assert.equal(classifyFindingText("  | Mode | Architectural | Clean |"), undefined);
});

test("reviewer-report vocabulary is skipped (self-match prevention)", () => {
  assert.equal(classifyFindingText("Architectural-class findings are proposed as /goal, Confirm required"), undefined);
  assert.equal(classifyFindingText("the reviewer found 3 architectural-class finding(s)"), undefined);
  assert.equal(classifyFindingText("**Cascade step**: propose-goal — schema change discussed"), undefined);
  assert.equal(classifyFindingText("default/auto/report × problems/architectural/clean — schema change column"), undefined);
});

test("real architectural + strategic text still classifies", () => {
  assert.equal(classifyFindingText("we should rewrite the event schema to normalize it"), "architectural");
  assert.equal(classifyFindingText("this needs a new dependency on zod"), "architectural");
  assert.equal(classifyFindingText("requires a schema change in the ledger format"), "architectural");
  assert.equal(classifyFindingText("a redesign of the widget layer is due"), "architectural");
  assert.equal(classifyFindingText("should we deprecate the old API?"), "strategic");
  assert.equal(classifyFindingText("TODO: fix the null deref"), "bug");
});

test("v0.34.83: the bare word 'issue' is REMOVED from the bug regex — GitHub issue references and prose don't classify as bugs", () => {
  // The 0.34.82 reviewer fired on every completion summary that mentioned
  // a GitHub issue number ("GitHub issue #5", "issue #3", etc.) and
  // enqueued a junk bug finding. Real bug markers (TODO/FIXME/bug/
  // regression/broken/fixme) still classify.
  // GitHub issue refs — citations, not bugs:
  assert.equal(classifyFindingText("fixed in GitHub issue #5 (regression shield non-ASCII)"), undefined);
  assert.equal(classifyFindingText("See GitHub issue #3 for the list-collision resolution"), undefined);
  assert.equal(classifyFindingText("traced back to gh-123"), undefined);
  // Issue-prose phrases — not bugs (no other bug markers in the line):
  assert.equal(classifyFindingText("this issue is open and awaiting triage"), undefined);
  assert.equal(classifyFindingText("open the issue tracker and pick the next one"), undefined);
  // Real bug markers still classify:
  assert.equal(classifyFindingText("TODO: fix the null deref"), "bug");
  assert.equal(classifyFindingText("FIXME: the cache key is broken"), "bug");
  assert.equal(classifyFindingText("regression in the auditor path"), "bug");
  // Multi-marker lines still classify (regression is a real bug marker).
  assert.equal(classifyFindingText("this issue is a regression we shipped"), "bug");
});

test("v0.34.83: a completion summary referencing GitHub issues enqueues zero bug findings through the curated pipeline", () => {
  // The full review pipeline (stripCodeSpans + unwrapHardWrappedLines +
  // classifyFindingText + extractFindings) must not enqueue bug findings
  // when the only trigger-words are "GitHub issue #N" citations.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-issue-"));
  const calls = { proposed: [] as string[], enqueued: [] as string[][] };
  const text = [
    "Closed GitHub issue #5 (regression shield non-ASCII) and GitHub issue #4 (final confirm dialog).",
    "Reused the GitHub issue #3 (list collision) resolution to verify single-instance.",
    "Tracked via gh-123 for the audit-storm finding.",
  ].join("\n");
  const deps: ReviewerDeps = {
    cwd: dir,
    nowMs: Date.parse("2026-08-07T17:00:00Z"),
    ledgerEntries: [],
    sources: [{ name: "archive", text }],
    enqueueListItems: (objs) => { calls.enqueued.push(objs); return objs.length; },
    proposeGoal: (obj) => { calls.proposed.push(obj); return true; },
    notify: () => {},
    ledger: () => {},
  };
  const out = runReviewer(resolveReviewerConfig(), { kind: "goal", goalId: "g-issue", objective: "verify and close", terminal: "goal-complete" }, deps);
  assert.equal(out.fired, true);
  // No bug findings — every "issue" mention was a citation, not a bug.
  const bugs = out.report!.findings.filter((f) => f.class === "bug");
  assert.equal(bugs.length, 0, "GitHub issue citations must not enqueue bug findings");
  assert.equal(calls.enqueued.flat().length, 0);
});

test("full runReviewer over 0.26.2-style source text produces zero architectural findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-harden-"));
  const calls = { proposed: [] as string[], enqueued: [] as string[][] };
  const deps: ReviewerDeps = {
    cwd: dir,
    nowMs: Date.parse("2026-07-26T13:00:00Z"),
    ledgerEntries: [],
    sources: [{ name: "archive", text: LIVE_FALSE_POSITIVES.join("\n") }],
    enqueueListItems: (objs) => { calls.enqueued.push(objs); return objs.length; },
    proposeGoal: (obj) => { calls.proposed.push(obj); return true; },
    notify: () => {},
    ledger: () => {},
  };
  const out = runReviewer(resolveReviewerConfig(), { kind: "goal", goalId: "g1", objective: "ship 0.26.2", terminal: "goal-complete" }, deps);
  assert.equal(out.fired, true);
  assert.equal(out.report!.findings.length, 0, "the live junk lines produce no findings at all");
  // Zero findings = clean completion. Since v0.29.0 the fire-audit-on-clean
  // step is OPT-IN (removed from the default cascade — the auditor already
  // verified the work; a reflexive re-scan pays for verification twice).
  // With the default config NOTHING is proposed — and the real invariant
  // holds: no junk architectural /goal proposals from false-positive lines.
  assert.equal(calls.proposed.length, 0);
});

test("extraction dedupe + cap still work after hardening", () => {
  const findings = extractFindings(
    [{ name: "x", text: "TODO: fix the parser null deref\nTODO: fix the parser null deref\nTODO: fix the cache key" }],
    10,
  );
  assert.equal(findings.length, 2, "duplicates collapse");
  assert.ok(findings.every((f) => f.class === "bug"));
});

// ---- v0.28.24: wrap-aware extraction — findings are sentence-shaped, not visual-line-shaped ----

test("hard-wrapped finding joins into ONE full-sentence finding (hellhunter regression)", () => {
  const wrapped =
    "Run a post-completion regression scan on the hellhunter codebase to\n" +
    "check for bugs in the movement system after the refactor.";
  const findings = extractFindings([{ name: "x", text: wrapped }], 10);
  assert.equal(findings.length, 1, "the wrapped paragraph is ONE finding");
  assert.match(findings[0]!.text, /codebase to check for bugs/, "full sentence, no mid-sentence cut");
});

test("uppercase-start lines do NOT join — punctuation-less items stay separate", () => {
  const findings = extractFindings(
    [{ name: "x", text: "TODO: fix the parser null deref\nTODO: fix the cache key" }],
    10,
  );
  assert.equal(findings.length, 2, "TODO chains are not wrapped paragraphs");
});

test("dangling-connector fragments are rejected", () => {
  const findings = extractFindings(
    [{ name: "x", text: "- Fix the regression in the codebase to" }],
    10,
  );
  assert.equal(findings.length, 0, "a candidate ending in 'to' is a fragment, not a finding");
});

test("completedObjective prefix-dedupe: a finding restating the completed goal is skipped", () => {
  const completed = "Run a post-completion regression scan on the hellhunter codebase to check for bugs after the refactor";
  const findings = extractFindings(
    [{ name: "x", text: `- ${completed.slice(0, 67)}` }], // the hellhunter fragment shape
    10,
    completed,
  );
  assert.equal(findings.length, 0, "prefix of the completed objective is a duplicate");
  // and a genuinely NEW finding survives the same call:
  const fresh = extractFindings(
    [{ name: "x", text: "- Fix the regression in the projectile collision system" }],
    10,
    completed,
  );
  assert.equal(fresh.length, 1, "unrelated findings are unaffected by the dedupe");
});

test("cutAtClauseBoundary: long findings cut at a clause, never mid-word", () => {
  const long = `Fix the parser: it drops frames when the input is malformed, and the cache layer keys on stale state, ${"x".repeat(220)}`;
  const cut = cutAtClauseBoundary(long, 200);
  assert.ok(cut.length <= 200);
  assert.match(cut, /[.,;:]$|^.{0,199}\S$/, "ends at a boundary");
  assert.ok(!/\s(to|and|the|of)$/i.test(cut), "never ends on a dangling connector mid-word");
  // short text passes through untouched:
  assert.equal(cutAtClauseBoundary("short finding", 200), "short finding");
});
