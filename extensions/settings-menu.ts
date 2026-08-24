// pi-goal-list-loop-audit — v0.28.0
// extensions/settings-menu.ts
//
// The /glla settings menu as a real TUI table (v0.28.0).
//
// Pre-0.28.0 used `ctx.ui.select` with flat single-line rows; v0.28.0
// replaces it with a `ctx.ui.custom` Container/Text layout featuring:
//   • a top TABS row listing all 7 sections (left/right to switch sections)
//   • a 4-column table for the active section (KEY | VALUE | SOURCE | DESCRIPTION)
//   • up/down navigation scoped to the active section's rows
//   • Enter → emit the selected row's id (caller dispatches handler)
//   • Esc / Ctrl+C → emit undefined (caller exits)
//
// Sections separate runtime roles so each agent's model, thinking, and
// fallback controls stay together:
//   keep-going | main-agent | drafter | auditor | subagents | stall-brakes | other
//
// Extracted into its own module so tests can import `buildSettingsRows` directly
// (mirrors how `readState` lives in goal-loop-core.ts) and so the renderer is
// unit-testable via synthetic handleInput calls (no live TUI needed).
//
// The pre-v0.28.0 headless fallback (`/glla` with no args and no UI) keeps its
// existing text rendering — that's still the right shape for tmux/cron. Only
// the TUI menu becomes a table.

import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_STALL_ESCALATION_REFIRES,
  resolveEffectiveAggressiveSettings,
} from "./goal-loop-core.ts";
import {
  DEFAULT_STALL_SIM_THRESHOLD,
  DEFAULT_STALL_SHORT_WORDS,
} from "./goal-loop-backoff.ts";
import type { Settings } from "./goal-settings.ts";
import { MAX_MAIN_MODEL_FALLBACKS } from "./main-model-recovery.ts";
import { resolveEffectiveSubagentModel, OVERRIDABLE_AGENT_TYPES } from "./goal-loop-subagents.ts";

// =================================================================
// Pure row builder (testable + reusable from the headless fallback)
// =================================================================

export type SettingsSectionId =
  | "keep-going"
  /** Legacy entry-point alias; it opens the Main agent tab. */
  | "agents"
  | "main-agent"
  | "drafter"
  | "auditor"
  | "subagents"
  | "stall-brakes"
  | "other";

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: "keep-going", label: "Keep-going" },
  { id: "main-agent", label: "Main agent" },
  { id: "drafter", label: "Drafter" },
  { id: "auditor", label: "Auditor" },
  { id: "subagents", label: "Subagents" },
  { id: "stall-brakes", label: "Stall brakes" },
  { id: "other", label: "Other" },
];

/** One menu row. `id` is the stable dispatch key (caller switch(id) → handler). */
export interface SettingsRow {
  /** Stable dispatch key — used both as the table id and as the switch(id) case. */
  id: string;
  /** Which section this row belongs to. */
  section: SettingsSectionId;
  /** KEY column — the setting name (left-aligned, padded to keyW). */
  label: string;
  /** VALUE column — current effective value, e.g. `true` / `(off)` / `60`. */
  valueText: string;
  /** SOURCE column — provenance tag: `project` / `global` / `default` / `runtime` (v0.28.20: bare — brackets were chrome). */
  sourceText: string;
  /** DESCRIPTION column — one-line explanation; truncated with ellipsis when narrow. */
  description: string;
}

export type ProvenanceSource = "project" | "global" | "default";

export interface MenuProvenance {
  value: unknown;
  source: ProvenanceSource;
}


/** Subagent model provenance context needed to render the subagent pins column. */
export interface MenuSubagentContext {
  /** Active session model id (provider/model) — used by inherit-parent resolution. */
  sessionModel?: string;
  /** Active session thinking level — used to show inherited agent settings. */
  sessionThinkingLevel?: string;
  /** Known model capabilities, keyed by lowercase provider/model ref. */
  thinkingLevelsByRef?: Readonly<Record<string, readonly string[]>>;
}

function modelThinkingText(
  ref: string,
  requested: string,
  context: MenuSubagentContext,
): string {
  const levels = context.thinkingLevelsByRef?.[ref.toLowerCase()];
  if (!levels || levels.length === 0 || requested === "session thinking" || requested === "session level") {
    return `${ref} · ${requested}`;
  }
  const effective = levels.includes(requested) ? requested : levels[levels.length - 1] ?? "off";
  return effective === requested
    ? `${ref} · ${effective}`
    : `${ref} · ${effective} (requested ${requested})`;
}

function modelChainText(
  refs: readonly string[] | undefined,
  requested: string,
  context: MenuSubagentContext,
): string {
  return (refs ?? []).map((ref) => modelThinkingText(ref, requested, context)).join(" → ");
}

/**
 * Build the full ordered list of menu rows for every section.
 * Pure: no I/O, no extension context; the renderer composes sections onto rows.
 */
export function buildSettingsRows(
  settings: Settings,
  prov: Partial<Record<keyof Settings, MenuProvenance>>,
  subagent: MenuSubagentContext = {},
): SettingsRow[] {
  const provFor = (k: keyof Settings): MenuProvenance =>
    prov[k] ?? { value: undefined, source: "default" };
  // v0.35.4: unset fallbacks surface the EFFECTIVE value (aggressiveMode is
  // ON by default: audit cap 10, stuck max 10, wedge alerts 0). The old
  // base-only "5 [default]" row lied about what the runtime would do.
  const effective = resolveEffectiveAggressiveSettings(settings);
  const show = (k: keyof Settings, fallback: string): string => {
    const p = provFor(k);
    if (p.value === undefined) return fallback;
    // v0.35.4: booleans render as on/off — the same vocabulary the select
    // editors and fallback labels use ("true"/"false" was a raw String()
    // leak in the VALUE column).
    return typeof p.value === "boolean" ? (p.value ? "on" : "off") : String(p.value);
  };
  const src = (k: keyof Settings): string => provFor(k).source;

  const rows: SettingsRow[] = [];
  const sessionRef = subagent.sessionModel ?? "session model";
  const sessionThinking = subagent.sessionThinkingLevel ?? "session thinking";
  const drafterRef = settings.drafterModel ?? sessionRef;
  const drafterThinking = settings.drafterThinkingLevel ?? sessionThinking;
  const auditorRef = settings.auditorModel ?? sessionRef;
  const auditorThinking = settings.auditorThinkingLevel ?? "high";

  // ── Keep-going ──
  rows.push(
    {
      id: "autoResume",
      section: "keep-going",
      label: "Auto-resume on load",
      valueText: show("autoResume", "default"),
      sourceText: src("autoResume"),
      description:
        "on: resume on session load too · off: never · default: hold on EVERY load — explicit resume",
    },
    {
      id: "decisionPopup",
      section: "keep-going",
      label: "Decision popup",
      valueText: show("decisionPopup", "on"),
      sourceText: src("decisionPopup"),
      description:
        "on: decision pauses pop the select() picker · off: widget card only — /goal decide reopens the picker",
    },
    {
      id: "carryover",
      section: "keep-going",
      label: "Carryover policy",
      valueText: show("carryover", "pause"),
      sourceText: src("carryover"),
      description:
        "new goal over stale paused work — pause: one summary, archive the stale goal, keep list+loop · clear: drop the stale queue too · resume: silent stack",
    },
    {
      id: "autoAcceptDrafts",
      section: "keep-going",
      label: "Auto-accept drafts",
      valueText: show("autoAcceptDrafts", "off"),
      sourceText: src("autoAcceptDrafts"),
      description: "on: goal/loop drafts activate without the Confirm dialog (unattended rigs)",
    },
    {
      id: "aggressiveMode",
      section: "keep-going",
      label: "Aggressive mode",
      valueText: show("aggressiveMode", "on"),
      sourceText: src("aggressiveMode"),
      description:
        "ON by default: keep-going defaults (autoResume, cap 10, stuck 10, wedge off, provider + no-verdict auditor retries, cap→TODOs); set off for conservative pauses; explicit per-key settings still win",
    },
    {
      id: "visionAssist",
      section: "keep-going",
      label: "Vision assist",
      valueText: show("visionAssist", "on"),
      sourceText: src("visionAssist"),
      description:
        "on: continuation prompts route 'can't see' checks to the mmx vision CLI instead of switching models; switches stay preapproved-only (forbiddenModels gate)",
    },
    // ── Main agent ──
    {
      id: "mainAgent",
      section: "main-agent",
      label: "Current main agent",
      valueText: modelThinkingText(sessionRef, sessionThinking, subagent),
      sourceText: "runtime",
      description: "the active pi session agent/model and thinking level — change it with pi's regular model and thinking selectors",
    },
    {
      id: "mainModelFallbacks",
      section: "main-agent",
      label: `Fallback models (up to ${MAX_MAIN_MODEL_FALLBACKS})`,
      valueText: settings.mainModelFallbacks?.length
        ? `${settings.mainModelFallbacks.length}/${MAX_MAIN_MODEL_FALLBACKS} · ${settings.mainModelFallbacks.map((ref, index) => `${index + 1}. ${modelThinkingText(ref, sessionThinking, subagent)}`).join(" → ")}`
        : `0/${MAX_MAIN_MODEL_FALLBACKS} · none`,
      sourceText: src("mainModelFallbacks"),
      description: "ordered and deselectable: current main agent → fallback 1 → fallback 2…; every recoverable provider failure switches one eligible fallback at a time",
    },
    {
      id: "forbiddenModels",
      section: "keep-going",
      label: "Forbidden model patterns",
      valueText: settings.forbiddenModels?.length ? settings.forbiddenModels.join(", ") : "none",
      sourceText: src("forbiddenModels"),
      description: "case-insensitive substring patterns matched against provider/id; recovery always skips matches, while the explicit-switch gate may block or ledger them"
    },
    {
      id: "blockForbiddenModelSwitches",
      section: "keep-going",
      label: "Block forbidden switches",
      valueText: show("blockForbiddenModelSwitches", "on"),
      sourceText: src("blockForbiddenModelSwitches"),
      description: "on: a forbidden selection is reverted to the previous model · off: the switch stands, the violation is still ledgered"
    },
    {
      id: "mainModelRetryMinutes",
      section: "main-agent",
      label: "Main recovery base minutes",
      valueText: show("mainModelRetryMinutes", "15"),
      sourceText: src("mainModelRetryMinutes"),
      description: "first retry is eager, later retries use this bounded ladder; an extra :00:30 probe runs after each hour starts; automatic recovery stops after 24h"
    },
    {
      id: "hourlyRetryProbe",
      section: "main-agent",
      label: "Hourly main recovery probe",
      valueText: show("hourlyRetryProbe", "on"),
      sourceText: src("hourlyRetryProbe"),
      description: "adds a probe at :00:30 while any main-model recovery is parked; off disables only this extra ticker, not the configured retry ladder"
    },
    {
      id: "mainModelFailback",
      section: "main-agent",
      label: "Primary failback policy",
      valueText: show("mainModelFailback", "auto"),
      sourceText: src("mainModelFailback"),
      description: "auto: a healthy fallback periodically tests the preferred primary · sticky: stay on the fallback until manually changed",
    },
    {
      id: "mainModelPrimaryProbeMinutes",
      section: "main-agent",
      label: "Primary probe minutes",
      valueText: show("mainModelPrimaryProbeMinutes", "15"),
      sourceText: src("mainModelPrimaryProbeMinutes"),
      description: "minutes between preferred-primary failback probes while the fallback is serving",
    },
  );

  // ── Drafter ──
  rows.push(
    {
      id: "drafterModel",
      section: "drafter",
      label: "Drafter agent",
      valueText: modelThinkingText(drafterRef, drafterThinking, subagent),
      sourceText: src("drafterModel"),
      description: "temporary agent/model used only during /goal, /list, and /loop drafting; after confirmation or interruption the session agent is restored",
    },
    {
      id: "drafterThinkingLevel",
      section: "drafter",
      label: "Drafter thinking",
      valueText: settings.drafterThinkingLevel ? settings.drafterThinkingLevel : `inherit ${sessionThinking}`,
      sourceText: src("drafterThinkingLevel"),
      description: "requested drafting-agent reasoning level — the same request follows the drafter fallback chain and Pi clamps it per model; unset inherits the session level",
    },
    {
      id: "drafterModelFallbacks",
      section: "drafter",
      label: "Drafter fallback agents",
      valueText: settings.drafterModelFallbacks?.length
        ? modelChainText(settings.drafterModelFallbacks, drafterThinking, subagent)
        : "none (session last resort)",
      sourceText: src("drafterModelFallbacks"),
      description: "ordered drafting-only fallback agents; each shows its effective/requested thinking level when the model registry exposes capabilities",
    },
  );

  // ── Subagent fallback chains (v0.34.115) ──
  // Fallback chains are editable for every embedded agent type. This is
  // intentionally broader than KNOWN_PINNED_DEFAULT_AGENTS: Plan and
  // general-purpose do not have upstream model pins, but their explicit
  // fallback chains are still valid settings and have menu dispatchers.
  for (const name of OVERRIDABLE_AGENT_TYPES) {
    const chain = settings.subagentFallbacks?.[name] ?? [];
    rows.push({
      id: `subagentFallbacks:${name}`,
      section: "subagents",
      label: `${name} fallback agents`,
      valueText: chain.length ? chain.join(" → ") : "none (uses pin or inherits)",
      sourceText: src("subagentFallbacks"),
      description: `ordered fallback agents; the FIRST eligible provider/model ref is written as the ${name}.md override. Empty → falls through to subagentModelOverrides / subagentModelStrategy.`,
    });
  }

  // ── Auditor ──
  rows.push(
    {
      id: "auditorModel",
      section: "auditor",
      label: "Auditor agent",
      valueText: modelThinkingText(auditorRef, auditorThinking, subagent),
      sourceText: src("auditorModel"),
      description: "provider/model override for the isolated auditor agent — you pick its thinking level right after the agent",
    },
    {
      id: "auditorThinkingLevel",
      section: "auditor",
      label: "Auditor thinking",
      valueText: settings.auditorThinkingLevel ?? "high (default)",
      sourceText: src("auditorThinkingLevel"),
      description: "DETACHED auditor worker's reasoning level — also picked right after the auditor model; your session's thinking is untouched",
    },
    {
      id: "auditorModelFallback",
      section: "auditor",
      label: "Auditor fallback agent",
      valueText: settings.auditorModelFallback
        ? modelThinkingText(settings.auditorModelFallback, auditorThinking, subagent)
        : `${sessionRef} · ${auditorThinking} (last resort)`,
      sourceText: src("auditorModelFallback"),
      description: "walked when the primary agent is unavailable OR IS the session model (the verifier should differ) — unset = the session model is the last resort",
    },
    {
      id: "auditorAllowedExtensions",
      section: "auditor",
      label: "Allowed extensions",
      // Count only — resolved install paths are long absolute strings; joining
      // them into VALUE expands compact-mode valueW past the terminal width and
      // crashes pi's TUI. Open the row to pick concrete specs in the picker.
      valueText: settings.auditorAllowedExtensions?.length
        ? `${settings.auditorAllowedExtensions.length} enabled`
        : "none (fully isolated, default)",
      sourceText: src("auditorAllowedExtensions"),
      description: "pi extension specs the DETACHED auditor may load (e.g. npm:pi-webaio) so extension-provided model providers can run — tools stay restricted to read/grep/find/ls/bash; empty = the default extension-less auditor",
    },
    {
      id: "auditorSameSessionSwap",
      section: "auditor",
      label: "Same-model swap",
      valueText: show("auditorSameSessionSwap", "on"),
      sourceText: src("auditorSameSessionSwap"),
      description: "when the pinned auditor IS the session model, walk the fallback pin (verifier ≠ executor) — off = same-model audits stand",
    },
    {
      id: "auditorSilent",
      section: "auditor",
      label: "Silent auditor stream",
      valueText: show("auditorSilent", "on"),
      sourceText: src("auditorSilent"),
      description: "on: the auditor's report renders final-only — the widget shows the text at the verdict, never word-by-word · off: live per-token tail",
    },
    {
      id: "auditorProgressSignals",
      section: "auditor",
      label: "Auditor progress signals",
      valueText: show("auditorProgressSignals", "on"),
      sourceText: src("auditorProgressSignals"),
      description: "on: during silent audits the card shows a phase label (reading source… / writing report…) and a report byte-counter so a long pass shows movement · off: plain timer-only card",
    },
    {
      id: "auditCap",
      section: "auditor",
      label: "Audit cap",
      valueText: show("auditCap", `${effective.auditCap}`),
      sourceText: src("auditCap"),
      description: "pause the goal after N consecutive disapprovals (0 = unlimited)",
    },
    {
      id: "auditFeedbackChars",
      section: "auditor",
      label: "Audit feedback chars",
      valueText: show(
        "auditFeedbackChars",
        DEFAULT_AUDIT_FEEDBACK_CHARS === 0 ? "full report" : `${DEFAULT_AUDIT_FEEDBACK_CHARS}`,
      ),
      sourceText: src("auditFeedbackChars"),
      description: "cap the executor-visible disapproval report (0 = full report)",
    },
  );

  // ── Stall brakes ──
  rows.push(
    {
      id: "wedgeAlertMinutes",
      section: "stall-brakes",
      label: "Wedge alert minutes",
      valueText: show("wedgeAlertMinutes", `${effective.wedgeAlertMinutes}`),
      sourceText: src("wedgeAlertMinutes"),
      description: "hung-command alert while the session is busy (0 = off)",
    },
    {
      id: "stuckMaxInterventions",
      section: "stall-brakes",
      label: "Stuck max interventions",
      valueText: show("stuckMaxInterventions", `${effective.stuckMaxInterventions}`),
      sourceText: src("stuckMaxInterventions"),
      description: "consecutive stuck interventions before a loop stops",
    },
    {
      id: "stallEscalationRefires",
      section: "stall-brakes",
      label: "Stall escalation refires",
      valueText: show("stallEscalationRefires", `${DEFAULT_STALL_ESCALATION_REFIRES}`),
      sourceText: src("stallEscalationRefires"),
      description:
        "heartbeat refires with no turn before the goal pauses / loop stops (0 = never)",
    },
    {
      id: "stallShortWords",
      section: "stall-brakes",
      label: "Stall short words",
      valueText: show("stallShortWords", `${DEFAULT_STALL_SHORT_WORDS}`),
      sourceText: src("stallShortWords"),
      description: "turns with no tools AND fewer words than this count as a nudge",
    },
    {
      id: "stallSimilarityThreshold",
      section: "stall-brakes",
      label: "Stall similarity threshold",
      valueText: show("stallSimilarityThreshold", `${DEFAULT_STALL_SIM_THRESHOLD}`),
      sourceText: src("stallSimilarityThreshold"),
      description:
        "no-tool turns whose text is > this similar to the prior turn count as a nudge (0–1)",
    },
  );

  // ── Subagents ──
  rows.push({
    id: "subagentModelStrategy",
    section: "subagents",
    label: "Subagent model strategy",
    valueText: show("subagentModelStrategy", "inherit-parent"),
    sourceText: src("subagentModelStrategy"),
    description:
      "inherit-parent shares your session model; agent-default uses upstream defaults; Designer remains available as a glla role",
  });
  for (const name of OVERRIDABLE_AGENT_TYPES) {
    rows.push({
      id: `subagentModelOverrides.${name}`,
      section: "subagents",
      label: `Subagent ${name} pin`,
      valueText: settings.subagentModelOverrides?.[name] ?? "follows strategy",
      sourceText: settings.subagentModelOverrides?.[name] !== undefined ? src("subagentModelOverrides") : "default",
      description: "provider/model pin; always wins over strategy",
    });
  }
  rows.push({
    id: "subagentResolved",
    section: "subagents",
    label: "Effective resolution",
    // v0.28.20: compact — strip the parenthesized qualifier (the
    // DESCRIPTION column carries semantics) and dedupe identical
    // resolutions.
    valueText: (() => {
      const strip = (r: string) => r.replace(/ \([^)]*\)$/, "").replace(/^\((.*)\)$/, "$1");
      const parts = OVERRIDABLE_AGENT_TYPES.map((name) => resolveEffectiveSubagentModel(name, settings, subagent.sessionModel)).map(strip);
      return parts.every((p) => p === parts[0]) ? parts[0]! : parts.join(" · ");
    })(),
    sourceText: "runtime",
    description: `effective ${OVERRIDABLE_AGENT_TYPES.join(" / ")} model given current settings`,
  });

  // ── Other ──
  rows.push(
    {
      id: "stateRoot",
      section: "other",
      label: "State root",
      valueText: show("stateRoot", "workingDir"),
      sourceText: src("stateRoot"),
      description: "durable glla state location — workingDir: <cwd>/.pi-glla · sessionDir: top-level Pi session directory (global-only; old root untouched)",
    },
    {
      id: "notifyCmd",
      section: "other",
      label: "Notify command",
      valueText: show("notifyCmd", "auto"),
      sourceText: src("notifyCmd"),
      description: "custom command ($1 = message) · unset = auto-detect notify-send/osascript · 'off' = silent",
    },
    {
      id: "tokenLimit",
      section: "other",
      label: "Token limit per goal",
      valueText: show("tokenLimit", "off"),
      sourceText: src("tokenLimit"),
      description: "per-goal token budget; pause when exceeded (0 = off)",
    },
    {
      id: "toolOverrides",
      section: "other",
      label: "Tool overrides",
      valueText: (() => {
        const o = settings.toolOverrides;
        if (!o) return "none";
        const parts: string[] = [];
        if (o.allow?.length) parts.push(`allow ${o.allow.length}`);
        if (o.hide?.length) parts.push(`hide ${o.hide.length}`);
        const cfgN = Object.keys(o.perToolConfig ?? {}).length;
        if (cfgN) parts.push(`cfg ${cfgN}`);
        return parts.join(" · ") || "none";
      })(),
      sourceText: src("toolOverrides"),
      description: "project-scoped per-tool policy — force tools visible/hidden despite modlists + per-tool config knobs; Enter opens the editor",
    },
    {
      id: "postaudit",
      section: "other",
      label: "Postaudit",
      valueText: "open sub-menu",
      sourceText: "—",
      description:
        "post-completion follow-up enqueuer: mode, triggers, cascade, caps (postaudit / reviewer)",
    },
  );

  return rows;
}

// =================================================================
// TUI table component
// =================================================================

/** Column separator (v0.28.18: box-drawing — the menu reads as a table). */
const COL_SEP = " │ ";
/** Header-rule junction matching COL_SEP's visible width. */
const COL_RULE_SEP = "─┼─";

/** Maximum width for each fixed column before truncation kicks in. */
const MAX_KEY_W = 32;
const MAX_VALUE_W = 24;
const MAX_SOURCE_W = 10;
const MIN_DESC_W = 12;

/** A minimal subset of pi-tui's Theme interface used by the renderer. */
export interface SettingsMenuTheme {
  fg(color: "accent" | "muted" | "dim" | "warning" | "success", text: string): string;
  /** Background used for the full-width active row. */
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

/** Structural type for the KeybindingsManager — avoids pulling in the
 * full class so callers can supply any compatible implementation.
 * (Top-level and nested pi-tui ship separate KeybindingsManager classes
 * with private fields; structural typing sidesteps the cross-package type
 * incompatibility entirely.) */
export interface KeybindingsManagerLike {
  matches(data: string, key: string): boolean;
}

export interface SettingsMenuFactoryDeps {
  rows: SettingsRow[];
  title: string;
  /** Optional section to open first when launched from a grouped command. */
  initialSection?: SettingsSectionId;
}

/**
 * TUI Component for the /glla settings menu. Renders a top tabs row + a
 * 4-column table for the active section. The host (extensions/loops/goal.ts)
 * constructs it via `ctx.ui.custom(...)` and dispatches the returned id
 * with `switch (id)` instead of the pre-v0.28.0 `startsWith` strings.
 */
export class SettingsMenuComponent implements Component {
  private readonly rows: SettingsRow[];
  private readonly title: string;
  private readonly requestRender: () => void;
  private readonly theme: SettingsMenuTheme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly done: (id: string | undefined) => void;

  private activeSectionIdx: number;
  private selectedIdx: number;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private showDescriptions = false;

  constructor(
    deps: SettingsMenuFactoryDeps,
    requestRender: () => void,
    theme: SettingsMenuTheme,
    keybindings: KeybindingsManagerLike,
    done: (id: string | undefined) => void,
  ) {
    this.rows = deps.rows;
    this.title = deps.title;
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    const initialSection = deps.initialSection === "agents" ? "main-agent" : deps.initialSection;
    this.activeSectionIdx = Math.max(
      0,
      SETTINGS_SECTIONS.findIndex((section) => section.id === initialSection),
    );
    this.selectedIdx = 0;
  }

  /** Index into `SETTINGS_SECTIONS`. Exposed for tests. */
  getActiveSectionIdx(): number {
    return this.activeSectionIdx;
  }

  /** Index into the active-section's visible rows. Exposed for tests. */
  getSelectedIdx(): number {
    return this.selectedIdx;
  }

  /** Whether the optional long-description column is currently visible. */
  descriptionsVisible(): boolean {
    return this.showDescriptions;
  }

  /** Rows in the active section. Exposed for tests. */
  visibleRows(): SettingsRow[] {
    return this.rows.filter(
      (r) => r.section === SETTINGS_SECTIONS[this.activeSectionIdx]!.id,
    );
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.requestRender();
  }

  /** Move within the active section, wrapping at ends. Exposed for tests. */
  move(delta: number): void {
    const vs = this.visibleRows();
    if (vs.length === 0) return;
    const n = vs.length;
    this.selectedIdx = ((this.selectedIdx + delta) % n + n) % n;
    this.refresh();
  }

  /** Switch section. -1 = left, +1 = right; wraps at ends. Exposed for tests. */
  switchSection(delta: number): void {
    const n = SETTINGS_SECTIONS.length;
    this.activeSectionIdx = ((this.activeSectionIdx + delta) % n + n) % n;
    this.selectedIdx = 0;
    this.refresh();
  }

  private resolveSelectedId(): string | undefined {
    return this.visibleRows()[this.selectedIdx]?.id;
  }

  private widths(width: number) {
    let keyW = visibleWidth(this.theme.bold("KEY"));
    let valueW = visibleWidth(this.theme.bold("VALUE"));
    let sourceW = visibleWidth(this.theme.bold("SOURCE"));
    // v0.28.18: widths are computed across ALL sections (not just the
    // active one) so the grid does NOT reflow on tab switch — a table's
    // columns stay put. The 2-char selection prefix ("▶ "/"  ") counts
    // toward the KEY column (before, rows overflowed keyW by 2 and the
    // whole VALUE column sat 2 chars right of the header's VALUE).
    for (const r of this.rows) {
      if (visibleWidth(r.label) + 2 > keyW) keyW = visibleWidth(r.label) + 2;
      if (visibleWidth(r.valueText) > valueW) valueW = visibleWidth(r.valueText);
      if (visibleWidth(r.sourceText) > sourceW) sourceW = visibleWidth(r.sourceText);
    }
    keyW = Math.min(keyW, MAX_KEY_W);
    sourceW = Math.min(sourceW, MAX_SOURCE_W);
    if (!this.showDescriptions) {
      // With details hidden, give VALUE the space formerly consumed by the
      // hint column — but NEVER grow past the terminal. Content-driven
      // valueW (e.g. joined absolute extension paths) used to expand the
      // grid past width and crash pi (pi-crash.log: terminal 150, line 164).
      const sepW = visibleWidth(COL_SEP);
      const available = Math.max(0, width - keyW - sourceW - 2 * sepW);
      valueW = available;
      return { keyW, valueW, sourceW, descW: 0 };
    }
    valueW = Math.min(valueW, MAX_VALUE_W);
    const descW = Math.max(MIN_DESC_W, width - keyW - valueW - sourceW - 3 * visibleWidth(COL_SEP));
    return { keyW, valueW, sourceW, descW };
  }

  private padEnd(text: string, width: number): string {
    const w = visibleWidth(text);
    return w >= width ? text : text + " ".repeat(width - w);
  }

  private renderBody(width: number): string[] {
    const { keyW, valueW, sourceW, descW } = this.widths(width);
    const sep = this.theme.fg("dim", COL_SEP);

    const lines: string[] = [];

    lines.push(this.theme.fg("accent", this.theme.bold(this.title)));

    // v0.28.19: color-only tabs (user call: "dropping the brackets") —
    // active = accent + bold, inactive = dim. No bracket chrome.
    lines.push(
      SETTINGS_SECTIONS.map((s, i) =>
        i === this.activeSectionIdx
          ? this.theme.fg("accent", this.theme.bold(s.label))
          : this.theme.fg("dim", s.label),
      ).join("  "),
    );

    const headerCells = [
      this.padEnd(this.theme.bold("KEY"), keyW),
      this.padEnd(this.theme.bold("VALUE"), valueW),
      this.padEnd(this.theme.bold("SOURCE"), sourceW),
    ];
    if (this.showDescriptions) headerCells.push(this.theme.bold("DESCRIPTION"));
    lines.push(headerCells.join(sep));
    // Header rule — the grid line that makes it read as a table.
    lines.push(
      this.theme.fg(
        "dim",
        [
          "─".repeat(keyW),
          "─".repeat(valueW),
          "─".repeat(sourceW),
          ...(this.showDescriptions ? ["─".repeat(descW)] : []),
        ].join(COL_RULE_SEP),
      ),
    );

    const vs = this.visibleRows();
    if (vs.length === 0) {
      lines.push(this.theme.fg("muted", "(no settings in this section)"));
    } else {
      vs.forEach((r, i) => {
        const selected = i === this.selectedIdx;
        const prefix = selected ? "▶ " : "  ";
        // v0.28.18: KEY (incl. prefix) and VALUE are truncated to their
        // column — before, an over-long VALUE (e.g. the subagent effective-
        // resolution composite) overflowed and shoved SOURCE/DESCRIPTION
        // right on that row only, breaking the grid.
        const rowCells = [
          this.padEnd(truncateToWidth(prefix + r.label, keyW, "…"), keyW),
          this.padEnd(truncateToWidth(r.valueText, valueW, "…"), valueW),
          this.padEnd(truncateToWidth(r.sourceText, sourceW, "…"), sourceW),
        ];
        if (this.showDescriptions) {
          // Keep the active background visible across the whole table width,
          // including otherwise-empty description space. This is intentionally
          // display-only; row values and persisted settings remain unchanged.
          rowCells.push(this.padEnd(truncateToWidth(r.description, descW, "…"), descW));
        }
        // Selected row: plain separators — the whole row gets one selected-bg
        // wrap; a nested dim separator's reset code would end it early.
        const row = rowCells.join(selected ? COL_SEP : sep);
        lines.push(
          selected
            ? this.theme.bg("selectedBg", this.theme.bold(row))
            : row,
        );
      });
    }

    lines.push(
      this.theme.fg(
        "dim",
        `←/→ tab · ↑/↓ move · d details ${this.showDescriptions ? "off" : "on"} · enter drill-in · esc exit`,
      ),
    );

    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = this.renderBody(width);
    return this.cachedLines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.resolveSelectedId());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(+1);
      return;
    }
    if (data === "d" || data === "D") {
      this.showDescriptions = !this.showDescriptions;
      this.refresh();
      return;
    }
    // Left/right cycle sections. The Keybindings type only has up/down, so we
    // match the raw CSI arrow-key sequences directly. Some terminals emit
    // SS3 ("\x1bOD"/"\x1bOC") instead — fall back to those too.
    if (data === "\x1b[D" || data === "\x1bOD") {
      this.switchSection(-1);
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      this.switchSection(+1);
      return;
    }
    if (data === "\t") {
      this.switchSection(+1);
      return;
    }
    if (data === "\x1b[Z") {
      this.switchSection(-1);
      return;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
