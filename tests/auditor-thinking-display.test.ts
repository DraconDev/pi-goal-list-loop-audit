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

test("headless /glla honors an explicit thinking setting and unknown models", async () => {
  const cwd = tmpCwd();
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
