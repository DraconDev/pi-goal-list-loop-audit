// pi-goal-list-loop-audit — v0.34.69
// tests/list-tweak-proposal.test.ts
//
// note.md 2026-08-07: "list tweak seems too literal, doesnt work, it should
// launcher into a what we update into" — a BARE /list tweak (and /goal tweak)
// previously died with a "Usage:" notify. Now it launches the update-proposal
// flow: the current item text is surfaced (notify preview + input pre-fill),
// the replacement is collected interactively, and the old→new proposal is
// confirmed BEFORE any apply. Contract: "/list tweak opens a proposal with
// old→new text and confirm before applying, test pins the flow".

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { readState } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

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

/** Paused list item — the /list tweak surface. */
async function listTweakFixture() {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "paused",
      objective: "old list objective",
      pauseReason: "paused by user",
      pauseSuggestedAction: "/list resume to continue",
    }),
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  return { cwd, ctx };
}

function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("bug (note 2026-08-07): bare /list tweak launches the update-proposal flow — current text shown, old→new confirmed, then applied", async () => {
  const { cwd, ctx } = await listTweakFixture();
  let inputTitle = "";
  let inputPlaceholder = "";
  ctx.ui.inputImpl = async (title, placeholder) => {
    inputTitle = title;
    inputPlaceholder = placeholder ?? "";
    return "new list objective";
  };
  let confirmMessage = "";
  ctx.ui.confirmImpl = async (_title, message) => {
    confirmMessage = message;
    return true;
  };

  await pi.command("list", "tweak", ctx); // bare — no replacement text

  // The flow surfaced the current item text: notify preview + input pre-fill.
  assert.ok(ctx.ui.matching("Tweak list item — current: old list objective").length >= 1, "current text previewed in a notify");
  assert.match(inputTitle, /update the list item into/, "input asks what to update the item into");
  assert.equal(inputPlaceholder, "old list objective", "current text pre-filled into the input");
  // The proposal shows the exact old→new pair (note.md item 2: the compact
  // card keeps the consent text exact and drops the CURRENT/NEW wall labels).
  assert.ok(confirmMessage.includes("old list objective"), "proposal shows the current text");
  assert.ok(confirmMessage.includes("new list objective"), "proposal shows the new text");
  assert.match(confirmMessage, /^\*\*From:\*\*$/m, "the old text is labelled on its own line");
  assert.match(confirmMessage, /^> old list objective$/m, "the old text is quoted verbatim");
  assert.match(confirmMessage, /^\*\*To:\*\*$/m, "the new text is labelled on its own line");
  assert.match(confirmMessage, /^> new list objective$/m, "the new text is quoted verbatim");
  // Applied: ledger + persisted state; still paused; revision bumped once.
  const applied = readState(cwd).goal as { objective: string; status: string; policy: string; revision: number };
  assert.equal(applied.objective, "new list objective");
  assert.equal(applied.status, "paused", "tweak does not activate the list item");
  assert.equal(applied.policy, "list", "list provenance preserved");
  assert.equal(applied.revision, 1, "v0.34.61 revision bump on a real tweak");
  const tweaks = readLedger(cwd).filter((l) => l.type === "goal_tweaked");
  assert.equal(tweaks.length, 1);
  assert.equal((tweaks[0]!.value as { via: string }).via, "/list tweak");
});

test("bare /list tweak with an empty/cancelled input changes nothing", async () => {
  const { cwd, ctx } = await listTweakFixture();
  ctx.ui.inputImpl = async () => undefined; // user pressed Esc
  let confirmCalled = false;
  ctx.ui.confirmImpl = async () => {
    confirmCalled = true;
    return true;
  };

  await pi.command("list", "tweak", ctx);

  assert.ok(ctx.ui.matching("Tweak cancelled; nothing changed.").length >= 1, "cancel notify");
  assert.equal(confirmCalled, false, "no proposal confirm for a cancelled input");
  assert.equal((readState(cwd).goal as { objective: string }).objective, "old list objective");
  assert.equal(readLedger(cwd).filter((l) => l.type === "goal_tweaked").length, 0);
});

test("bare /list tweak returning the unchanged text is a no-op (no revision bump, no confirm)", async () => {
  const { cwd, ctx } = await listTweakFixture();
  ctx.ui.inputImpl = async () => "old list objective"; // Enter on the pre-fill
  let confirmCalled = false;
  ctx.ui.confirmImpl = async () => {
    confirmCalled = true;
    return true;
  };

  await pi.command("list", "tweak", ctx);

  assert.ok(ctx.ui.matching("Tweak cancelled — objective and contract are unchanged; nothing was amended.").length >= 1, "no-op notify");
  assert.equal(confirmCalled, false, "no confirm dialog for a no-op");
  assert.equal((readState(cwd).goal as { objective: string }).objective, "old list objective");
  assert.equal(readLedger(cwd).filter((l) => l.type === "goal_tweaked").length, 0, "no goal_tweaked ledger");
});

test("bare /list tweak input carrying a 'Done when:' clause applies the new contract", async () => {
  const { cwd, ctx } = await listTweakFixture();
  ctx.ui.inputImpl = async () => "new list objective. Done when: new check";
  let confirmMessage = "";
  ctx.ui.confirmImpl = async (_t, message) => {
    confirmMessage = message;
    return true;
  };

  await pi.command("list", "tweak", ctx);

  // The compact card states the consequence; the contract body itself is in the
  // expandable rationale (buildTweakRationaleBody), not the default card.
  assert.match(confirmMessage, /Replaces the list item objective and its verification contract/,
    "the compact card names the contract consequence");
  assert.equal(
    (readState(cwd).goal as { verificationContract?: string }).verificationContract,
    "new check",
    "interactive-path contract semantics match the arg path",
  );
});

test("goal tweak rebases onto a pause that lands while confirmation is open", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    seedState(cwd, {
      goal: seedGoal({ policy: "goal", status: "active", objective: "old goal objective" }),
    });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    ctx.ui.inputImpl = async () => "new goal objective";
    ctx.ui.confirmImpl = async () => {
      // A real host event can mutate state while the confirm dialog yields.
      // Pause through the registered command to reproduce that interleaving.
      await pi.command("goal", "pause", ctx);
      return true;
    };

    await pi.command("goal", "tweak", ctx);

    const updated = readState(cwd).goal as { objective: string; status: string; pauseReason?: string; revision: number };
    assert.equal(updated.objective, "new goal objective");
    assert.equal(updated.status, "paused", "the pause that landed during confirmation must survive the tweak");
    assert.equal(updated.pauseReason, "paused by user", "the latest pause metadata must not be restored from the old snapshot");
    assert.equal(updated.revision, 1, "the tweak still bumps the latest goal revision once");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("mirror: bare /goal tweak launches the same flow for an active goal", async () => {
  setGlobalAutoResume(true); // keep the active goal active past the restore gate
  const cwd = tmpCwd();
  try {
    seedState(cwd, {
      goal: seedGoal({ policy: "goal", status: "active", objective: "old goal objective" }),
    });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    let confirmMessage = "";
    ctx.ui.inputImpl = async () => "new goal objective";
    ctx.ui.confirmImpl = async (_t, message) => {
      confirmMessage = message;
      return true;
    };

    await pi.command("goal", "tweak", ctx);

    assert.ok(confirmMessage.includes("old goal objective"), "goal proposal shows the old text");
    assert.ok(confirmMessage.includes("new goal objective"), "goal proposal shows the new text");
    assert.equal((readState(cwd).goal as { objective: string }).objective, "new goal objective");
    const tweaks = readLedger(cwd).filter((l) => l.type === "goal_tweaked");
    assert.equal(tweaks.length, 1);
    assert.equal((tweaks[0]!.value as { via: string }).via, "/goal tweak");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
