import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ORCH = fs.readFileSync(path.join(__dirname, "..", "extensions", "loops", "goal-orchestrator.ts"), "utf8");
const TOOLS = fs.readFileSync(path.join(__dirname, "..", "extensions", "loops", "goal-tools.ts"), "utf8");
const CONT = fs.readFileSync(path.join(__dirname, "..", "extensions", "goal-continuation.ts"), "utf8");

test("stall parks prove persistence before claiming safety", () => {
  const esc = ORCH.slice(ORCH.indexOf("function escalateStallNow"), ORCH.indexOf("function escalateStallNow") + 3000);
  assert.match(esc, /const stallParkLanded = updateGoal\(/, "goal stall park captures the write result");
  assert.match(esc, /const loopStopLanded = persistState\(ctx\)/, "loop stall stop captures the write result");
  assert.match(esc, /could not persist/, "degraded storage gets the caveat in the notify");
});

test("complete_goal claim write refuses to launch an auditor it cannot see", () => {
  assert.match(TOOLS, /if \(\!updateGoal\(\{ pendingTasks: undefined/, "the claim write is checked like abort/confirm");
  assert.match(TOOLS, /no auditor was launched\. Do NOT wait for an audit/, "failure tells the agent not to wait");
});

test("replan one-shot latch lands before forensics claims it armed", () => {
  assert.match(CONT, /if \(\!updateGoal\(\{ repairTarget:/, "the latch write is checked");
  assert.match(CONT, /faulty_objective_replan_turn_armed_failed/, "latch failure is ledgered distinctly");
});
