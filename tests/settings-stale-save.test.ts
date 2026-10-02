import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, handleSettingChoice } from "../extensions/loops/goal.js";
import { loadGlobalSettings } from "../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tick, tmpCwd } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
async function boot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `settings-stale-save-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120); return ctx;
}
afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
});

test("C9: stale-probe refusal fails the save loudly — no false saved claim", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const prior = (globalThis as Record<string, unknown>).warnIfStaleAtEntry;
  (globalThis as Record<string, unknown>).warnIfStaleAtEntry = () => true;
  ctx.ui.selectImpl = async () => "on — --session <jobDir>/session.jsonl: tail -f it live, resume it after the audit";
  try {
    await assert.rejects(handleSettingChoice("auditorInspection", ctx), /went stale during the edit/);
    assert.equal(ctx.ui.matching("Auditor inspection ON").length, 0, "the branch success notify never ran");
    assert.equal(loadGlobalSettings().auditorInspection, undefined, "nothing was written");
  } finally {
    (globalThis as Record<string, unknown>).warnIfStaleAtEntry = prior;
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("C9 control: healthy probe saves and reports normally", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const prior = (globalThis as Record<string, unknown>).warnIfStaleAtEntry;
  (globalThis as Record<string, unknown>).warnIfStaleAtEntry = () => false;
  ctx.ui.selectImpl = async () => "on — --session <jobDir>/session.jsonl: tail -f it live, resume it after the audit";
  try {
    await handleSettingChoice("auditorInspection", ctx);
    assert.equal(ctx.ui.matching("Auditor inspection ON").length, 1);
    assert.equal(loadGlobalSettings().auditorInspection, true);
  } finally {
    (globalThis as Record<string, unknown>).warnIfStaleAtEntry = prior;
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
