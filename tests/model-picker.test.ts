// tests/model-picker.test.ts
//
// v0.29.17: /model-style fuzzy picker for model-valued settings + the
// loud session-model fallback for unavailable auditorModel values.
//
// Field: the auditor ran on openrouter/anthropic/claude-sonnet-4.5 until
// the OpenRouter key hit its TOTAL limit — every audit fleet-wide 403'd
// into quota parks. Fixing the setting meant hand-typing provider/model
// into a bare ctx.ui.input; the user asked for the /model interaction
// shape instead (search + filtered list), plus "fall back to the session
// model if unavailable".

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { buildModelPickItems, ModelPickerComponent } from "../extensions/model-picker.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const THEME = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};
const HIGHLIGHT_THEME = {
  ...THEME,
  bg: (_c: string, t: string) => `<selected>${t}</selected>`,
};
const KB = {
  matches: (data: string, key: string) =>
    (key === "tui.select.confirm" && data === "\r") ||
    (key === "tui.select.cancel" && data === "\x1b") ||
    (key === "tui.select.up" && data === "\x1b[A") ||
    (key === "tui.select.down" && data === "\x1b[B"),
};

const MODELS = [
  { provider: "minimax", id: "MiniMax-M3", name: "MiniMax-M3" },
  { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax-M2.7" },
  { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
];

function makePicker(items: ReturnType<typeof buildModelPickItems>) {
  let rendered = 0;
  let result: unknown = "unset";
  const comp = new ModelPickerComponent(
    { title: "Auditor model override", items },
    () => { rendered++; },
    THEME,
    KB,
    (item) => { result = item; },
  );
  return {
    comp,
    get result() { return result as any; },
    get renders() { return rendered; },
  };
}

test("model-picker items: session row first, manual row last, models sorted by provider/id", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  assert.equal(items[0]!.kind, "session");
  assert.ok(items[0]!.label.includes("minimax/MiniMax-M3"), "session row names the current session model");
  assert.equal(items[items.length - 1]!.kind, "manual");
  const refs = items.filter((i) => i.kind === "model").map((i) => i.ref);
  assert.deepEqual(refs, [
    "anthropic/claude-opus-4-7",
    "minimax/MiniMax-M2.7",
    "minimax/MiniMax-M3",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
});

test("v0.34.118 backup picker: excludes forbidden refs before rendering", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3", {
    excludeRefs: ["minimax/MiniMax-M2.7", "openrouter/anthropic/claude-sonnet-4.5"],
    includeSessionRow: false,
    includeManualRow: false,
  });
  const refs = items.filter((i) => i.kind === "model").map((i) => i.ref);
  assert.deepEqual(refs, ["anthropic/claude-opus-4-7", "minimax/MiniMax-M3"]);
  assert.equal(items.some((i) => i.ref === "minimax/MiniMax-M2.7"), false);
  assert.equal(items.some((i) => i.ref === "openrouter/anthropic/claude-sonnet-4.5"), false);
  assert.equal(items.some((i) => i.kind === "session"), false, "ordered backup pickers contain no no-op session row");
  assert.equal(items.some((i) => i.kind === "manual"), false, "ordered backup pickers contain no no-op manual row");
});

test("model-picker exclusion honors case-insensitive substring policy entries", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3", {
    excludeRefs: ["SONNET"],
    includeSessionRow: false,
    includeManualRow: false,
  });
  const refs = items.filter((i) => i.kind === "model").map((i) => i.ref);
  assert.deepEqual(refs, [
    "anthropic/claude-opus-4-7",
    "minimax/MiniMax-M2.7",
    "minimax/MiniMax-M3",
  ]);
  assert.equal(items.some((i) => i.ref === "openrouter/anthropic/claude-sonnet-4.5"), false, "raw sonnet policy hides the provider/id candidate");
});

test("model-picker: typing fuzzy-filters the list; enter returns the highlighted model", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  for (const ch of "minimax-m3") p.comp.handleInput(ch);
  assert.equal(p.comp.getQuery(), "minimax-m3");
  const filtered = p.comp.filteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.ref, "minimax/MiniMax-M3");
  p.comp.handleInput("\r");
  assert.equal(p.result.kind, "model");
  assert.equal(p.result.ref, "minimax/MiniMax-M3");
  assert.ok(p.renders > 0, "re-rendered on each keystroke");
});

test("model-picker: slash-token fuzzy match (provider/model style), nav wraps, backspace edits", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  for (const ch of "openrouter sonnet") p.comp.handleInput(ch);
  const filtered = p.comp.filteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.ref, "openrouter/anthropic/claude-sonnet-4.5");
  p.comp.handleInput("\x7f"); // backspace one char — filter widens
  assert.equal(p.comp.getQuery(), "openrouter sonne");
  assert.ok(p.comp.filteredItems().length >= 1);
});

test("model-picker: up/down moves the selection; esc cancels with undefined", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\x1b[B");
  assert.equal(p.comp.getSelectedIdx(), 1);
  p.comp.handleInput("\x1b[A");
  assert.equal(p.comp.getSelectedIdx(), 0);
  p.comp.handleInput("\x1b");
  assert.equal(p.result, undefined);
});

test("model-picker: selecting the session row clears the override; manual row is the typed escape hatch", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\r"); // first row = session
  assert.equal(p.result.kind, "session");
  const manual = items[items.length - 1]!;
  assert.equal(manual.kind, "manual");
  assert.ok(!manual.ref, "manual carries no ref — the host opens the typed input");
});

test("model-picker: render stays within width and shows the filter hint", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  const lines = p.comp.render(60);
  const text = lines.join("\n");
  assert.ok(text.includes("Auditor model override"));
  assert.ok(text.includes("type to filter"));
  assert.ok(text.includes("minimax/MiniMax-M3"));
});

test("model-picker: active model row uses the available width for selection", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const component = new ModelPickerComponent(
    { title: "Auditor model override", items },
    () => undefined,
    HIGHLIGHT_THEME,
    KB,
    () => undefined,
  );
  const line = component.render(60)[4]!;
  assert.match(line, /^<selected>→ /);
  assert.ok(line.endsWith("</selected>"));
  assert.equal(line.slice("<selected>".length, -"</selected>".length).length, 58);
});

test("v0.29.17 wiring: model-valued settings use the fuzzy picker; unavailable auditor models fall back LOUDLY to the session model", () => {
  const SRC = readGoalRuntimeSource();
  // The picker hosts via ctx.ui.custom over buildModelPickItems:
  // v0.35.24: the auditor slot threads opts.excludeRefs (forbidden-models
  // parity); the bare two-arg call remains for other model-valued rows.
  assert.match(SRC, /buildModelPickItems\(models, sessionLabel, \{ excludeRefs: exclude \}\)/);
  assert.match(SRC, /new ModelPickerComponent\(\{ title, items \}/);
  // Configured-auth filter — a pick from the list can never be a dead provider:
  assert.match(SRC, /hasConfiguredAuth\(m\)/);
  // The old bare-input auditorModel editor is gone from the case body:
  const caseIdx = SRC.indexOf('case "auditorModel": {');
  const caseBody = SRC.slice(caseIdx, caseIdx + 1600);
  assert.match(caseBody, /promptModelRef\(ctx, "Auditor model override"/);
  assert.ok(!caseBody.includes("ctx.ui.input(\"Auditor model override\""), "typed input replaced by the picker");
  // Subagent model pins use the picker too:
  const pinIdx = SRC.indexOf('id.startsWith("subagentModelOverrides.")');
  const pinBody = SRC.slice(pinIdx, pinIdx + 1_200);
  assert.match(pinBody, /promptModelRef\(ctx, `Model pin for \$\{agentType\} subagents`/);
  // Fallback: unavailable configured model → session model, notified + ledgered:
  assert.match(SRC, /auditor_model_fallback/);
  assert.match(SRC, /if \(sessionModel && currentRef\) addCandidate\(currentRef, sessionModel, candidates\.length > 0 \? "session-fallback" : "session"\)/);
  assert.match(SRC, /falling back to the session model\. Fix via \/glla → Auditor model/);
  assert.match(SRC, /no configured auth for \$\{provider\}/, "unkeyed provider counts as unavailable");
});

test("v0.36.0: auditor thinking inherits the parent dial unless explicitly overridden", () => {
  const SRC = readGoalRuntimeSource();
  // An unset auditor level follows the live parent session at both audit launch
  // sites; max is the detached/headless default when the host exposes no dial.
  assert.match(SRC, /thinkingLevel: \(settings\.auditorThinkingLevel \?\? ctx\.thinkingLevel \?\? "max"\) as any,/);
  // Completion retries inherit the dial before resolving support separately
  // for every fallback model; never pass an unsupported level to the worker.
  assert.match(SRC, /const requestedThinking = settings\.auditorThinkingLevel \?\? liveCtx\.thinkingLevel \?\? "max";/);
  assert.match(SRC, /const effectiveThinking = resolveAuditorThinkingLevel\(candidate\.model, requestedThinking\);/);
  assert.match(SRC, /thinkingLevel: effectiveThinking as any,/);
  assert.ok(!SRC.includes("getSessionThinkingLevel"), "the session-dial follower is explicit context, not a hidden helper");
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  // v0.38.2: thinking is selected WITH the model pick (drafter/auditor model rows
  // already chain a thinking select after the model picker). The standalone
  // Auditor thinking row added in v0.34.127 is removed — it duplicated the
  // ladder and violated "Main has no thinking row, neither should they".
  assert.ok(!MENU.includes('id: "auditorThinkingLevel"'), "standalone thinking row removed — thinking is chosen with the model");
  assert.ok(!MENU.includes('id: "drafterThinkingLevel"'), "standalone thinking row removed — thinking is chosen with the model");
  assert.match(MENU, /valueText: modelThinkingText\(auditorRef, auditorThinking, subagent\)/);
  const UI = fs.readFileSync("extensions/loops/goal-settings-ui.ts", "utf-8");
  assert.ok(!UI.includes('case "auditorThinkingLevel"'), "standalone thinking dispatcher removed");
  assert.ok(!UI.includes('case "drafterThinkingLevel"'), "standalone thinking dispatcher removed");
  assert.ok(!UI.includes('/glla thinking='), "the never-existing /glla thinking= claim is gone");
  // v0.36.0: the auditor fallback row is the same ordered multi-select
  // shape as mainModelFallbacks.
  assert.match(MENU, /valueText: settings\.auditorModelFallbacks/);
  const caseIdx2 = SRC.indexOf('case "auditorModel": {');
  // Audit 2026-09-07: inherit/clear parity added ~600 chars above the
  // ladder — 3600 keeps the title inside the window.
  assert.match(SRC.slice(caseIdx2, caseIdx2 + 3600), /"Auditor thinking — DETACHED auditor worker ONLY/);
  // Audit 2026-09-07 (MEDIUM, findings 386-387): the auditor flow mirrors
  // the drafter inherit/clear parity — a non-reasoning pick clears a stale
  // override, and the ladder offers a session-inherit row that clears it.
  const auditorBlock = SRC.slice(caseIdx2, caseIdx2 + 6000);
  assert.match(auditorBlock, /drafterThinkingChoiceOptions\(/, "auditor ladder offers the session-inherit row");
  assert.match(auditorBlock, /startsWith\("session —"\)/, "the inherit row parses like the drafter's");
  assert.match(auditorBlock, /auditorThinkingLevel: undefined \}\);/, "inherit / non-reasoning clears the override");
  // v0.38.2: standalone row removed — the model cases already carry the
  // thinking ladder inline, so no separate dispatcher is needed.
  assert.ok(!SRC.includes('case "auditorThinkingLevel"'), "standalone thinking dispatcher removed");
  assert.ok(!SRC.includes('case "drafterThinkingLevel"'), "standalone thinking dispatcher removed");
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /inherit the live session thinking level/);
});

test("v0.36.0: the auditor chain — pinned primary → ordered fallbacks → session LAST; same-as-session auto-swap", () => {
  const SRC = readGoalRuntimeSource();
  // The cascade is assembled through the canonical normalizer and selector;
  // the settings contract uses the same ordered fallback array as the main
  // agent, normalized before the selector walks it.
  assert.match(SRC, /configuredFallbackRefs/);
  assert.match(SRC, /normalizedFallbackRefs = normalizeMainModelFallbackRefs/);
  assert.match(SRC, /primaryRef = normalizeModelRefs\(ref\)\[0\]/);
  assert.match(SRC, /new ModelSelector\(/);
  assert.match(SRC, /All pinned auditor models are unavailable — falling back to the session model/);
  assert.match(SRC, /auditor_model_same_as_session/);
  assert.match(SRC, /select a different \/glla → Auditor fallback model so the verifier can differ/);
  assert.match(SRC, /resolveAuditorModel\(liveCtx, settings\.auditorModel, settings\.auditorModelFallbacks, settings\.auditorSameSessionSwap !== false\)/);
  assert.match(SRC, /resolveAuditorModel\(ctx, settings\.auditorModel, settings\.auditorModelFallbacks, settings\.auditorSameSessionSwap !== false\)/);
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /auditorModelFallbacks\?: string\[\];/);
  assert.match(SETTINGS, /@deprecated v0\.36\.0: singular compatibility alias/);
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /id: "auditorModelFallbacks"/);
  assert.doesNotMatch(MENU, /id: "auditorModelFallback"[^s]/);
  assert.match(MENU, /section: "auditor",[\s\S]{0,220}?Fallback models \(up to/);
  assert.match(SRC, /case "auditorModelFallbacks": \{/);
  assert.doesNotMatch(SRC, /case "auditorModelFallback": \{/);
  // The v0.31.2 "diverse" machinery is gone (complexity cost > benefit):
  assert.ok(!SRC.includes("pickDiverseAuditorModel") && !SRC.includes('"diverse"'), "diverse strategy removed");
});

test("v0.31.6: same-model swap toggle — default ON, off = same-model audits stand", () => {
  const SRC = readGoalRuntimeSource();
  assert.match(SRC, /sameSessionSwap = true,\n\): \{ model: any; error\?: string; via\?: string; fallbackModels\?: AuditorModelCandidate\[\] \} \{/);
  assert.equal(SRC.match(/settings\.auditorSameSessionSwap !== false/g)!.length, 2, "both audit call sites pass the toggle (undefined = on)");
  assert.match(SRC, /const currentPinned = sameSessionSwap && primaryMatchesSession/); // same-model guard remains explicit
  assert.match(SRC, /case "auditorSameSessionSwap": \{/);
  assert.match(SRC, /off — same-model audits stand; isolation \+ evidence contract still apply/);
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /auditorSameSessionSwap\?: boolean;/);
  assert.match(SETTINGS, /Default ON \(undefined\)/);
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /id: "auditorSameSessionSwap"/);
  assert.match(MENU, /valueText: show\("auditorSameSessionSwap", "on"\)/);
});

test("v0.31.8: thinking options come from the PICKED MODEL — xhigh/max only when the model maps them", () => {
  const SRC = readGoalRuntimeSource();
  assert.match(SRC, /function auditorThinkingLevels\(model: any\): string\[\] \{/);
  assert.match(SRC, /if \(!model\?\.reasoning\) return \["off"\];/);
  assert.match(SRC, /if \(level === "xhigh" \|\| level === "max"\) return mapped !== undefined;/);
  assert.match(SRC, /const levels = auditorThinkingLevels\(pickedModel\);/);
  // non-reasoning model → told, not asked:
  assert.match(SRC, /if \(levels\.length <= 1\) \{/);
  assert.match(SRC, /this model exposes no thinking levels \(auditor runs with thinking off\)/);
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /auditorThinkingLevel\?: "off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max";/);
});

test("v0.31.9: fork-bomb lesson is prompt-law — auditor reject-class + executor hard rule", () => {
  const AUD = fs.readFileSync("extensions/goal-loop-auditor.ts", "utf-8");
  assert.match(AUD, /Reject-class pattern \(v0\.31\.9, field-observed fork bomb\)/);
  assert.match(AUD, /a `timeout` wrapper kills processes, not recursion depth/);
  assert.match(AUD, /provably depth-capped \(e\.g\. an env sentinel/);
  for (const f of ["prompts/goal-loop-continuation.md", "prompts/goal-loop-forever.md", "prompts/goal-loop-forever-metricless.md"]) {
    const t = fs.readFileSync(f, "utf-8");
    assert.match(t, /Never run the suite from inside the suite/, f);
  }
});
