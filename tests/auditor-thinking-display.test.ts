// pi-goal-list-loop-audit — 2026-09-26 field follow-up (session max,
// auditor high): the headless /glla list showed only the raw thinking
// setting, never the effective level after session-inherit + per-model
// fallback. These drive the real dispatcher headlessly and pin the
// effective-resolution line plus its why.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import { loadSettings, saveSettings } from "../extensions/goal-settings.js";
import { resolveAuditorThinkingLevel } from "../extensions/auditor-thinking.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

const FLASH = {
  provider: "agnes",
  id: "agnes-3.0-flash",
  reasoning: true,
  thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
};

function headlessCtx(cwd: string): any {
  const ctx: any = makeMockCtx(cwd);
  ctx.hasUI = false;
  ctx.thinkingLevel = "max";
  ctx.model = { provider: "openrouter", id: "stealth/space-bunny-alpha" };
  ctx.modelRegistry = { getAvailable: () => [FLASH] };
  return ctx;
}

async function boot(cwd: string): Promise<any> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = headlessCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

function headlessText(ctx: any): string {
  const notes = ctx.ui.notifies.map((n: { message: string }) => n.message).join("\n");
  return notes;
}

test("headless /glla shows the effective auditor thinking level with its why", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, auditorModel: "agnes/agnes-3.0-flash" }));
  const ctx = await boot(cwd);
  await pi.command("glla", "", ctx);
  const text = headlessText(ctx);
  assert.match(text, /auditorThinkingEffective: high \(requested max \[session-inherit\]; capped by agnes\/agnes-3\.0-flash support\)/);
  await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
});

test("headless auditor display agrees with dispatch for xhigh without support and non-reasoning models", async () => {
  for (const reasoning of [true, false]) {
    const cwd = tmpCwd();
    const model = { ...FLASH, reasoning, thinkingLevelMap: { xhigh: null, max: "max" } };
    fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false,
      auditorModel: `${model.provider}/${model.id}`, auditorThinkingLevel: "xhigh" }));
    const ctx = await boot(cwd);
    ctx.modelRegistry = { getAvailable: () => [model] };
    try {
      await pi.command("glla", "", ctx);
      const expected = resolveAuditorThinkingLevel(model, "xhigh");
      assert.equal(expected, reasoning ? "high" : "off");
      assert.match(headlessText(ctx), new RegExp(`auditorThinkingEffective: ${expected} `));
      assert.doesNotMatch(headlessText(ctx), /auditorThinkingEffective: max /);
    } finally {
      await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    }
  }
});

test("headless fallback-only auditors do not claim the session thinking cap is effective", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({
    aggressiveMode: false, auditorModelFallbacks: ["agnes/agnes-3.0-flash"],
    auditorSameSessionSwap: false,
  }));
  const ctx = await boot(cwd);
  try {
    await pi.command("glla", "", ctx);
    const text = headlessText(ctx);
    assert.match(text, /auditorThinkingEffective: pending \(requested max \[session-inherit\]; configured fallbacks precede session; per-model support checked at dispatch\)/);
    assert.doesNotMatch(text, /auditorThinkingEffective: max \(.*capabilities unknown/);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("headless explicit session selection reports the live pair despite global pins and retained backups", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({
    aggressiveMode: false, auditorModel: "agnes/agnes-3.0-flash",
    auditorThinkingLevel: "low", auditorModelFallbacks: ["agnes/agnes-3.0-flash"],
  }));
  const ctx = await boot(cwd);
  const session = { provider: "live", id: "current", reasoning: true, thinkingLevelMap: { max: "max" } };
  ctx.model = session;
  ctx.modelRegistry = { getAvailable: () => [FLASH, session] };
  // v0.39.62: auditor primary + dial are global-only, so the picker’s
  // explicit-session state is a GLOBAL null (+ cleared dial), not a project
  // mask. The headless display must still report the live pair.
  saveSettings("global", cwd, { auditorModel: null, auditorThinkingLevel: undefined });
  try {
    await pi.command("glla", "", ctx);
    const line = headlessText(ctx).split("\n").find(line => line.startsWith("auditorThinkingEffective:"));
    assert.ok(line, "headless output includes the effective auditor route");
    assert.match(line, /^auditorThinkingEffective: max /, "uses the live dial, not the global pin or backup cap");
    assert.ok(line.includes("live/current"), "identifies the live session model");
    assert.doesNotMatch(line, /pending|fallbacks precede session|capped by agnes/);
    assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, ["agnes/agnes-3.0-flash"], "display leaves the explicit backups intact");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("headless /glla honors an explicit thinking setting and unknown models", async () => {  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, auditorThinkingLevel: "medium", auditorModel: "agnes/agnes-3.0-flash" }));
  const ctx = await boot(cwd);
  await pi.command("glla", "", ctx);
  assert.match(
    headlessText(ctx),
    /auditorThinkingEffective: medium \(requested medium \[global\]; as requested\)/,
  );

  const cwd2 = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  const ctx2: any = makeMockCtx(cwd2);
  ctx2.hasUI = false;
  ctx2.thinkingLevel = "max";
  ctx2.model = { provider: "openrouter", id: "stealth/space-bunny-alpha" };
  ctx2.modelRegistry = { getAvailable: () => [] };
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  await pi.fire("session_start", { reason: "reload" }, ctx2);
  await pi.command("glla", "", ctx2);
  assert.match(
    headlessText(ctx2),
    /auditorThinkingEffective: max \(requested max \[session-inherit\]; .* capabilities unknown\)/,
  );
  await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  await pi.fire("session_shutdown", { reason: "test-end" }, ctx2);
});

test("headless /glla shows the session route ignores an explicitly configured auditor dial", async () => {
  // v0.39.43: the session model is the auditor's default AND its last
  // resort, so it runs at the SESSION's thinking level. An explicit
  // `auditorThinkingLevel` is a choice about the CONFIGURED auditor models
  // and no longer turns down the route that has to carry the decision.
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, auditorThinkingLevel: "medium" }));
  const ctx: any = makeMockCtx(cwd);
  ctx.hasUI = false;
  ctx.thinkingLevel = "max";
  ctx.model = { provider: "openrouter", id: "stealth/space-bunny-alpha" };
  ctx.modelRegistry = { getAvailable: () => [] };
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await pi.command("glla", "", ctx);
  const text = headlessText(ctx);
  // The session's dial (max), not the configured auditor dial (medium).
  assert.match(text, /auditorThinkingEffective: max \(requested max \[session-model\]/);
  await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
});
