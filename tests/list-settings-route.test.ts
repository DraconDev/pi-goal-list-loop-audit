// pi-goal-list-loop-audit — v0.34.53
// tests/list-settings-route.test.ts
//
// Contract item: "Clarify settings command routing — route/help tests
// document the supported settings command, handle /list settings explicitly,
// and prevent it from accidentally entering natural-language list drafting."
//
// Field shape: /list's routing treats any unknown first word as a
// natural-language dump (v0.18.0) — so "/list settings" fell into
// routeListText → goalArgsNeedDrafting("settings") → a drafting interview
// seeded with the word "settings". The user asked for settings and got a
// grill about a one-word non-objective. Now the verb is handled explicitly
// BEFORE the dump fallthrough: a clear redirect naming the supported
// settings command (/glla), ledgered as list_settings_redirect, and never a
// drafting seed. /list add settings… keeps working (the explicit add verb
// is the only way an item literally named "settings" enters the queue).
// The redirect is read-only, so it also works on a stale extension handle.
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
import { readGoalRuntimeSource } from "./harness/goal-source.js";

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
// /list settings is handled explicitly — never a drafting seed
// ────────────────────────────────────────────────────────────────────

test("v0.34.53: /list settings redirects to /glla explicitly — no drafting, no state mutation", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  const sentBefore = pi.sent.length;

  await pi.command("list", "settings", ctx);
  await tick();

  const after = ledgerText(cwd);
  const state = readState(cwd) as { goal: unknown; list: unknown[] };
  // The explicit redirect, naming the supported settings command:
  const redirects = ctx.ui.matching("Settings are under /glla");
  assert.ok(redirects.length >= 1, "the redirect names /glla as the settings command");
  assert.ok(redirects.some((n) => n.message.includes("bare /glla opens the settings table")), "points at the settings entry");
  // No drafting interview: no steer message was sent, no drafting notice.
  assert.equal(pi.sent.length, sentBefore, "no drafting seed was sent to the agent");
  assert.ok(!ctx.ui.matching("grill").some((n) => n.message.includes("started")), "no drafting interview notice");
  assert.equal(state.goal, null, "no goal was created");
  assert.equal(state.list.length, 0, "no item was queued");
  assert.ok(after.includes('"list_settings_redirect"'), "the redirect is ledgered");
  assert.ok(!after.includes('"list_added"'), "no add event");
});

test("v0.34.53: /list settings is read-only — it still redirects on a stale extension handle", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  invalidateHostSession(pi, ctx);

  await pi.command("list", "settings", ctx);
  await tick();

  const after = ledgerText(cwd);
  assert.ok(ctx.ui.matching("Settings are under /glla").length >= 1, "redirect still works while stale");
  assert.ok(!after.includes('"list_settings_redirect"'), "stale inspection stays byte-read-only");
  assert.ok(!after.includes('"list_mutation_refused_stale"'), "a read-only redirect is not a refused mutation");
  assert.ok(!after.includes('"list_dump_refused_stale"') && !/list_mutation_refused_stale/.test(after), "the dump gate never fired");
  const state = readState(cwd) as { goal: unknown; list: unknown[] };
  assert.equal(state.goal, null, "nothing drafted");
  assert.equal(state.list.length, 0, "nothing queued");
});

test("v0.34.53: /list add settings… still adds a literal item — the explicit verb is the only way in", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();

  await pi.command("list", "add settings — done when: the page renders", ctx);
  await tick();

  const state = readState(cwd) as { goal: { objective: string } | null; list: unknown[] };
  assert.ok(state.goal && state.goal.objective.includes("settings"), "idle queue: the literal item activated as the goal");
  assert.equal(state.list.length, 0, "activation moved the item out of the queue");
  assert.ok(ledgerText(cwd).includes('"list_added"'), "the item was added via the add verb");
  assert.ok(!ledgerText(cwd).includes('"list_settings_redirect"'), "the add verb is NOT redirected");
});

// ────────────────────────────────────────────────────────────────────
// Help surface + source pins — the supported settings command is documented
// ────────────────────────────────────────────────────────────────────

test("v0.34.53: source — /list help documents /glla as the settings command and the branch precedes the dump fallthrough", () => {
  const SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  const GOAL = readGoalRuntimeSource();
  // The command surface (registerCommand description) documents the
  // supported settings command (description stays in goal.ts):
  assert.match(GOAL, /Loop 2: the list of audited goals[\s\S]*?Settings are under \/glla, not \/list — bare \/glla opens the settings table\./, "description points at /glla");
  // The completion entry:
  assert.match(GOAL, /\["settings", "settings live under \/glla — bare \/glla opens the settings table"\]/, "completion documents the redirect");
  // The explicit branch sits before the natural-language dump fallthrough:
  const settingsIdx = SRC.indexOf('if (sub === "settings") {');
  const dumpIdx = SRC.indexOf("// v0.18.0: an unknown first word isn't an error");
  assert.ok(settingsIdx > 0 && dumpIdx > settingsIdx, "settings branch precedes the dump fallthrough");
  assert.match(SRC, /if \(!staleEntry\) appendLedger\(ctx\.cwd, "list_settings_redirect", \{\}\)/, "redirect is ledgered only from the admitted session");
  // And the redirect message itself names the supported command:
  assert.match(SRC, /Settings are under \/glla, not \/list — bare \/glla opens the settings table/, "message names /glla");
});
