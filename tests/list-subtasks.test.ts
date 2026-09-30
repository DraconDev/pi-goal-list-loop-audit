/**
 * v0.34.81 — LIGHT parent/child subtask binding for list items.
 *
 * Contract (preview accepted 2026-08-07):
 *   - ListItem gains an OPTIONAL parentId. One level only; nesting refused.
 *   - Declaration: line-start `Subtask of: <parent objective> — <child>`.
 *     The marker is consumed; the child objective carries its own Parallel /
 *     Done-when clauses as normal.
 *   - Enqueue resolves parentId by objective match: earlier items in the
 *     SAME batch win, then existing queue. Unresolved / nested / empty
 *     children refused loudly; the rest of the batch still lands.
 *   - Auto-advance SILENTLY skips a group (queue item with open children):
 *     children are queued right after the parent, so the scan lands on the
 *     natural next item. EXPLICIT picks on a group (`/list next <n>`,
 *     list_activate) refuse loudly so the user is not confused by a
 *     silent jump.
 *   - Cascade close in archiveCurrentGoal: when the last child of a group
 *     completes, the parent is removed from the queue, its disk sidecar
 *     deleted, and `list_group_closed` ledgered. No synthetic goal archive
 *     md (the child IS the audit unit; the ledger is the durable trace).
 *   - /list show + list_status render groups with `[group: N open]` and
 *     children as `1.1`, `1.2` under their parent.
 *
 * These tests are arranged in two tiers: pure parser/render checks (no
 * MockPi), and behavioral checks (MockPi + activateNextListItem +
 * archiveCurrentGoal). The pure tier pins the data model; the behavioral
 * tier pins the lifecycle.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  extractSubtaskParent,
  parseListItemDeclaration,
  visibleListPosition,
  visibleListPositions,
  type ListItem,
} from "../extensions/goal-loop-core.js";

// =====================================================================
// PURE TIER — parser / data model
// =====================================================================

test("v0.35.72: visible hierarchical positions map to flat queue indexes", () => {
  const queue: ListItem[] = [
    { id: "parent", objective: "parent", addedAt: "2026-08-27T00:00:00Z" },
    { id: "child-a", objective: "child a", parentId: "parent", addedAt: "2026-08-27T00:01:00Z" },
    { id: "child-b", objective: "child b", parentId: "parent", addedAt: "2026-08-27T00:02:00Z" },
    { id: "next", objective: "next top-level", addedAt: "2026-08-27T00:03:00Z" },
  ];
  assert.deepEqual(visibleListPositions(queue).map((entry) => [entry.label, entry.item.id, entry.flatIndex]), [
    ["1", "parent", 0],
    ["1.1", "child-a", 1],
    ["1.2", "child-b", 2],
    ["2", "next", 3],
  ]);
  assert.equal(visibleListPosition(queue, "2")?.item.id, "next");
  assert.equal(visibleListPosition(queue, "1.1")?.item.id, "child-a");
});

test("v0.34.81: SUBTASK_MARKER is line-start + case-insensitive", () => {
  assert.match("Subtask of: Parent — Child", /^[ \t]*subtask of[ \t]*:/i);
  assert.match("subtask of: Parent — Child", /^[ \t]*subtask of[ \t]*:/i);
  assert.match("SUBTASK OF: Parent — Child", /^[ \t]*subtask of[ \t]*:/i);
  assert.doesNotMatch("The subtask of: x — y", /^[ \t]*subtask of[ \t]*:/i, "mid-sentence is not a declaration");
});

test("v0.34.81: extractSubtaskParent — no marker → undefined parent", () => {
  const r = extractSubtaskParent("Plain item, no parent");
  assert.equal(r.parentObjective, undefined);
  assert.equal(r.objective, "Plain item, no parent");
});

test("v0.34.81: extractSubtaskParent — em-dash splits parent/child", () => {
  const r = extractSubtaskParent("Subtask of: Deploy the release pipeline — bump version");
  assert.equal(r.parentObjective, "Deploy the release pipeline");
  assert.equal(r.objective, "bump version");
});

test("v0.34.81: extractSubtaskParent — en-dash and hyphen-separator both work", () => {
  assert.equal(extractSubtaskParent("Subtask of: Parent – child-A").parentObjective, "Parent");
  assert.equal(extractSubtaskParent("Subtask of: Parent - child-A").parentObjective, "Parent");
});

test("v0.34.81: extractSubtaskParent — hyphen WITHOUT spaces does NOT split", () => {
  // "Fix A-B" is a single parent objective; only spaced em/en/hyphen split.
  const r = extractSubtaskParent("Subtask of: Fix A-B — do the thing");
  assert.equal(r.parentObjective, "Fix A-B");
  assert.equal(r.objective, "do the thing");
});

test("v0.34.81: extractSubtaskParent — no separator captures parent only, empty child", () => {
  const r = extractSubtaskParent("Subtask of: Just a parent");
  assert.equal(r.parentObjective, "Just a parent");
  assert.equal(r.objective, "");
});

test("v0.34.81: extractSubtaskParent — multi-line child objective survives marker strip", () => {
  const raw = "Subtask of: Pipeline rollout — do the thing\n  with care\n  verify via tests";
  const r = extractSubtaskParent(raw);
  assert.equal(r.parentObjective, "Pipeline rollout");
  // Whitespace inside the original raw is preserved verbatim — the
  // verification-contract pass trims later. The marker line is the only
  // line that is split.
  assert.equal(r.objective, "do the thing\n  with care\n  verify via tests");
});

test("v0.34.81: parseListItemDeclaration — child objective keeps its own Parallel + Done when", () => {
  const r = parseListItemDeclaration(
    "Subtask of: Deploy the release pipeline — bump version. Parallel: yes. Done when: npm test passes",
  );
  assert.equal(r.parentObjective, "Deploy the release pipeline");
  // extractVerificationContract strips a trailing period left over from
  // splitting off the contract clause.
  assert.equal(r.objective, "bump version");
  assert.equal(r.parallelSafe, true);
  assert.match(r.verificationContract, /npm test passes/);
});

test("v0.34.81: parseListItemDeclaration — no marker means parentObjective is undefined", () => {
  const r = parseListItemDeclaration("Just a normal item. Done when: foo");
  assert.equal(r.parentObjective, undefined);
  assert.equal(r.objective, "Just a normal item");
});

// =====================================================================
// SIDE-CAR ROUND-TRIP
// =====================================================================

test("v0.34.81: parentId round-trips through writeQueueItemFile → readQueueFromDisk", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subtasks-"));
  try {
    const parent: ListItem = { id: "p1", objective: "Deploy the release pipeline", addedAt: "2026-08-07T10:00:00.000Z" };
    const child: ListItem = { id: "c1", objective: "bump version", parentId: "p1", addedAt: "2026-08-07T10:00:01.000Z" };
    // Use the same write path the runtime uses (require the module fresh per cwd).
    const { writeQueueItemFile, readQueueFromDisk } = require("../extensions/goal-loop-core.js");
    writeQueueItemFile(cwd, parent);
    writeQueueItemFile(cwd, child);
    const reloaded = readQueueFromDisk(cwd);
    const foundChild = reloaded.find((x: ListItem) => x.id === "c1");
    assert.ok(foundChild, "child reloaded");
    assert.equal(foundChild!.parentId, "p1");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.34.81: readQueueFromDisk ignores malformed parentId (non-string)", () => {
  // Direct check — write a sidecar with a bogus parentId and confirm the
  // reader drops it. Belt-and-suspenders so a torn-write or hand-edit
  // cannot resurrect a phantom parentId.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subtasks-bad-"));
  try {
    const dir = path.join(cwd, ".pi-glla", "goals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "x1.queue.json"),
      JSON.stringify({ schema: 1, type: "queue-item", id: "x1", objective: "x", parentId: 42, addedAt: "x" }),
    );
    const { readQueueFromDisk } = require("../extensions/goal-loop-core.js");
    const reloaded = readQueueFromDisk(cwd);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]!.parentId, undefined, "non-string parentId dropped on read");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// =====================================================================
// SOURCE-PIN — wiring lives in goal.ts (no behavioral harness needed
// for the wiring itself; the behavioral tier below covers the effect).
// =====================================================================

test("v0.34.81: wiring — parse in core, resolve/refuse/cascade in goal.ts", () => {
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  const SRC = readGoalRuntimeSource();
  const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2
  // Parse step lives in core (single source of truth for the marker regex).
  assert.match(CORE, /const \{ objective, parentObjective \} = extractSubtaskParent\(raw\);/);
  // Refusal ledger key
  assert.match(CMDS, /appendLedger\(ctx\.cwd, "list_subtask_refused", \{ source, count: refused\.length, refusals: refused \}\);/);
  // Cascade close ledger key
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_group_closed", \{[\s\S]*parentId: pid,/);
  // Explicit-pick refusal key
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_group_activation_refused", \{ goalId: target\.id, open \}\);/); // stays in goal.ts (activation path)
  // Scan-skip uses groupOpenChildren
  assert.match(SRC, /while \(scan < queue\.length && groupOpenChildren\(queue\[scan\]!\.id\) > 0\) scan\+\+;/); // stays in goal.ts (activation path)
  // parentId carried onto the active goal
  assert.match(SRC, /if \(next\.parentId\) goal\.parentId = next\.parentId;/);
  // Nesting refused
  assert.match(CMDS, /nested subtask ".*" — one level only/); // decomposition step 2: enqueue validation moved
  // Unresolved parent refused
  assert.match(CMDS, /unresolved parent ".*" for child/);
});
// =====================================================================
// BEHAVIORAL TIER — drives the extension via MockPi + activate()
// to exercise enqueue resolution, scan-skip, cascade close, and the
// explicit-pick refusal. One MockPi + activate per file (bun test isolates
// module state per file). __testOnlyResetOwnerSession between fixtures so
// each gets a fresh MAIN owner and blank-start barrier.
// =====================================================================

import activate, {
  __testOnlyResetOwnerSession,
} from "../extensions/loops/goal.js";
import {
  MockPi,
  makeMockCtx,
  tick,
  tmpCwd,
  type MockCtx,
} from "./harness/mock-pi.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";
import { readState } from "../extensions/goal-loop-core.js";

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

// Global settings path mirrors the orchestrator's helper — write the file
// to flip autoResume, restore it after each test.
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  return fs.readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value: Record<string, unknown> });
}

function dir(cwd: string): string {
  return path.join(cwd, ".pi-glla", "goals");
}

function writeSidecar(cwd: string, item: Record<string, unknown>): void {
  fs.mkdirSync(dir(cwd), { recursive: true });
  fs.writeFileSync(
    path.join(dir(cwd), `${item.id}.queue.json`),
    JSON.stringify({ schema: 1, type: "queue-item", ...item }),
  );
}

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string, reason = "startup"): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

afterEach(() => setGlobalAutoResume(false));

/** Build a fake completed-goal state line for archiveCurrentGoal to act on.
 * Kept as a documented utility for future expansion; the current cascade-
 * close source-pin + sidecar round-trip cover the contract without driving
 * the live archiveCurrentGoal path (which requires the full auditor
 * pipeline — out of scope for a list-shape test). */
function seedCompletedListGoal(cwd: string, parentId?: string): string {
  const id = `done-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const goal: Record<string, unknown> = {
    id,
    objective: parentId ? "child objective" : "done objective",
    status: "complete",
    policy: "list",
    autoContinue: true,
    verificationContract: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (parentId) goal.parentId = parentId;
  const line = JSON.stringify({ type: "state", value: { goal, list: [], loop: null }, at: new Date().toISOString() });
  fs.appendFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), line + "\n");
  return id;
}

beforeEach(() => {
  __testOnlyResetOwnerSession();
});

test("v0.34.81 (behavioral): list_add with a subtask binds parentId to the matching queue item", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  // Pre-seed state with an ACTIVE goal so the bulk-add does NOT auto-
  // activate (enqueueItems only auto-activates when state.goal is
  // null/complete/aborted — an active slot blocks it). We want to inspect
  // the queue unchanged so we can see BOTH children bound.
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const seedLine = JSON.stringify({
    type: "state",
    value: {
      goal: {
        id: "seed-active",
        objective: "seeded active blocker",
        status: "active",
        policy: "goal",
        autoContinue: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      list: [],
      loop: null,
    },
    at: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), seedLine + "\n");
  const ctx = await freshSession(cwd);
  // Single bulk-add with the parent first, then its two children, then an
  // unrelated item. All go through one enqueueItems call so the resolve
  // step finds the parent in `resolved[]`.
  await pi.command(
    "list",
    "add Deploy the release pipeline. Done when: foo. Parallel: yes.\n" +
      "Subtask of: Deploy the release pipeline — bump version. Done when: bar\n" +
      "Subtask of: Deploy the release pipeline — write the changelog. Done when: baz\n" +
      "Unrelated work. Done when: qux",
    ctx,
  );
  await tick();

  // Filter for type=="state" so continuation-dispatch / ledger entries
  // interleaved on active.jsonl don't poison the read.
  const stateRaw = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  const lines = stateRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stateLines = lines.filter((l: any) => l.type === "state");
  const queue: any[] = stateLines[stateLines.length - 1].value.list;
  const parent = queue.find((s: any) => typeof s.objective === "string" && s.objective.startsWith("Deploy the release pipeline"));
  const children = queue.filter((s: any) => typeof s.parentId === "string");
  assert.ok(parent, "parent in queue");
  assert.equal(parent.parallelSafe, true, "parent keeps its own Parallel: yes");
  assert.equal(children.length, 2, "both children bound (the active-blocker stopped auto-activate)");
  for (const c of children) {
    assert.equal(c.parentId, parent.id, "child.parentId points at the parent");
  }
  // No refusals for a clean batch.
  const ledger = readLedger(cwd);
  assert.equal(
    ledger.some((e) => e.type === "list_subtask_refused"),
    false,
    "no refusals expected for a clean batch",
  );
});

test("v0.34.81 (behavioral): unresolved parent refuses that child, other items still land", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  // Active-blocker pre-seed so auto-activate does not claim the Real parent.
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const seedLine = JSON.stringify({
    type: "state",
    value: {
      goal: {
        id: "seed-active",
        objective: "seeded active blocker",
        status: "active",
        policy: "goal",
        autoContinue: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      list: [],
      loop: null,
    },
    at: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), seedLine + "\n");
  const ctx = await freshSession(cwd);
  // Bulk-add with a child referencing a parent that is NEVER declared.
  await pi.command(
    "list",
    "add Real parent. Done when: foo\n" +
      "Subtask of: Bogus parent — child with no actual parent",
    ctx,
  );
  await tick();
  // Only the real parent made it (the child with a bogus parent is refused).
  const stateRaw = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  const lines = stateRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stateLines = lines.filter((l: any) => l.type === "state");
  const queue: any[] = stateLines[stateLines.length - 1].value.list;
  assert.equal(queue.length, 1, "refused child never written");
  const ledger = readLedger(cwd);
  const refused = ledger.find((e) => e.type === "list_subtask_refused");
  assert.ok(refused, "refusal ledger present");
  const refusals = refused.value.refusals;
  assert.ok(Array.isArray(refusals), "refusals is an array");
  assert.match(String((refusals as string[])[0] ?? ""), /unresolved parent "Bogus parent"/);
});

test("v0.34.81 (behavioral): explicit pick on a group refuses loudly (no silent jump)", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // Seed a parent + child directly into the queue sidecars so the queue
  // head IS a group (the parent has one open child). No bulk-add involved
  // — the auto-advance scan-skip would silently activate the child, so we
  // place the group before any /list add that could auto-activate.
  fs.mkdirSync(dir(cwd), { recursive: true });
  const parentId = "p-" + Math.random().toString(36).slice(2, 8);
  const childId = "c-" + Math.random().toString(36).slice(2, 8);
  writeSidecar(cwd, {
    id: parentId,
    objective: "Pick-refusal parent group",
    addedAt: new Date().toISOString(),
  });
  writeSidecar(cwd, {
    id: childId,
    objective: "Pick-refusal child one",
    parentId,
    addedAt: new Date().toISOString(),
  });
  // The queue lives in active.jsonl's `list` array, not the sidecar dir,
  // once the extension has booted. Sidecars are the stale-handle fallback
  // (v0.34.60). For the live `listQueue()` path, the items must also be in
  // state.list. Easiest: load the state line, push the parent+child into
  // its list, write it back. session_start re-reads it.
  // (The /list show path also falls back to readQueueFromDisk, but
  // activateNextListItem reads from state.list directly.)
  const stateLine = JSON.stringify({
    type: "state",
    value: {
      goal: null,
      list: [
        { id: parentId, objective: "Pick-refusal parent group", addedAt: new Date().toISOString() },
        { id: childId, objective: "Pick-refusal child one", parentId, addedAt: new Date().toISOString() },
      ],
      loop: null,
    },
    at: new Date().toISOString(),
  });
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), stateLine + "\n");
  // Fresh session — reads the state line, queue is now [parent, child]
  // where parent has one open child. groupOpenChildren(parent.id) === 1.
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  // /list next 1 → activateNextListItem(ctx, 1, { explicit: true }) →
  // target is the head (the parent). Must refuse loudly with
  // list_group_activation_refused.
  await pi.command("list", "next 1", ctx);
  await tick();
  const ledger = readLedger(cwd);
  assert.equal(
    ledger.some((e) => e.type === "list_group_activation_refused"),
    true,
    "explicit pick on a group is refused loudly",
  );
});

test("v0.34.81 (behavioral): auto-advance skips a head group and lands on its first open child", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // Bulk-add parent + two children in ONE call so the resolve step finds
  // the parent in `resolved[]` (the parent is NOT auto-activated first
  // because enqueueItems queues them all and activates AFTER — the scan-
  // skip in activateNextListItem then lands on child one).
  await pi.command(
    "list",
    "add Parent group. Done when: foo\n" +
      "Subtask of: Parent group — child one. Done when: bar\n" +
      "Subtask of: Parent group — child two. Done when: baz",
    ctx,
  );
  await tick();
  // Read the LAST STATE line (filter out continuation-dispatch / ledger
// entries that interleave on active.jsonl). After auto-advance the goal
// is "child one" and the queue holds [Parent group, child two].
  const stateRaw = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  const lines = stateRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stateLines = lines.filter((l: any) => l.type === "state");
  const lastStateLine = stateLines[stateLines.length - 1];
  const goal = lastStateLine.value.goal;
  assert.ok(goal, "a goal is active after auto-advance");
  assert.match(String(goal.objective), /child one/);
  const queue = lastStateLine.value.list;
  assert.equal(queue.length, 2, "parent + child two remain queued");
  assert.equal(queue.some((q: any) => q.objective.includes("Parent group")), true);
  assert.equal(queue.some((q: any) => q.objective.includes("child two")), true);
  const parent = queue.find((q: any) => q.objective.includes("Parent group"));
  assert.equal(goal.parentId, parent.id, "active goal carries parentId pointing at the parent");
});

test("audit-2026-09-06: auto-advance head-group skip is ledgered, not silent", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  await pi.command(
    "list",
    "add Skip-ledger parent. Done when: foo\n" +
      "Subtask of: Skip-ledger parent — skip child one. Done when: bar",
    ctx,
  );
  await tick();
  const skips = readLedger(cwd).filter((e) => e.type === "list_group_auto_skipped");
  assert.equal(skips.length, 1, "exactly one skip event for the head group");
  assert.match(String(skips[0]!.value.landedOn), /.+/, "landing item recorded");
  assert.equal(skips[0]!.value.skippedGroups, 1);
});

test("v0.38.104: list_activate accepts the dotted child label the queue prints", async () => {
  // `list_status` and `/list show` hand the agent labels like `1.1`, and this
  // tool's own error text names that form — but the schema typed `n` as
  // Type.Number, so validation rejected it BEFORE execute could explain it.
  // A JSON number cannot carry a label token at all.
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  // An ACTIVE goal blocks enqueue auto-activation, so parent + child stay
  // queued and inspectable while the label is exercised.
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const seedLine = JSON.stringify({
    type: "state",
    value: {
      goal: {
        id: "seed-active",
        objective: "seeded active blocker",
        status: "active",
        policy: "goal",
        autoContinue: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      list: [],
      loop: null,
    },
    at: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), seedLine + "\n");
  const ctx = await freshSession(cwd);
  try {
    await pi.command(
      "list",
      "add Label parent. Done when: foo\n" +
        "Subtask of: Label parent — label child. Done when: bar",
      ctx,
    );
    const queued = readState(cwd).list ?? [];
    const child = queued.find((item) => item.objective.includes("label child"));
    assert.ok(child, "the child is queued under its parent");
    assert.deepEqual(visibleListPositions(queued).map((entry) => entry.label), ["1", "1.1"], "the queue prints the 1.1 label");

    // The active goal is a live conflict, so the pick goes through the same
    // update/replace/cancel choice the number form needs.
    ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Update current objective");
    ctx.ui.confirmImpl = async () => true;
    const result = await pi.runTool("list_activate", { n: "1.1" }, ctx);
    assert.ok(
      !/must be a visible list position/.test(result.content[0]?.text ?? ""),
      `the child label must be accepted, got: ${result.content[0]?.text}`,
    );
    const goal = readState(cwd).goal;
    assert.equal(goal?.objective, child.objective, "the child item became the active objective");
    assert.equal(goal?.parentId, child.parentId, "and it keeps its parent link");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.38.104 (schema pin): list_activate's `n` accepts the child-label string form", () => {
  // The behavioral test above cannot catch a schema regression: the MockPi
  // harness passes params straight to execute, while the real host validates
  // against the tool schema BEFORE the handler runs. So pin the declared type
  // and the description that names the form the error text teaches.
  const src = readGoalRuntimeSource();
  const tool = src.slice(src.indexOf('name: "list_activate"'), src.indexOf('name: "list_status"'));
  assert.match(tool, /n: Type\.Union\(\[Type\.Number\(\), Type\.String\(\)\]/, "n accepts a number or a child-label string");
  assert.match(tool, /1\.1/, "the description names the dotted child label");
  assert.match(tool, /const p = params as \{ n: number \| string \}/, "the handler types the widened parameter");
});
