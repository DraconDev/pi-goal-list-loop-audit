import { test } from "node:test";
import * as assert from "node:assert/strict";

import { renderGoalMarkdown, type Goal } from "../extensions/goal-loop-core.ts";
import { buildWidgetLines } from "../extensions/goal-loop-display.ts";

const NOW = Date.parse("2026-08-19T05:20:00Z");

const RECAP = [
  "Outcome: Shipped the completion-summary policy review.",
  "Changed: Added audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md.",
  "Evidence: Focused source review and the policy artifact.",
  "Tests: bun test tests/goal-loop-core.test.ts — 52 passed, 0 failed.",
  "Unresolved: No source fix is supported by the current evidence.",
  "Next: Apply the template to future completion claims.",
].join("\n");

function completedGoal(): Goal {
  return {
    id: "20260819052000-recap1",
    objective: "Define a useful structured end-of-goal summary",
    status: "complete",
    policy: "list",
    autoContinue: true,
    completionSummary: RECAP,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-19T05:00:00Z",
    updatedAt: "2026-08-19T05:20:00Z",
  };
}

test("structured completion recap survives archive rendering and the terminal widget", () => {
  const goal = completedGoal();
  const archived = renderGoalMarkdown(goal);

  assert.match(archived, /^## Completion summary$/m);
  for (const label of ["Outcome", "Changed", "Evidence", "Tests", "Unresolved", "Next"]) {
    assert.match(archived, new RegExp(`^${label}: .+`, "m"), `${label} remains in the archived recap`);
  }

  const widget = buildWidgetLines(
    { goal, list: [] },
    null,
    NOW,
    undefined,
    600,
  );
  assert.ok(widget);
  assert.equal(widget.length, 1, "the compact terminal surface remains one line");
  assert.match(widget[0]!, /Shipped the completion-summary policy review/);
  assert.doesNotMatch(widget[0]!, /Tests:|52 passed|Changed:|Evidence:/, "technical recap labels stay out of the default TUI card");
  assert.match(widget[0]!, /✓ done/);
  assert.match(widget[0]!, /took 20m/);
});

// The detached completion auditor must receive completionSummary and
// verificationSummary as INDEPENDENT fields. The recap is an executor
// claim; the verification summary is per-contract evidence; the auditor
// cross-checks one against real artifacts. Pin the structural separation
// so a future refactor of buildGoalAuditorPrompt cannot collapse them
// into a single string without breaking this test.
test("auditor receives completionSummary and verificationSummary independently", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("extensions/goal-loop-auditor.ts", "utf-8");
  const promptFn = src.match(/function buildGoalAuditorPrompt[\s\S]+?^}/m);
  assert.ok(promptFn, "buildGoalAuditorPrompt function found");

  const body = promptFn[0]!;
  assert.match(body, /completionSummary/, "completionSummary parameter is referenced");
  assert.match(body, /verificationSummary/, "verificationSummary parameter is referenced");
  assert.match(body, /<completion_summary>/, "completionSummary is rendered inside its own XML block");
  assert.match(body, /<verification_summary>/, "verificationSummary is rendered inside its own XML block");

  // The two blocks must not be concatenated by the formatter: completion_summary
  // closes BEFORE verification_summary opens, and each has its own label.
  const closeCompletion = body.indexOf("</completion_summary>");
  const openVerification = body.indexOf("<verification_summary>");
  assert.ok(closeCompletion > 0, "completion_summary block closes");
  assert.ok(openVerification > 0, "verification_summary block opens");
  assert.ok(
    openVerification > closeCompletion,
    "verification_summary opens AFTER completion_summary closes — they are independent blocks",
  );
});

// The complete_goal tool schema description must point callers at the
// six-label shape and the policy artifact. Without this anchor a future
// refactor can rewrite the description back to "1-paragraph completion
// claim" without anyone noticing.
test("complete_goal tool schema references the six-label policy", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("extensions/loops/goal-tools.ts", "utf-8");
  const toolBlock = src.match(/name:\s*"complete_goal"[\s\S]+?parameters:\s*Type\.Object\(\{[\s\S]+?\}\),/m);
  assert.ok(toolBlock, "complete_goal tool block found");

  const body = toolBlock[0]!;
  assert.match(body, /Outcome:/, "Outcome label is named in the schema description");
  assert.match(body, /Changed:/, "Changed label is named in the schema description");
  assert.match(body, /Evidence:/, "Evidence label is named in the schema description");
  assert.match(body, /Tests:/, "Tests label is named in the schema description");
  assert.match(body, /Unresolved:/, "Unresolved label is named in the schema description");
  assert.match(body, /Next:/, "Next label is named in the schema description");
  assert.match(body, /COMPLETION-SUMMARY-POLICY-2026-08-19\.md/, "policy doc is referenced");
});
