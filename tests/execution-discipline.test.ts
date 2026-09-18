import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  findMidRunPlanViolations,
  validateTaskProposal,
} from "../extensions/goal-loop-core.ts";

// ------------------------------------------------------------------
// Execution-discipline pins: drafted plans must never schedule mid-run
// question or manual-check steps. Questions are batched upfront in
// drafting; manual testing happens only when the contract mandates it —
// as a verification gate, never as a scheduled mid-run step. The only
// exemption is a step that explicitly cites its contract-mandated gate.
// ------------------------------------------------------------------

test("mid-run question steps are violations, naming the step", () => {
  const violations = findMidRunPlanViolations([
    { title: "Implement the storage layer" },
    { title: "Ask the user which database to use", subtasks: ["present options", "wait for pick"] },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.id, "2");
  assert.match(violations[0]!.title, /database/);
  assert.match(violations[0]!.reason, /mid-run question/i);
});

test("ask_user_question subtasks are violations too", () => {
  const violations = findMidRunPlanViolations([
    { title: "Ship it", subtasks: ["implement", "ask_user_question to confirm the rollout window"] },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.id, "1.2");
  assert.match(violations[0]!.reason, /mid-run question/i);
});

test("manual-check steps are violations unless the contract mandates them", () => {
  const violations = findMidRunPlanViolations([
    { title: "Manually verify the checkout flow in staging" },
    { title: "Eyeball the dashboard for regressions" },
  ]);
  assert.equal(violations.length, 2);
  for (const v of violations) assert.match(v.reason, /manual/i);
});

test("contract-mandated gates are exempt, not violations", () => {
  const violations = findMidRunPlanViolations([
    { title: "Present the contract via propose_goal_draft for Confirm-dialog approval" },
    { title: "Manual screen-reader pass mandated by verification contract gate 5 (no automation covers it)" },
    { title: "Route the auth design through the Designer checkpoint before implementing" },
  ]);
  assert.deepEqual(violations, []);
});

test("clean plans pass with no violations", () => {
  assert.deepEqual(
    findMidRunPlanViolations([
      { title: "Implement the storage layer", subtasks: ["schema", "migration"] },
      { title: "Run the suite until green", verificationContract: "TMPDIR=/var/tmp bun test" },
    ]),
    [],
  );
});

test("propose_task_list validation refuses mid-run steps", () => {
  const err = validateTaskProposal([
    { title: "Implement the storage layer" },
    { title: "Ask the user which database to use" },
  ]);
  assert.match(err!, /mid-run question/i);
  assert.match(err!, /"2"/);
  const manual = validateTaskProposal([{ title: "Manually click through staging" }]);
  assert.match(manual!, /manual/i);
});

test("goal/list drafting prompt pins never-schedule-mid-run plus manual-only-when-mandatory", () => {
  const md = fs.readFileSync(path.resolve("prompts/goal-loop-draft.md"), "utf8");
  assert.match(md, /never schedule a mid-run question/i);
  assert.match(md, /manual testing only when/i);
  assert.match(md, /never as a scheduled mid-run step/i);
});

test("plan prompt pins milestone shape: no mid-run question or manual-check milestones", () => {
  const md = fs.readFileSync(path.resolve("prompts/goal-loop-plan.md"), "utf8");
  assert.match(md, /no mid-run question or manual-check milestones/i);
  assert.match(md, /contract-mandated gate/i);
});
