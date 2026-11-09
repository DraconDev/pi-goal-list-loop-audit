// pi-goal-list-loop-audit — v0.39.66
// tests/recovery-projection-truth.test.ts
//
// GitHub #62: a saved goal projection disagreed with live state, restore-as-
// new lost the task linkage, and a naive contract round trip accumulated a
// `Done when: ` marker per recreation. Four acceptance checks are pinned here,
// one describe-level block each:
//
//   1. A leftover projection beside a `goal: null` snapshot is never presented
//      as currently running (classification + the /goal status and /goal resume
//      replies).
//   2. Resumable paused goal, cancelled list with no current work, unrelated
//      live work, and completed/aborted history are classified SEPARATELY;
//      /goal recover never resumes, activates or revives anything.
//   3. The restore-as-new recipe preserves the objective, every criterion and
//      the plan structure, all tasks starting pending — while historical
//      evidence stays historical.
//   4. Contracts with absent, inline, line-start and already-present
//      introducers are round-trip stable: repeated export/recreation neither
//      accumulates markers nor drops criteria.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import {
  archiveDir,
  buildTaskList,
  extractVerificationContract,
  goalMdPath,
  piGlaDir,
  readState,
  renderGoalMarkdown,
  routeGoalArgs,
  stripContractIntroducers,
  type Goal,
} from "../extensions/goal-loop-core.js";
import { contractItems } from "../extensions/goal-loop-shield.js";
import {
  buildRestoreRecipe,
  classifySavedRecord,
  collectSavedGoalRecords,
  formatRecoveryInventory,
  parseSavedGoalMarkdown,
  savedRecordsOneLiner,
} from "../extensions/goal-recovery-inventory.js";
import { HELD_ON_RESTORE } from "../extensions/goal-loop-forever.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const NOW = new Date("2026-11-06T20:44:08.545Z").toISOString();

afterEach(() => __testOnlyResetProcessState());

function objectiveOf(overrides: Record<string, unknown> = {}): Goal {
  return seedGoal({
    objective: "Ship the widget",
    verificationContract: "- alpha renders\n- beta persists",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as unknown as Goal;
}

/** Write the markdown projection a live goal would have left behind. */
function writeProjection(cwd: string, goal: Goal): void {
  fs.mkdirSync(path.join(piGlaDir(cwd), "goals"), { recursive: true });
  fs.writeFileSync(goalMdPath(cwd, goal.id), renderGoalMarkdown(goal));
}

function writeArchive(cwd: string, goal: Goal): void {
  fs.mkdirSync(archiveDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(archiveDir(cwd), `${goal.id}.md`), `${renderGoalMarkdown(goal)}\n## Terminal summary\n\n- archived\n`);
}

function boot(liveState: Parameters<typeof seedState>[1]): { pi: MockPi; ctx: MockCtx; cwd: string } {
  __testOnlyResetProcessState();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, liveState);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `recovery-projection-${Math.random().toString(36).slice(2, 8)}` } });
  return { pi, ctx, cwd };
}

// ────────────────────────────────────────────────────────────────────
// 1. A stale projection is not live work
// ────────────────────────────────────────────────────────────────────

test("#62: a leftover active projection beside `goal: null` classifies as a stale projection", () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({ status: "active" });
  writeProjection(cwd, saved);
  const records = collectSavedGoalRecords(cwd);
  assert.equal(records.length, 1);
  const state = classifySavedRecord(records[0]!, { goalPresent: false, goal: null });
  assert.equal(state, "stale-projection");
  // The projection's own Status marker is read verbatim — it is the whole
  // point: the FILE says active, and that claim is not promotable.
  assert.equal(records[0]!.status, "active");
  assert.equal(savedRecordsOneLiner(records, { goalPresent: false, goal: null }),
    "1 stale projection on disk — none is live work. /goal recover previews each one and the restore-as-new recipe.");
});

test("#62: /goal status with no live goal names the stale projection and offers the inventory", async () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({ status: "active" });
  writeProjection(cwd, saved);
  seedState(cwd, { goal: null, list: [] });
  const { pi, ctx } = boot({ goal: null, list: [] });
  ctx.cwd = cwd;
  await pi.command("goal", "status", ctx);
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /No active goal\./);
  assert.match(text, /1 stale projection on disk — none is live work/);
  assert.match(text, /\/goal recover previews each one/);
  assert.doesNotMatch(text, /active:? /i, "the answer must not present the stale projection as running work");
});

test("#62: /goal resume with no live goal says resume cannot reopen history and points at recover", async () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({ status: "active" });
  writeProjection(cwd, saved);
  // The archived terminal record is what makes this history rather than debt.
  writeArchive(cwd, objectiveOf({ status: "aborted", stopReason: "list cancelled" }));
  const { pi, ctx } = boot({ goal: null, list: [] });
  ctx.cwd = cwd;
  await pi.command("goal", "resume", ctx);
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /Nothing to resume/);
  assert.match(text, /1 archived record on disk — none is live work/);
  assert.match(text, /\/goal recover/);
});

test("#62: a saved record that is the live goal classifies as CURRENT, not stale", () => {
  const cwd = tmpCwd();
  const live = objectiveOf({ status: "paused" });
  writeProjection(cwd, live);
  const records = collectSavedGoalRecords(cwd);
  assert.equal(classifySavedRecord(records[0]!, { goalPresent: true, goal: { id: live.id, status: "paused", policy: "goal" } }), "current");
  assert.equal(savedRecordsOneLiner(records, { goalPresent: true, goal: { id: live.id } }), undefined, "a current record needs no recovery hint");
});

// ────────────────────────────────────────────────────────────────────
// 2. Four shapes classified separately; recover mutates nothing
// ────────────────────────────────────────────────────────────────────

test("#62: resumable paused goal, cancelled list, unrelated live work and history are classified separately", () => {
  const cwd = tmpCwd();
  const paused = objectiveOf({ id: "20261106120000-paused1", status: "paused" });
  const cancelled = objectiveOf({ id: "20261106130000-cancel1", status: "aborted", stopReason: "list cancelled", policy: "list" });
  const history = objectiveOf({ id: "20261106140000-histor1", status: "complete" });
  writeProjection(cwd, paused);
  writeProjection(cwd, cancelled);
  writeArchive(cwd, cancelled);
  writeArchive(cwd, history);
  const livePlus = objectiveOf({ id: "20261106150000-live001", status: "active" });
  writeProjection(cwd, livePlus);

  const records = collectSavedGoalRecords(cwd);
  const live = { goalPresent: true, goal: { id: livePlus.id, status: "active", policy: "goal" } } as const;
  const byId = new Map(records.map((record) => [record.id, classifySavedRecord(record, live)]));
  assert.equal(byId.get(paused.id), "stale-projection", "a paused projection is NOT resumable when the live slot is empty (this live slot holds another goal)");
  assert.equal(byId.get(cancelled.id), "historical", "a cancelled list with its archive is history");
  assert.equal(byId.get(history.id), "historical", "a completed goal is history");
  assert.equal(byId.get(livePlus.id), "current");

  // The same tree with NO live goal: the paused record still is not "current",
  // because live state alone grants that status.
  const noLive = { goalPresent: false, goal: null } as const;
  const byId2 = new Map(records.map((record) => [record.id, classifySavedRecord(record, noLive)]));
  assert.equal(byId2.get(paused.id), "stale-projection");
  assert.equal(byId2.get(cancelled.id), "historical");
});

test("#62: a paused live goal is the only resumable case and recover never resumes it", async () => {
  const paused = objectiveOf({ status: "paused" });
  const { pi, ctx } = boot({ goal: paused });
  writeProjection(ctx.cwd, paused);
  const before = readState(ctx.cwd);
  await pi.command("goal", "recover", "", ctx);
  const after = readState(ctx.cwd);
  assert.deepEqual(after, before, "/goal recover mutates no durable state");
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /CURRENT/, "the paused live goal is the current record");
  assert.match(text, /The CURRENT record is the only resumable one/);
  assert.match(text, /\/goal resume/);
});

test("#62: a terminal record with no published archive is cleanup debt, not history", () => {
  const cwd = tmpCwd();
  const unarchived = objectiveOf({ status: "aborted", stopReason: "list cancelled" });
  writeProjection(cwd, unarchived);
  const records = collectSavedGoalRecords(cwd);
  assert.equal(classifySavedRecord(records[0]!, { goalPresent: false, goal: null }), "unarchived-terminal");
});

test("#62: an unrelated live goal does not make another saved record resumable", async () => {
  const unrelated = objectiveOf({ id: "20261106150000-live001", status: "active" });
  const cancelled = objectiveOf({ id: "20261106130000-cancel1", status: "aborted", stopReason: "list cancelled" });
  const { pi, ctx } = boot({ goal: unrelated });
  writeProjection(ctx.cwd, unrelated);
  writeProjection(ctx.cwd, cancelled);
  writeArchive(ctx.cwd, cancelled);
  await pi.command("goal", "recover", cancelled.id, ctx);
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /HISTORICAL/, "the cancelled record is history");
  assert.match(text, /NOT resumable/);
  assert.match(text, /Restore as NEW/);
  assert.match(text, /new identity, no armed timers, no carried approvals/);
  assert.doesNotMatch(text, /revive|cancel(?:led)? (?:is|was) undone/);
});

test("#62: recover journals what it showed and never claims it activated anything", async () => {
  const { pi, ctx } = boot({ goal: null, list: [] });
  const saved = objectiveOf({ status: "active" });
  writeProjection(ctx.cwd, saved);
  await pi.command("goal", "recover", "", ctx);
  const ledger = fs.readFileSync(path.join(piGlaDir(ctx.cwd), "active.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line) as { type: string; value?: Record<string, unknown> });
  const row = ledger.find((entry) => entry.type === "goal_recovery_inventory");
  assert.ok(row, "the inventory read is journaled for later reports");
  assert.equal(row!.value?.saved, 1);
  assert.equal(row!.value?.stale, 1);
  assert.equal(row!.value?.recipes, 1, "the recipe passed its round-trip check");
  assert.equal(readState(ctx.cwd).goal, null, "a command receipt is not activation evidence");
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /confirm the durable result rather than a command receipt/);
  assert.match(text, /list_status must show the new goal active/);
});

test("#62: recover filters by id and refuses an unknown filter instead of guessing", async () => {
  const { pi, ctx } = boot({ goal: null, list: [] });
  writeProjection(ctx.cwd, objectiveOf({ id: "20261106130000-cancel1", status: "aborted", stopReason: "list cancelled" }));
  writeProjection(ctx.cwd, objectiveOf({ id: "20261106140000-histor1", status: "complete" }));
  await pi.command("goal", "recover", "cancel1", ctx);
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /20261106130000-cancel1 — HISTORICAL/);
  assert.doesNotMatch(text, /20261106140000-histor1/, "the filter excludes other records");
  await pi.command("goal", "recover", "nope123", ctx);
  assert.match(ctx.ui.notifies.at(-1)!.message, /No saved record matching "nope123"/);
});

test("#62: an orphan queue sidecar is reported as a queue, not as a goal", async () => {
  const { pi, ctx } = boot({ goal: null, list: [] });
  fs.mkdirSync(path.join(piGlaDir(ctx.cwd), "goals"), { recursive: true });
  fs.writeFileSync(path.join(piGlaDir(ctx.cwd), "goals", "20261106120000-qw001.queue.json"), JSON.stringify({
    schema: 1, type: "queue-item", id: "20261106120000-qw001", objective: "Fix the flaky login test", addedAt: NOW,
  }));
  await pi.command("goal", "recover", "", ctx);
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /Saved queue sidecars not in the live list \(1\): this is a queue, not a goal/);
  assert.match(text, /\/list resume activates its head/);
});

// ────────────────────────────────────────────────────────────────────
// 3. Restore-as-new preserves scope + plan, and starts the plan pending
// ────────────────────────────────────────────────────────────────────

const PLAN = buildTaskList([
  { title: "Design the widget shell", subtasks: ["Sketch the layout", "Approve the palette"] },
  { title: "Implement the renderer", subtasks: ["Wire the props", "Add the empty state"] },
  { title: "Cover with tests", subtasks: ["Unit render", "Integration flow", "Screenshot"] },
  { title: "Document the surface", subtasks: ["README row", "CHANGELOG entry"] },
  { title: "Ship the release", subtasks: ["Bump version", "Tag", "Publish", "Verify registry"] },
]);

function withProgress(plan: typeof PLAN): typeof PLAN {
  // A record that finished work BEFORE the cancellation: the recipe must not
  // carry those completions forward as current proof.
  const copy = JSON.parse(JSON.stringify(plan)) as typeof PLAN;
  copy.tasks[0]!.status = "complete";
  copy.tasks[1]!.status = "complete";
  copy.tasks[2]!.subtasks![0]!.status = "complete";
  return copy;
}

test("#62: the restore recipe preserves the full objective, every criterion and the plan size", () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({ status: "aborted", stopReason: "list cancelled", taskList: withProgress(PLAN) });
  writeProjection(cwd, saved);
  const record = collectSavedGoalRecords(cwd)[0]!;
  assert.equal(record.tasks.total, 5, "five top-level tasks are read back from the projection");
  assert.equal(record.tasks.subtasks, 14, "fifteen subtasks render as fourteen nested rows under five parents");
  assert.equal(record.tasks.complete, 3, "the completed rows are counted so they can be labelled historical");

  const recipe = buildRestoreRecipe(record);
  assert.ok(recipe, "a readable record yields a recipe");
  assert.equal(recipe!.criteria.length, 2);
  assert.deepEqual(recipe!.criteria, ["alpha renders", "beta persists"]);
  assert.equal(recipe!.roundTrip.criteriaIn, 2);
  assert.equal(recipe!.roundTrip.criteriaOut, 2);
  assert.equal(recipe!.roundTrip.objectiveMatch, true);
  assert.equal(recipe!.roundTrip.ok, true, "the recipe re-parses to the saved objective and criteria");
  const reparsed = extractVerificationContract(recipe!.command);
  assert.equal(reparsed.objective, "Ship the widget");
  assert.equal(new Set(contractItems(reparsed.verificationContract)).size, 2, "no criterion is dropped");
  assert.match(recipe!.command, /Done when:\n- alpha renders\n- beta persists/);
});

test("#62: the rendered recipe tells the operator the plan starts pending and old evidence stays historical", async () => {
  const { pi, ctx } = boot({ goal: null, list: [] });
  const saved = objectiveOf({ status: "aborted", stopReason: "list cancelled", taskList: withProgress(PLAN) });
  writeProjection(ctx.cwd, saved);
  await pi.command("goal", "recover", "", ctx);
  const text = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.match(text, /plan 5 tasks\/14 subtasks \(3 complete — historical\)/);
  assert.match(text, /then propose_task_list with the saved plan \(5 tasks, 14 subtasks\) — all pending, nothing pre-completed\./);
  assert.match(text, /Old audit reports and test runs stay historical until revalidated here\./);
});

test("#62: a recreation through the public /goal start command keeps the objective and criteria", async () => {
  const saved = objectiveOf({ status: "aborted", stopReason: "list cancelled", taskList: PLAN });
  const recipe = buildRestoreRecipe({ objective: saved.objective, verificationContract: saved.verificationContract ?? "", objectiveAmbiguous: false });
  const { pi, ctx } = boot({ goal: null, list: [] });
  await pi.command("goal", "start", recipe!.command, ctx);
  await tick(60);
  const created = readState(ctx.cwd).goal;
  assert.ok(created, "the public start path created the goal");
  assert.equal(created!.policy, "goal", "recovery stays goal-mode — never converted into a list item");
  assert.equal(created!.createdVia, "user");
  assert.equal(created!.objective, "Ship the widget");
  assert.deepEqual(contractItems(created!.verificationContract ?? ""), ["alpha renders", "beta persists"]);
  assert.equal(created!.taskList, undefined, "the plan is recreated through propose_task_list, not carried into the new goal");
  assert.equal(created!.auditHistory ?? undefined, undefined, "no historical audit approval rides the new goal");
});

test("#62: an objective carrying its own section heading gets no automatic recipe", () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({
    status: "aborted",
    objective: "Do the thing\n\n## Notes\n\nthen ship it",
  });
  writeProjection(cwd, saved);
  const record = collectSavedGoalRecords(cwd)[0]!;
  assert.equal(record.objectiveAmbiguous, true);
  assert.equal(buildRestoreRecipe(record), undefined, "a boundary the renderer cannot round-trip is not presented as a recipe");
  const text = formatRecoveryInventory({
    live: { goalPresent: false, goal: null, listCount: 0, loop: null },
    records: [record],
    orphanQueue: [],
  });
  assert.match(text, /no automatic recipe: the objective carries its own section heading/);
  assert.doesNotMatch(text, /\/goal start\n/, "no command is printed when the round trip cannot be trusted");
});

// ────────────────────────────────────────────────────────────────────
// 4. The contract round trip is a fixed point for every introducer shape
// ────────────────────────────────────────────────────────────────────

const INTRODUCER_SHAPES = [
  { name: "absent introducer (bare criteria)", contract: "- alpha renders\n- beta persists" },
  { name: "inline introducer with content", contract: "Done when: run the full suite" },
  { name: "line-start introducer + list", contract: "Done when:\n- alpha renders\n- beta persists" },
  { name: "decorated introducer", contract: "Done when ALL of the following are true:\n- alpha renders\n- beta persists" },
  { name: "already-present duplicate marker", contract: "Done when: Done when: run the full suite" },
] as const;

for (const shape of INTRODUCER_SHAPES) {
  test(`#62: round trip is a fixed point — ${shape.name}`, () => {
    const objective = "Ship the widget";
    let text = `${objective}\nDone when:\n${shape.contract}`;
    const criteriaAtStart = contractItems(extractVerificationContract(text).verificationContract);
    const seen: Array<{ contract: string; items: string[]; markers: number }> = [];
    for (let round = 0; round < 4; round++) {
      const parsed = extractVerificationContract(text);
      const items = contractItems(parsed.verificationContract);
      seen.push({ contract: parsed.verificationContract, items, markers: (parsed.verificationContract.match(/Done when/gi) ?? []).length });
      text = `${parsed.objective}\nDone when: ${parsed.verificationContract}`;
    }
    const first = seen[1]!;
    for (const later of seen.slice(1)) {
      assert.equal(later.contract, first.contract, `round ${shape.name}: contract text must not drift after the first export`);
      assert.deepEqual(later.items, first.items, `round ${shape.name}: criteria must not change`);
    }
    assert.deepEqual(first.items, criteriaAtStart, "no criterion is dropped by the export");
    assert.ok(first.markers <= 1, `at most one introducer survives (found ${first.markers})`);
  });
}

test("#62: stripContractIntroducers consumes duplicates but never rewrites criteria", () => {
  assert.equal(stripContractIntroducers("Done when: Done when: run tests"), "run tests");
  assert.equal(stripContractIntroducers("Verification contract: run tests"), "run tests");
  assert.equal(stripContractIntroducers("- alpha renders\n- beta persists"), "- alpha renders\n- beta persists",
    "a criteria block with no introducer is untouched");
  assert.equal(stripContractIntroducers("Done when:\n- alpha renders"), "- alpha renders");
  // A criteria line that merely CONTAINS the phrase mid-sentence is not an
  // introducer and must survive verbatim.
  assert.equal(stripContractIntroducers("the report says Done when: twice"), "the report says Done when: twice");
});

test("#62: an omitted contract stays omitted in a recreation (no invented criteria)", () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({ status: "aborted", verificationContract: "" });
  writeProjection(cwd, saved);
  const record = collectSavedGoalRecords(cwd)[0]!;
  const recipe = buildRestoreRecipe(record);
  assert.ok(recipe);
  assert.deepEqual(recipe!.criteria, []);
  assert.equal(recipe!.command, "Ship the widget", "an objective with no saved criteria recreates as objective-only");
  assert.equal(recipe!.roundTrip.ok, true);
  const parsed = extractVerificationContract(recipe!.command);
  assert.equal(parsed.objective, "Ship the widget");
  assert.equal(parsed.verificationContract, "");
});

// ────────────────────────────────────────────────────────────────────
// 5. Routing / registration
// ────────────────────────────────────────────────────────────────────

test("#62: /goal recover routes as a subcommand, with or without an id filter", () => {
  assert.deepEqual(routeGoalArgs("recover"), { kind: "sub", name: "recover", rest: "" });
  assert.deepEqual(routeGoalArgs("recover 20261106130000-cancel1"), { kind: "sub", name: "recover", rest: "20261106130000-cancel1" });
  // An objective that merely starts with the word still sets a goal.
  assert.deepEqual(routeGoalArgs("recover the deleted fixtures from the backup"), { kind: "set", text: "recover the deleted fixtures from the backup" });
});

test("#62: an unreadable record is reported, never silently dropped or promoted", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(piGlaDir(cwd), "goals"), { recursive: true });
  fs.writeFileSync(path.join(piGlaDir(cwd), "goals", "20261106120000-broken.md"), "not a goal record\n");
  const records = collectSavedGoalRecords(cwd);
  assert.equal(records.length, 1);
  assert.equal(classifySavedRecord(records[0]!, { goalPresent: false, goal: null }), "unreadable");
  const text = formatRecoveryInventory({ live: { goalPresent: false, goal: null, listCount: 0, loop: null } , records, orphanQueue: [] });
  assert.match(text, /UNREADABLE/);
  assert.match(text, /not a GLLA goal record/);
});

test("#62: a held loop is named in the inventory header so it is never confused with a goal", () => {
  const text = formatRecoveryInventory({
    live: { goalPresent: false, goal: null, listCount: 0, loop: { active: false, target: "metric loop", iteration: 3 } },
    records: [],
    orphanQueue: [],
  });
  assert.match(text, /live state: no live goal · list empty · loop stopped/);
  assert.match(text, /No saved records on disk — nothing to recover and nothing stale\./);
  assert.equal(formatRecoveryInventory({
    live: { goalPresent: false, goal: null, listCount: 2, loop: { active: true, iteration: 3 } },
    records: [],
    orphanQueue: [],
  }).split("\n")[0], "Recovery inventory — live state: no live goal · list 2 waiting · loop active (iter 3).");
});

test("#62: the projection parser reads status, policy, stop reason, objective and contract", () => {
  const parsed = parseSavedGoalMarkdown(renderGoalMarkdown(objectiveOf({
    status: "aborted",
    policy: "list",
    stopReason: "list cancelled",
  })));
  assert.equal(parsed.status, "aborted");
  assert.equal(parsed.policy, "list");
  assert.equal(parsed.stopReason, "list cancelled");
  assert.equal(parsed.objective, "Ship the widget");
  assert.equal(parsed.verificationContract, "- alpha renders\n- beta persists");
  assert.equal(parsed.objectiveAmbiguous, false);
  assert.equal(parsed.tasks.total, 0);
});

test("#62: a completed plan's checkboxes survive the projection and stay historical", () => {
  const cwd = tmpCwd();
  const saved = objectiveOf({ status: "complete", taskList: withProgress(PLAN) });
  writeArchive(cwd, saved);
  const record = collectSavedGoalRecords(cwd)[0]!;
  assert.equal(record.tasks.complete, 3, "completed rows are visible as history");
  assert.equal(classifySavedRecord(record, { goalPresent: false, goal: null }), "historical");
  const recipe = buildRestoreRecipe(record);
  assert.ok(recipe?.roundTrip.ok, "history still yields a clean round trip — as a NEW goal");
  const text = formatRecoveryInventory({ live: { goalPresent: false, goal: null, listCount: 0, loop: null }, records: [record], orphanQueue: [] });
  assert.match(text, /HISTORICAL/);
  assert.match(text, /nothing pre-completed/);
  assert.match(text, /Old audit reports and test runs stay historical until revalidated here\./);
});

test("#62: HELD_ON_RESTORE loops are not reported as goals in a recovery inventory", () => {
  // Guards the seam the field report ran into: a held loop occupies the
  // session but must never be read as a resumable goal.
  const text = formatRecoveryInventory({
    live: { goalPresent: false, goal: null, listCount: 0, loop: { active: false, stopReason: HELD_ON_RESTORE } as never },
    records: [],
    orphanQueue: [],
  });
  assert.doesNotMatch(text, /goal paused|goal active/i);
  assert.match(text, /no live goal/);
});

// keep the seedLoop import meaningful for the seam above
void seedLoop;
