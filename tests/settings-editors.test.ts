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
import * as path from "node:path";
import { handleSettingChoice } from "../extensions/loops/goal.js";
import { globalSettingsPath, loadSettings, projectSettingsPath, saveSettings, settingsProvenance } from "../extensions/goal-settings.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

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
  for (const id of ["autoResume", "carryover", "aggressiveMode", "auditorSameSessionSwap", "decisionPopup", "autoAcceptDrafts"]) {
    let seen: string[] = [];
    ctx.ui.selectImpl = async (_t, options) => { seen = options ?? []; return undefined; };
    await handleSettingChoice(id, ctx as unknown as ExtensionContext);
    assert.ok(seen.length >= 2, `${id} offers a select`);
    for (const o of seen) {
      assert.ok(o.length <= 100, `${id} option is menu noise (${o.length} chars): ${o.slice(0, 70)}…`);
    }
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

test("T4: input editor — auditorModel set / cleared on empty", async () => {
  try {
    const ctx = makeMockCtx(tmpCwd());
    ctx.ui.inputImpl = async () => "openai/gpt-5";
    await handleSettingChoice("auditorModel", ctx as unknown as ExtensionContext);
    assert.equal(readGlobal().auditorModel, "openai/gpt-5");

    ctx.ui.inputImpl = async () => "   ";
    await handleSettingChoice("auditorModel", ctx as unknown as ExtensionContext);
    assert.ok(!("auditorModel" in readGlobal()), "empty input removes the override");
  } finally {
    restoreGlobal();
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

    ctx.ui.selectImpl = async (title: string) => title.startsWith("Drafter thinking")
      ? "session — inherit current session level (default) (current)"
      : undefined;
    await handleSettingChoice("drafterThinkingLevel", ctx as ExtensionContext);
    assert.equal("drafterThinkingLevel" in readGlobal(), false, "the drafter row can restore session-level inheritance");
  } finally {
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
  // README decoupling (user: "too married to our own eco"):
  const README = fs.readFileSync("README.md", "utf-8");
  assert.match(README, /^## Subagents$/m);
  assert.doesNotMatch(README, /## Subagents \(`@tintinweb\/pi-subagents`\)/);
  assert.match(README, /any Agent-tool\s+provider gets them/);
  assert.match(README, /Overlaps — pick one/);
  assert.match(README, /We ran both\s+and removed pi-tasks\./);
  assert.match(README, /auto-detects `notify-send`\/`osascript`; `notify=off` silences/);
});
