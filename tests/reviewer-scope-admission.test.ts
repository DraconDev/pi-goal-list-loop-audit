import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractFindings, formatReviewReport, resolveReviewerConfig, runReviewer, type ReviewerDeps } from "../extensions/reviewer.ts";

const source = { kind: "goal" as const, goalId: "scope-admission", objective: "ship the change", terminal: "goal-complete" };
function fixture(text: string, admitted: number) {
  const notes: string[] = [];
  const events: Array<{ type: string; value: Record<string, unknown> }> = [];
  const requests: string[][] = [];
  const deps: ReviewerDeps = {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "glla-review-admission-")),
    nowMs: Date.now(), ledgerEntries: [], sources: [{ name: "audit", text }],
    enqueueListItems: items => { requests.push(items); return admitted; },
    proposeGoal: () => false, notify: text => { notes.push(text); },
    ledger: (type, value) => { events.push({ type, value }); },
  };
  return { deps, notes, events, requests };
}

test("Outside Scope heading survives extraction, nested sections, and report rendering", () => {
  const text = "## Outside Scope\n\n- TODO: fix external provider crash\n### Details\n- redesign external architecture\n## Local fixes\n- TODO: fix local handler\n";
  const findings = extractFindings([{ name: "audit", text }], 10);
  assert.equal(findings.length, 3);
  assert.equal(findings[0]!.outsideScope, true);
  assert.equal(findings[1]!.outsideScope, true);
  assert.equal(findings[2]!.outsideScope, undefined);
  const f = fixture(text, 1);
  const out = runReviewer(resolveReviewerConfig({ mode: "aggressive" }), source, f.deps);
  assert.deepEqual(f.requests, [["TODO: fix local handler"]]);
  assert.equal(out.enqueued, 1);
  assert.equal(out.proposed, 0);
  const report = formatReviewReport(out.report!);
  assert.match(report, /## Outside Scope \(informational only\)/);
  assert.match(report, /TODO: fix external provider crash/);
  assert.equal(f.events.find(e => e.type === "reviewer_outside_scope")!.value.count, 2);
});

test("outside-scope section does not leak to the next report source", () => {
  const findings = extractFindings([
    { name: "one", text: "## Outside Scope\n- TODO: external problem" },
    { name: "two", text: "- TODO: local problem" },
  ], 10);
  assert.equal(findings[0]!.outsideScope, true);
  assert.equal(findings[1]!.outsideScope, undefined);
});

for (const mode of ["on", "auto", "aggressive"] as const) {
  test(`${mode} counts rejected queue admissions honestly`, () => {
    const f = fixture("- TODO: fix local handler", 0);
    const out = runReviewer(resolveReviewerConfig({ mode }), source, f.deps);
    assert.equal(out.enqueued, 0);
    assert.equal(out.cascadeStep, "enqueue-rejected");
    const event = f.events.find(e => e.type === "reviewer_fired")!;
    assert.equal(event.value.enqueued, 0);
    assert.equal(event.value.enqueueRejected, 1);
    assert.ok(f.notes.some(n => n.includes("0 enqueued to /list")));
  });
}

test("partial admission counts only durable items", () => {
  const f = fixture("- TODO: first broken handler\n- FIXME: second broken handler", 1);
  const out = runReviewer(resolveReviewerConfig(), source, f.deps);
  assert.equal(out.enqueued, 1);
  assert.equal(out.cascadeStep, "convert-findings-to-list");
  assert.equal(f.events.find(e => e.type === "reviewer_fired")!.value.enqueueRejected, 1);
});

for (const order of ["outside-first", "local-first"] as const) {
  test(`scope-aware deduplication preserves local admission (${order})`, () => {
    const text = "TODO: fix broken handler";
    const external = { name: "external-report", text: `## Outside Scope\n- ${text}` };
    const local = { name: "local-report", text: `## Local Findings\n- ${text}` };
    const sources = order === "outside-first" ? [external, local] : [local, external];
    // Copies within each scope still deduplicate, independently of order.
    const f = fixture("", 1);
    f.deps.sources = [...sources, ...sources];
    const out = runReviewer(resolveReviewerConfig(), source, f.deps);
    assert.deepEqual(f.requests, [[text]], "only the local repair is queued exactly once");
    assert.equal(out.enqueued, 1);
    assert.equal(out.proposed, 0);
    assert.equal(out.report!.findings.length, 2, "one informational and one actionable identity");
    const outside = out.report!.findings.filter(finding => finding.outsideScope);
    const inside = out.report!.findings.filter(finding => !finding.outsideScope);
    assert.equal(outside.length, 1);
    assert.equal(outside[0]!.source, "external-report");
    assert.equal(inside.length, 1);
    assert.equal(inside[0]!.source, "local-report");
    assert.match(formatReviewReport(out.report!), /Outside Scope \(informational only\)/);
    assert.equal(f.events.find(e => e.type === "reviewer_outside_scope")!.value.count, 1);
  });
}

test("architectural auto queue and clean audit queue use actual admissions", () => {
  for (const text of ["- redesign the local architecture", "No findings."]) {
    const f = fixture(text, 0);
    const out = runReviewer(resolveReviewerConfig({ mode: "auto", cascade: ["fire-audit-on-clean"] }), source, f.deps);
    assert.equal(f.requests.length, 1);
    assert.equal(out.enqueued, 0);
    assert.equal(out.cascadeStep, "enqueue-rejected");
  }
});
