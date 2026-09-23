// pi-goal-list-loop-audit — v0.35.15
// tests/pause-decision-interrupt.test.ts
//
// Field complaint (2026-08-21): "glla agents fail to properly kick off a
// decide event and the user is never given an option before the agent moves
// on." Root cause was two-fold:
//
//   1. pause_goal only returned text — pi kept the SAME turn running after
//      the tool result, so the model kept working past its own pause and
//      the 600ms-deferred decision picker lost the race against continued
//      generation (pi serializes dialogs; the user saw nothing until the
//      turn ended, by which time the agent had moved on).
//   2. A model that passed options but omitted kind="decision" had its
//      options silently dropped — no card, no picker, nothing.
//
// Contract under test:
//   1. kind="decision" + options → persisted pauseKind/pauseOptions AND the
//      turn is aborted (ctx.abort) with a ledger entry.
//   2. options WITHOUT kind → inferred as decision (lenient intent).
//   3. Any agent-authored pause aborts the turn (blocked/error/wait too).
//   4. The impossible-drop auto-advance path does NOT abort (the queue's
//      continuation owns the turn).
//   5. The decision picker wiring (maybeDecisionPopup on decision pauses)
//      stays pinned in the source.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { readState } from "../extensions/goal-loop-core.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
} from "../extensions/loops/goal.js";
import {
  MockPi,
  makeMockCtx,
  tmpCwd,
  seedState,
  seedGoal,
  tick,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(
    GLOBAL_SETTINGS_PATH,
    JSON.stringify(
      v
        ? { autoResume: true, aggressiveMode: false }
        : { aggressiveMode: false },
    ),
  );
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession();
});

function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Mock ctx that counts abort() calls — the "did the turn actually stop" probe. */
function abortCountingCtx(cwd: string): { ctx: MockCtx; aborts: () => number } {
  let count = 0;
  const base = makeMockCtx(cwd, { sessionManager: MAIN_SM }) as Record<
    string,
    unknown
  >;
  const ctx = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    abort: () => {
      count++;
    },
  }) as unknown as MockCtx;
  return { ctx, aborts: () => count };
}

/** Active goal restored through session_start (the owner-session gate).
 * Returns an aborts() probe counting turn-abort calls on the SAME ctx object
 * the tool resolves through currentToolContext(execCtx). */
async function activeGoalFixture(
  goalOverrides: Record<string, unknown> = {},
): Promise<{ cwd: string; ctx: MockCtx; aborts: () => number }> {
  setGlobalAutoResume(true); // keep the goal ACTIVE past the restore gate
  const cwd = tmpCwd();
  __testOnlyResetOwnerSession();
  seedState(cwd, {
    goal: seedGoal({ status: "active", policy: "goal", ...goalOverrides }),
    list: [],
    loop: null,
  });
  const { ctx, aborts } = abortCountingCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick();
  return { cwd, ctx, aborts };
}

function runPauseTool(
  ctx: MockCtx,
  params: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return pi.runTool("pause_goal", params, ctx) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

test("decision pause persists options AND aborts the turn so the picker owns an idle surface", async () => {
  const { cwd, ctx, aborts } = await activeGoalFixture();

  const res = await runPauseTool(ctx, {
    reason: "two viable architectures — user picks",
    kind: "decision",
    options: [
      "Option A (/goal resume)",
      'Option B (/goal tweak "do B instead")',
    ],
    recommended: 1,
  });
  await tick();

  const g = readState(cwd).goal as {
    status: string;
    pauseKind?: string;
    pauseOptions?: string[];
    pauseRecommended?: number;
  };
  assert.equal(g.status, "paused");
  assert.equal(g.pauseKind, "decision");
  assert.deepEqual(g.pauseOptions, [
    "Option A (/goal resume)",
    'Option B (/goal tweak "do B instead")',
  ]);
  assert.equal(g.pauseRecommended, 1);
  // THE fix: the turn ends — the model cannot keep working past its own pause.
  assert.equal(aborts(), 1, "pause_goal must abort the running turn");
  assert.equal(
    readLedger(cwd).filter((l) => l.type === "pause_goal_aborted_turn").length,
    1,
    "abort ledgered",
  );
  assert.match(res.content[0]!.text, /turn ends here/);
});

test("options without kind are inferred as decision — no silently dropped picker", async () => {
  const { cwd, ctx, aborts } = await activeGoalFixture();

  await runPauseTool(ctx, {
    reason: "user must choose",
    options: ["/goal resume — keep going", "/goal cancel — stop"],
  });
  await tick();

  const g = readState(cwd).goal as {
    pauseKind?: string;
    pauseOptions?: string[];
  };
  assert.equal(
    g.pauseKind,
    "decision",
    "non-empty options imply kind=decision",
  );
  assert.equal(g.pauseOptions?.length, 2);
  assert.ok(aborts() >= 1, "inferred decision pauses also end the turn");
});

test("every agent-authored pause ends the turn (blocked/error/wait), not just decisions", async () => {
  for (const kind of ["blocked", "error", "wait"] as const) {
    const { cwd, ctx, aborts } = await activeGoalFixture();
    try {
      await runPauseTool(
        ctx,
        kind === "wait"
          ? {
              reason: "quota resets soon",
              kind,
              resumeAt: new Date(Date.now() + 60_000).toISOString(),
            }
          : { reason: "cannot proceed alone", kind },
      );
      await tick();
      assert.equal(aborts(), 1, `kind=${kind} must abort the turn`);
      assert.equal(
        (readState(cwd).goal as { status: string }).status,
        "paused",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("impossible-drop auto-advance does NOT abort — the next item's continuation owns the turn", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    __testOnlyResetOwnerSession();
    seedState(cwd, {
      goal: seedGoal({
        status: "active",
        policy: "list",
        objective: "impossible item A",
      }),
      list: [{ id: "q-item-2", objective: "second list item" }],
      loop: null,
    });
    const { ctx } = abortCountingCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, ctx);
    await tick();

    const res = await runPauseTool(ctx, {
      reason: "the API is gone and nothing else can do this",
      kind: "blocked",
    });
    await tick();

    // The queue advanced (existing contract, impossible-list-drop.test.ts).
    const advanced = readState(cwd).goal as {
      objective: string;
      status: string;
    };
    assert.equal(advanced.objective, "second list item");
    assert.equal(advanced.status, "active");
    // …and the advance was not killed by a pause-time abort.
    const ledger = readLedger(cwd);
    assert.equal(
      ledger.filter((l) => l.type === "pause_goal_aborted_turn").length,
      0,
      "no abort on the drop path",
    );
    assert.match(res.content[0]!.text, /auto-dropped as impossible/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("source pins: decision picker wiring + abort ordering survive refactors", () => {
  const src = fs.readFileSync("extensions/loops/goal-tools.ts", "utf-8");
  // The picker fires for decision pauses (before the abort block).
  assert.match(
    src,
    /if \(p\.kind === "decision" && p\.options && p\.options\.length > 0\) maybeDecisionPopup\(ctx\);/,
  );
  // Abort is inside pause_goal's execute, guarded against the drop path.
  // v0.38.97: a user redirect is a second no-abort path (park-and-continue).
  const exec = src.match(/name: "pause_goal",[\s\S]*?^ {4}\},$/m);
  assert.ok(exec, "pause_goal registration found");
  assert.match(
    exec![0],
    /if \(!droppedImpossible && !redirect\) \{[\s\S]{0,600}?ctx\.abort\(\)/,
    "abort guarded by !droppedImpossible && !redirect",
  );
  assert.match(exec![0], /pause_goal_aborted_turn/, "abort ledgered");
  assert.match(
    exec![0],
    /else if \(redirect && !droppedImpossible\) \{[\s\S]{0,300}?pause_goal_redirect/,
    "redirect park skips the abort with its own ledger event",
  );
  // Lenient inference lives before the state guard.
  assert.match(
    src,
    /if \(!p\.kind && p\.options && p\.options\.length > 0\) p\.kind = "decision";/,
  );
});
