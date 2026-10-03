import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { handleSettingChoice, __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import { globalSettingsPath, loadSettings, saveSettings } from "../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tmpCwd, invalidateHostSession, seedState, seedGoal } from "./harness/mock-pi.js";
import type { SettingsMenuComponent } from "../extensions/settings-menu.js";

const globalFile = globalSettingsPath();
const original = fs.readFileSync(globalFile, "utf8");
let running: { pi: MockPi; ctx: ReturnType<typeof makeMockCtx> } | undefined;
async function boot(settings: Record<string, unknown> = {}) {
  __testOnlyResetProcessState();
  fs.writeFileSync(globalFile, JSON.stringify({ aggressiveMode: false, autoResume: false, ...settings }));
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: `ui-audit-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  running = { pi, ctx };
  return running;
}
afterEach(async () => {
  if (running) await running.pi.fire("session_shutdown", { reason: "test" }, running.ctx);
  running = undefined;
  __testOnlyResetProcessState();
  fs.writeFileSync(globalFile, original);
});

test("settings table reopens the tab that was edited", async () => {
  const { pi, ctx } = await boot();
  let calls = 0;
  let reopenedSection: string | undefined;
  ctx.ui.customStubMode = true;
  ctx.ui.customImpl = async (...args) => {
    const factory = args[0] as (...values: any[]) => SettingsMenuComponent;
    const component = factory({ requestRender() {} }, { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t }, { matches: () => false }, () => {});
    if (calls++ === 0) {
      for (let i = 0; i < 4; i++) component.handleInput("\x1b[C");
      assert.equal(component.visibleRows()[0]?.section, "auditor");
      return "auditorSilent";
    }
    reopenedSection = component.visibleRows()[0]?.section;
    return undefined;
  };
  await pi.command("glla", "", ctx);
  assert.equal(calls, 2);
  assert.equal(reopenedSection, "auditor", "editing does not reset navigation to Keep-going");
});

test("forbidden substring patterns cannot disable configured fallback chains", async () => {
  const { ctx } = await boot({ mainModelFallbacks: ["provider/backup"], forbiddenModels: [] });
  ctx.ui.customStubMode = true;
  ctx.ui.inputImpl = async () => "provider/,other/model";
  await handleSettingChoice("forbiddenModels", ctx);
  assert.deepEqual(loadSettings(ctx.cwd).forbiddenModels, ["other/model"]);
  assert.ok(ctx.ui.matching("policy").length > 0);
});

for (const id of ["drafterModel", "compactorModel", "subagentModelOverrides.scout"]) {
  test(`${id} refuses a forbidden primary pin`, async () => {
    const { ctx } = await boot({ forbiddenModels: ["blocked"] });
    ctx.ui.customStubMode = true;
    ctx.ui.inputImpl = async () => "provider/blocked-model";
    await handleSettingChoice(id, ctx);
    const settings = loadSettings(ctx.cwd);
    assert.equal(settings.drafterModel, undefined);
    assert.equal(settings.compactorModel, undefined);
    assert.equal(settings.subagentModelOverrides?.scout, undefined);
    assert.ok(ctx.ui.matching("forbidden").length > 0);
  });
}

test("editing a role fallback preserves other roles saved while its picker was open", async () => {
  const { ctx } = await boot({ subagentFallbacks: { worker: ["provider/old"] } });
  ctx.ui.customStubMode = true;
  ctx.ui.inputImpl = async () => {
    saveSettings("global", ctx.cwd, { subagentFallbacks: { worker: ["provider/new"] } });
    return "provider/scout";
  };
  await handleSettingChoice("subagentFallbacks:scout", ctx);
  assert.deepEqual(loadSettings(ctx.cwd).subagentFallbacks, { worker: ["provider/new"], scout: ["provider/scout"] });
});

test("audit health stays available but cleanup is refused on a stale host", async () => {
  const { pi, ctx } = await boot({ auditJobRetentionMs: 0 });
  const job = path.join(ctx.cwd, ".pi-glla", "audit-jobs", "finished");
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, "result.json"), "{}");
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(job, old, old);
  invalidateHostSession(pi, ctx);
  await pi.command("glla", "audits health", ctx);
  assert.ok(ctx.ui.matching("audit-job health").length > 0);
  await pi.command("glla", "audits health cleanup", ctx);
  assert.ok(fs.existsSync(job), "an invalidated host cannot delete audit evidence");
});

test("tool visibility commands replace conflicting overrides", async () => {
  const { pi, ctx } = await boot();
  await pi.command("glla", "tooloverride hide bash", ctx);
  await pi.command("glla", "tooloverride allow bash", ctx);
  assert.deepEqual(loadSettings(ctx.cwd).toolOverrides?.allow, ["bash"]);
  assert.deepEqual(loadSettings(ctx.cwd).toolOverrides?.hide ?? [], []);
});

test("tool config accepts spaced JSON and refuses empty keys", async () => {
  const { pi, ctx } = await boot();
  await pi.command("glla", 'tooloverride set bash metadata={"label": "two words"}', ctx);
  assert.deepEqual(loadSettings(ctx.cwd).toolOverrides?.perToolConfig?.bash?.metadata, { label: "two words" });
  await pi.command("glla", "tooloverride set bash =60", ctx);
  assert.equal(loadSettings(ctx.cwd).toolOverrides?.perToolConfig?.bash?.[""], undefined);
});

test("postaudit refuses a save after the host became stale in its dialog", async () => {
  const { pi, ctx } = await boot();
  let called = false;
  ctx.ui.selectImpl = async (_title, options) => {
    if (called) return undefined;
    called = true;
    invalidateHostSession(pi, ctx);
    return options.find(option => option.startsWith("Enabled"));
  };
  await pi.command("glla", "postaudit", ctx);
  assert.equal(loadSettings(ctx.cwd).postaudit, undefined);
  assert.equal(loadSettings(ctx.cwd).reviewer, undefined);
  assert.ok(ctx.ui.matching("NOT saved").length > 0);
});

test("wipe revalidates its host after the confirmation dialog", async () => {
  const { pi, ctx } = await boot();
  seedState(ctx.cwd, { goal: seedGoal({ status: "paused", objective: "preserve work when the confirmation's host is replaced" }) });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  ctx.ui.confirmImpl = async () => { invalidateHostSession(pi, ctx); return true; };
  await pi.command("glla", "wipe", ctx);
  const journal = fs.readFileSync(path.join(ctx.cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(!journal.includes('"glla_wipe"'));
  assert.ok(journal.includes("preserve work when"));
});

test("tool metadata editor preserves concurrent updates and names its execution limit", async () => {
  const { ctx } = await boot();
  ctx.ui.selectImpl = async () => "set — per-tool config";
  let inputs = 0;
  ctx.ui.inputImpl = async () => {
    if (inputs++ === 0) return "bash";
    saveSettings("project", ctx.cwd, { toolOverrides: { allow: ["read"], perToolConfig: { other: { enabled: true } } } });
    return ' metadata = {"label": "two words"}';
  };
  await handleSettingChoice("toolOverrides", ctx);
  assert.deepEqual(loadSettings(ctx.cwd).toolOverrides, { allow: ["read"], perToolConfig: { other: { enabled: true }, bash: { metadata: { label: "two words" } } } });
  assert.ok(ctx.ui.matching("not applied to tool execution").length > 0);
});

test("compactor picker labels its clear choice as registry plan B", async () => {
  const { ctx } = await boot();
  let clearLabel: string | undefined;
  ctx.ui.customStubMode = true;
  ctx.ui.customImpl = async (...args) => {
    const factory = args[0] as (...values: any[]) => { render(width: number): string[] };
    const component = factory({ requestRender() {} }, { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t }, { matches: () => false }, () => {});
    clearLabel = component.render(140).join("\n");
    return undefined;
  };
  await handleSettingChoice("compactorModel", ctx);
  assert.match(clearLabel ?? "", /registry plan B/);
  assert.doesNotMatch(clearLabel ?? "", /session model.*clear the override/);
});
