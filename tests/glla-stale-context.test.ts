// pi-goal-list-loop-audit — v0.34.52
// tests/glla-stale-context.test.ts
//
// Contract item: "Harden bare /glla settings UI on stale extension contexts —
// stale settings entry is caught with the standard recovery message and a
// fresh session can reopen the UI."
//
// Field shape (hegemon/polis 2026-07-26+): pi invalidates the extension
// handle on session replacement. /goal, /list, /glla resume, and the drafting
// entries probe warnIfStaleAtEntry — but BARE /glla (the settings surface)
// did not: it opened the settings table in a doomed process, where every
// choice writes state the stale session can neither announce nor run, and
// /glla wipe/cancel/reviewer/postaudit/tooloverride mutated directly. Now
// cmdSettings probes at entry and refuses the settings entry + all mutating
// actions with the standard recovery message and a
// settings_mutation_refused_stale ledger trail; read-only surfaces
// (status/log/stats/audits) stay usable so the user can still inspect.
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
const SETTINGS_UI = fs.readFileSync("extensions/loops/goal-settings-ui.ts", "utf-8");
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
function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi-glla", "settings.json");
}

// ────────────────────────────────────────────────────────────────────
// Bare /glla (the settings entry) is refused on a stale handle
// ────────────────────────────────────────────────────────────────────

test("v0.34.52: bare /glla on a stale handle is refused — standard recovery message, UI never opens, settings untouched", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const settingsFile = projectSettingsPath(cwd);
  fs.writeFileSync(settingsFile, JSON.stringify({ autoAcceptDrafts: true }));
  const ctx = await freshSession(cwd, "startup");
  await tick();
  let uiOpened = 0;
  ctx.ui.customImpl = async () => {
    uiOpened++;
    return undefined; // cancel — openSettingsUI exits after the first render
  };
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  await pi.command("glla", "", ctx);
  await tick();

  const after = ledgerText(cwd);
  assert.equal(uiOpened, 0, "the settings table never opened in the doomed process");
  assert.equal(fs.readFileSync(settingsFile, "utf-8"), JSON.stringify({ autoAcceptDrafts: true }), "settings file untouched");
  const honest = ctx.ui.matching("stale");
  assert.ok(honest.length >= 1, "the standard recovery message was printed");
  assert.ok(honest.some((n) => n.message.includes("can't send continuations in this process")), "names the real boundary");
  assert.ok(honest.some((n) => n.message.includes("State is safe in .pi-glla/")), "points at the durable state");
  assert.ok(honest.some((n) => n.message.includes("Use /new to create a fresh context") && n.message.includes("session_start will resume it")), "names the actual recovery path");
  assert.ok(after.includes('"settings_mutation_refused_stale"'), "refusal is ledgered");
  assert.ok(after.includes('"extension_api_stale"'), "entry probe is ledgered");
  assert.ok(!after.includes('"settings_saved"'), "no settings write event");
});

test("v0.34.52: mutating /glla actions (wipe, cancel, resume, reviewer, postaudit, tooloverride) are all refused on a stale handle", async () => {
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
  let uiOpened = 0;
  ctx.ui.customImpl = async () => {
    uiOpened++;
    return undefined;
  };
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  for (const args of ["wipe", "cancel", "resume", "reviewer", "postaudit", "tooloverride show"]) {
    await pi.command("glla", args, ctx);
  }
  await tick();

  const after = ledgerText(cwd);
  const state = readState(cwd) as { goal: { status: string; pauseReason?: string }; list: unknown[] };
  assert.equal(state.list.length, 2, "queue untouched — wipe/cancel did not run");
  assert.equal(state.goal.status, "paused", "paused item not cancelled");
  assert.equal(state.goal.pauseReason, "user paused", "pause state untouched");
  assert.equal(uiOpened, 0, "no settings/reviewer UI opened in the doomed process");
  const refusals = after.match(/"settings_mutation_refused_stale"/g) ?? [];
  assert.equal(refusals.length, 6, "every mutating action is refused and ledgered");
  assert.ok(!after.includes('"list_cleared"'), "wipe did not clear");
  assert.ok(!after.includes('"goal_aborted"'), "cancel did not abort");
});

// ────────────────────────────────────────────────────────────────────
// Read-only surfaces keep working; the fresh session reopens the UI
// ────────────────────────────────────────────────────────────────────

test("v0.34.52: /glla status, log, stats, audits stay usable on a stale handle (inspect, don't mutate)", async () => {
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

  await pi.command("glla", "status", ctx);
  await pi.command("glla", "log", ctx);
  await pi.command("glla", "stats", ctx);
  await pi.command("glla", "audits", ctx);
  await tick();

  const after = ledgerText(cwd);
  assert.ok(ctx.ui.matching("seeded list item").length >= 1, "status still renders the live goal");
  assert.ok(!after.includes('"settings_mutation_refused_stale"'), "read-only actions are not refused");
  // Only the entry-probe stale ledger line was added (one per command).
  const probes = (after.match(/"extension_api_stale"/g) ?? []).length;
  const beforeProbes = (before.match(/"extension_api_stale"/g) ?? []).length;
  assert.equal(probes - beforeProbes, 4, "each read-only command got its entry probe trail");
});

test("audit 2026-09-07 (LOW, finding 399): bare `/glla fallbacks` is a read-only display — allowed on a stale handle; `fallbacks clear` still mutates and is refused", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  await pi.command("glla", "fallbacks", ctx);
  await tick();
  assert.ok(ctx.ui.matching("fallback models").length >= 1, "the read-only chain display still renders");
  assert.ok(!ledgerText(cwd).includes('"settings_mutation_refused_stale"', before.length), "bare display is not refused");

  await pi.command("glla", "fallbacks clear", ctx);
  await tick();
  const after = ledgerText(cwd);
  assert.ok(after.includes('"settings_mutation_refused_stale"'), "the mutating clear is refused and ledgered");
  assert.ok(!after.includes('"settings_saved"'), "clear wrote nothing");
});

test("v0.34.52: the standard recovery — a fresh session reopens the settings UI and owns the next /glla", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd, "startup");
  await tick();
  invalidateHostSession(pi, ctx);

  await pi.command("glla", "", ctx);
  await tick();
  assert.ok(ledgerText(cwd).includes('"settings_mutation_refused_stale"'), "refused in the doomed session");

  // The lifecycle replacement arrives: a fresh factory run clears the stale
  // latch (__testOnlyResetStaleFlag simulates it) and session_start rebinds.
  __testOnlyResetStaleFlag();
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  const fresh = await freshSession(cwd, "startup");
  await tick();
  const refusedCount = (ledgerText(cwd).match(/"settings_mutation_refused_stale"/g) ?? []).length;
  let uiOpened = 0;
  fresh.ui.customImpl = async () => {
    uiOpened++;
    return undefined; // cancel — one render is enough to prove the UI opened
  };

  await pi.command("glla", "", fresh);
  await tick();

  assert.equal(uiOpened, 1, "the settings table opened again in the fresh session");
  assert.equal((ledgerText(cwd).match(/"settings_mutation_refused_stale"/g) ?? []).length, refusedCount, "no new refusal — the fresh session owns the command");
});

// ────────────────────────────────────────────────────────────────────
// Source pins — the gate itself
// ────────────────────────────────────────────────────────────────────

test("v0.35.72: source — settings rechecks admission after the menu and before saves", () => {
  assert.match(SETTINGS_UI, /if \(typeof probe === "function" && probe\(ctx, "settings edit"\)\) return;/);
  assert.match(SETTINGS_UI, /function saveSettings\(scope: "global" \| "project", ctx: ExtensionContext,/);
  assert.match(SETTINGS_UI, /probe\(ctx, "settings save"\)/);
  assert.doesNotMatch(SETTINGS_UI, /settingsEditContext/, "each save carries its originating editor context");
});

test("v0.34.52: source — cmdSettings captures the entry probe and gates the settings entry + mutating actions", () => {
  const SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2: cmdSettings moved
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  assert.match(SRC, /const staleEntry = warnIfStaleAtEntry\(ctx, "\/glla"\);/, "entry probe result is captured");
  // Audit 2026-09-07 (LOW, finding 399): the gate is arg-aware for the
  // mixed `fallbacks` verb — bare display reads only, clear mutates.
  assert.match(SRC, /fallbacksReadOnly = verb === "fallbacks"/, "bare fallbacks display carves out of the mutating gate");
  assert.match(SRC, /if \(staleEntry && \(verb === "ui" \|\| \(!fallbacksReadOnly && SETTINGS_MUTATING_ACTIONS\.has\(verb\)\)\)\) \{/, "settings-entry + action gate");
  assert.match(SRC, /appendLedger\(ctx\.cwd, "settings_mutation_refused_stale", \{ sub: verb \}\)/, "refusal is ledgered with the verb");
  assert.match(CORE, /SETTINGS_MUTATING_ACTIONS = new Set\(\[/, "the action set lives in core next to the /list gate");
  for (const verb of ["wipe", "reset", "cancel", "resume", "reviewer", "postaudit", "tooloverride"]) {
    assert.ok(CORE.includes(`"${verb}"`), `set covers ${verb}`);
  }
  for (const readOnly of ["status", "log", "stats", "audits"]) {
    const setText = CORE.slice(CORE.indexOf("SETTINGS_MUTATING_ACTIONS = new Set(["));
    const setLiteral = setText.slice(0, setText.indexOf("];"));
    assert.ok(!setLiteral.includes(`"${readOnly}"`), `read-only action ${readOnly} is NOT in the set`);
  }
  // Probe runs before the gate:
  const probeIdx = SRC.indexOf('const staleEntry = warnIfStaleAtEntry(ctx, "/glla");');
  const gateIdx = SRC.indexOf("SETTINGS_MUTATING_ACTIONS.has(verb)");
  assert.ok(probeIdx > 0 && gateIdx > probeIdx, "entry probe precedes the mutation gate");
});
