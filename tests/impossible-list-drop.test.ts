// pi-goal-list-loop-audit — v0.34.70
// tests/impossible-list-drop.test.ts
//
// note.md 2026-08-07: "auto drop impossible ones i think or auto adjust
// instead of stopping" — instead of stopping the /list queue on an
// impossible item, auto-drop it (with a ledgered reason) and advance.
//
// DEFINED IMPOSSIBLE STATE (the rule lives in the extension, pause_goal
// handler): a /list item paused as kind="blocked" with NO resume path (no
// non-empty suggestedAction) — the pause itself declares "blocked forever,
// no way forward". Every internal blocked pause (restore hold, audit retry
// horizon, abort wall, …) carries a suggestedAction, so only an
// agent-authored blocked pause that offers no way forward reaches the rule.
//
// Contract: the impossible-state rule is defined in the extension, the
// behavior is ledgered (list_item_impossible + list_item_auto_dropped) and
// tested; suite green + tsc clean.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { readState } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import {
  MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, seedLoop, tick,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession();
});

function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function assertCompactRecap(message: string, context: string): void {
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Unresolved:", "Next:"]) {
    assert.match(message, new RegExp(label), `${context} includes ${label}`);
  }
  assert.doesNotMatch(message, /Tests:/, `${context} hides technical Tests by default`);
}

function runPauseTool(ctx: MockCtx, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  return pi.runTool("pause_goal", params, ctx) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

function writeImpossibleAuditor(cwd: string, reason: string): string {
  const script = `${cwd}/fake-impossible-auditor.mjs`;
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
const report = ${JSON.stringify(`<impossible>${reason}</impossible>`)};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
`);
  fs.chmodSync(script, 0o700);
  return script;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for terminal impossible archive");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Active /list item + a queued follow-up — the auto-advance target. */
async function impossibleFixture(extra: Record<string, unknown> = {}) {
  setGlobalAutoResume(true); // keep the active goal ACTIVE past the restore gate
  const cwd = tmpCwd();
  try {
    const goal = seedGoal({
      policy: "list",
      status: "active",
      objective: "impossible item A",
      ...(extra.goal as Record<string, unknown> | undefined),
    });
    seedState(cwd, {
      goal,
      list: extra.list !== undefined
        ? (extra.list as unknown[])
        : [{ id: "q-item-2", objective: "second list item" }],
      ...((extra.state ?? {}) as Record<string, unknown>),
    });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    return { cwd, ctx, goal };
  } catch (err) {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}

test("rule: blocked + no resume path on a /list item → auto-dropped (ledgered) and the queue advances", async () => {
  const { cwd, ctx, goal } = await impossibleFixture();
  const before = readState(cwd).goal as { id: string };

  const res = await runPauseTool(ctx, { reason: "the API is gone and nothing else can do this", kind: "blocked" });
  await tick();

  // Detection + drop ledgered with the item id.
  const impossible = readLedger(cwd).filter((l) => l.type === "list_item_impossible");
  assert.equal(impossible.length, 1);
  assert.equal((impossible[0]!.value as { itemId: string }).itemId, before.id);
  assert.match((impossible[0]!.value as { reason: string }).reason, /API is gone/);
  const dropped = readLedger(cwd).filter((l) => l.type === "list_item_auto_dropped");
  assert.equal(dropped.length, 1);
  assert.equal((dropped[0]!.value as { itemId: string }).itemId, before.id);
  // The dropped item is terminalized before the queue advances; the next
  // item, not the dropped one, owns the live slot.
  const after = readState(cwd).goal as { objective: string; status: string; policy: string };
  assert.equal(after.objective, "second list item", "advanced to the queued follow-up");
  assert.ok(fs.existsSync(`${cwd}/.pi-glla/archive/${before.id}.md`), "dropped item has a durable archive");
  const archived = fs.readFileSync(`${cwd}/.pi-glla/archive/${before.id}.md`, "utf8");
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(archived, new RegExp(`^${label}`, "m"));
  const dropNotice = ctx.ui.notifies.find((notice) => notice.message.includes("auto-dropped as impossible"))?.message ?? "";
  assertCompactRecap(dropNotice, "auto-drop notification");
  assert.equal(after.status, "active");
  assert.equal(after.policy, "list");
  assert.equal(readState(cwd).list?.length, 0, "queue drained");
  // Surfaced: warning notify + tool result text.
  assert.ok(ctx.ui.matching("auto-dropped as impossible").length >= 1, "drop notify");
  assert.match(res.content[0]!.text, /auto-dropped as impossible/);
  assert.ok(ctx.ui.matching("advancing to the next item").length >= 1, "advance notify");
});

test("guard: blocked WITH a resume path stays paused — never overridden", async () => {
  const { cwd, ctx, goal } = await impossibleFixture();
  const before = readState(cwd).goal as { id: string };

  const res = await runPauseTool(ctx, {
    reason: "need the user to fix the API key",
    kind: "blocked",
    suggestedAction: "/goal resume after fixing the API key",
  });
  await tick();

  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_impossible").length, 0, "no impossible detection");
  const after = readState(cwd).goal as { id: string; status: string; objective: string; pauseKind?: string };
  assert.equal(after.id, before.id, "same item stays");
  assert.equal(after.status, "paused", "regular blocked pause is preserved");
  assert.equal(after.pauseKind, "blocked");
  assert.equal(after.objective, "impossible item A", "no advance — the follow-up stays queued");
  assert.equal(readState(cwd).list?.length, 1, "queue untouched");
  assert.match(res.content[0]!.text, /Goal paused/);
});

test("guard: blocked + no resume path on a plain GOAL is not a list drop", async () => {
  const { cwd, ctx, goal } = await impossibleFixture({
    goal: { policy: "goal" as const, objective: "plain goal objective" },
  });
  const before = readState(cwd).goal as { id: string };

  await runPauseTool(ctx, { reason: "cannot proceed", kind: "blocked" });
  await tick();

  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_impossible").length, 0, "goal pauses never ledger list drops");
  const after = readState(cwd).goal as { id: string; status: string };
  assert.equal(after.id, before.id);
  assert.equal(after.status, "paused", "stays a normal paused goal");
});

test("last item: drop still ledgered, list goes empty, no advance possible", async () => {
  const { cwd, ctx, goal } = await impossibleFixture({ list: [] });
  const before = readState(cwd).goal as { id: string };

  await runPauseTool(ctx, { reason: "nobody can build this", kind: "blocked" });
  await tick();

  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_auto_dropped").length, 1, "drop ledgered even for the last item");
  const after = readState(cwd).goal;
  assert.equal(after, null, "the impossible item is terminalized even when the queue is empty");
  assert.ok(fs.existsSync(`${cwd}/.pi-glla/archive/${before.id}.md`), "last dropped item has a durable archive");
  assert.equal(readState(cwd).list?.length, 0);
  assert.ok(ctx.ui.matching("the list is now empty").length >= 1, "empty-list notify");
  const emptyDropNotice = ctx.ui.notifies.find((notice) => notice.message.includes("the list is now empty"))?.message ?? "";
  assertCompactRecap(emptyDropNotice, "empty-list auto-drop notification");
});

test("full auditor IMPOSSIBLE result is terminalized with a durable recap and notification", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeImpossibleAuditor(cwd, "the required upstream capability no longer exists");
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start impossible audit target — done when pinned", ctx);
    await tick();
    const result = await pi.runTool("complete_goal", {
      completionSummary: "Outcome: completion claim submitted. Changed: none. Evidence: auditor verdict is captured. Tests: not run — semantic impossibility fixture. Unresolved: impossible upstream dependency. Next: review the archived verdict.",
      verificationSummary: "The fake auditor returns a full IMPOSSIBLE verdict.",
    }, ctx);
    assert.match(result.content[0]!.text, /AUDIT PENDING — nonterminal/, "pending stays nonterminal in plain voice");
    await waitUntil(() => readState(cwd).goal === null);

    const archivedPath = `${cwd}/.pi-glla/archive`;
    const archivedFiles = fs.readdirSync(archivedPath);
    assert.equal(archivedFiles.length, 1, "the impossible objective has one archive");
    const archived = fs.readFileSync(`${archivedPath}/${archivedFiles[0]!}`, "utf8");
    assert.match(archived, /Status.*aborted/);
    assert.match(archived, /impossible/, "the independent IMPOSSIBLE verdict remains in the archive history");
    for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(archived, new RegExp(label));
    const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8");
    assert.match(ledger, /goal_impossible_terminalized/);
    assert.match(ledger, /goal_archived/);
    const impossibleNotice = ctx.ui.notifies.find((notice) => notice.message.includes("Goal archived as aborted"))?.message ?? "";
    assertCompactRecap(impossibleNotice, "full impossible notification");
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
    __testOnlyResetOwnerSession();
  }
});

test("stored-claim full IMPOSSIBLE retry also terminalizes with its recap", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeImpossibleAuditor(cwd, "the claimed objective is impossible in this environment");
  try {
    seedState(cwd, {
      goal: seedGoal({
        status: "paused",
        pendingCompletion: {
          completionSummary: "saved completion claim",
          verificationSummary: "saved verification claim",
          at: new Date().toISOString(),
          phase: "recovery-pending",
          attemptId: "stored-impossible-attempt",
        },
      }),
    });
    const ctx = await freshSession(cwd, "startup");
    const retry = (globalThis as any).retryStoredCompletionAudit as ((origin: string) => Promise<void>);
    assert.equal(typeof retry, "function", "stored audit retry is wired");
    await retry("manual");
    await waitUntil(() => readState(cwd).goal === null);
    const archivedFiles = fs.readdirSync(`${cwd}/.pi-glla/archive`);
    assert.equal(archivedFiles.length, 1);
    const archived = fs.readFileSync(`${cwd}/.pi-glla/archive/${archivedFiles[0]!}`, "utf8");
    assert.match(archived, /Status.*aborted/);
    for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(archived, new RegExp(label));
    assert.match(fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8"), /provider_retry_impossible_terminalized/);
    const storedImpossibleNotice = ctx.ui.notifies.find((notice) => notice.message.includes("Goal archived as aborted"))?.message ?? "";
    assertCompactRecap(storedImpossibleNotice, "stored impossible notification");
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
    __testOnlyResetOwnerSession();
  }
});

test("loop hold: drop ledgered but NO advance while a loop owns the surface", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    // __testOnlyLoadState skips session_start, so the stacked-state
    // auto-arbitration (which would park the loop) never runs — a live
    // loop AND a live list goal can coexist for this gate test.
    const goal = seedGoal({ policy: "list", status: "active", objective: "impossible item A" });
    seedState(cwd, {
      goal,
      list: [{ id: "q-item-2", objective: "second list item" }],
      loop: seedLoop({ active: true, startedAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    __testOnlyLoadState(cwd);
    const ctx = ownerCtx(cwd);
    const before = readState(cwd).goal as { id: string };

    await runPauseTool(ctx, { reason: "cannot be done", kind: "blocked" });
    await tick();

    assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_auto_dropped").length, 1, "drop ledgered");
    const after = readState(cwd).goal;
    assert.equal(after, null, "the impossible item is terminalized while the loop remains owner");
    assert.ok(fs.existsSync(`${cwd}/.pi-glla/archive/${before.id}.md`), "loop-held dropped item has a durable archive");
    assert.equal(readState(cwd).list?.length, 1, "follow-up stays queued behind the live loop");
    assert.ok(ctx.ui.matching("a running loop holds the surface").length >= 1, "loop-hold notify");
    const loopHeldNotice = ctx.ui.notifies.find((notice) => notice.message.includes("a running loop holds the surface"))?.message ?? "";
    assertCompactRecap(loopHeldNotice, "loop-held auto-drop notification");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
