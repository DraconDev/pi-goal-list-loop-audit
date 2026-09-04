// pi-goal-list-loop-audit — v0.28.0
// tests/settings-menu-complete.test.ts
//
// v0.28.0: the menu is structured data (`buildSettingsRows`) and a stable
// `id` dispatch (v0.27.0 relied on `choice.startsWith("...")` strings).
// These tests pin the structural surface against `buildSettingsRows` + the
// `handleSettingChoice` dispatch table in extensions/loops/goal.ts, rather
// than slicing source for flat-row strings.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  buildSettingsRows,
  SETTINGS_SECTIONS,
  type SettingsRow,
} from "../extensions/settings-menu.ts";
import type { Settings } from "../extensions/goal-settings.ts";
import { CURRENT_SUBAGENT_AGENT_NAMES } from "../extensions/goal-loop-subagents.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

/* --------------------------------------------------------------------- */
/*  Pure row-builder pins                                                */
/* --------------------------------------------------------------------- */

const SAMPLE_SETTINGS: Settings = {
  autoResume: true,
  autoAcceptDrafts: false,
  aggressiveMode: false,
  auditorModel: "anthropic/claude-sonnet-4",
  auditorThinkingLevel: "high",
  auditCap: 10,
  auditFeedbackChars: 500,
  hourlyRetryProbe: true,
  mainModelFailback: "auto",
  mainModelPrimaryProbeMinutes: 15,
  wedgeAlertMinutes: 0,
  subagentHangEscalationMinutes: 30,
  stuckMaxInterventions: 5,
  stallEscalationRefires: 5,
  zombieRetryMaxAttempts: 3,
  stallShortWords: 15,
  stallSimilarityThreshold: 0.6,
  notifyCmd: "notify-send $1",
  tokenLimit: 200000,
  subagentModelStrategy: "inherit-parent",
  subagentModelOverrides: {
    scout: "minimax/MiniMax-M3",
    worker: "minimax/MiniMax-M3",
  },
};

const EMPTY_PROV: Partial<Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }>> = {};

/** Build the provenance map the SAME way `settingsProvenance(cwd)` does in
 * production — each key gets a `{value, source}` from settings[k], defaulting
 * to source="global" when set and source="default" when unset. Used by tests
 * to mirror real-call behavior. */
function provFromSettings(s: Partial<Settings>): Partial<Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }>> {
  const out: Partial<Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }>> = {};
  for (const k of Object.keys(s) as Array<keyof Settings>) {
    out[k] = { value: s[k], source: "global" };
  }
  return out;
}

test("every row carries every required column field", () => {
  const rows = buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV);
  for (const r of rows) {
    assert.ok(typeof r.id === "string" && r.id.length > 0, `id: ${r.id}`);
    assert.ok(typeof r.section === "string", `section: ${r.section}`);
    assert.ok(typeof r.label === "string" && r.label.length > 0, `label: ${r.label}`);
    assert.ok(typeof r.valueText === "string", `valueText: ${r.valueText}`);
    assert.ok(typeof r.sourceText === "string", `sourceText: ${r.sourceText}`);
    assert.ok(typeof r.description === "string" && r.description.length > 0, `description: ${r.description}`);
  }
});

test("role-specific tabs keep each agent's model, thinking, and fallback controls together", () => {
  const ids = SETTINGS_SECTIONS.map((s) => s.id);
  assert.deepEqual(ids, ["keep-going", "main-agent", "drafter", "compactor", "auditor", "subagents", "stall-brakes", "other"]);
  assert.ok(SETTINGS_SECTIONS.every((s) => typeof s.label === "string" && s.label.length > 0));
});

test("every row's section is one of the 8 known section ids (no orphans)", () => {
  const validSections = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));
  const rows = buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV);
  for (const r of rows) {
    assert.ok(validSections.has(r.section), `row ${r.id} has section ${r.section}`);
  }
});

test("main-agent tab starts with the runtime agent; drafter and subagent chains have their own tabs", () => {
  const rows = buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("mainAgent")?.section, "main-agent");
  assert.equal(byId.get("mainModelFallbacks")?.section, "main-agent");
  assert.equal(rows.filter((r) => r.section === "main-agent")[0]!.id, "mainAgent");
  assert.equal(byId.get("drafterModel")?.section, "drafter");
  assert.equal(byId.get("drafterModelFallbacks")?.section, "drafter");
  assert.equal(byId.get("drafterThinkingLevel"), undefined, "thinking is selected with the model, not as a standalone row");
  assert.ok(rows.filter((r) => r.id.startsWith("subagentFallbacks:")).every((r) => r.section === "subagents"));
  assert.equal(byId.get("forbiddenModels")?.section, "keep-going", "policy gate stays with keep-going controls");
});

test("main fallback row explains ordered, deselectable selection", () => {
  const rows = buildSettingsRows(
    { ...SAMPLE_SETTINGS, mainModelFallbacks: ["provider/first", "provider/second"] },
    provFromSettings({ mainModelFallbacks: ["provider/first", "provider/second"] }),
  );
  const row = rows.find((candidate) => candidate.id === "mainModelFallbacks")!;
  assert.equal(row.section, "main-agent");
  assert.match(row.description, /ordered and deselectable/);
});

test("role rows show each selected model with requested/effective thinking", () => {
  const rows = buildSettingsRows(
    {
      drafterModel: "provider/primary",
      drafterThinkingLevel: "max",
      drafterModelFallbacks: ["provider/no-max", "provider/also-max"],
      auditorModel: "provider/auditor",
      auditorThinkingLevel: "high",
      auditorModelFallbacks: ["provider/auditor-fallback"],
    } as Settings,
    EMPTY_PROV,
    {
      sessionModel: "provider/session",
      sessionThinkingLevel: "high",
      thinkingLevelsByRef: {
        "provider/primary": ["off", "high", "max"],
        "provider/no-max": ["off", "low", "high"],
        "provider/also-max": ["off", "high", "max"],
        "provider/auditor": ["off", "high"],
        "provider/auditor-fallback": ["off", "low"],
      },
    },
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("mainAgent")?.valueText, "provider/session · high");
  assert.equal(byId.get("drafterModel")?.valueText, "provider/primary · max");
  assert.equal(
    byId.get("drafterModelFallbacks")?.valueText,
    "2/10 · 1. provider/no-max · high (requested max) → 2. provider/also-max · max",
  );
  assert.equal(byId.get("auditorModelFallbacks")?.valueText, "1/10 · 1. provider/auditor-fallback · low (requested high)");
});

test("v0.36.0: unset auditor thinking mirrors the parent session and the fallback row uses the main shape", () => {
  const rows = buildSettingsRows(
    { auditorModel: "provider/auditor", auditorModelFallbacks: ["provider/backup"] } as Settings,
    EMPTY_PROV,
    {
      sessionModel: "provider/session",
      sessionThinkingLevel: "max",
      thinkingLevelsByRef: {
        "provider/auditor": ["off", "high", "max"],
        "provider/backup": ["off", "max"],
      },
    },
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("auditorModel")?.valueText, "provider/auditor · max");
  assert.equal(byId.get("auditorThinkingLevel"), undefined, "thinking is selected with the model, not as a standalone row");
  assert.equal(byId.get("auditorModelFallbacks")?.valueText, "1/10 · 1. provider/backup · max");
  assert.match(byId.get("auditorModelFallbacks")?.description ?? "", /ordered and deselectable/);
});

test("inherited drafter and auditor model rows identify the session category", () => {
  const rows = buildSettingsRows(
    {} as Settings,
    EMPTY_PROV,
    { sessionModel: "provider/session", sessionThinkingLevel: "high" },
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("drafterModel")?.valueText, "session model · high");
  assert.equal(byId.get("auditorModel")?.valueText, "session model · high");
});

test("all embedded subagent types expose editable fallback-chain rows", () => {
  const rows = buildSettingsRows(
    {
      subagentFallbacks: {
        worker: ["provider/worker-backup"],
        scout: ["provider/scout-backup"],
      },
    } as Settings,
    EMPTY_PROV,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("subagentFallbacks:delegate")?.valueText, "none (uses pin or inherits)");
  assert.equal(byId.get("subagentFallbacks:worker")?.valueText, "provider/worker-backup");
  assert.equal(byId.get("subagentFallbacks:scout")?.valueText, "provider/scout-backup");
});

test("key rows from v0.27.0 settings menu are all present (menu coverage contract)", () => {
  const ids = new Set(buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV).map((r) => r.id));
  for (const id of [
    "autoResume",
    "autoAcceptDrafts",
    "carryover",
    "aggressiveMode",
    "mainModelFallbacks",
    "mainModelRetryMinutes",
    "hourlyRetryProbe",
    "mainModelFailback",
    "mainModelPrimaryProbeMinutes",
    "auditorModel",
    "auditorModelFallbacks",
    "auditorSilent",
    "auditorInspection",
    "auditCap",
    "auditFeedbackChars",
    "wedgeAlertMinutes",
    "subagentHangEscalationMinutes",
    "stuckMaxInterventions",
    "stallEscalationRefires",
    "zombieRetryMaxAttempts",
    "stallShortWords",
    "stallSimilarityThreshold",
    "subagentModelStrategy",
    ...CURRENT_SUBAGENT_AGENT_NAMES.map((name) => `subagentModelOverrides.${name}`),
    "subagentModelOverrides.Designer",
    "notifyCmd",
    "tokenLimit",
    "toolOverrides",
    "postaudit",
  ]) {
    assert.ok(ids.has(id), `missing id: ${id}`);
  }
});

test("descriptions and values carry no version-tag chrome (v0.34.25)", () => {
  // Release tags like "(v0.28.21") belong in CHANGELOG.md, not in the menu
  // grid — they padded the noisiest column for zero in-menu value.
  for (const r of buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV)) {
    assert.doesNotMatch(r.description, /\(v0\.\d+\.\d+\)/, `${r.id} description carries a version tag`);
    assert.doesNotMatch(r.valueText, /\(v0\.\d+\.\d+\)/, `${r.id} value carries a version tag`);
  }
});

test("rows map 1:1 to dispatchable ids (every id can drive a handler)", () => {
  // The id → handler mapping lives in handleSettingChoice in goal.ts.
  // Build the set of case-labels we expect.
  const src = readGoalRuntimeSource();
  const dispatcher = src.slice(
    src.indexOf("async function handleSettingChoice"),
    src.indexOf("/** v0.26.0: /review"),
  );
  const caseLabels = new Set<string>();
  for (const m of dispatcher.matchAll(/case\s+"([^"]+)":/g)) {
    caseLabels.add(m[1]!);
  }
  const rowIds = new Set(buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV).map((r) => r.id));
  // Every row id must have a case in the dispatcher. Current pi-subagents
  // role ids are handled by the data-driven prefix guard before the switch.
  const readOnly = new Set(["subagentResolved"]);
  let covered = 0;
  for (const r of rowIds) {
    if (readOnly.has(r)) continue;
    const currentSubagentId = r.startsWith("subagentModelOverrides.") || r.startsWith("subagentFallbacks:");
    if (currentSubagentId) {
      assert.match(dispatcher, /OVERRIDABLE_AGENT_TYPES\.includes\(agentType\)/, `row id "${r}" has no current-role dispatcher guard`);
    } else {
      assert.ok(caseLabels.has(r), `row id "${r}" has no dispatcher case in handleSettingChoice`);
    }
    covered++;
  }
  assert.ok(covered >= 18, `expected at least 18 dispatcher-covered rows, saw ${covered}`);
});

test("main fallback row shows the persisted numbered try order and truthful runtime semantics", () => {
  const rows = buildSettingsRows(
    { ...SAMPLE_SETTINGS, mainModelFallbacks: ["provider/first", "provider/second"] },
    provFromSettings({ mainModelFallbacks: ["provider/first", "provider/second"] }),
  );
  const row = rows.find((candidate) => candidate.id === "mainModelFallbacks")!;
  assert.match(row.valueText, /1\. provider\/first · session thinking → 2\. provider\/second · session thinking/);
  assert.match(row.description, /current main agent → fallback 1 → fallback 2/);
  assert.match(row.description, /every recoverable provider failure switches one eligible fallback at a time/);
  assert.doesNotMatch(row.description, /account\/plan\/billing\/auth|request-rate/);
});

test("auditorAllowedExtensions valueText is a count — never joined absolute paths (screen-size crash)", () => {
  // Absolute install paths from discovery are long enough that joining them
  // into VALUE expands compact-mode valueW past the terminal width and
  // crashes pi's TUI. The row must show a short count; the picker still
  // lists the concrete specs when the user opens the editor.
  const longPaths = [
    "/home/user/.pi/agent/extensions/npm/node_modules/pi-webaio/index.ts",
    "/home/user/.pi/agent/extensions/git/some-org/very-long-repo-name/extension.ts",
    "/opt/shared/pi-extensions/another-provider/dist/index.js",
  ];
  const rows = buildSettingsRows(
    { auditorAllowedExtensions: longPaths } as Settings,
    { auditorAllowedExtensions: { value: longPaths, source: "global" } },
  );
  const row = rows.find((r) => r.id === "auditorAllowedExtensions")!;
  assert.equal(row.valueText, "3 enabled");
  for (const p of longPaths) {
    assert.doesNotMatch(row.valueText, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const empty = buildSettingsRows({} as Settings, EMPTY_PROV)
    .find((r) => r.id === "auditorAllowedExtensions")!;
  assert.equal(empty.valueText, "none (fully isolated, default)");
});

test("valueText derives from settings (effective values surface for each row)", () => {
  const rows = buildSettingsRows(SAMPLE_SETTINGS, provFromSettings(SAMPLE_SETTINGS));
  const byId = new Map<string, SettingsRow>(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("autoResume")!.valueText, "on"); // v0.35.4: booleans render on/off, not raw true/false
  assert.equal(byId.get("auditorModel")!.valueText, "anthropic/claude-sonnet-4 · high");
  assert.equal(byId.get("wedgeAlertMinutes")!.valueText, "0");
  assert.equal(byId.get("subagentHangEscalationMinutes")!.valueText, "30m");
  assert.equal(byId.get("zombieRetryMaxAttempts")!.valueText, "3");
  assert.equal(
    byId.get("subagentModelOverrides.scout")!.valueText,
    "minimax/MiniMax-M3",
  );
});

test("default fallbacks surface when settings + provenance both missing", () => {
  const rows = buildSettingsRows({} as Settings, EMPTY_PROV);
  const byId = new Map<string, SettingsRow>(rows.map((r) => [r.id, r]));
  // No row should leak a literal `undefined` or `null` string — every
  // value is either a fallback `(...)` / `default` / `on` / `off` / a setting
  // value or a subagent resolution string.
  for (const r of rows) {
    assert.notEqual(r.valueText, "undefined");
    assert.notEqual(r.valueText, "");
  }
  // Specific defaults the contract pins:
  assert.match(byId.get("postaudit")!.valueText, /open sub-menu/);
  assert.equal(byId.get("autoAcceptDrafts")!.valueText, "off"); // v0.28.20: bare values
  // v0.35.4: aggressiveMode is ON by default, so the unset fallbacks show
  // the EFFECTIVE values — the old base-only "5" lied about the runtime.
  assert.equal(byId.get("auditCap")!.valueText, "10");
  assert.equal(byId.get("stuckMaxInterventions")!.valueText, "10");
  assert.equal(byId.get("wedgeAlertMinutes")!.valueText, "0");
  assert.equal(byId.get("subagentHangEscalationMinutes")!.valueText, "30m");
  assert.equal(byId.get("zombieRetryMaxAttempts")!.valueText, "3");
  assert.match(byId.get("subagentModelStrategy")!.valueText, /inherit-parent/);
});

test("default fallbacks follow the effective aggressive matrix (explicit off → base values)", () => {
  const rows = buildSettingsRows({ aggressiveMode: false } as Settings, EMPTY_PROV);
  const byId = new Map<string, SettingsRow>(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("auditCap")!.valueText, "5", "explicit aggressiveMode off surfaces the base cap");
  assert.equal(byId.get("stuckMaxInterventions")!.valueText, "5");
  assert.equal(byId.get("wedgeAlertMinutes")!.valueText, "30");
  // Explicit settings still win over the fallback.
  const rows2 = buildSettingsRows({ auditCap: 7 } as Settings, EMPTY_PROV);
  assert.equal(new Map(rows2.map((r) => [r.id, r])).get("auditCap")!.valueText, "7");
});

test("effective resolution names the real session model for inherit-parent", () => {
  const rows = buildSettingsRows(
    { subagentModelStrategy: "inherit-parent" },
    EMPTY_PROV,
    { sessionModel: "provider/session-model" },
  );
  const effective = rows.find((row) => row.id === "subagentResolved");
  assert.equal(effective?.valueText, "provider/session-model", "the compact row keeps the real model instead of generic session model");

  const ui = fs.readFileSync("extensions/loops/goal-settings-ui.ts", "utf-8");
  assert.match(ui, /buildSettingsRows\(settings, prov, \{\s*sessionModel,\s*sessionThinkingLevel:/, "interactive settings passes its session model and thinking to the row builder");
});

test("provenance flows into sourceText (project/global/default tags)", () => {
  const rows1 = buildSettingsRows(SAMPLE_SETTINGS, {
    autoResume: { value: true, source: "project" },
    auditorModel: { value: "anthropic/claude-sonnet-4", source: "global" },
  });
  const byId = new Map(rows1.map((r) => [r.id, r]));
  assert.equal(byId.get("autoResume")!.sourceText, "project"); // v0.28.20: bare
  assert.equal(byId.get("auditorModel")!.sourceText, "global"); // v0.28.20: bare
  // No provenance → "default" (v0.28.20: bare)
  assert.equal(byId.get("wedgeAlertMinutes")!.sourceText, "default");
});

test("haiku mention is dropped from any valueText / description / sourceText", () => {
  const rows = buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV);
  for (const r of rows) {
    for (const field of [r.valueText, r.description, r.sourceText, r.label] as const) {
      assert.doesNotMatch(field, /haiku/i, `row ${r.id} field "${field}" mentions haiku`);
    }
  }
});

/* --------------------------------------------------------------------- */
/*  Headless fallback contract                                            */
/* --------------------------------------------------------------------- */

test("headless `/glla` fallback keeps stall brakes and the v0.34.127 sync list", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2: cmdSettings moved
  // v0.28.0: the headless fallback is the second branch in `if (typeof ctx.ui.custom !== "function")`
  // (the rare legacy shard) OR the original text fallback at the bottom of
  // cmdSettings. Isolate that fallback so this contract cannot pass because
  // an unrelated settings reference elsewhere happens to match.
  const start = src.indexOf("// Headless fallback:");
  const end = src.indexOf("// Command-collision detector", start);
  assert.ok(start >= 0 && end > start, "headless fallback block must remain discoverable");
  const fallback = src.slice(start, end);

  assert.match(
    fallback,
    /fmt\("stallEscalationRefires", "stallEscalation"\)/,
    "headless fallback must still include stallEscalationRefires",
  );
  assert.match(
    fallback,
    /fmt\("wedgeAlertMinutes", "wedgeAlert"\)/,
    "headless fallback must still include wedgeAlertMinutes",
  );
  assert.match(
    fallback,
    /fmt\("subagentHangEscalationMinutes", "subagentHangActionMinutes"\)/,
    "headless fallback must include the subagent hang action setting",
  );

  // v0.34.127: every key copied into the interactive settings list must also
  // be visible in the headless /glla listing. Keep this list explicit so a
  // future edit cannot silently drop a synced setting.
  assert.match(fallback, /auditorModelFallbacks:/, "headless fallback must show the ordered auditor chain");
  assert.match(fallback, /mainAgent:.*\[runtime\]/, "headless fallback must show the current main agent");
  assert.match(fallback, /formatSettingValue\(p\.value\)/, "headless fallback must serialize structured settings values");

  for (const key of [
    "stateRoot",
    "auditorAllowedExtensions",
    "decisionPopup",
    "carryover",
    "auditorSameSessionSwap",
    "auditorSilent",
    "auditorProgressSignals",
    "auditorInspection",
    "hourlyRetryProbe",
    "mainModelFailback",
    "mainModelPrimaryProbeMinutes",
    "subagentModelStrategy",
    "subagentModelOverrides",
    "subagentFallbacks",
    "toolOverrides",
    "zombieRetryMaxAttempts",
  ]) {
    assert.match(fallback, new RegExp(`fmt\\(\\"${key}\\"`), `headless fallback missing synced key: ${key}`);
  }
});

test("the legacy flat-row startsWith logic is removed (no more `──` section headers in code)", () => {
  const src = readGoalRuntimeSource();
  assert.doesNotMatch(
    src,
    /── Keep-going ──/,
    "section header strings should be gone — sections are now top tabs",
  );
  assert.doesNotMatch(
    src,
    /choice\.startsWith\("Auto-resume"\)/,
    "startsWith dispatch must be replaced by handleSettingChoice switch",
  );
});

test("/glla tooloverride still routes headlessly (regression: subsystems unchanged)", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2
  assert.match(src, /tooloverride\b.*cmdToolOverride|cmdToolOverride\(trimmed\.slice\("tooloverride"/);
});

test("postaudit and reviewer routes both open the reviewer menu (back-compat)", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2
  assert.match(src, /postaudit.*cmdReviewerSettings|cmdReviewerSettings/);
});

test("stateRoot: one global-only row with the workingDir default", () => {
  const rows = buildSettingsRows(SAMPLE_SETTINGS, EMPTY_PROV);
  const stateRows = rows.filter((r: SettingsRow) => r.id === "stateRoot");
  assert.equal(stateRows.length, 1);
  assert.equal(stateRows[0]?.section, "other");
  assert.equal(stateRows[0]?.valueText, "workingDir");
  assert.match(stateRows[0]?.description ?? "", /sessionDir/);
});

test("v0.28.20: no bracket/paren chrome — VALUE and SOURCE render bare", () => {
  const rows = buildSettingsRows(SAMPLE_SETTINGS, {});
  for (const r of rows) {
    assert.doesNotMatch(
      r.sourceText,
      /^\[.*\]$/,
      `SOURCE must be a bare word (${r.id}): ${r.sourceText}`,
    );
    assert.doesNotMatch(
      r.valueText,
      /^\(.*\)$/,
      `VALUE must not be paren-wrapped (${r.id}): ${r.valueText}`,
    );
  }
  // The "Effective resolution" composite compacts identical resolutions to one.
  const eff = rows.find((r) => r.id === "subagentResolved")!;
  assert.ok(
    !eff.valueText.includes("·") || eff.valueText.split("·").length > 1,
    "composite either deduped or a real multi-part join",
  );
  assert.doesNotMatch(eff.valueText, /\(|\)/, `no parens in composite: ${eff.valueText}`);
});
