// pi-goal-list-loop-audit — v0.2.0
// tests/confirm-draft.test.ts
//
// v0.34.78 (GitHub #4): the draft-class confirm dialog renders as Markdown
// through ctx.ui.custom (ConfirmDraftComponent) instead of the plain-text
// select. Pins: the pure markdown builder, the component's rendered lines
// and SelectList wiring, and the goal.ts behavior on BOTH paths — custom
// first (yes/no/ALWAYS/stale) and the select fallback when the runtime has
// no custom shard.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";

import activate, { __testOnlyLastConfirmDialog, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, seedGoal, tick, staleError } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.ts";
import { buildConfirmDraftMarkdown, ConfirmDraftComponent } from "../extensions/confirm-draft.ts";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));

const pi = new MockPi();
activate(pi.api);

const FAKE_THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
const FAKE_KB = { matches: () => false };

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-confirm-draft-"));
}

function ledgerText(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

// ── pure builder ────────────────────────────────────────────────────────

test("buildConfirmDraftMarkdown: title is the H1, body follows", () => {
  const md = buildConfirmDraftMarkdown("Confirm goal", "objective — done when pinned");
  assert.equal(md, "# Confirm goal\n\nobjective — done when pinned");
});

// ── component ───────────────────────────────────────────────────────────

test("ConfirmDraftComponent renders the title, body, and all three choices", () => {
  const lines = new ConfirmDraftComponent(
    { title: "Confirm goal", body: "swap survival — done when absorbed", options: ["Yes", "No", "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)"] },
    () => {},
    FAKE_THEME,
    FAKE_KB,
    () => {},
  ).render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("Confirm goal"), "H1 title renders");
  assert.ok(text.includes("swap survival — done when absorbed"), "body renders");
  assert.ok(text.includes("Yes"), "Yes choice renders");
  assert.ok(text.includes("No"), "No choice renders");
  assert.ok(text.includes("auto-accept"), "ALWAYS choice renders (long option)");
});

test("ConfirmDraftComponent: first choice selected, no-throw on input/invalidate", () => {
  const comp = new ConfirmDraftComponent(
    { title: "Confirm goal", body: "b", options: ["Yes", "No"] },
    () => {},
    FAKE_THEME,
    FAKE_KB,
    () => {},
  );
  assert.equal(comp.getSelectedItem(), "Yes", "the first option is pre-selected");
  assert.doesNotThrow(() => comp.handleInput("j")); // navigate-down key data
  assert.doesNotThrow(() => comp.invalidate());
  assert.ok(comp.render(80).length > 0);
});

// ── goal.ts behavior: custom path (mock drives it via customImpl) ───────

function setup(cwd: string) {
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd);
  return ctx;
}

/** Enter goal-drafting mode like behavioral-orchestrator: /goal (no args)
 * + two user messages (the seed send is a no-op; the floor is 2). */
async function enterGoalDrafting(ctx: ReturnType<typeof makeMockCtx>): Promise<void> {
  await pi.command("goal", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
}

async function enterListDrafting(ctx: ReturnType<typeof makeMockCtx>): Promise<void> {
  await pi.command("list", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
}

test("custom path: Yes accepts the draft and the dialog is captured", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  ctx.ui.customImpl = async () => "Yes";
  const res = await pi.runTool("propose_goal_draft", { objective: "confirm custom yes — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  const dlg = __testOnlyLastConfirmDialog();
  assert.ok(dlg, "custom path captured the dialog");
  assert.equal(dlg!.title, "Confirm goal");
  assert.ok(dlg!.body.includes("confirm custom yes"));
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.equal((readState(cwd).goal as { objective: string }).objective, "confirm custom yes — done when pinned");
});

test("custom path: No rejects the draft", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  ctx.ui.customImpl = async () => "No";
  const res = await pi.runTool("propose_goal_draft", { objective: "confirm custom no — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  assert.match(res.content[0]!.text, /declined|not activated|not started|rejected/i);
  assert.equal(readState(cwd).goal, null, "nothing created on No");
});

test("custom path: a stale error returns stale (NOT-a-rejection)", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  ctx.ui.customImpl = async () => { throw staleError(); };
  const res = await pi.runTool("propose_goal_draft", { objective: "confirm stale — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  assert.match(res.content[0]!.text, /NOT a rejection/);
  assert.equal(readState(cwd).goal, null);
});

// ── goal.ts behavior: select fallback when custom is unavailable ────────

test("fallback: no custom shard → plain select path still accepts (Yes)", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  (ctx.ui as { custom?: unknown }).custom = undefined; // emulate headless/RPC
  let selectTitle = "";
  ctx.ui.selectImpl = async (title: string) => {
    selectTitle = title;
    return "Yes";
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "fallback select — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  assert.match(selectTitle, /Confirm goal/, "the select fallback rendered the same title");
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.equal((readState(cwd).goal as { objective: string }).objective, "fallback select — done when pinned");
});

test("fallback: a stale select error still returns stale", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  (ctx.ui as { custom?: unknown }).custom = undefined;
  ctx.ui.selectImpl = async () => { throw staleError(); };
  ctx.ui.confirmImpl = async () => { throw staleError(); };
  const res = await pi.runTool("propose_goal_draft", { objective: "fallback stale — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  ctx.ui.confirmImpl = undefined;
  assert.match(res.content[0]!.text, /NOT a rejection/);
  assert.equal(readState(cwd).goal, null);
});

test("list batch confirmation resolves paused carryover before activating the head", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const pausedId = "paused-carryover-draft";
  seedState(cwd, {
    goal: seedGoal({
      id: pausedId,
      status: "paused",
      policy: "goal",
      objective: "paused carryover objective — done when held",
      pauseReason: "held for explicit resume",
    }),
  });
  const ctx = makeMockCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterListDrafting(ctx);
  ctx.ui.customImpl = async () => "Yes";
  const result = await pi.runTool("propose_goal_draft", {
    objective: "drafted list batch",
    items: [
      "first drafted list item — done when first proof exists",
      "second drafted list item — done when second proof exists",
    ],
  }, ctx);
  ctx.ui.customImpl = undefined;

  assert.match(result.content[0]!.text, /list head activated|Begin work/i);
  const current = readState(cwd);
  assert.equal(current.goal?.policy, "list");
  assert.equal(current.goal?.status, "active");
  assert.match(current.goal?.objective ?? "", /first drafted list item/);
  assert.equal(current.list?.length, 1, "the second batch item remains queued");
  assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "archive", `${pausedId}.md`)), "paused carryover is archived");
  assert.match(ledgerText(cwd), /carryover_resolved/);
});

// ── v0.34.80 (GitHub #4 rework): the REAL headless/RPC shape ───────────
// pi 0.84.1's RPC/noOp `custom` IS a function that resolves `undefined`
// WITHOUT ever invoking the factory — `typeof custom === "function"` is true
// in every mode, so the fallback must engage on "factory never invoked",
// not on typeof. The mock reproduces the stub with customStubMode=true.

test("RPC stub (custom present, factory never invoked): the select fallback fires and accepts", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  const ui = ctx.ui as { customStubMode?: boolean };
  ui.customStubMode = true; // real pi 0.84.1 RPC stub: custom resolves undefined, builder never runs
  let selectTitle = "";
  ctx.ui.selectImpl = async (title: string) => {
    selectTitle = title;
    return "Yes";
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "rpc stub — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  ui.customStubMode = false;
  assert.match(selectTitle, /Confirm goal/, "the stub falls through to the HOST dialog (select) instead of silently rejecting");
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.equal((readState(cwd).goal as { objective: string }).objective, "rpc stub — done when pinned");
  assert.ok(ledgerText(cwd).includes("confirm_dialog_fallback_select"), "the fallback is ledgered with the stub cause");
});

test("v0.34.82: the custom-path factory is INVOKED and returns a ConfirmDraftComponent that renders the body + all three choices", async () => {
  // Auditor (disapproval 2026-08-07T15:39:15): the previous custom-path test
  // asserted `__testOnlyLastConfirmDialog` — which is assigned BEFORE the
  // custom factory runs. The mock invoked the factory but discarded the
  // returned component. Replacing the component with anything else (or
  // making the constructor throw) would still pass those tests. This test
  // captures the factory's RETURNED object and asserts it is a real
  // ConfirmDraftComponent whose rendered output contains the Markdown body
  // and all three choice labels.
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  let captured: unknown = undefined;
  ctx.ui.customImpl = async (...args) => {
    const factory = args[0] as (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown;
    captured = factory({ requestRender: () => {} }, FAKE_THEME, FAKE_KB, () => {});
    return "Yes";
  };
  await pi.runTool("propose_goal_draft", { objective: "factory captures component — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  assert.ok(captured, "the custom factory was invoked and returned a component");
  assert.ok(captured instanceof ConfirmDraftComponent, `the factory returned a ConfirmDraftComponent (got ${(captured as { constructor?: { name?: string } })?.constructor?.name})`);
  const rendered = (captured as ConfirmDraftComponent).render(120).join("\n");
  assert.ok(rendered.includes("factory captures component"), "the rendered Markdown body includes the objective");
  assert.ok(rendered.includes("Yes"), "Yes choice renders");
  assert.ok(rendered.includes("No"), "No choice renders");
  assert.ok(rendered.includes("auto-accept"), "Yes-and-always choice renders");
  assert.ok(rendered.includes("Confirm goal"), "the H1 title renders");
});

test("RPC stub: a select 'No' still declines, and a stale select error returns stale", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await enterGoalDrafting(ctx);
  const ui = ctx.ui as { customStubMode?: boolean };
  ui.customStubMode = true;
  ctx.ui.selectImpl = async () => "No";
  const declined = await pi.runTool("propose_goal_draft", { objective: "rpc no — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  ui.customStubMode = false;
  assert.match(declined.content[0]!.text, /not accepted|refused|rejected|declined|skip/i);
  assert.equal(readState(cwd).goal, null);

  ui.customStubMode = true;
  ctx.ui.selectImpl = async () => { throw staleError(); };
  ctx.ui.confirmImpl = async () => { throw staleError(); };
  const stale = await pi.runTool("propose_goal_draft", { objective: "rpc stale — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  ctx.ui.confirmImpl = undefined;
  ui.customStubMode = false;
  assert.match(stale.content[0]!.text, /NOT a rejection/);
  assert.equal(readState(cwd).goal, null);
});
