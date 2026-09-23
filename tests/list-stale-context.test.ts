// pi-goal-list-loop-audit — v0.34.51
// tests/list-stale-context.test.ts
//
// Contract item: "/list command handling on stale extension contexts — a
// stale-context test returns an honest recovery result instead of silently
// failing drafting or mutating state."
//
// Field shape (hegemon/polis 2026-07-26+): pi invalidates the extension
// handle on session replacement. warnIfStaleAtEntry has WARNED at /list
// entry since v0.28.1 — but cmdList discarded the probe's return and went
// on to mutate anyway: `/list add` on an idle queue ACTIVATED a goal in a
// doomed process (no continuation possible, no interrupt marker — the
// marker goStaleTerminal stamps on send failures never got the chance),
// `/list clear` wiped the queue from a session that could not announce it,
// `/list remove/next/cancel` the same. The drafting path was already
// guarded (startDrafting's entry probe returns false) — the mutation path
// was not. Now every mutating subcommand is REFUSED on a stale handle with
// the honest recovery result and a ledger trail; read-only subcommands
// (show, depth) keep working so the queue stays inspectable while the
// lifecycle replacement is pending.
//
// Shared-process hazard (note.md): this file activates the goal.js module
// singleton at module scope, so it copies loop-error-exemption.test.ts's
// afterEach cleanup and the __testOnlyResetOwnerSession() in freshSession.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetStaleFlag, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, invalidateHostSession, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
afterEach(() => {
  setGlobalAutoResume(false);
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

function ledgerText(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
}

// ────────────────────────────────────────────────────────────────────
// Mutating subcommands are refused on a stale handle
// ────────────────────────────────────────────────────────────────────

test("v0.34.51: /list add on a stale handle is refused — honest recovery result, zero state mutation", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {}); // idle queue — the activation trap
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  await pi.command("list", "add fix the login bug — done when: the test passes", ctx);
  await tick();

  const after = ledgerText(cwd);
  const state = readState(cwd) as { goal: unknown; list: unknown[] };
  assert.equal(state.goal, null, "idle-queue add must NOT activate a goal in a doomed process");
  assert.equal(state.list.length, 0, "the item was not queued");
  // The only deltas are the honest trail: entry probe + refusal ledger.
  assert.ok(after.includes('"list_mutation_refused_stale"'), "refusal is ledgered");
  assert.ok(after.includes('"extension_api_stale"'), "entry probe is ledgered");
  assert.ok(!after.includes('"list_added"'), "no add event");
  const honest = ctx.ui.matching("stale");
  assert.ok(honest.length >= 1, "the entry probe printed the honest recovery result");
  assert.ok(honest.some((n) => n.message.includes("can't send continuations in this process")), "names the real boundary");
  assert.ok(honest.some((n) => n.message.includes("State is safe in .pi-glla/")), "points at the durable state");
});

test("v0.34.51: /list remove, clear, cancel, next, tweak, pause, resume are all refused on a stale handle", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: {
      id: "list-item-1",
      objective: "active seeded list item — done when pinned",
      status: "paused",
      policy: "list",
      autoContinue: true,
      pauseReason: "user paused",
      pauseKind: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    list: [
      { id: "queued-1", objective: "queued item one", addedAt: new Date().toISOString() },
      { id: "queued-2", objective: "queued item two", addedAt: new Date().toISOString() },
    ],
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  for (const args of ["remove 1", "clear", "cancel", "next", "tweak queued item one", "pause", "resume"]) {
    await pi.command("list", args, ctx);
  }
  await tick();

  const after = ledgerText(cwd);
  const state = readState(cwd) as { goal: { status: string; pauseReason?: string }; list: unknown[] };
  assert.equal(state.list.length, 2, "queue untouched by any mutating subcommand");
  assert.equal(state.goal.status, "paused", "paused item not resumed/aborted by the stale session");
  assert.equal(state.goal.pauseReason, "user paused", "pause state untouched");
  const refusals = after.match(/"list_mutation_refused_stale"/g) ?? [];
  assert.equal(refusals.length, 7, "every mutating subcommand is refused and ledgered");
  assert.ok(!after.includes('"list_removed"'), "no remove event");
  assert.ok(!after.includes('"list_cleared"'), "no clear event");
  assert.ok(!after.includes('"list_cancelled"'), "no cancel event");
});

test("v0.34.51: the natural-language dump fallthrough is refused on a stale handle — drafting never starts", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  // "/list fix the login bug" — unknown first word → dump fallthrough.
  await pi.command("list", "fix the login bug, add dark mode", ctx);
  await tick();

  const after = ledgerText(cwd);
  const state = readState(cwd) as { goal: unknown; list: unknown[] };
  assert.equal(state.goal, null, "no drafting side effect");
  assert.equal(state.list.length, 0, "no items from the dump");
  assert.ok(after.includes('"list_mutation_refused_stale"'), "dump refusal is ledgered");
  assert.ok(!after.includes("drafting"), "no drafting session was started in the doomed process");
  // The honest result came from the entry probe, not a silent return:
  assert.ok(ctx.ui.matching("stale").length >= 1, "honest warning was printed");
});

// ────────────────────────────────────────────────────────────────────
// Read-only subcommands keep working; the fresh session recovers
// ────────────────────────────────────────────────────────────────────

test("v0.34.51: /list show and /list depth stay usable on a stale handle (inspect, don't mutate)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: {
      id: "list-item-1",
      objective: "active seeded list item — done when pinned",
      status: "active",
      policy: "list",
      autoContinue: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    list: [{ id: "queued-1", objective: "queued item one", addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  await pi.command("list", "show", ctx);
  await pi.command("list", "settings", ctx);
  await tick();

  const after = ledgerText(cwd);
  const shows = ctx.ui.matching("List (1)");
  assert.ok(shows.length >= 1, "the queue is still visible on the stale handle");
  assert.ok(shows.some((n) => n.message.includes("queued item one")), "items render");
  assert.ok(!after.includes('"list_mutation_refused_stale"'), "read-only commands are not refused");
  assert.equal(
    after.split("\n").length,
    before.split("\n").length + 1, // only the entry-probe stale ledger line was added
    "stale show/settings add no command-event ledger lines",
  );
  assert.ok(!after.includes('"list_recovered_from_disk"'));
  assert.ok(!after.includes('"list_settings_redirect"'));
});

test("v0.34.51: the honest recovery result — the refreshed session owns the command and the add lands", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  invalidateHostSession(pi, ctx);

  await pi.command("list", "add stale-session item — done when: refused", ctx);
  await tick();
  assert.equal((readState(cwd) as { list: unknown[] }).list.length, 0, "refused in the doomed session");

  // The lifecycle replacement arrives: a fresh factory run clears the stale
  // latch (__testOnlyResetStaleFlag simulates it) and session_start rebinds.
  __testOnlyResetStaleFlag();
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  const fresh = await freshSession(cwd, "startup");
  await tick();

  await pi.command("list", "add post-reload item — done when: lands", fresh);
  await tick();
  const state = readState(cwd) as { goal: { objective: string; status: string } | null; list: unknown[] };
  assert.equal(state.list.length, 0, "idle queue: the item activated instead of waiting");
  assert.ok(state.goal, "the fresh session activates the added item");
  assert.match(state.goal!.objective, /post-reload item/);
  assert.equal(state.goal!.status, "active", "and the fresh session can actually run it");
});

// ────────────────────────────────────────────────────────────────────
// Agent tools on a stale invocation context
// ────────────────────────────────────────────────────────────────────

test("v0.34.51: list_add and list_activate tools return the stale-context recovery result without mutating", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true); // seeded ACTIVE goal must survive session_start (HOLD default pauses it)
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: {
      id: "list-item-1",
      objective: "active seeded list item — done when pinned",
      status: "active",
      policy: "list",
      autoContinue: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    list: [{ id: "queued-1", objective: "queued item one", addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  // Bind lastCtx to THIS test's ctx object (session_start doesn't rememberCtx;
  // a previous test's still-valid ctx would otherwise be the fallback).
  await pi.command("list", "show", ctx);
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  const add = await pi.runTool("list_add", { items: ["tool queued item"] }, ctx);
  assert.match(add.content[0]!.text, /crossed a session replacement before it could run/, "list_add says the honest recovery result");
  const act = await pi.runTool("list_activate", { n: 1 }, ctx);
  assert.match(act.content[0]!.text, /crossed a session replacement before it could run/, "list_activate says the honest recovery result");

  const after = ledgerText(cwd);
  const state = readState(cwd) as { goal: { status: string }; list: unknown[] };
  assert.equal(state.list.length, 1, "no tool-queued item");
  assert.equal(state.goal.status, "active", "active goal not aborted by the stale list_activate");
  assert.ok(!after.includes('"list_added"'), "no add event");
  assert.ok(!after.includes("skipped via list_activate"), "no abort event");
});

// ────────────────────────────────────────────────────────────────────
// Source pins — the gate itself
// ────────────────────────────────────────────────────────────────────

test("v0.34.51: source — cmdList captures the entry probe and gates every mutating path", () => {
  const SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2: cmdList moved
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  assert.match(SRC, /const staleEntry = warnIfStaleAtEntry\(ctx, "\/list"\);/, "entry probe result is captured");
  assert.match(SRC, /if \(staleEntry && LIST_MUTATING_SUBCOMMANDS\.has\(sub\)\) \{/, "top-level mutation gate");
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_mutation_refused_stale", \{ sub \}\)/, "refusal is ledgered with the verb");
  assert.match(SRC, /if \(staleEntry\) \{\n    if \(queuePendingListOperation\(ctx, args\)\) return;\n    appendLedger\(ctx\.cwd, "list_mutation_refused_stale", \{ sub: "dump" \}\);\n    return;\n  \}/, "dump fallthrough is deferred only for a validated handoff");
  // Probe runs before the gate, and the gate runs after sub parsing:
  const probeIdx = SRC.indexOf("const staleEntry = warnIfStaleAtEntry(ctx, \"/list\");");
  const gateIdx = SRC.indexOf("if (staleEntry && LIST_MUTATING_SUBCOMMANDS.has(sub))");
  assert.ok(probeIdx > 0 && gateIdx > probeIdx, "entry probe precedes the mutation gate");
  assert.match(CORE, /LIST_MUTATING_SUBCOMMANDS = new Set\(\[/, "the verb set lives in core next to listMutationBlocked");
  for (const verb of ["audit", "tweak", "pause", "resume", "add", "import", "clear", "cancel", "next", "remove", "rm"]) {
    assert.ok(CORE.includes(`"${verb}"`), `set covers ${verb}`);
  }
  assert.ok(!CORE.includes('"show"') && !CORE.includes('"depth"'), "read-only verbs are NOT in the set");
});
