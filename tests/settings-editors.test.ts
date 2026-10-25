// pi-goal-list-loop-audit — v0.28.7
// tests/settings-editors.test.ts
//
// Behavioral pins for handleSettingChoice (audit T4): the v0.28.0 tests
// covered the settings MENU (render/nav/completeness) but never EXECUTED an
// editor — "menu renders and navigates perfectly while edits silently don't
// save" was the regression shape. These drive the per-key editors end-to-end
// (select/input → saveSettings with the right scope/key/value) against the
// REAL global settings file (snapshotted + restored around every test).
//
// Editor classes in the switch: select (booleans/enums) and input (strings/
// numbers with validation). No confirm-class editors exist (asserted: 0
// ctx.ui.confirm in the switch).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSettingChoice } from "../extensions/loops/goal.js";
import { globalSettingsPath, loadSettings, projectSettingsPath, saveSettings, settingsProvenance } from "../extensions/goal-settings.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalRuntimeSource } from "./harness/goal-source.js";
import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.js";
import { resolveCandidateThinkingLevel } from "../extensions/auditor-thinking.js";
import { buildSettingsRows } from "../extensions/settings-menu.js";

const GOAL_SRC = readGoalRuntimeSource();
const GLOBAL_FILE = globalSettingsPath();
const ORIGINAL = fs.existsSync(GLOBAL_FILE) ? fs.readFileSync(GLOBAL_FILE, "utf-8") : null;

function restoreGlobal(): void {
  if (ORIGINAL === null) {
    try {
      fs.unlinkSync(GLOBAL_FILE);
    } catch {
      /* didn't exist */
    }
  } else {
    fs.writeFileSync(GLOBAL_FILE, ORIGINAL);
  }
}

function readGlobal(): Record<string, unknown> {
  return fs.existsSync(GLOBAL_FILE) ? (JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf-8")) as Record<string, unknown>) : {};
}

test("T4: select editor — stateRoot writes the global workingDir/sessionDir choice", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "sessionDir — top-level Pi session directory (opt-in)";
    await handleSettingChoice("stateRoot", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().stateRoot, "sessionDir");

    ctx.ui.selectImpl = async () => "workingDir — <cwd>/.pi-glla (default)";
    await handleSettingChoice("stateRoot", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().stateRoot, "workingDir");
  } finally {
    restoreGlobal();
  }
});

test("T4: select editor — autoResume writes on/off/default with the right key", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "on — auto-resume on EVERY session start (unattended rigs)";
    await handleSettingChoice("autoResume", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().autoResume, true);

    ctx.ui.selectImpl = async () => "off — never auto-resume; always wait for an explicit resume";
    await handleSettingChoice("autoResume", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().autoResume, false);

    ctx.ui.selectImpl = async (t) => (t.startsWith("Auto-resume") ? "default — HOLD when a session is loaded (popup shows what waits); auto-resume on reload/fork so machinery never strands work" : undefined);
    await handleSettingChoice("autoResume", ctx as unknown as ExtensionContext);
    assert.ok(!("autoResume" in readGlobal()), "default removes the key (tri-state undefined)");
  } finally {
    restoreGlobal();
  }
});

test("T4: select editor — auditorInspection is opt-in on (writes true), off clears to default", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "on — --session <jobDir>/session.jsonl: tail -f it live, resume it after the audit";
    await handleSettingChoice("auditorInspection", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorInspection, true);

    ctx.ui.selectImpl = async () => "off — the original --no-session spawn (default)";
    await handleSettingChoice("auditorInspection", ctx as unknown as ExtensionContext);
    assert.ok(!("auditorInspection" in readGlobal()), "off is the default — the key is removed (tri-state undefined)");
  } finally {
    restoreGlobal();
  }
});

test("removed request-rate fallback setting has no editor or persistence path", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "off — keep retrying the current model; never spend backups on 429s";
    await handleSettingChoice("mainModelFallbackOnRateLimit", ctx as unknown as ExtensionContext);
    assert.equal("mainModelFallbackOnRateLimit" in readGlobal(), false);
    assert.equal(ctx.ui.matching("request-rate").length, 0);
  } finally {
    restoreGlobal();
  }
});

test("T4: select editor — aggressiveMode writes the boolean + notifies", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "on — keep-going defaults; the goal does not park at the audit cap";
    await handleSettingChoice("aggressiveMode", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().aggressiveMode, true);
    assert.ok(ctx.ui.matching("aggressive mode on").length >= 1, "mode flip announced");
  } finally {
    restoreGlobal();
  }
});

test("T4: select editor — contextCheckpointProjection writes true, off removes the key (v0.38.54)", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "on — splice a bounded checkpoint every turn (legacy; busts the prompt cache)";
    await handleSettingChoice("contextCheckpointProjection", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().contextCheckpointProjection, true);
    assert.ok(ctx.ui.matching("projection on").length >= 1, "opt-in announced");

    ctx.ui.selectImpl = async () => "off — leave the transcript alone; the continuation prompt carries live state (default)";
    await handleSettingChoice("contextCheckpointProjection", ctx as unknown as ExtensionContext);
    assert.ok(!("contextCheckpointProjection" in readGlobal()), "off is the default — the key is removed");
  } finally {
    restoreGlobal();
  }
});

test("T4: select editor — carryover writes clear/resume, pause removes the key (v0.34.25)", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "clear — also drop the stale queue and dismiss the held loop";
    await handleSettingChoice("carryover", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().carryover, "clear");

    ctx.ui.selectImpl = async () => "resume — legacy silent stacking, no summary";
    await handleSettingChoice("carryover", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().carryover, "resume");

    ctx.ui.selectImpl = async () => "pause — one summary; archive the stale goal, keep the list + held loop (default)";
    await handleSettingChoice("carryover", ctx as unknown as ExtensionContext);
    assert.ok(!("carryover" in readGlobal()), "pause is the default — the key is removed (tri-state)");
  } finally {
    restoreGlobal();
  }
});

test("T4: select options stay concise — rationale lives in the title, not the option rows (v0.34.25)", async () => {
  const ctx = makeMockCtx(tmpCwd());
  for (const id of ["autoResume", "carryover", "aggressiveMode", "decisionPopup", "autoAcceptDrafts", "auditorInspection", "contextCheckpointProjection"]) {
    let seen: string[] = [];
    ctx.ui.selectImpl = async (_t, options) => { seen = options ?? []; return undefined; };
    await handleSettingChoice(id, ctx as unknown as ExtensionContext);
    assert.ok(seen.length >= 2, `${id} offers a select`);
    for (const o of seen) {
      assert.ok(o.length <= 100, `${id} option is menu noise (${o.length} chars): ${o.slice(0, 70)}…`);
    }
  }
});

test("a project subagent pin shadows only its own role, not every global pin", () => {
  // v0.39.45 (audit 2026-10-22): the per-role PIN maps replaced the global
  // map wholesale, so a project that pinned one role made every other
  // role's global pin inert in that project.
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({
      subagentModelOverrides: { reviewer: "project/reviewer-model" },
    }));
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      subagentModelOverrides: { reviewer: "global/reviewer-model", scout: "global/scout-model" },
      subagentThinkingOverrides: { reviewer: "high", scout: "low" },
    }));
    const settings = loadSettings(cwd);
    assert.equal(settings.subagentModelOverrides?.reviewer, "project/reviewer-model", "the project role wins");
    assert.equal(settings.subagentModelOverrides?.scout, "global/scout-model", "other global roles survive");
    assert.equal(settings.subagentThinkingOverrides?.reviewer, "high", "the global thinking pin survives");
    assert.equal(settings.subagentThinkingOverrides?.scout, "low");
  } finally {
    restoreGlobal();
  }
});

test("a dead project pin entry falls through to the live global role", () => {
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({
      subagentModelOverrides: { reviewer: "   " },
      subagentThinkingOverrides: { reviewer: "not-a-level" },
    }));
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      subagentModelOverrides: { reviewer: "global/reviewer-model" },
      subagentThinkingOverrides: { reviewer: "medium" },
    }));
    const settings = loadSettings(cwd);
    assert.equal(settings.subagentModelOverrides?.reviewer, "global/reviewer-model");
    assert.equal(settings.subagentThinkingOverrides?.reviewer, "medium");
  } finally {
    restoreGlobal();
  }
});

test("main recovery settings are global-only and project copies cannot create a UI/runtime mismatch", () => {
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({
      mainModelFallbacks: ["project/backup"],
      mainModelRetryMinutes: 99,
      mainModelFailback: "sticky",
      mainModelPrimaryProbeMinutes: 9,
      hourlyRetryProbe: false,
    }));
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      mainModelFallbacks: ["global/backup"],
      mainModelRetryMinutes: 22,
      mainModelFailback: "auto",
      mainModelPrimaryProbeMinutes: 17,
      hourlyRetryProbe: true,
    }));
    const settings = loadSettings(cwd);
    assert.deepEqual(settings.mainModelFallbacks, ["global/backup"]);
    saveSettings("project", cwd, { notifyCmd: "notify-send" });
    const projectAfterUnrelatedSave = JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8"));
    assert.equal(projectAfterUnrelatedSave.mainModelFallbacks, undefined);
    assert.equal(projectAfterUnrelatedSave.mainModelRetryMinutes, undefined);
    assert.equal(projectAfterUnrelatedSave.mainModelFailback, undefined);
    assert.equal(projectAfterUnrelatedSave.mainModelPrimaryProbeMinutes, undefined);
    assert.equal(projectAfterUnrelatedSave.hourlyRetryProbe, undefined);
    assert.equal(settings.mainModelRetryMinutes, 22);
    assert.equal(settings.mainModelFailback, "auto");
    assert.equal(settings.mainModelPrimaryProbeMinutes, 17);
    assert.equal(settings.hourlyRetryProbe, true);
    const prov = settingsProvenance(cwd);
    assert.equal(prov.mainModelFallbacks?.source, "global");
    assert.equal(prov.mainModelRetryMinutes?.source, "global");
    assert.equal(prov.mainModelFailback?.source, "global");
    assert.equal(prov.mainModelPrimaryProbeMinutes?.source, "global");
    assert.equal(prov.hourlyRetryProbe?.source, "global");
  } finally {
    restoreGlobal();
  }
});

test("scope-aware settings editing updates a project override instead of a hidden global baseline", async () => {
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ auditCap: 3 }));
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ auditCap: 9 }));
    const ctx = makeMockCtx(cwd);
    ctx.ui.inputImpl = async () => "7";
    await handleSettingChoice("auditCap", ctx as unknown as ExtensionContext);

    assert.equal(loadSettings(cwd).auditCap, 7, "the edited project value is effective immediately");
    assert.equal(JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8")).auditCap, 7);
    assert.equal(readGlobal().auditCap, 9, "the global baseline remains unchanged");

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("auditCap", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(cwd).auditCap, 9, "clearing the project override reveals the global baseline");
    assert.equal(JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8")).auditCap, undefined);
  } finally {
    restoreGlobal();
  }
});

test("forbidden-model editing excludes drafter and auditor fallback chains", async () => {
  try {
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      forbiddenModels: [],
      drafterModelFallbacks: ["provider/drafter-backup"],
      auditorModelFallbacks: ["provider/auditor-backup"],
    }));
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.customStubMode = true;
    ctx.ui.inputImpl = async () => "provider/drafter-backup,provider/new,provider/auditor-backup";
    await handleSettingChoice("forbiddenModels", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().forbiddenModels, ["provider/new"], "all configured fallback roles stay mutually exclusive");
    assert.ok(ctx.ui.matching("policy excludes").length >= 1);
  } finally {
    restoreGlobal();
  }
});

test("a subagent pin edit writes only its own role into the owning layer", async () => {
  // v0.39.45 (audit 2026-10-22): the pin editor used to save the EFFECTIVE
  // map (global merged with project) back into one layer, which cloned
  // every global pin into the project file and shadowed other roles.
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({
      subagentModelOverrides: { reviewer: "project/reviewer-model" },
    }));
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      subagentModelOverrides: { reviewer: "global/reviewer-model", scout: "global/scout-model" },
    }));
    const ctx = makeMockCtx(cwd) as any;
    const scout = { provider: "openai", id: "new-scout", reasoning: true };
    ctx.modelRegistry = {
      find: (provider: string, id: string) => (provider === "openai" && id === "new-scout" ? scout : undefined),
      getAvailable: () => [scout],
      hasConfiguredAuth: () => true,
    };
    ctx.ui.customImpl = async () => ({ kind: "model", ref: "openai/new-scout" });
    await handleSettingChoice("subagentModelOverrides.scout", ctx as unknown as ExtensionContext);

    const globalAfter = JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf8"));
    assert.equal(globalAfter.subagentModelOverrides.scout, "openai/new-scout", "the edited role lands in the global layer");
    assert.equal(globalAfter.subagentModelOverrides.reviewer, "global/reviewer-model", "other global roles are untouched");
    const projectAfter = JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8"));
    assert.equal(projectAfter.subagentModelOverrides.reviewer, "project/reviewer-model", "the project layer keeps its own role");
    assert.equal(projectAfter.subagentModelOverrides.scout, undefined, "the global pin is not cloned into the project layer");
  } finally {
    restoreGlobal();
  }
});

test("the auditor fallback editor excludes the EFFECTIVE primary, not the global one", async () => {
  // v0.39.45 (audit 2026-10-22): the editor computed the primary from the
  // global layer while the runtime resolves the project-aware one, so a
  // project-owned primary could be saved as a backup and was then dropped
  // at runtime.
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ auditorModel: "project/auditor" }));
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      auditorModel: "global/auditor",
      auditorModelFallbacks: ["global/backup", "project/auditor"],
    }));
    const ctx = makeMockCtx(cwd) as any;
    const projectAuditor = { provider: "project", id: "auditor", reasoning: true };
    const globalBackup = { provider: "global", id: "backup", reasoning: true };
    ctx.modelRegistry = {
      find: (provider: string, id: string) => (provider === "project" && id === "auditor" ? projectAuditor : provider === "global" && id === "backup" ? globalBackup : undefined),
      getAvailable: () => [projectAuditor, globalBackup],
      hasConfiguredAuth: () => true,
    };
    ctx.ui.customStubMode = true;
    ctx.ui.inputImpl = async () => "global/backup,project/auditor";
    await handleSettingChoice("auditorModelFallbacks", ctx as unknown as ExtensionContext);
    const saved = readGlobal().auditorModelFallbacks as string[];
    assert.ok(saved.includes("global/backup"), "the real backup is kept");
    assert.ok(!saved.includes("project/auditor"), "the effective (project) primary is not offered as its own backup");
  } finally {
    restoreGlobal();
  }
});

test("forbidden-model editing also protects the pinned role primaries and dedupes case-insensitively", async () => {
  // v0.39.45 (audit 2026-10-22): a forbidden pattern that matches a pinned
  // auditor/drafter/designer model silently voids that pin at runtime, so
  // the editor must not offer it. The selection also deduplicates
  // case-insensitively now — the forbidden gate matches that way.
  try {
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({
      forbiddenModels: [],
      drafterModel: "provider/drafter-primary",
      auditorModel: "provider/auditor-primary",
      designerModel: "provider/designer-primary",
    }));
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.customStubMode = true;
    ctx.ui.inputImpl = async () => "provider/drafter-primary,provider/auditor-primary,provider/designer-primary,Provider/New,Sonnet,sonnet";
    await handleSettingChoice("forbiddenModels", ctx as unknown as ExtensionContext);
    const saved = readGlobal().forbiddenModels as string[];
    assert.ok(!saved.includes("provider/drafter-primary"), "a pinned drafter primary cannot be forbidden");
    assert.ok(!saved.includes("provider/auditor-primary"), "a pinned auditor primary cannot be forbidden");
    assert.ok(!saved.includes("provider/designer-primary"), "a pinned designer primary cannot be forbidden");
    assert.deepEqual(saved.filter(ref => ref.toLowerCase() === "sonnet"), ["Sonnet"], "case variants collapse to one row");
    assert.ok(saved.includes("Provider/New"), "an unrelated pattern is still saved");
  } finally {
    restoreGlobal();
  }
});

test("numeric settings reject malformed integer prefixes instead of truncating them", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "15minutes";
    await handleSettingChoice("mainModelRetryMinutes", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().mainModelRetryMinutes, undefined);
    assert.ok(ctx.ui.matching("must be a positive integer").length >= 1);
  } finally {
    restoreGlobal();
  }
});

test("RPC custom stub falls back to typed main-backup editing instead of silently canceling", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.customStubMode = true;
    ctx.ui.inputImpl = async () => "rpc/backup-a, rpc/backup-b";
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().mainModelFallbacks, ["rpc/backup-a", "rpc/backup-b"]);
  } finally {
    restoreGlobal();
  }
});

test("main failback policy and primary-probe cadence are global settings", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "sticky — stay on the fallback until a manual model selection";
    await handleSettingChoice("mainModelFailback", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().mainModelFailback, "sticky");

    ctx.ui.inputImpl = async () => "7";
    await handleSettingChoice("mainModelPrimaryProbeMinutes", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().mainModelPrimaryProbeMinutes, 7);
  } finally {
    restoreGlobal();
  }
});

test("T4: input editor — main model backups preserve order and retry cadence", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async (title) => title.startsWith("Main agent fallback models") ? "openai/gpt-5, minimax/MiniMax-M2" : "15";
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().mainModelFallbacks, ["openai/gpt-5", "minimax/MiniMax-M2"]);

    await handleSettingChoice("mainModelRetryMinutes", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().mainModelRetryMinutes, 15);

    ctx.ui.inputImpl = async () => "   ";
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().mainModelFallbacks, undefined, "empty input unsets backups");
  } finally {
    restoreGlobal();
  }
});

test("main backup editor refuses the 11th typed model and keeps the first ten in order", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    const refs = Array.from({ length: 11 }, (_, i) => `provider/model-${i + 1}`);
    ctx.ui.inputImpl = async (title) => title.startsWith("Main agent fallback models") ? refs.join(",") : undefined;
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().mainModelFallbacks, refs.slice(0, 10));
    assert.ok(ctx.ui.matching("first 10 fallback agents").length >= 1, "the refused 11th selection is visible");
  } finally {
    restoreGlobal();
  }
});

test("main-model fallback reload preserves explicit order and does not reintroduce a cleared key", async () => {
  try {
    const cwd = tmpCwd();
    const refs = ["persisted/first", "persisted/second"];
    const ctx = makeMockCtx(cwd);
    ctx.ui.inputImpl = async (title) => title.startsWith("Main agent fallback models") ? refs.join(",") : undefined;
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(cwd).mainModelFallbacks, refs, "explicitly selected order is persisted");
    assert.deepEqual(loadSettings(cwd).mainModelFallbacks, refs, "explicit order survives reload");

    ctx.ui.inputImpl = async () => "   ";
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.equal("mainModelFallbacks" in readGlobal(), false, "clearing removes the persisted key");
    assert.deepEqual(loadSettings(cwd).mainModelFallbacks, [], "reload uses the empty default");
    assert.equal("mainModelFallbacks" in readGlobal(), false, "reload does not reintroduce the absent key");
  } finally {
    restoreGlobal();
  }
});

test("v0.34.118: backup and forbidden editors enforce mutual exclusion even in headless input mode", async () => {
  try {
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ forbiddenModels: ["sonnet"] }, null, 2));
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async (title) => title.startsWith("Main agent fallback models")
      ? "openrouter/anthropic/claude-sonnet-4.5,good/provider"
      : "good/provider,other/provider";
    await handleSettingChoice("mainModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().mainModelFallbacks, ["good/provider"], "forbidden refs cannot enter a backup chain");

    await handleSettingChoice("forbiddenModels", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().forbiddenModels, ["other/provider"], "backup refs cannot enter forbiddenModels");
  } finally {
    restoreGlobal();
  }
});

test("T4: input editor — auditorModel pin / explicit session on empty", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "openai/gpt-5";
    await handleSettingChoice("auditorModel", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorModel, "openai/gpt-5");

    ctx.ui.inputImpl = async () => "   ";
    await handleSettingChoice("auditorModel", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(ctx.cwd).auditorModel, null, "empty input explicitly inherits the session instead of exposing a lower-layer pin");
    assert.equal(loadSettings(ctx.cwd).auditorThinkingLevel, undefined);
    assert.equal(readGlobal().auditorModel, "openai/gpt-5", "the global pin still serves other projects");
  } finally {
    restoreGlobal();
  }
});

// Absence inherits a lower settings layer; explicit session must instead
// mask its model AND dial without mutating that layer or losing backups.
for (const scenario of [
  { name: "both project overrides", project: { auditorModel: "audit/project", auditorThinkingLevel: "medium" } },
  { name: "project model plus global thinking", project: { auditorModel: "audit/project" } },
  { name: "project thinking plus global model", project: { auditorThinkingLevel: "medium" } },
  { name: "only global pins", project: {} },
]) test(`auditor session selection masks ${scenario.name} and preserves other projects and backups`, async () => {
  try {
    const cwd = tmpCwd();
    const otherProject = tmpCwd();
    const session = { provider: "live", id: "current", reasoning: true, thinkingLevelMap: { max: "max" } };
    const backups = ["audit/backup1", "audit/backup2"];
    const models = [session, ...["global", "project", "backup1", "backup2", "global-backup"].map(id => ({ provider: "audit", id, reasoning: true }))];
    const ctx = Object.assign(makeMockCtx(cwd), {
      model: session, thinkingLevel: "max",
      modelRegistry: {
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
        find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      },
    });
    const hostCtx = ctx as unknown as ExtensionContext;
    const global = { auditorModel: "audit/global", auditorThinkingLevel: "low", auditorModelFallbacks: backups, autoAcceptDrafts: false, mainModelSameModelRetries: 3 };
    fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify(global, null, 2));
    const globalBytes = fs.readFileSync(GLOBAL_FILE, "utf8");
    const project = { ...scenario.project, subagentFallbacks: { scout: ["audit/project"] }, progressEvery: 7 };
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify(project));
    ctx.ui.customStubMode = true;
    ctx.ui.customImpl = async () => ({ kind: "session" });
    await handleSettingChoice("auditorModel", hostCtx);

    assert.equal(fs.readFileSync(GLOBAL_FILE, "utf8"), globalBytes, "global settings are byte-for-byte unchanged");
    const persisted = JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8"));
    const { auditorThinkingLevel: _removed, ...expectedProject } = project as Record<string, unknown>;
    assert.deepEqual(persisted, { ...expectedProject, auditorModel: null }, "only the project model/thinking selection changes");
    const settings = loadSettings(cwd);
    assert.equal(settings.auditorModel, null);
    assert.equal(settings.auditorThinkingLevel, undefined);
    const journal = path.join(cwd, ".pi-glla", "active.jsonl");
    const entries: Array<{ type: string; value?: { key?: string } }> = fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    assert.ok(!entries.some(entry => entry.type === "settings_invalid_ignored" && entry.value?.key === "auditorThinkingLevel"), "an intentionally shadowed valid dial is not junk");
    assert.deepEqual(settings.auditorModelFallbacks, backups);
    const resolved = resolveAuditorModel(hostCtx, settings.auditorModel, settings.auditorModelFallbacks);
    assert.equal(resolved.model, session);
    assert.equal(resolved.via, "session");
    assert.equal(resolveCandidateThinkingLevel(resolved, { auditorThinkingLevel: settings.auditorThinkingLevel, sessionThinkingLevel: ctx.thinkingLevel }), "max");
    assert.deepEqual(resolved.fallbackModels?.map(candidate => candidate.ref), backups);
    const row = buildSettingsRows(settings, settingsProvenance(cwd), {
      sessionModel: "live/current", sessionThinkingLevel: ctx.thinkingLevel,
    }).find(row => row.id === "auditorModel");
    assert.ok(row, "auditor model row exists");
    assert.ok(row.valueText.includes("live/current"), "menu names the live session model, not the backup chain");
    assert.ok(row.valueText.includes("max"), "menu shows the effective session dial");
    assert.equal(loadSettings(otherProject).auditorModel, "audit/global");
    assert.equal(loadSettings(otherProject).auditorThinkingLevel, "low");
    assert.deepEqual(loadSettings(otherProject).auditorModelFallbacks, global.auditorModelFallbacks);

    // It is a live choice, not a pin to whatever ref/dial was current on save.
    const replacement = { ...session, id: "replacement" };
    Object.assign(ctx, { model: replacement, thinkingLevel: "medium" });
    const later = resolveAuditorModel(hostCtx, loadSettings(cwd).auditorModel, settings.auditorModelFallbacks);
    assert.equal(later.model, replacement);
    assert.equal(resolveCandidateThinkingLevel(later, { sessionThinkingLevel: ctx.thinkingLevel }), "medium");

    // A subsequent explicit pin replaces the tombstone in the same project.
    ctx.ui.customImpl = async () => ({ kind: "model", ref: "audit/project" });
    ctx.ui.selectImpl = async () => "high";
    await handleSettingChoice("auditorModel", hostCtx);
    assert.equal(loadSettings(cwd).auditorModel, "audit/project");
    assert.equal(loadSettings(cwd).auditorThinkingLevel, "high");
    assert.equal(fs.readFileSync(GLOBAL_FILE, "utf8"), globalBytes);
    assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, backups);
  } finally { restoreGlobal(); }
});

test("v0.36.0: auditor fallback editor preserves ordered refs, caps at ten, and clears", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.customStubMode = true;
    const refs = Array.from({ length: 11 }, (_, i) => `provider/auditor-${i + 1}`);
    ctx.ui.inputImpl = async (title) => title.startsWith("Auditor fallback models") ? refs.join(",") : undefined;
    await handleSettingChoice("auditorModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal().auditorModelFallbacks, refs.slice(0, 10));
    assert.ok(ctx.ui.matching("first 10 fallback agents").length >= 1, "the refused 11th selection is visible");

    ctx.ui.inputImpl = async () => "   ";
    await handleSettingChoice("auditorModelFallbacks", ctx as unknown as ExtensionContext);
    assert.equal("auditorModelFallbacks" in readGlobal(), false, "clearing removes the persisted chain");
    assert.deepEqual(loadSettings(tmpCwd()).auditorModelFallbacks, [], "reload keeps the empty default");
  } finally {
    restoreGlobal();
  }
});

test("v0.36.0: the singular auditor fallback setting migrates to the ordered chain", () => {
  try {
    const cwd = tmpCwd();
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ auditorModelFallback: "legacy/auditor" }));
    assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, ["legacy/auditor"]);
    assert.equal(settingsProvenance(cwd).auditorModelFallbacks?.source, "global");

    saveSettings("global", cwd, { auditorModelFallbacks: ["new/first", "new/second"] });
    const saved = readGlobal();
    assert.deepEqual(saved.auditorModelFallbacks, ["new/first", "new/second"]);
    assert.equal("auditorModelFallback" in saved, false, "the compatibility alias is removed on the next save");
  } finally {
    restoreGlobal();
  }
});

test("choosing session inherits both role settings without a separate thinking prompt", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "glla-session-pair-editor-"));
  try {
    for (const role of ["designer", "drafter", "auditor"]) {
      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ [`${role}Model`]: "test/selected", [`${role}ThinkingLevel`]: "low", ...(role === "designer" ? { designerEnabled: true } : {}) }));
      const ctx = makeMockCtx(tmpCwd()) as any;
      ctx.model = { provider: "test", id: "session", reasoning: true, thinkingLevelMap: { max: "max" } };
      ctx.thinkingLevel = "max";
      ctx.modelRegistry = {
        getAvailable: () => [ctx.model], find: () => ctx.model, hasConfiguredAuth: () => true,
      };
      ctx.ui.customImpl = async () => ({ kind: "session" });
      ctx.ui.selectImpl = async () => { throw new Error("session inherits its thinking without another choice"); };
      await handleSettingChoice(`${role}Model`, ctx as ExtensionContext);
      if (role === "auditor") {
        const effective = loadSettings(ctx.cwd);
        assert.equal(effective.auditorModel, null, "explicit session masks the global model");
        assert.equal(effective.auditorThinkingLevel, undefined);
        assert.equal(readGlobal().auditorModel, "test/selected", "other projects keep their pin");
        assert.equal(readGlobal().auditorThinkingLevel, "low");
      } else {
        assert.equal(readGlobal()[`${role}Model`], undefined, role);
        assert.equal(readGlobal()[`${role}ThinkingLevel`], undefined, role);
      }
      assert.ok(ctx.ui.matching("session model and thinking inherited together").length > 0, role);
      if (role === "designer") {
        const file = path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "Designer.md");
        assert.match(fs.readFileSync(file, "utf8"), /^thinking: max$/m);
        ctx.thinkingLevel = "off";
        await handleSettingChoice("designerModel", ctx as ExtensionContext);
        assert.match(fs.readFileSync(file, "utf8"), /^thinking: off$/m);
      }
    }
  } finally {
    restoreGlobal();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("drafter agent picker immediately offers model-specific thinking and persists both choices", async () => {
  try {
    restoreGlobal();
    const ctx = makeMockCtx(tmpCwd()) as any;
    const session = { provider: "anthropic", id: "session", reasoning: true };
    const drafter = {
      provider: "openai",
      id: "drafter",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    ctx.model = session;
    ctx.thinkingLevel = "high";
    ctx.modelRegistry = {
      find(provider: string, id: string) {
        return provider === "openai" && id === "drafter" ? drafter : provider === "anthropic" && id === "session" ? session : undefined;
      },
      getAvailable() { return [session, drafter]; },
      hasConfiguredAuth() { return true; },
    };
    ctx.ui.customImpl = async () => ({ kind: "model", ref: "openai/drafter" });
    ctx.ui.selectImpl = async (title: string) => title.startsWith("Drafter thinking") ? "medium — ~8k tokens" : undefined;

    await handleSettingChoice("drafterModel", ctx as ExtensionContext);

    const saved = readGlobal();
    assert.equal(saved.drafterModel, "openai/drafter");
    assert.equal(saved.drafterThinkingLevel, "medium");
    assert.ok(ctx.ui.matching("Drafter agent").length >= 1);

    // Thinking is chosen WITH the model — re-picking the model with "session — inherit"
    // clears the explicit thinking level (no standalone row needed).
    ctx.ui.customImpl = async () => ({ kind: "model", ref: "openai/drafter" });
    ctx.ui.selectImpl = async (title: string) => title.startsWith("Drafter thinking")
      ? "session — inherit current session level (default) (current)"
      : undefined;
    await handleSettingChoice("drafterModel", ctx as ExtensionContext);
    assert.equal("drafterThinkingLevel" in readGlobal(), false, "the model pick can restore session-level inheritance");
  } finally {
    restoreGlobal();
  }
});

test("Designer tab: model picker persists dedicated model+thinking and registers Designer.md; disabling unregisters it", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-designer-editor-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    restoreGlobal();
    const ctx = makeMockCtx(tmpCwd()) as any;
    const session = { provider: "anthropic", id: "session", reasoning: true };
    const designer = {
      provider: "openai",
      id: "designer",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    ctx.model = session;
    ctx.thinkingLevel = "high";
    ctx.modelRegistry = {
      find(provider: string, id: string) {
        return provider === "openai" && id === "designer" ? designer : provider === "anthropic" && id === "session" ? session : undefined;
      },
      getAvailable() { return [session, designer]; },
      hasConfiguredAuth() { return true; },
    };
    ctx.ui.customImpl = async () => ({ kind: "model", ref: "openai/designer" });
    ctx.ui.selectImpl = async (title: string) => title.startsWith("Designer thinking") ? "medium — ~8k tokens" : undefined;
    await handleSettingChoice("designerModel", ctx as ExtensionContext);
    const saved = readGlobal();
    assert.equal(saved.designerModel, "openai/designer");
    assert.equal(saved.designerThinkingLevel, "medium");
    const designerFile = path.join(agentDir, "agents", "Designer.md");
    assert.ok(fs.existsSync(designerFile), "picking a Designer agent registers Designer.md immediately");
    const content = fs.readFileSync(designerFile, "utf-8");
    assert.match(content, /^model: openai\/designer$/m);
    assert.match(content, /^thinking: medium$/m);

    ctx.ui.selectImpl = async (title: string) => title.startsWith("Designer enabled") ? "off — never register Designer (model picks are kept)" : undefined;
    await handleSettingChoice("designerEnabled", ctx as ExtensionContext);
    assert.equal(readGlobal().designerEnabled, false);
    assert.equal(readGlobal().designerModel, "openai/designer", "disabling keeps the model pick");
    assert.ok(!fs.existsSync(designerFile), "disabling unregisters Designer.md");

    ctx.ui.selectImpl = async (title: string) => title.startsWith("Designer enabled") ? "on-demand — register when a goal/list item/task asks for Designer" : undefined;
    await handleSettingChoice("designerEnabled", ctx as ExtensionContext);
    assert.ok(!("designerEnabled" in readGlobal()), "on-demand restores the tri-state default");
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    restoreGlobal();
  }
});

test("T4: input editor validation — auditCap rejects garbage loudly, accepts integers, clears on empty", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "7";
    await handleSettingChoice("auditCap", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditCap, 7);

    ctx.ui.inputImpl = async () => "abc";
    await handleSettingChoice("auditCap", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditCap, 7, "invalid input leaves the saved value untouched");
    assert.ok(ctx.ui.matching("not a non-negative integer").length >= 1, "validation failure is loud");

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("auditCap", ctx as unknown as ExtensionContext);
    assert.ok(!("auditCap" in readGlobal()), "empty input restores the default");
  } finally {
    restoreGlobal();
  }
});

test("v0.35.64: subagent hang action accepts warning-only/long thresholds and rejects unsafe values", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "0";
    await handleSettingChoice("subagentHangEscalationMinutes", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().subagentHangEscalationMinutes, 0);

    ctx.ui.inputImpl = async () => "4";
    await handleSettingChoice("subagentHangEscalationMinutes", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().subagentHangEscalationMinutes, 0, "unsafe short action threshold is rejected");
    assert.ok(ctx.ui.matching("must be 0 or an integer >= 5").length >= 1);

    ctx.ui.inputImpl = async () => "30";
    await handleSettingChoice("subagentHangEscalationMinutes", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().subagentHangEscalationMinutes, 30);

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("subagentHangEscalationMinutes", ctx as unknown as ExtensionContext);
    assert.ok(!("subagentHangEscalationMinutes" in readGlobal()), "empty input restores the default");
    assert.equal(loadSettings(tmpCwd()).subagentHangEscalationMinutes, 30);
  } finally {
    restoreGlobal();
  }
});

test("v0.35.x: zero-stream retry budget persists and rejects values outside 0..10", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "4";
    await handleSettingChoice("zombieRetryMaxAttempts", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().zombieRetryMaxAttempts, 4);

    ctx.ui.inputImpl = async () => "11";
    await handleSettingChoice("zombieRetryMaxAttempts", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().zombieRetryMaxAttempts, 4, "values above the safety cap are rejected");
    assert.ok(ctx.ui.matching("must be an integer from 0 to 10").length >= 1);

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("zombieRetryMaxAttempts", ctx as unknown as ExtensionContext);
    assert.ok(!("zombieRetryMaxAttempts" in readGlobal()), "empty input restores the default");
    assert.equal(loadSettings(tmpCwd()).zombieRetryMaxAttempts, 3);
  } finally {
    restoreGlobal();
  }
});

test("v0.39.38: stuckMaxInterventions editor accepts 0 with documented meaning, matching the file loader", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "0";
    await handleSettingChoice("stuckMaxInterventions", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().stuckMaxInterventions, 0, "0 persists from the editor, like its siblings");
    assert.equal(loadSettings(tmpCwd()).stuckMaxInterventions, 0, "file-loaded 0 survives normalization (editor/file parity)");

    ctx.ui.inputImpl = async () => "-1";
    await handleSettingChoice("stuckMaxInterventions", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().stuckMaxInterventions, 0, "negatives are still rejected");
    assert.ok(ctx.ui.matching("not a non-negative integer").length >= 1);

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("stuckMaxInterventions", ctx as unknown as ExtensionContext);
    assert.ok(!("stuckMaxInterventions" in readGlobal()), "empty input restores the default");
  } finally {
    restoreGlobal();
  }
});
test("v0.35.x: hand-edited zero-stream retry budgets normalize to the safe default", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
  fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ zombieRetryMaxAttempts: 99 }));
  assert.equal(loadSettings(cwd).zombieRetryMaxAttempts, 3);
  fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ zombieRetryMaxAttempts: -1 }));
  assert.equal(loadSettings(cwd).zombieRetryMaxAttempts, 3);
});

test("T4: a dismissed editor (Esc → undefined) writes NOTHING", async () => {
  try {
    restoreGlobal(); // known-clean baseline
    const before = readGlobal();
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => undefined; // user pressed Esc
    await handleSettingChoice("autoResume", ctx as unknown as ExtensionContext);
    await handleSettingChoice("aggressiveMode", ctx as unknown as ExtensionContext);
    ctx.ui.inputImpl = async () => undefined;
    await handleSettingChoice("auditorModel", ctx as unknown as ExtensionContext);
    assert.deepEqual(readGlobal(), before, "no key written by a dismissed editor");
  } finally {
    restoreGlobal();
  }
});

test("settings editor failures notify loudly and return to the menu", () => {
  const menu = GOAL_SRC.slice(
    GOAL_SRC.indexOf("async function openSettingsUI"),
    GOAL_SRC.indexOf("async function promptSettingsMenu"),
  );
  assert.match(menu, /catch \(err\)/, "the menu catches editor failures");
  assert.match(menu, /glla setting .* NOT saved/, "failed writes are announced");
  assert.match(menu, /ctx\.ui\.notify\([\s\S]*?"warning"/, "the notification is a warning");
  assert.doesNotMatch(menu, /catch \{\s*return;/, "an editor failure must not silently exit the whole menu");
});

test("T4: the switch has no confirm-class editors (select + input only)", () => {
  const sw = GOAL_SRC.slice(GOAL_SRC.indexOf("export async function handleSettingChoice"));
  const switchBody = sw.slice(0, sw.indexOf("\n}\n"));
  assert.equal((switchBody.match(/ctx\.ui\.confirm/g) ?? []).length, 0, "a new confirm-class editor appeared — extend these tests");
});

test("v0.28.34: notify folds a default IN — auto-detect notify-send/osascript, 'off' silences, custom overrides", () => {
  const SRC = readGoalRuntimeSource();
const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  // resolution order: explicit off → custom → auto-probe:
  assert.match(SRC, /if \(settings\.notifyCmd === "off" \|\| !extensionApi\) return;/);
  assert.match(SRC, /const cmd = settings\.notifyCmd \?\? autoNotifyCmd;/);
  assert.match(CMDS, /command -v notify-send \|\| command -v osascript/); // decomposition step 2: probe moved
  assert.match(CMDS, /autoNotifyCmd = `notify-send "pi-goal-list-loop-audit" "\$1"`;/);
  assert.match(CMDS, /GLLA_MSG="\$1" osascript/);
  // pushes stay actionable-only (no per-turn site exists):
  assert.match(CMDS, /Pushes fire only where there is something to DO/); // decomposition step 2
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /unset = auto-detect notify-send\/osascript · 'off' = silent/);
});

test("audit-2026-09-06: headless /glla fallback shows compactor + display-richness rows", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(src, /fmt\("compactorModel", "compactorModel"\)/, "compactorModel row present");
  assert.match(src, /compactorModelFallbacks: \$\{formatMainModelFallbacks/, "compactor fallbacks row present");
  assert.match(src, /fmt\("subagentDisplayRichness", "subagentDisplayRichness"\)/, "display richness row present");
});

test("audit 2026-09-06: docs/SETTINGS.md covers every SETTINGS_KEYS entry", async () => {
  const { SETTINGS_KEYS } = await import("../extensions/goal-settings.ts");
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "SETTINGS.md"), "utf-8");
  const missing = (SETTINGS_KEYS as string[]).filter((key) => !doc.includes(`\`${key}\``));
  assert.deepEqual(missing, [], `settings reference drift: ${missing.join(", ")}`);
});

test("audit 2026-09-07 (LOW, finding 400): typing the displayed `auto` in the notify editor round-trips to unset, not a literal shell command", async () => {
  for (const typed of ["auto", "auto-detect", "DEFAULT", "  "]) {
    const cwd = tmpCwd();
    const ctx = makeMockCtx(cwd);
    ctx.ui.inputImpl = async () => typed;
    await handleSettingChoice("notifyCmd", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(cwd).notifyCmd, undefined, `typing ${JSON.stringify(typed)} restores auto-detect`);
  }
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd);
  ctx.ui.inputImpl = async () => "my-notify $1";
  await handleSettingChoice("notifyCmd", ctx as unknown as ExtensionContext);
  assert.equal(loadSettings(cwd).notifyCmd, "my-notify $1", "a real command still saves");
});

test("audit 2026-09-25: decisionPauseBudget is visible on every operator surface", async () => {
  const { SETTINGS_KEYS } = await import("../extensions/goal-settings.ts");
  assert.ok((SETTINGS_KEYS as string[]).includes("decisionPauseBudget"), "provenance-tracked keys include the budget");
  const { buildSettingsRows } = await import("../extensions/settings-menu.ts");
  const rows = buildSettingsRows({} as never, {});
  assert.ok(rows.some((r) => r.id === "decisionPauseBudget"), "the interactive menu renders a budget row");
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(src, /fmt\("decisionPauseBudget", "decisionPauseBudget"\)/, "headless /glla list shows the budget row");
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ decisionPauseBudget: 2 }));
    assert.equal(settingsProvenance(cwd).decisionPauseBudget?.source, "project", "a JSON-set budget reports its source");
    assert.equal(settingsProvenance(cwd).decisionPauseBudget?.value, 2, "a JSON-set budget reports its value");
    assert.equal(loadSettings(cwd).decisionPauseBudget, 2, "the JSON-set budget is effective");

    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "3";
    await handleSettingChoice("decisionPauseBudget", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().decisionPauseBudget, 3, "the editor saves integers");

    ctx.ui.inputImpl = async () => "abc";
    await handleSettingChoice("decisionPauseBudget", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().decisionPauseBudget, 3, "invalid input leaves the saved value untouched");

    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("decisionPauseBudget", ctx as unknown as ExtensionContext);
    assert.ok(!("decisionPauseBudget" in readGlobal()), "empty input restores the default");
  } finally {
    restoreGlobal();
  }
});

test("audit 2026-09-26: subagent thinking editor pins, inherits, and rejects garbage", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.selectImpl = async () => "high — ";
    await handleSettingChoice("subagentThinkingOverrides.Designer", ctx as unknown as ExtensionContext);
    // Designer parity: the legacy per-type pin is migrated into the dedicated
    // key on save — the generic map no longer carries a Designer entry.
    assert.equal((readGlobal() as { designerThinkingLevel?: string }).designerThinkingLevel, "high", "the Designer thinking pin migrates to the dedicated key");
    assert.ok(!("subagentThinkingOverrides" in readGlobal()), "the legacy map is stripped of Designer on save");

    ctx.ui.selectImpl = async () => "ultra — ";
    await handleSettingChoice("subagentThinkingOverrides.scout", ctx as unknown as ExtensionContext);
    assert.ok(!("subagentThinkingOverrides" in readGlobal()), "garbage leaves storage untouched");
    assert.ok(ctx.ui.matching("not a thinking level").length >= 1, "validation failure is loud");

    ctx.ui.selectImpl = async () => "low — ";
    await handleSettingChoice("subagentThinkingOverrides.Nope", ctx as unknown as ExtensionContext);
    assert.ok(!("subagentThinkingOverrides" in readGlobal()), "unknown agent types never save");
  } finally {
    restoreGlobal();
  }
});

test("audit 2026-09-26: headless /glla fallback covers every SETTINGS_KEYS entry", async () => {
  // The 2026-09-26 /glla completeness review found auditorMirrorSessionExtensions
  // invisible headlessly. This gate fails on the next omission instead of the
  // next field report. Legacy `reviewer` is an alias by design (see SETTINGS_KEYS).
  const { SETTINGS_KEYS } = await import("../extensions/goal-settings.ts");
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  const headless = src.slice(src.indexOf("Headless fallback"));
  assert.ok(headless.length > 1000, "headless block anchors the review");
  const missing = (SETTINGS_KEYS as string[]).filter((key) => key !== "reviewer" && !headless.includes(key));
  assert.deepEqual(missing, [], `headless drift: ${missing.join(", ")}`);
});

test("audit 2026-10-25: every settings editor is reachable from a row in the interactive table", () => {
  // The 2026-10-25 /glla operator-surface audit found `versionDisplay` shipped
  // with a complete editor and a documented "Version indicator" row that the
  // table never rendered: the headless list showed the value and then pointed
  // the operator at an interactive session that could not reach it, so only a
  // hand-edited settings JSON could change it. The doc gate and the headless
  // gate both PASSED — nothing checked the INTERACTIVE table, and the per-key
  // row checks are written one key at a time. This gate fails on the next
  // omission instead of the next field report.
  const src = fs.readFileSync("extensions/loops/goal-settings-ui.ts", "utf-8");
  const body = src.slice(src.indexOf("export async function handleSettingChoice"));
  assert.ok(body.length > 1000, "the editor dispatcher anchors the review");
  const editorIds = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
  const rowIds = buildSettingsRows({} as never, {} as never).map((r: { id: string }) => r.id);
  const unreachable = editorIds.filter((id) => !rowIds.includes(id));
  assert.deepEqual(
    unreachable,
    [],
    `settings editors with no reachable row: ${unreachable.join(", ")} — an editor the operator cannot open is not a feature`,
  );
});

test("audit 2026-10-25: the documented 'Version indicator' row exists in the settings table", () => {
  // docs/SETTINGS.md: "Set it with **Version indicator** in `/glla` settings."
  // CHANGELOG.md v0.39.49 promised the same row.
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "SETTINGS.md"), "utf-8");
  assert.match(doc, /Set it with \*\*Version indicator\*\* in `\/glla` settings/, "the reference still promises the row");
  const rows = buildSettingsRows({} as never, {} as never);
  const row = rows.find((r: { id: string }) => r.id === "versionDisplay");
  assert.ok(row, "the settings table has a Version indicator row");
  assert.match(String(row.label), /version indicator/i, "the row is labelled the way the reference names it");
});

test("v0.38.104: the audit-dir retention row renders a legal 0 instead of the unknown-value '?'", async () => {
  const { buildSettingsRows } = await import("../extensions/settings-menu.ts");
  const rows = buildSettingsRows({ auditJobRetentionMs: 0 } as never, {} as never);
  const row = rows.find((r: { id: string }) => r.id === "auditJobRetentionMs");
  assert.ok(row, "the retention row exists");
  assert.match(String(row.valueText), /0s dead-dir window/, "0 means reap immediately and must read as a value");
  assert.doesNotMatch(String(row.valueText), /\?/, "a set 0 is never rendered as an unknown value");
});

test("v0.38.104: the main-recovery row does not promise a 24h stop the default mode removes", async () => {
  const { buildSettingsRows } = await import("../extensions/settings-menu.ts");
  const rows = buildSettingsRows({} as never, {} as never);
  const row = rows.find((r: { id: string }) => r.id === "mainModelRetryMinutes");
  assert.ok(row, "the main-recovery row exists");
  const description = String(row.description);
  assert.match(description, /24h/, "the horizon is still documented for non-aggressive mode");
  assert.match(description, /aggressive/i, "the copy must name the mode that removes the horizon");
  assert.doesNotMatch(description, /stops after 24h$/, "an unconditional 24h promise is the drift the fix removes");
});

test("v0.38.104: every 'Global-only.' annotation in docs/SETTINGS.md is true in code", async () => {
  const { GLOBAL_ONLY_KEYS } = await import("../extensions/goal-settings.ts");
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "SETTINGS.md"), "utf-8");
  const claimed = [...doc.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|[^|]*\|([^|]*)\|/gm)]
    .filter((m) => /Global-only\./.test(m[2] ?? ""))
    .map((m) => m[1]);
  assert.ok(claimed.length > 0, "the reference still documents global-only keys");
  const wrong = claimed.filter((key) => !GLOBAL_ONLY_KEYS.has(key as never));
  assert.deepEqual(wrong, [], `doc claims Global-only for keys the runtime lets a project set: ${wrong.join(", ")}`);
});

test("v0.39.38: the Global-only paragraph lists every GLOBAL_ONLY_KEYS member", async () => {
  const { GLOBAL_ONLY_KEYS } = await import("../extensions/goal-settings.ts");
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "SETTINGS.md"), "utf-8");
  // Scope to the key-list paragraph only (prose backticks like `300k` live
  // outside it) so both directions below compare keys against keys.
  const start = doc.indexOf("copies are ignored (GLLA reads the global file for these policies):");
  const end = doc.indexOf("This list is `GLOBAL_ONLY_KEYS`", start);
  assert.ok(start >= 0 && end > start, "the key-list paragraph is still present");
  const listed = [...doc.slice(start, end).matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
  const missing = [...GLOBAL_ONLY_KEYS].filter((key) => !listed.includes(key as string));
  assert.deepEqual(missing, [], `paragraph omits global-only keys: ${missing.join(", ")}`);
  const extra = [...new Set(listed)].filter((key) => !GLOBAL_ONLY_KEYS.has(key as never));
  assert.deepEqual(extra, [], `paragraph lists non-global-only keys: ${extra.join(", ")}`);
});

test("v0.38.104: the superseded DESIGN.md table does not mark files that do not exist as shipped", () => {
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "DESIGN.md"), "utf-8");
  const start = doc.indexOf("### Decision 7");
  const table = doc.slice(start, doc.indexOf("\n### ", start + 10));
  const rows = [...table.matchAll(/^\|\s*`([^`]+)`\s*\|[^|]*\|\s*shipped\s*\|/gm)].map((m) => m[1]);
  assert.ok(rows.length > 0, "the historical table still has shipped rows");
  const missing = rows.filter((rel) => !rel || !fs.existsSync(path.join(import.meta.dirname, "..", rel)));
  assert.deepEqual(missing, [], `a superseded table marks non-existent paths as shipped: ${missing.join(", ")}`);
});

test("v0.38.104: the auditor model path carries no dead settings placeholders", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "extensions", "loops", "goal-settings-ui.ts"), "utf-8");
  assert.doesNotMatch(src, /const settings2 = /, "a half-applied rename left a dead second settings layer");
  const bindings = [...src.matchAll(/^\s*const (\w+) = undefined;$/gm)].map((m) => m[1]);
  assert.deepEqual(bindings, [], `dead undefined bindings: ${bindings.join(", ")}`);
});

// v0.39.45 (audit 2026-10-22) — "session — inherit" for the auditor dial
// must clear the dial in EVERY layer. The editor wrote to one scope, so a
// pin in the other layer survived: the menu announced session inheritance
// while the runtime still applied the other layer's dial.
test("subagent thinking inherit clears both role pins and preserves other roles", async () => {
  try {
    const cwd = tmpCwd();
    const ctx = makeMockCtx(cwd);
    fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ subagentThinkingOverrides: { scout: "high", reviewer: "low" } }));
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ subagentThinkingOverrides: { scout: "low", worker: "medium" } }));
    ctx.ui.selectImpl = async () => "session — inherit current session level (default)";
    await handleSettingChoice("subagentThinkingOverrides.scout", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(cwd).subagentThinkingOverrides?.scout, undefined, "one inherit choice must not expose the global pin");
    assert.deepEqual(readGlobal().subagentThinkingOverrides, { reviewer: "low" });
    assert.deepEqual(JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8")).subagentThinkingOverrides, { worker: "medium" });
    ctx.ui.selectImpl = async () => "high — ";
    await handleSettingChoice("subagentThinkingOverrides.worker", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(cwd).subagentThinkingOverrides?.worker, "high", "concrete edits still route to the owning layer");
    assert.deepEqual(readGlobal().subagentThinkingOverrides, { reviewer: "low" });
  } finally {
    restoreGlobal();
  }
});

test("auditor dial inherit clears the pin in every layer, not only the owning one", async () => {
  try {
    const cwd = tmpCwd();
    const session = { provider: "live", id: "current", reasoning: true, thinkingLevelMap: { max: "max" } };
    const models = [session, { provider: "audit", id: "project", reasoning: true, thinkingLevelMap: { max: "max" } }];
    const ctx = Object.assign(makeMockCtx(cwd), {
      model: session, thinkingLevel: "max",
      modelRegistry: {
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
        find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      },
    });
    const hostCtx = ctx as unknown as ExtensionContext;
    fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ auditorModel: "audit/global", auditorThinkingLevel: "low" }, null, 2));
    // The project owns the MODEL; the global owns the DIAL.
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ auditorModel: "audit/project" }));
    ctx.ui.customStubMode = true;
    ctx.ui.customImpl = async () => ({ kind: "model", ref: "audit/project" });
    ctx.ui.selectImpl = async () => "session — inherit current session level (default)";
    await handleSettingChoice("auditorModel", hostCtx);
    assert.equal(loadSettings(cwd).auditorThinkingLevel, undefined,
      "the effective dial is inherited, not the other layer's pin");
    assert.equal(readGlobal().auditorThinkingLevel, undefined,
      "the global layer's dial is cleared too");
    const resolved = resolveAuditorModel(hostCtx, loadSettings(cwd).auditorModel, loadSettings(cwd).auditorModelFallbacks);
    assert.equal(resolveCandidateThinkingLevel(resolved, {
      auditorThinkingLevel: loadSettings(cwd).auditorThinkingLevel,
      sessionThinkingLevel: ctx.thinkingLevel,
    }), "max", "the auditor runs at the session dial");
  } finally {
    restoreGlobal();
  }
});

// v0.39.45 (audit 2026-10-22) — a RETIRED recovery knob must not be
// dropped silently. `mainModelFallbackOnRateLimit` stopped controlling
// anything in v0.34.142, but the shipped docs still described it as a live
// switch, so an operator could set it and watch nothing happen.
test("a retired recovery knob is reported as ignored instead of vanishing", () => {
  try {
    const cwd = tmpCwd();
    fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ mainModelFallbackOnRateLimit: false }));
    const loaded = loadSettings(cwd) as unknown as Record<string, unknown>;
    assert.equal(loaded.mainModelFallbackOnRateLimit, undefined, "the retired knob is inert");
    const journal = path.join(cwd, ".pi-glla", "active.jsonl");
    const rows = fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
    assert.ok(
      rows.some(row => row.type === "settings_invalid_ignored" && row.value?.key === "mainModelFallbackOnRateLimit"),
      "the retired knob is reported so the operator learns it is inert",
    );
  } finally {
    restoreGlobal();
  }
});
