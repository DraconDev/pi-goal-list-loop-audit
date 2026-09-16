import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ACTIVE_EXECUTION_QUESTION_GUIDANCE,
  buildSeedGrillMessage,
  LONG_RUNNING_JUDGMENT_POLICY,
} from "../extensions/goal-loop-core.ts";
import { continuationPrompt } from "../extensions/goal-continuation.ts";
import { ContinuousSupervisor, SUPERVISION_MAX_POLL_MS, SUPERVISION_MIN_POLL_MS } from "../extensions/continuous-supervision.ts";

// ------------------------------------------------------------------
// Now §1 — "keep checking instead of waiting (guess 10m but finishes in 10s)"
// Policy: event-driven + 250ms→15s adaptive fallback, never a guessed sleep.
// ------------------------------------------------------------------

test("long-running supervision is event-driven with 250ms→15s fallback, not duration-guessed", () => {
  assert.equal(SUPERVISION_MIN_POLL_MS, 250, "fallback starts at 250ms, not a guessed task duration");
  assert.equal(SUPERVISION_MAX_POLL_MS, 15_000, "fallback caps at the 15s safety cadence");
  const sup = new ContinuousSupervisor();
  // after a durable observation, fallback starts at 250ms and doubles
  sup.observeState({ goal: { id: "g", objective: "work", status: "active", policy: "goal", autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 }, createdAt: "2026-08-28T00:00:00Z", updatedAt: "2026-08-28T00:00:00Z" } as any, list: [] });
  assert.equal(sup.nextPollMs(true), 250);
  assert.equal(sup.nextPollMs(true), 500);
  sup.signal({ plane: "goal", kind: "progress", source: "tool_done" });
  assert.equal(sup.nextPollMs(true), 250, "a real progress event resets the fallback — a 10s task is picked up in seconds, not after a guessed 10m wait");
  const src = fs.readFileSync(path.resolve("extensions/continuous-supervision.ts"), "utf8");
  // no guessed 10-minute sleep
  assert.doesNotMatch(src, /sleep\(.*60.*000.*task/i);
});

test("monitor goals are display-only — scheduling is event-driven for every plane", () => {
  const cont = fs.readFileSync(path.resolve("extensions/goal-continuation.ts"), "utf8");
  assert.match(cont, /scheduling is event-driven for every plane/i, "monitor throttle comment explains event-driven scheduling");
  assert.match(cont, /isMonitorGoal stays pure for display parity/i);
  assert.match(cont, /void MONITOR_CHECK_INTERVAL_MS; \/\/ deprecated throttle/i, "monitor throttle is retired but kept for compat");
  // the old throttle block must not be present as active scheduling logic
  assert.doesNotMatch(cont, /if\s*\(delayMs === undefined && state\.goal && isMonitorGoal/);
  // display still shares the predicate so icon and throttling cannot diverge silently
  const display = fs.readFileSync(path.resolve("extensions/goal-loop-display.ts"), "utf8");
  assert.match(display, /isMonitorGoal/);
  assert.match(display, /MONITORING/);
  const core = fs.readFileSync(path.resolve("extensions/goal-loop-core.ts"), "utf8");
  assert.match(core, /function isMonitorGoal/);
});

// ------------------------------------------------------------------
// Now §2 — "cut down on questions mid execution ideally none — compensate by asking more up front"
// Policy: drafting is the ONLY place for scope/acceptance questions (batched 2–4),
// active execution stays at zero questions unless irreversible/destructive.
// ------------------------------------------------------------------

test("drafting batches 2–4 questions up front via one ask_user_question picker", () => {
  const msg = buildSeedGrillMessage("[DRAFT]", "ship the feature", "propose_goal_draft");
  assert.match(msg, /2-4 sharp, seed-specific questions UP FRONT in ONE batched ask_user_question call/i);
  assert.match(msg, /recommended default/i);
  assert.match(msg, /Resolve these decisions during drafting, before execution/i);
  assert.match(msg, /Do targeted read-only research first/i);
  // Independent choices are batched; dependent choices wait for real answers.
  assert.match(msg, /batch independent questions within the current phase/i);
  assert.match(msg, /ask dependent questions only after the earlier answers/i);
});

test("long-running policies compensate zero mid-run questions with more upfront", () => {
  assert.match(LONG_RUNNING_JUDGMENT_POLICY, /Compensate for zero mid-run questions by asking MORE up front/i);
  assert.match(LONG_RUNNING_JUDGMENT_POLICY, /batch 2-4 critical scope\/acceptance questions with recommended defaults via a single ask_user_question invocation/i);
  assert.match(LONG_RUNNING_JUDGMENT_POLICY, /NEVER a question/i);

  assert.match(ACTIVE_EXECUTION_QUESTION_GUIDANCE, /Drafting is the ONLY place/i);
  assert.match(ACTIVE_EXECUTION_QUESTION_GUIDANCE, /zero mid-execution questions unless/i);
  assert.match(ACTIVE_EXECUTION_QUESTION_GUIDANCE, /batch 2-4 sharp questions up front/i);
  assert.match(ACTIVE_EXECUTION_QUESTION_GUIDANCE, /irreversible[\/ ]+(or )?destructive external boundary/i);
});

test("continuation prompt carries both policies so active execution sees them", () => {
  const prompt = continuationPrompt({
    id: "discipline",
    objective: "ship the durable fix",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  });
  assert.match(prompt, /LONG-RUNNING JUDGMENT POLICY/);
  assert.match(prompt, /ACTIVE-EXECUTION QUESTION DISCIPLINE/);
  assert.match(prompt, /Compensate for zero mid-run questions by asking MORE up front/);
  assert.match(prompt, /Drafting is the ONLY place/);
  const md = fs.readFileSync(path.resolve("prompts/goal-loop-continuation.md"), "utf8");
  assert.match(md, /Batch 2[–-]4 sharp questions UP FRONT in drafting/i);
  assert.match(md, /zero further clarification/i);
});
