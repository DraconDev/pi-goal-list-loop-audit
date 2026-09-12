// pi-goal-list-loop-audit — v0.38.51
// tests/list-bare-draft.test.ts
//
// Contract (user note 2026-09-12): bare /list drafts from context like bare
// /goal does; /list show remains the viewer. Pins:
//   1. bare /list enters LIST drafting (agent list_add is blocked with the
//      drafting-gate message);
//   2. /list show still renders the queue;
//   3. the stale guard mirrors cmdSet's empty-goal path: a stale bare /list
//      latches no drafting gate, so a later list_add lands normally.
// Cleanup uses the honest user path: an explicit /goal start with a
// "Done when:" clause cancels the drafting session (goal-commands.ts).
//
// Shared-process hazard (note.md): this file activates the goal.js module
// singleton at module scope, so it copies list-settings-route.test.ts's
// afterEach cleanup and the __testOnlyResetOwnerSession() in freshSession.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import activate, { __testOnlyResetStaleFlag, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, invalidateHostSession, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
afterEach(() => {
  pi.execHandler = null;
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  __testOnlyResetOwnerSession(); // release the claim so later files are unaffected
});

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession(); // behavioral-orchestrator's owner claim precedes this file
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

// ────────────────────────────────────────────────────────────────────
// Bare /list drafts from context like bare /goal
// ────────────────────────────────────────────────────────────────────

test("v0.38.51: bare /list enters list drafting — agent list_add is gated", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();

  await pi.command("list", "", ctx);
  await tick();

  const blocked = await pi.runTool("list_add", { items: ["gated item — done when pinned"] }, ctx);
  assert.match(blocked.content[0]!.text, /LIST DRAFTING IN PROGRESS/, "bare /list latched the list-drafting gate");

  // Honest user exit: an explicit objective cancels the drafting session.
  await pi.command("goal", "start cleanup objective — done when: pinned", ctx);
  await tick();
  const added = await pi.runTool("list_add", { items: ["after draft — done when pinned"] }, ctx);
  assert.match(added.content[0]!.text, /item\(s\) queued/, "explicit start cleared the gate; the item waits behind the active goal");
});

test("v0.38.51: /list show still renders the queue (viewer preserved)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  await pi.command("goal", "start active one — done when: pinned", ctx);
  await tick();
  await pi.command("list", "add waiting one — done when: pinned", ctx);
  await tick();

  await pi.command("list", "show", ctx);
  await tick();

  const last = ctx.ui.notifies.at(-1)?.message ?? "";
  assert.match(last, /List \(1\)/, "show renders the waiting queue");
  assert.match(last, /waiting one/, "the queued item renders");
  const state = readState(cwd) as { goal: { objective: string } | null };
  assert.ok(state.goal && state.goal.objective.includes("active one"), "show mutated nothing — the active goal is untouched");
});

test("v0.38.51: stale bare /list latches no drafting gate — a later list_add lands", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  invalidateHostSession(pi, ctx);

  await pi.command("list", "", ctx);
  await tick();

  // The lifecycle replacement arrives: a fresh session_start rebinds. If
  // the stale bare /list had latched the (module-global) drafting gate,
  // this fresh context's list_add would still be blocked.
  __testOnlyResetStaleFlag();
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  const fresh = await freshSession(cwd, "startup");
  await tick();
  const added = await pi.runTool("list_add", { items: ["stale-seed item — done when pinned"] }, fresh);
  assert.match(added.content[0]!.text, /item\(s\) added|item.*active/i, "a stale bare /list left no drafting gate behind");
  await pi.command("list", "cancel", fresh);
});
