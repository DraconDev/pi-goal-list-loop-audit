import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyObjectiveRepair,
  assessSuspiciousObjective,
  buildRepairTaskObjective,
  deriveObjectiveRepair,
  hasQueuedObjectiveRepair,
} from "../extensions/faulty-objective-recovery.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { guardGoalBeforeContinuation, sendContinuation } from "../extensions/goal-continuation.js";
import { readState, queueItemPath, writeQueueItemFile } from "../extensions/goal-loop-core.js";
import { state } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260810152305-8or7m9",
    objective: "passes sequentially, including validated recovery (archive)",
    status: "active",
    policy: "list",
    autoContinue: true,
    verificationContract: "",
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-10T15:23:05.000Z",
    updatedAt: "2026-08-10T15:23:05.000Z",
    ...overrides,
  };
}

test("detects archive-derived and verification-fragment objectives", () => {
  const result = assessSuspiciousObjective("passes sequentially, including validated recovery (archive)");
  assert.equal(result.suspicious, true);
  assert.ok(result.reasons.includes("archive-metadata"));
  assert.ok(result.reasons.includes("verification-fragment"));
});

test("detects reviewer prose, headings, numbered audit text, and dangling fragments", () => {
  for (const text of [
    "The gate and both apply sites exist. Now I need to verify the retry path.",
    "## Required fixes",
    "1. Guard the stored completion audit and stale generation.",
    "Implement the recovery gate or",
  ]) {
    assert.equal(assessSuspiciousObjective(text).suspicious, true, text);
  }
});

test("valid imperative objectives are not flagged", () => {
  assert.equal(assessSuspiciousObjective("Implement the recovery gate").suspicious, false);
  assert.equal(assessSuspiciousObjective("Implement archive").suspicious, false);
  assert.equal(assessSuspiciousObjective("Fix the stale resume path", "run the focused tests").suspicious, false);
});

test("valid imperative objectives may mention auditor and verification machinery", () => {
  const result = assessSuspiciousObjective("Fix the detached completion-auditor recovery path and add focused verification coverage");
  assert.equal(result.suspicious, false);
});

test("imperative implementation requests mentioning audit, verification, or regression stay valid", () => {
  for (const text of [
    "Implement an audit verification regression for the recovery gate",
    "Fix the auditor verification path and add regression coverage",
    "Add regression tests for audit report verification",
    "Harden the detached auditor verification contract",
  ]) {
    const result = assessSuspiciousObjective(text);
    assert.equal(result.suspicious, false, text);
    assert.deepEqual(result.reasons, [], text);
  }
});

test("queue items that merely name the auditor role are not verification-fragments (2026-08-16 field regression)", () => {
  // Both of these were falsely flagged as verification-fragment at list
  // schedule time on 2026-08-16, spawning a synthetic repair goal
  // (5bthvx) and a replan card. Root cause: REVIEWER_VOCABULARY matched a
  // BARE "auditor" (modifier optional) and IMPERATIVE_START lacked the
  // verbs "show"/"diagnose", so a legit imperative that merely names the
  // roles (main/auditor/drafter, auditor workers) tripped the gate.
  const items = [
    "Show the selected models on the goal card and review the footer: display the goal's effective model(s) (main/auditor/drafter) on the goal card, and audit what we currently put on the goal card + footer vs what matters",
    "Diagnose the goal-loop's heavy resource consumption: measure memory/CPU of the loop (goal-loop-forever, heartbeat, auditor workers) over a few hours of active goals, identify the top consumers, and report findings + concrete reduction candidates",
    "Show the effective auditor, drafter, and main models on the goal card",
    "Display the selected main/auditor/drafter model on the goal card footer",
    "List the active auditor and drafter models in /goal status",
    "Read the goal card and write footer review notes for the auditor model selection",
  ];
  for (const text of items) {
    const result = assessSuspiciousObjective(text);
    assert.equal(result.suspicious, false, text);
    assert.deepEqual(result.reasons, [], text);
  }
});

test("auditor/reviewer verdict-shaped text is still a verification-fragment", () => {
  for (const text of [
    "The auditor approved the fix; evidence: no regressions",
    "Reviewer finding: the goal card shows the auditor model",
    "Auditor report: two follow-ups remain",
    "The reviewer feedback was: add the auditor model to the footer",
  ]) {
    const result = assessSuspiciousObjective(text);
    assert.equal(result.suspicious, true, text);
    assert.ok(result.reasons.includes("verification-fragment"), text);
  }
});

test("explicit reviewer and evidence fragments are rejected", () => {
  for (const text of [
    "Reviewer: the implementation is complete; evidence: 16 tests pass",
    "The reviewer says the fix is complete; evidence: focused tests pass",
    "Focused tests: 16 pass; Full suite: 1268 pass / 1 skip / 0 fail",
    "Fix the recovery gate. Evidence: focused tests pass.",
    "Fix the recovery gate. Focused tests: 16 pass; Full suite: 1268 pass / 1 skip / 0 fail.",
    "Review complete; Focused tests: 16 pass",
  ]) {
    const result = assessSuspiciousObjective(text);
    assert.equal(result.suspicious, true, text);
    assert.deepEqual(result.reasons, ["verification-fragment"], text);
  }
});

test("the screenshot reviewer fragment records the exact saved-intent repair", () => {
  const reviewerFragment = "The auditor’s objection was fixed.\n\n- Added an isolated executable runtime regression that injects a failed provider probe and verifies the later hourly slot runs.\n- Added runtime checks for opt-out and stale-generation fencing.\n- Focused tests: 16 pass\n- Full suite: 1268 pass / 1 skip / 0 fail\n- Typecheck and diff checks pass.\n- Resubmitted for detached-auditor approval.";
  const savedObjective = "Fix the detached auditor verification regression";
  const savedContract = "focused classifier tests pass";
  const g = goal({
    objective: reviewerFragment,
    verificationContract: "",
    objectiveProvenance: {
      originalObjective: savedObjective,
      originalContract: savedContract,
      userSeeds: [savedObjective],
    },
  });
  const assessment = assessSuspiciousObjective(g.objective, g.verificationContract);
  assert.deepEqual(assessment.reasons, ["verification-fragment"]);
  const proposal = deriveObjectiveRepair(g, assessment);
  assert.ok(proposal);
  assert.equal(proposal?.source, "original-record");
  assert.equal(proposal?.objective, savedObjective);
  assert.equal(proposal?.verificationContract, savedContract);
  const record = applyObjectiveRepair(g, proposal!, "2026-08-13T10:06:00.000Z");
  assert.equal(record.originalObjective, reviewerFragment);
  assert.equal(record.replacementObjective, savedObjective);
  assert.equal(record.replacementContract, savedContract);
  assert.equal(record.source, "original-record");
  assert.deepEqual(g.objectiveRepairHistory, [record]);
  assert.equal(g.objective, savedObjective);
  assert.equal(g.verificationContract, savedContract);
});

test("recover is a valid imperative for the exact queued detached-auditor item", () => {
  const result = assessSuspiciousObjective("Recover parked detached-auditor claims after infrastructure timeout (evidence: Screenshot_20260811_213659.png, Screenshot_20260811_214045.png, and the parked-auditor panels)");
  assert.equal(result.suspicious, false);
});

test("normalization is an automatic provenance repair", () => {
  const g = goal({ objective: "Implement the repair gate (archive)" });
  const assessment = assessSuspiciousObjective(g.objective, g.verificationContract);
  const proposal = deriveObjectiveRepair(g, assessment);
  assert.ok(proposal);
  assert.equal(proposal?.objective, "Implement the repair gate");
  const record = applyObjectiveRepair(g, proposal!, "2026-08-10T15:24:00.000Z");
  assert.equal(g.objective, "Implement the repair gate");
  assert.equal(g.revision, 1);
  assert.equal(record.action, "auto-applied");
  assert.equal(record.reason, "removed explicit archive decoration without inventing intent");
  assert.equal(record.revisionBefore, 0);
  assert.equal(record.revisionAfter, 1);
  assert.equal(g.objectiveRepairHistory?.length, 1);
});

test("durable original provenance wins over reviewer prose and supplies the saved contract", () => {
  const g = goal({
    objective: "The gate and both apply sites exist. Now I need to verify the retry path.",
    verificationContract: "",
    objectiveProvenance: {
      originalObjective: "Implement archive",
      originalContract: "Done when: the recovery test passes",
      userSeeds: ["Implement archive\nDone when: the recovery test passes"],
    },
    pendingCompletion: {
      at: "2026-08-10T15:24:00.000Z",
      verificationSummary: "Ran 1228 tests, zero failures",
    },
  });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "original-record");
  assert.equal(proposal?.objective, "Implement archive");
  assert.equal(proposal?.verificationContract, "Done when: the recovery test passes");
  assert.match(proposal?.evidence ?? "", /original record/);
  assert.match(proposal?.evidence ?? "", /pending verification summary/);
});

test("unverified completion prose is never promoted", () => {
  const g = goal({
    objective: "The gate and both apply sites exist. Now I need to verify the retry path.",
    completionSummary: "Implement an invented replacement from the last chat",
  });
  assert.equal(deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective)), null);
});

test("approved completion context from an older revision cannot resurrect saved intent", () => {
  const g = goal({
    objective: "The gate and both apply sites exist. Now I need to verify the retry path.",
    revision: 2,
    completionSummary: "Implement the obsolete pre-tweak objective",
    auditHistory: [{
      at: "2026-08-10T15:24:00.000Z",
      approved: true,
      disapproved: false,
      impossible: false,
      model: "test-auditor",
      revision: 1,
    }],
  });
  assert.equal(deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective)), null);
});

test("audit history contributes only an actionable required-fix line", () => {
  const g = goal({
    objective: "## Required fixes",
    auditHistory: [{
      at: "2026-08-10T15:24:00.000Z",
      approved: false,
      disapproved: true,
      impossible: false,
      model: "test-auditor",
      report: "## Required fixes\n- Implement the missing guard\n\n<disapproved/>",
    }],
  });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "auditHistory");
  assert.equal(proposal?.objective, "Implement the missing guard");
});

test("all direct continuation and stored-audit paths retain the final gate", () => {
  const continuation = fs.readFileSync(path.join(process.cwd(), "extensions", "goal-continuation.ts"), "utf8");
  const auditorHooks = fs.readFileSync(path.join(process.cwd(), "extensions", "loops", "goal-auditor-hooks.ts"), "utf8");
  assert.match(continuation, /sendStallEscalation[\s\S]{0,500}guardGoalBeforeContinuation/);
  assert.match(continuation, /sendLengthContinue[\s\S]{0,500}guardGoalBeforeContinuation/);
  assert.match(continuation, /retryContinuationDispatch[\s\S]{0,500}guardGoalBeforeContinuation/);
  assert.match(auditorHooks, /stored-completion-audit/);
});

test("durable pending task is preferred when the objective cannot be normalized", () => {
  const g = goal({ objective: "verification contract", pendingTasks: ["Implement the paused recovery gate"] });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "pendingTasks");
  assert.equal(proposal?.objective, "Implement the paused recovery gate");
});

test("irrecoverable suspicious objectives produce a non-suspicious queued repair task", () => {
  const g = goal({ objective: "verification contract" });
  const assessment = assessSuspiciousObjective(g.objective);
  assert.equal(deriveObjectiveRepair(g, assessment), null);
  const repair = buildRepairTaskObjective(g, assessment);
  assert.equal(assessSuspiciousObjective(repair).suspicious, false);
  assert.match(repair, /^Repair the blocked list item from saved intent$/);
  assert.equal(hasQueuedObjectiveRepair(g), false);
});

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalAutoResume(enabled: boolean): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(enabled ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
afterEach(() => setGlobalAutoResume(false));

function suspiciousGoal(status: "active" | "paused" | "auditing" | "aborted" = "active", policy: "goal" | "list" = "goal"): Record<string, unknown> {
  return seedGoal({
    status,
    policy,
    objective: "passes sequentially, including validated recovery, no-proof manual hold, and duplicate/stale-attempt protections.",
    verificationContract: "",
  });
}

async function boot(pi: MockPi, cwd: string): Promise<ReturnType<typeof makeMockCtx>> {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `faulty-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  return ctx;
}

test("session_start auto-resume blocks a suspicious active objective and queues repair", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  seedState(cwd, { goal: suspiciousGoal("active"), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  const state = readState(cwd);
  assert.equal(state.goal?.status, "paused");
  assert.equal(state.list?.[0]?.objective, "Repair the blocked goal from saved intent");
  assert.match(ledger(cwd), /"faulty_objective_repair_queued"/);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
});

test("manual resume blocks a suspicious paused objective before dispatch", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: suspiciousGoal("paused"), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("goal", "resume", ctx);
  await tick(80);
  assert.equal(readState(cwd).goal?.status, "paused");
  assert.match(ledger(cwd), /"faulty_objective_repair_queued"/);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
});

test("list activation blocks a suspicious queued objective and leaves its repair task actionable", async () => {
  const cwd = tmpCwd();
  const queued = seedGoal({ policy: "list" });
  const item = {
    id: String(queued.id),
    objective: "passes sequentially, including validated recovery (archive)",
    addedAt: new Date().toISOString(),
  };
  seedState(cwd, { goal: null, list: [item] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(80);
  const state = readState(cwd);
  assert.equal(state.goal, null);
  assert.equal(state.list?.[0]?.objective, "Repair the blocked list item from saved intent");
  assert.equal(state.list?.[1]?.objective, item.objective);
  assert.match(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
  await pi.command("list", "next", ctx);
  await tick(80);
  const repaired = readState(cwd);
  assert.equal(repaired.goal?.objective, "Repair the blocked list item from saved intent");
  assert.equal(repaired.goal?.repairTarget?.id, item.id);
  assert.equal(repaired.goal?.repairTarget?.objective, item.objective);
  assert.equal(typeof repaired.goal?.repairTarget?.replanPromptedAt, "string", "the one bounded replan turn is durable");
  assert.equal(pi.sent.length, 1, "the repair card gets one bootstrap turn so the model can propose the confirmed redraft");
  const firstPrompt = pi.sent[0]?.message.content ?? "";
  assert.match(firstPrompt, /REPLAN REQUIRED/);
  assert.match(firstPrompt, /propose_task_list/);
  assert.ok(firstPrompt.includes(item.objective), "the original target is included in the bootstrap prompt");
  await tick(80);
  assert.equal(pi.sent.length, 1, "repeated heartbeat/settle ticks do not re-fire the repair card");
  await pi.fire("before_agent_start", { prompt: firstPrompt }, ctx);
  await sendContinuation(String(repaired.goal?.id));
  await tick(40);
  assert.equal(pi.sent.length, 1, "after the bootstrap turn, only a confirmed task-list redraft can clear the latch");
  assert.match(ledger(cwd), /"faulty_objective_replan_required"/);
});

test("repair cards require a concrete replan objective and clear the latch only after confirmation", async () => {
  const cwd = tmpCwd();
  const target = "Implement the saved recovery behavior";
  const g = suspiciousGoal("active", "list");
  g.objective = "Repair the blocked list item from saved intent";
  g.repairTarget = { id: "original-1", objective: target, reasons: ["verification-fragment"], source: "test" };
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  // Restore the active phase for the direct tool contract test. Production
  // activation now permits one bounded bootstrap turn, but this case focuses
  // the confirmed task-list mutation itself.
  state.goal!.status = "active";
  ctx.ui.confirmImpl = async () => true;
  ctx.ui.selectImpl = async () => "Yes";
  ctx.ui.customStubMode = true;
  const rejected = await pi.runTool("propose_task_list", { tasks: [{ title: "Do the thing" }] }, ctx);
  assert.match(rejected.content[0]?.text ?? "", /include.*objective/i);
  assert.equal(readState(cwd).goal?.repairTarget?.objective, target);
  const accepted = await pi.runTool("propose_task_list", {
    objective: target,
    tasks: [{ title: "Implement the recovery behavior" }, { title: "Run focused verification" }],
  }, ctx);
  assert.match(accepted.content[0]?.text ?? "", /Task list set/);
  const restored = readState(cwd);
  assert.equal(restored.goal?.objective, target);
  assert.equal(restored.goal?.repairTarget, undefined);
  assert.equal(restored.goal?.taskList?.tasks.length, 2);
  assert.match(ledger(cwd), /"faulty_objective_replanned"/);
});

test("exact queued detached-auditor objective activates without a repair task", async () => {
  const cwd = tmpCwd();
  const item = {
    id: "20260812082104-tgb8p3",
    objective: "Recover parked detached-auditor claims after infrastructure timeout (evidence: Screenshot_20260811_213659.png, Screenshot_20260811_214045.png, and the parked-auditor panels)",
    addedAt: "2026-08-12T08:21:04.085Z",
  };
  seedState(cwd, { goal: null, list: [item] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(80);
  const state = readState(cwd);
  assert.equal(state.goal?.objective, item.objective);
  assert.deepEqual(state.list, []);
  assert.doesNotMatch(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
  assert.doesNotMatch(ledger(cwd), /Repair the blocked list item from saved intent/);
  assert.match(ledger(cwd), /"goal_created"/);
});

test("provenance-backed repair auto-applies before dispatch", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  const g = suspiciousGoal("active");
  g.objective = "Implement the recovery gate (archive)";
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  const state = readState(cwd);
  assert.equal(state.goal?.objective, "Implement the recovery gate");
  assert.equal(state.goal?.revision, 1);
  assert.match(ledger(cwd), /"faulty_objective_auto_repaired"/);
  assert.match(ledger(cwd), /"goal_continuation_sent"/);
});

test("direct continuation dispatch rechecks the suspicious objective", async () => {
  const cwd = tmpCwd();
  const g = suspiciousGoal("active");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  await sendContinuation(String(g.id));
  await tick(80);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
  assert.equal(readState(cwd).goal?.status, "paused");
});

test("a canceled goal and stale continuation attempt are hard fences", async () => {
  const cwd = tmpCwd();
  const g = suspiciousGoal("aborted");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  assert.equal(guardGoalBeforeContinuation(ctx as any, "canceled-test", String(g.id)), false);
  await sendContinuation(`${g.id}-stale`);
  await tick(40);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
  assert.match(ledger(cwd), /"faulty_objective_terminal_fence"|"faulty_objective_stale_attempt_fence"/);
});

test("an archived goal id is a hard fence against stale resurrection", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  const g = suspiciousGoal("active");
  fs.mkdirSync(path.join(cwd, ".pi-glla", "archive"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "archive", `${g.id}.md`), "# Goal\\n\\n**Status**: aborted\\n");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  assert.equal(readState(cwd).goal, null);
  assert.match(ledger(cwd), /"faulty_objective_archive_fence"/);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
});

test("an active goal with an interrupted terminal stopReason is not dispatched", () => {
  const cwd = tmpCwd();
  const g = seedGoal({ status: "active", stopReason: "already_shipped:v0.34.74" });
  seedState(cwd, { goal: g, list: [] });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd);
  assert.equal(guardGoalBeforeContinuation(ctx as any, "interrupted-terminal-test", String(g.id)), false);
  assert.match(ledger(cwd), /"faulty_objective_terminal_fence"/);
});

// v0.35.31 (field: Screenshot_20260822_193744): an explicit /goal start with
// casual user prose ("…because we are logged in") tripped DANGLING_END and
// parked the goal behind a repair task the user never asked for. User-seeded
// objectives on user-created goals dispatch verbatim.
test("an explicit /goal start objective is dispatched even when the heuristic flags it", async () => {
  const cwd = tmpCwd();
  const objective = "play around with the buttons because discover and projects lead to the same place and we are logged in";
  const g = seedGoal({
    status: "active",
    policy: "goal",
    objective,
    createdVia: "user",
    objectiveProvenance: { originalObjective: objective, userSeeds: [objective] },
  });
  seedState(cwd, { goal: g, list: [] });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd);
  // Sanity: the heuristic DOES flag this prose in isolation.
  assert.equal(assessSuspiciousObjective(objective).suspicious, true);
  assert.equal(guardGoalBeforeContinuation(ctx as any, "user-seed-test", String(g.id)), true);
  assert.equal(readState(cwd).goal?.status, "active", "no suspicious pause for user intent");
  assert.match(ledger(cwd), /"faulty_objective_user_seed_trusted"/);
});

test("v0.35.35: seed trust survives a Done when: clause and @role in the raw seed (createGoal stores raw vs cleaned)", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  // EXACTLY the createGoal shape: userSeeds holds the RAW arg while the
  // objective is the CLEANED text (role + contract stripped). v0.35.31's
  // exact-equality check never matched this shape — the trust silently
  // no-op'd and the goal still parked behind the heuristic. The prose must
  // ITSELF trip the heuristic after cleaning (like the field report), so
  // this exercises the trust path rather than an already-innocent objective.
  const prose = "play around with the buttons because discover and projects lead to the same place and we are logged in";
  const rawSeed = `${prose}\nAgent: Designer\nDone when: bun test tests/login.test.ts passes`;
  const g = seedGoal({
    status: "active",
    policy: "goal",
    objective: prose,
    createdVia: "user",
    agentRole: "designer",
    verificationContract: "bun test tests/login.test.ts passes",
    objectiveProvenance: { originalObjective: prose, userSeeds: [rawSeed] },
  });
  seedState(cwd, { goal: g, list: [] });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd);
  // Sanity: the CLEANED objective still trips the heuristic — only the seed
  // trust can save this goal.
  assert.equal(assessSuspiciousObjective(prose).suspicious, true);
  assert.equal(guardGoalBeforeContinuation(ctx as any, "user-seed-cleaned-test", String(g.id)), true);
  assert.equal(readState(cwd).goal?.status, "active", "clause-bearing user seeds still dispatch verbatim");
  assert.match(ledger(cwd), /"faulty_objective_user_seed_trusted"/);
});

test("v0.35.35: normalization does not widen trust to agent-authored seeds", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  // A reviewer-created goal whose provenance happens to contain a seed that
  // CLEANS to the objective must never get the trust ledger — createdVia
  // gates the trust; normalization only fixes the COMPARISON. Whatever the
  // pre-existing repair/pause machinery does afterward is unchanged.
  const prose = "play around with the buttons because discover and projects lead to the same place and we are logged in";
  const g = seedGoal({
    status: "active",
    policy: "goal",
    objective: prose,
    createdVia: "reviewer",
    objectiveProvenance: {
      originalObjective: prose,
      userSeeds: [`${prose}\nDone when: nothing`],
    },
  });
  seedState(cwd, { goal: g, list: [] });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd);
  guardGoalBeforeContinuation(ctx as any, "agent-seed-test", String(g.id));
  assert.doesNotMatch(ledger(cwd), /"faulty_objective_user_seed_trusted"/);
});

test("agent-authored suspicious objectives still pause — the trust is user-seed only", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  const g = seedGoal({
    status: "active",
    policy: "goal",
    objective: "play around with the buttons because discover and projects lead to the same place and we are logged in",
    createdVia: "reviewer",
  });
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  assert.equal(readState(cwd).goal?.status, "paused");
  assert.doesNotMatch(ledger(cwd), /"faulty_objective_user_seed_trusted"/);
});

test("replan confirmation consumes the source queue fragment and its sidecar", async () => {
  const cwd = tmpCwd();
  const fragment = "Item: every DECIDE finding has been raised to the user and recorded as DECIDED/DEFERRED (or the report states plainly that none were found)";
  const src = {
    id: "20260816054711-jtcstn",
    objective: fragment,
    addedAt: "2026-08-16T05:47:11.820Z",
  };
  const g = suspiciousGoal("active", "list");
  g.objective = "Repair the blocked list item from saved intent";
  g.repairTarget = { id: src.id, objective: fragment, reasons: ["verification-fragment"], source: "list-activation" };
  seedState(cwd, { goal: g, list: [src] });
  writeQueueItemFile(cwd, src); // the disk sidecar the queue keeps for the parked fragment
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  state.goal!.status = "active";
  ctx.ui.confirmImpl = async () => true;
  ctx.ui.selectImpl = async () => "Yes";
  ctx.ui.customStubMode = true;
  await pi.runTool("propose_task_list", {
    objective: "Consume repaired queue fragments on replan confirmation so they cannot respawn",
    tasks: [{ title: "Consume the source fragment" }, { title: "Verify no respawn" }],
  }, ctx);
  const after = readState(cwd);
  assert.equal(after.goal?.repairTarget, undefined);
  assert.equal(after.goal?.objective, "Consume repaired queue fragments on replan confirmation so they cannot respawn");
  assert.deepEqual(after.list, []); // the parked fragment left the queue
  assert.equal(fs.existsSync(queueItemPath(cwd, src.id)), false); // and its sidecar is gone
  assert.match(ledger(cwd), /"faulty_objective_source_consumed"/);
});
