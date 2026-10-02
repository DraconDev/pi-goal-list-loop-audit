import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate, { handleSettingChoice, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { globalSettingsPath, loadGlobalSettings, loadSettings, projectSettingsPath, saveSettings, settingsProvenance } from "../extensions/goal-settings.js";
import { maybeCompactTranscriptAtBoundary, compactorBoundaryMarkerPath, __testOnlySetSpawnWorker, __testOnlyResetCompactor } from "../extensions/goal-compactor.js";
import { buildSettingsRows } from "../extensions/settings-menu.js";
import { MockPi, makeMockCtx, tmpCwd, tick } from "./harness/mock-pi.js";

const globalFile = globalSettingsPath();
const original = fs.readFileSync(globalFile, "utf8"); // hermetic test-preload path
const asHost = (ctx: ReturnType<typeof makeMockCtx>) => ctx as unknown as ExtensionContext;
afterEach(() => {
  fs.writeFileSync(globalFile, original);
  __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
});

test("/glla token-target editor persists shorthand, cancellation, validation, and reset", async () => {
  const cwd = tmpCwd(), ctx = makeMockCtx(cwd);
  for (const [input, expected] of [["300k", 300_000], ["250,000", 250_000], ["1M", 1_000_000]] as const) {
    ctx.ui.inputImpl = async () => input;
    await handleSettingChoice("compactionTokenThreshold", asHost(ctx));
    assert.equal(loadGlobalSettings().compactionTokenThreshold, expected);
    assert.match(ctx.ui.notifies.at(-1)!.message, /idle boundary/);
  }
  for (const input of [undefined, "0", "-5", "12.5", "20,00", "200k junk", "Infinity", "9007199254740992"]) {
    ctx.ui.inputImpl = async () => input;
    await handleSettingChoice("compactionTokenThreshold", asHost(ctx));
    assert.equal(loadGlobalSettings().compactionTokenThreshold, 1_000_000, `invalid/cancelled ${input} must preserve the value`);
  }
  ctx.ui.inputImpl = async () => "";
  await handleSettingChoice("compactionTokenThreshold", asHost(ctx));
  assert.equal(loadGlobalSettings().compactionTokenThreshold, 200_000);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).compactionTokenThreshold, undefined);
});

test("global-only target, defaults, provenance and menu describe the effective policy", () => {
  const cwd = tmpCwd();
  assert.equal(loadSettings(cwd).compactionTokenThreshold, 200_000);
  saveSettings("global", cwd, { compactionTokenThreshold: 300_000 });
  fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
  fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ compactionTokenThreshold: 50_000 }));
  const settings = loadSettings(cwd), prov = settingsProvenance(cwd);
  assert.equal(settings.compactionTokenThreshold, 300_000, "project copies cannot pretend to change global policy");
  assert.equal(prov.compactionTokenThreshold.source, "global");
  const row = buildSettingsRows(settings, prov).find(r => r.id === "compactionTokenThreshold")!;
  assert.equal(row.section, "compactor");
  assert.match(row.valueText, /300,000 tokens.*idle boundary/);
  assert.match(row.description, /opportunistically/);
  assert.equal(row.sourceText, "global");
});

test("configured target reaches the actual trigger, idle guard, and hysteresis", async () => {
  const cwd = tmpCwd(), ctx = makeMockCtx(cwd);
  ctx.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
  let tokens = 250_000, idle = true, compacts = 0;
  ctx.isIdle = () => idle;
  ctx.compact = () => { compacts++; };
  __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: test. Next task: verify." }));
  saveSettings("global", cwd, { compactionTokenThreshold: 300_000 });
  const flags = { supervising: true, auditInFlight: false, paused: false };
  assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), false, "250k is below the chosen 300k target");
  tokens = 320_000; idle = false;
  assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), false, "crossing the target never interrupts a running turn");
  idle = true;
  assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), true);
  assert.equal(compacts, 1);
  assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), false, "no repeated compaction within an episode");
  tokens = 140_000; // below half of 300k, but NOT below half of the old 200k
  assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), false);
  assert.equal(fs.existsSync(compactorBoundaryMarkerPath(cwd)), false, "hysteresis follows the configured target");
  tokens = 310_000;
  assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), true);
  assert.equal(compacts, 2);
  await tick(100);
});

test("hand-edited invalid targets safely fall back at runtime", async () => {
  const flags = { supervising: true, auditInFlight: false, paused: false };
  __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: test. Next task: verify." }));
  for (const value of [0, -10, 1.5, "300k", null, 9007199254740992]) {
    fs.writeFileSync(globalFile, JSON.stringify({ compactionTokenThreshold: value }));
    const cwd = tmpCwd(), ctx = makeMockCtx(cwd); let compacts = 0;
    ctx.getContextUsage = () => ({ tokens: 210_000, contextWindow: 1_000_000, percent: 21 });
    ctx.compact = () => { compacts++; };
    assert.equal(settingsProvenance(cwd).compactionTokenThreshold.source, "default");
    assert.equal(maybeCompactTranscriptAtBoundary(asHost(ctx), flags), true);
    assert.equal(compacts, 1);
  }
  await tick(100);
});

test("headless /glla exposes the chosen token target and source", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "compaction-target-headless" } });
  ctx.hasUI = false;
  await pi.fire("session_start", { reason: "startup" }, ctx);
  saveSettings("global", cwd, { compactionTokenThreshold: 300_000 });
  try {
    await pi.command("glla", "", ctx);
    assert.match(ctx.ui.notifies.at(-1)!.message, /compactionTokenThreshold: 300000 tokens.*idle boundary.*\[global\]/);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
