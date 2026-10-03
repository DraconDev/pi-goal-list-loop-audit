import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  const prior = Object.getOwnPropertyDescriptor(globalThis, "warnIfStaleAtEntry")!;
  Object.defineProperty(globalThis, "warnIfStaleAtEntry", { configurable: true, value: () => true });
  ctx.ui.selectImpl = async () => "on — --session <jobDir>/session.jsonl: tail -f it live, resume it after the audit";
  try {
    await assert.rejects(handleSettingChoice("auditorInspection", ctx as unknown as ExtensionContext), /went stale during the edit/);
    assert.equal(ctx.ui.matching("Auditor inspection ON").length, 0, "the branch success notify never ran");
    assert.equal(loadGlobalSettings().auditorInspection, false, "nothing was written");
  } finally {
    Object.defineProperty(globalThis, "warnIfStaleAtEntry", prior);
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("C9 control: healthy probe saves and reports normally", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const prior = Object.getOwnPropertyDescriptor(globalThis, "warnIfStaleAtEntry")!;
  Object.defineProperty(globalThis, "warnIfStaleAtEntry", { configurable: true, value: () => false });
  ctx.ui.selectImpl = async () => "on — --session <jobDir>/session.jsonl: tail -f it live, resume it after the audit";
  try {
    await handleSettingChoice("auditorInspection", ctx as unknown as ExtensionContext);
    assert.equal(ctx.ui.matching("Auditor inspection ON").length, 1);
    assert.equal(loadGlobalSettings().auditorInspection, true);
  } finally {
    Object.defineProperty(globalThis, "warnIfStaleAtEntry", prior);
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});


test("settings save validates its own session after an overlapping editor", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const fresh = makeMockCtx(cwd, { sessionManager: { name: "replacement-settings-session" } });
  const prior = Object.getOwnPropertyDescriptor(globalThis, "warnIfStaleAtEntry")!;
  Object.defineProperty(globalThis, "warnIfStaleAtEntry", { configurable: true, value: (candidate: unknown) => candidate === ctx });
  let answer!: (value: string) => void;
  ctx.ui.selectImpl = () => new Promise<string>(resolve => { answer = resolve; });
  try {
    const staleEdit = handleSettingChoice("auditorInspection", ctx as unknown as ExtensionContext);
    // A second editor replaces the old module-global context while the first
    // one waits for its answer. Even a cancelled edit exposed the race.
    fresh.ui.selectImpl = async () => undefined;
    await handleSettingChoice("auditorInspection", fresh as unknown as ExtensionContext);
    answer("on — persist inspection");
    await assert.rejects(staleEdit, /went stale during the edit/);
    assert.equal(loadGlobalSettings().auditorInspection, false, "stale editor wrote nothing");
    assert.equal(ctx.ui.matching("Auditor inspection ON").length, 0);
  } finally {
    Object.defineProperty(globalThis, "warnIfStaleAtEntry", prior);
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("similarity editor empty input restores the default; explicit zero stays zero", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  try {
    ctx.ui.inputImpl = async () => "0";
    await handleSettingChoice("stallSimilarityThreshold", ctx as unknown as ExtensionContext);
    assert.equal(loadGlobalSettings().stallSimilarityThreshold, 0);
    ctx.ui.inputImpl = async () => "   ";
    await handleSettingChoice("stallSimilarityThreshold", ctx as unknown as ExtensionContext);
    assert.equal(loadGlobalSettings().stallSimilarityThreshold, undefined);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});


test("auditor picker offers thinking for provider refs containing nested model ids", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const model = { provider: "openrouter", id: "vendor/reasoner", reasoning: true, thinkingLevelMap: { max: "max" } };
  ctx.modelRegistry = {
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    getAvailable: () => [model],
    hasConfiguredAuth: () => true,
  } as unknown as ExtensionContext["modelRegistry"];
  ctx.ui.customImpl = async () => ({ kind: "model", ref: "openrouter/vendor/reasoner" });
  let thinkingPrompts = 0;
  ctx.ui.selectImpl = async (title: string) => {
    if (!title.startsWith("Auditor thinking")) return undefined;
    thinkingPrompts++;
    return "max — maximum reasoning";
  };
  try {
    await handleSettingChoice("auditorModel", ctx as unknown as ExtensionContext);
    assert.equal(thinkingPrompts, 1);
    assert.equal(loadGlobalSettings().auditorThinkingLevel, "max");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
