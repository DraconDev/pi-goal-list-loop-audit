// pi-goal-list-loop-audit — layered prompt contract tests
//
// Render-diff gate: full assembly (every detail active) is byte-identical to
// the source file minus its structural marker lines, for ALL SEVEN prompt
// files. Production subsets differ from legacy output by EXACTLY the deferred
// detail bodies — proven by equal-length-fixture diffs below.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  assemblePrompt,
  assemblePromptFull,
  loadPromptSegments,
  loadPromptWhole,
  parsePromptLayers,
  promptDetailIds,
} from "../extensions/prompt-layers.ts";
import { continuationPrompt } from "../extensions/goal-continuation.ts";

const PROMPTS = [
  "goal-loop-continuation.md",
  "goal-loop-forever.md",
  "goal-loop-forever-metricless.md",
  "goal-loop-draft.md",
  "goal-loop-forever-draft.md",
  "goal-loop-plan.md",
  "goal-loop-plan-loop.md",
];

function stripMarkers(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.match(/glla-layer:/))
    .join("\n");
}

for (const name of PROMPTS) {
  test(`full assembly of ${name} is byte-identical to source minus markers`, () => {
    const raw = fs.readFileSync(`prompts/${name}`, "utf-8");
    assert.equal(assemblePromptFull(name), stripMarkers(raw));
  });
}

test("continuation declares exactly the three conditional details", () => {
  assert.deepEqual(promptDetailIds("goal-loop-continuation.md"), [
    "auditor-disapproval",
    "survey-pivot",
    "session-restart",
  ]);
});

test("the other six prompts are skeleton-only (whole file is the skeleton)", () => {
  for (const name of PROMPTS.slice(1)) {
    assert.deepEqual(promptDetailIds(name), [], name);
    assert.equal(assemblePrompt(name, []), fs.readFileSync(`prompts/${name}`, "utf-8"));
  }
});

test("missing prompt file fails loudly, never lean", () => {
  assert.throws(() => loadPromptWhole("no-such-prompt.md"), /prompt file missing: prompts\/no-such-prompt\.md/);
  assert.throws(() => assemblePrompt("no-such-prompt.md", []), /prompt file missing/);
});

test("unknown detail id fails loudly", () => {
  assert.throws(
    () => assemblePrompt("goal-loop-continuation.md", ["bogus-id"]),
    /unknown detail id "bogus-id"/,
  );
});

test("parser defects fail loudly", () => {
  assert.throws(() => parsePromptLayers("a\n<!-- glla-layer: detail x -->\nb", "t.md"), /unclosed/);
  assert.throws(
    () => parsePromptLayers("<!-- glla-layer: detail x -->\na\n<!-- glla-layer: end -->\n<!-- glla-layer: detail x -->\nb\n<!-- glla-layer: end -->", "t.md"),
    /duplicate detail id/,
  );
  assert.throws(() => parsePromptLayers("a\n<!-- glla-layer: end -->", "t.md"), /without an open detail/);
  assert.throws(
    () => parsePromptLayers("<!-- glla-layer: detail x -->\n<!-- glla-layer: detail y -->\n", "t.md"),
    /unclosed/,
  );
});

test("assembly order is file order regardless of request order (same every turn)", () => {
  const a = assemblePrompt("goal-loop-continuation.md", ["session-restart", "auditor-disapproval", "survey-pivot"]);
  const b = assemblePrompt("goal-loop-continuation.md", ["auditor-disapproval", "survey-pivot", "session-restart"]);
  assert.equal(a, b);
  assert.equal(a, assemblePromptFull("goal-loop-continuation.md"));
});

function baseGoal(): any {
  return {
    id: "layer-test",
    objective: "Repair the login flow edge case",
    verificationContract: "login test green",
    status: "active",
    policy: "goal",
    startedAt: "2026-09-11T00:00:00.000Z",
    auditHistory: [],
    taskList: { tasks: [] },
  };
}

function detailBody(id: string): string {
  const segs = loadPromptSegments("goal-loop-continuation.md");
  const seg = segs.find((s) => s.kind === "detail" && s.id === id);
  assert.ok(seg, `detail ${id} exists`);
  return seg!.lines.join("\n");
}

const padRight = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));

test("normal-turn render omits all three details; token cost lower by the deferred bodies", () => {
  const normal = continuationPrompt(baseGoal());
  assert.doesNotMatch(normal, /## WHEN THE AUDITOR DISAPPROVES/);
  assert.doesNotMatch(normal, /## PIVOT DETECTION/);
  assert.doesNotMatch(normal, /## AFTER A SESSION RESTART/);
  const full = assemblePromptFull("goal-loop-continuation.md");
  const bare = assemblePrompt("goal-loop-continuation.md", []);
  const saved = full.length - bare.length;
  assert.ok(saved > 1000, `deferred bodies save ${saved} chars`);
});

test("survey-pivot delta is EXACTLY the deferred body (equal-length objectives)", () => {
  const plain = "Repair the login flow edge case";
  const survey = "Survey the login flow edge case";
  assert.equal(plain.length, survey.length);
  const a = continuationPrompt({ ...baseGoal(), objective: plain });
  const b = continuationPrompt({ ...baseGoal(), objective: survey });
  assert.ok(b.includes("## PIVOT DETECTION"));
  const body = detailBody("survey-pivot");
  // Joining the block into the line stream contributes exactly one extra
  // newline beyond the body itself (skeleton blank lines on both sides).
  assert.equal(b.length - a.length, body.length + 1);
  assert.equal(b.replace(body + "\n", ""), a);
});

test("session-restart delta is EXACTLY the deferred body (opts flag only)", () => {
  const goal = baseGoal();
  const a = continuationPrompt({ ...goal });
  const b = continuationPrompt({ ...goal }, { includeRestartDetail: true });
  assert.ok(b.includes("## AFTER A SESSION RESTART"));
  const body = detailBody("session-restart");
  // See above: one extra joining newline beyond the body itself.
  assert.equal(b.length - a.length, body.length + 1);
  assert.equal(b.replace(body + "\n", ""), a);
});

test("autoResumedAt goals get the restart detail without opts", () => {
  const b = continuationPrompt({ ...baseGoal(), autoResumedAt: "2026-09-11T00:00:00.000Z" });
  assert.ok(b.includes("## AFTER A SESSION RESTART"));
});

function disapproval(): any {
  return {
    at: "2026-09-11T00:00:00.000Z",
    disapproved: true,
    approved: false,
    report: "objection: the widget still drops the tail",
  };
}

test("live disapproval loads the auditor playbook detail", () => {
  const a = continuationPrompt(baseGoal());
  const b = continuationPrompt({ ...baseGoal(), auditHistory: [disapproval()] });
  assert.ok(b.includes("## WHEN THE AUDITOR DISAPPROVES"));
  const body = detailBody("auditor-disapproval");
  assert.ok(b.length - a.length >= body.length, "render grows by at least the deferred body");
});

test("padRight helper keeps fixture objectives length-neutral", () => {
  const x = padRight("short", 10);
  assert.equal(x.length, 10);
});
