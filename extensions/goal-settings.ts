// pi-goal-list-loop-audit — v0.25.0
// extensions/goal-settings.ts
//
// The settings layer, extracted from loops/goal.ts so tests can drive it
// without importing the whole extension. Two-tier config (v0.7.0): GLOBAL
// is the normal home, PROJECT the rare local override. Resolution:
// project > global > defaults (per key).
//
// v0.35.6: this module owns the typed boundary for the long-term
// preferences policy (audit/LONG-TERM-PREFERENCES-POLICY-2026-08-19.md).
// The Settings interface is the ONLY schema accepted by saveSettings;
// natural-language conversation / completion / auditor / scout
// transcripts are NEVER written here. A regression in
// tests/long-term-preferences-boundary.test.ts pins this boundary.

import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeAuditorAllowedExtensions } from "./auditor-extensions.ts";
import { globalSettingsPath, stateRootPending } from "./glla-state-root.js";

import {
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_FORBIDDEN_MODELS,
  mergeSettings,
  piGlaDir,
} from "./goal-loop-core.ts";
import type { SubagentModelStrategy } from "./goal-loop-subagents.js";
import {
  DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES,
  normalizeMainModelFallbackRefs,
} from "./main-model-recovery.js";
// v0.37.0: the auditor timeout bases/bounds live with the watchdogs that
// consume them — the settings layer only defaults/clamps against them.
import {
  AUDIT_JOB_CLEANUP_MIN_AGE_MS,
  DEFAULT_AUDITOR_STALL_MS,
  DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  MAX_AUDIT_JOB_RETENTION_MS,
  MAX_AUDITOR_STALL_MS,
  MAX_AUDITOR_TOOL_TIMEOUT_MS,
  MIN_AUDITOR_STALL_MS,
  MIN_AUDITOR_TOOL_TIMEOUT_MS,
} from "./goal-loop-auditor-process.js";
import {
  DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS,
  MAX_ZOMBIE_RETRY_ATTEMPTS,
} from "./goal-loop-backoff.js";

export interface Settings {
  /** Where glla's durable state directory lives. This is global-only because
   * project settings.json lives inside the selected state root. The historical
   * cwd root remains the safe default; sessionDir is an explicit opt-in. */
  stateRoot?: "workingDir" | "sessionDir";
  /** v0.34.57: model refs/ids that must never be selected — the policy
   * guard (bug #1.14). The v0.34.115 default is [] (no opinionated ban
   * list); users can explicitly configure refs such as gpt-5.5 / sonnet /
   * opus. Matches case-insensitively as a substring against the
   * "provider/id" ref. Every switch to a forbidden model is ledgered as
   * `forbidden_model_switch`; with blockForbiddenModelSwitches on the
   * selection is reverted. */
  forbiddenModels?: string[];
  /** v0.34.57: when a forbidden model is selected, revert to the previous
   * model (block the call). Default ON. Off = the switch stands but the
   * `forbidden_model_switch` ledger entry records the violation. */
  blockForbiddenModelSwitches?: boolean;
  /** On (default) → continuation prompts carry the VISION-ASSIST
   * directive: agents that need to SEE something prefer the current model's
   * native image capability. External providers are optional and model
   * switches remain gated by forbiddenModels. Off → no vision guidance is
   * injected (the forbiddenModels gate still stands). */
  visionAssist?: boolean;
  /** Global-only ordered provider/model refs to use when the MAIN session model fails. */
  mainModelFallbacks?: string[];
  /** Global-only primary model used temporarily for goal/list/loop drafting. */
  drafterModel?: string;
  /** Global-only thinking level for the temporary drafting agent. Unset means
   * inherit the session's current level for the duration of drafting. */
  drafterThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Global-only ordered drafting fallback agents; the current session model is the final fallback. */
  drafterModelFallbacks?: string[];
  /** Global-only primary model for the emergency compactor handoff brief. Unset → registry plan B. Never the session model (it is the stuck one). */
  compactorModel?: string;
  /** Global-only ordered emergency-compactor fallback agents; walked exactly like Main/drafter/auditor. No session last resort. */
  compactorModelFallbacks?: string[];
  /** v0.34.115: per-subagent fallback chains. Keyed by current pi-subagents
   * role name (scout, researcher, worker, reviewer, oracle, delegate, …). When set, the subagent sync uses
   * the FIRST eligible ref in the chain via ModelSelector.selectNextValid;
   * when unset, behavior is byte-identical to v0.34.114 (inherit-parent or
   * per-type pin). */
  subagentFallbacks?: Record<string, string[]>;
  /** Global-only base minutes before main-session recovery; doubles per attempt, caps at 5h, and the automatic window ends at 24h. */
  mainModelRetryMinutes?: number;
  /** Global-only: after a fallback succeeds, automatically test the preferred
   * primary again, or keep the fallback for the rest of the session. */
  mainModelFailback?: "auto" | "sticky";
  /** Global-only minutes between preferred-primary health probes while a
   * fallback is serving successfully. */
  mainModelPrimaryProbeMinutes?: number;
  /** "provider/model-id" or bare "model-id". Unset → session model. */
  auditorModel?: string;
  /** Global-only ordered provider/model refs to try after the detached
   * auditor primary fails or is skipped. The session model remains the final
   * fallback. The shape and cap match mainModelFallbacks. */
  auditorModelFallbacks?: string[];
  /** @deprecated v0.36.0: singular compatibility alias. Reads and writes
   * migrate it to auditorModelFallbacks; new UI/runtime code uses the ordered
   * array. */
  auditorModelFallback?: string;
  /** v0.31.6: when the pinned auditor IS the session model, walk the
   * ordered fallback chain (verifier ≠ executor). Default ON (undefined); false =
   * same-model audits stand — the isolated session + evidence contract is
   * the first-order defense either way; diversity is the second-order one
   * the user may deliberately trade away. */
  auditorSameSessionSwap?: boolean;
  /** v0.34.66: on → the auditor's report text renders FINAL-ONLY in the
   * widget: the live per-token tail is hidden while the detached worker
   * streams and the text surfaces at the verdict. Default ON — the
   * word-by-word HUD was the user complaint (note.md #4,
   * Screenshot_20260804_211341/211506). */
  auditorSilent?: boolean;
  /** v0.34.86: intermediate progress signals during silent audits — phase
   * label ("reading source…" / "writing report…") + report byte-counter.
   * Default ON; off = the plain timer-only card. */
  auditorProgressSignals?: boolean;
  /** v0.37.0: base budget, in milliseconds, for ONE allowed auditor tool
   * call (read/grep/find/ls/bash). Default 5m. Every failed detached
   * attempt that gets retried doubles the effective budget (cap 4× base),
   * so slow local models and long bounded verification commands stop being
   * killed by the identical 5m wall on every retry. Bounds: 30s–6h.
   * Global-only: it describes machine/provider speed, not the project. */
  auditorToolTimeoutMs?: number;
  /** v0.37.0: base silence/no-progress budget, in milliseconds, for the
   * detached auditor (worker inactivity brake + parent stale-heartbeat /
   * no-progress / first-event windows). Default 10m; doubles per retried
   * attempt (cap 4× base). A model that is actively generating (streaming
   * text, running a tool) never counts as silent. Bounds: 1m–24h.
   * Global-only for the same reason as auditorToolTimeoutMs. */
  auditorStallMs?: number;
  /** v0.38.3: how long a PROVEN-DEAD audit job dir (.pi-glla/audit-jobs/<id>/)
   * is kept before explicit cleanup reaps it — the retention window during
   * which the finished audit's session log and result stay readable.
   * Default 15m (the legacy hardcoded threshold); bounds 0–7d. Global-only:
   * disk hygiene is a machine characteristic, not a project one. */
  auditJobRetentionMs?: number;
  /** v0.38.3: on → the detached auditor's pi runs as a normal persistent
   * session (--session <jobDir>/session.jsonl) instead of --no-session, so
   * you can `tail -f` it live or resume it interactively after the audit.
   * Default OFF: the original --no-session spawn is unchanged. The session
   * file lives inside the job dir, so its lifetime = the job-dir retention
   * window (auditJobRetentionMs). */
  auditorInspection?: boolean;
  /** Global-only: when main-model recovery is parked, fire an extra retry at
   * the next :00:30 every hour. This is a blind retry slot; the plugin does
   * not query or infer provider quota state. Default ON. */
  hourlyRetryProbe?: boolean;
  /** v0.36.0: pi extension specs ("npm:pi-webaio", "git:…", or a local
   * path) the DETACHED auditor may load via `pi --extension <spec>` while
   * keeping `--no-extensions` discovery off. Default [] = the fully
   * isolated, extension-less auditor (unchanged behavior). The worker still
   * restricts tools to read,grep,find,ls,bash, so allow-listed extensions
   * register model providers without contributing tools. Entries may be
   * raw specs (npm:<pkg>, git:<url>, relative paths) or already-resolved
   * absolute install paths; dispatch resolves them to existing install
   * paths and drops unloadable entries fail-closed before the worker
   * spawns (extensions/auditor-extensions.ts). */
  auditorAllowedExtensions?: string[];
  auditorThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Shell command run on goal complete / goal pause / loop stop; message passed as $1. */
  notifyCmd?: string;
  /** Per-goal token budget; crossing it pauses the goal. Off by default
   * (opt-in guard, v0.12.0): unset/0 = no budget. */
  tokenLimit?: number;
  /** v0.23.2: minutes of busy-but-silent before the wedge alert fires
   * (hung-command detector). Unset = 30 (WEDGE_ALERT_DEFAULT_MINUTES); 0 = off. */
  wedgeAlertMinutes?: number;
  /** on → restored goals/loops/lists auto-resume even in fresh sessions
   * (unattended rigs). Default off: restore holds until /goal resume. */
  autoResume?: boolean;
  /** v0.28.23: off → decision pauses don't pop the select() picker (the
   * widget card still shows the options; /goal decide opens it on demand).
   * Default on; unattended rigs have no UI so this never fires there. */
  decisionPopup?: boolean;
  /** v0.28.14: what happens to stale carryover (paused goal, waiting list,
   * held loop from before this session) when NEW work activates.
   * pause (default) = leave it + ONE summary; clear = drop it all honestly;
   * resume = legacy silent stacking. */
  carryover?: "resume" | "pause" | "clear";
  /** v0.24.2: pause the goal after N consecutive auditor disapprovals (0 = unlimited).
   * Default 5 (raised from 3 in v0.25.0, contract item 7). */
  auditCap?: number;
  /** Maximum auditor-report characters returned to the executor after a
   * disapproval (0 = full report). Default 0 (full report). */
  auditFeedbackChars?: number;
  /** v0.25.0: flip the continuation defaults toward keep-going
   * (contract item 5): auditCap 10, stuckMax 10, wedge off, and provider
   * errors auto-retry silently. autoResume remains a separate explicit
   * global consent because cold restore must hold by default. v0.34.140:
   * no-verdict auditor recovery also keeps retrying inside its bounded
   * 24-hour window. Default ON since v0.34.141; set false for the
   * conservative pause-first policy. Explicit per-key settings still win. */
  aggressiveMode?: boolean;
  /** Consecutive stuck interventions before a loop stops (default 5,
   * 10 under aggressiveMode). */
  stuckMaxInterventions?: number;
  /** @deprecated v0.34.16: retained so older settings files deserialize, but
   * ignored. Recovery now uses session_shutdown/session_start handoff and
   * never injects terminal keystrokes. */
  autoReloadOnStale?: boolean;
  /** @deprecated v0.34.16: retained for settings-file compatibility, but
   * ignored. Lifecycle handoff is always enabled. */
  autoRecovery?: boolean;
  /** v0.35.64: minutes of confirmed no-progress before glla requests a
   * child-specific abort for a top-level tracked subagent. Default 30; 0 =
   * warning/telemetry only. The 5m/20m detection warnings remain separate. */
  subagentHangEscalationMinutes?: number;
  /** v0.26.1: consecutive heartbeat refires without a real turn before
   * the goal pauses / loop stops (default 5; 0 = never escalate). */
  stallEscalationRefires?: number;
  /** v0.27.3: a turn with no tool calls AND fewer words than this is a
   * nudge. Default 15 words. Higher = stricter (more pauses). */
  stallShortWords?: number;
  /** Maximum automatic re-dispatches after one uninterrupted busy/no-stream
   * episode (default 3; 0 = manual resume only; max 10). */
  zombieRetryMaxAttempts?: number;
  /** v0.27.3: a turn with no tool calls whose text trigram-similarity to
   * the prior assistant turn exceeds this is a nudge. Default 0.6. Higher
   * = stricter (more pauses). */
  stallSimilarityThreshold?: number;
  /** on → propose_* drafts activate WITHOUT the Confirm dialog and the
   * interview floor is skipped — the seed carries the intent (unattended
   * rigs). Default off: nothing activates before the user confirms. */
  autoAcceptDrafts?: boolean;
  /** Subagent model strategy. Current pi-subagents built-ins inherit the
   * session model by default; explicit per-role pins still use managed agent
   * files. Applies to NEW sessions (the companion registers agents at start). */
  /** v0.26.0: reviewer (post-completion follow-up enqueuer) config —
   * project-scoped; see extensions/reviewer.ts DEFAULT_REVIEWER_CONFIG.
   * v0.27.5: superseded by `postaudit` (same shape, terminology reflects
   * the auditor-adjacent role). Both keys are read; `postaudit` wins
   * when both are present. `reviewer` is kept for backwards compat. */
  reviewer?: Record<string, unknown>;
  /** v0.27.5: post-completion audit config. Same shape as `reviewer`. */
  postaudit?: Record<string, unknown>;
  subagentModelStrategy?: SubagentModelStrategy;
  /** Per-agent-type model pin, e.g. { "scout": "minimax/MiniMax-M3" }.
   * Always wins over subagentModelStrategy — the managed override is written
   * WITH this pin regardless of strategy. */
  subagentModelOverrides?: Record<string, string>;
  /** v0.27.9: per-tool overrides — allowlist (force tools visible despite
   * an external modlist), hidden (force tools hidden even when allowed by
   * the session), and per-tool config (Record<toolName, Record<key, value>>
   * — extensible for tool-specific knobs like timeouts, formats, etc.). */
  toolOverrides?: {
    /** Tools that MUST be active even when an external allowlist hides them. */
    allow?: string[];
    /** Tools that MUST be hidden even when the session allows them. */
    hide?: string[];
    /** Per-tool configuration knobs (extensible). */
    perToolConfig?: Record<string, Record<string, unknown>>;
  };
}

/** These settings describe global provider-recovery policy, not a project
 * artifact. The recovery runtime intentionally reads the global file for
 * them; ignoring project copies keeps the settings table and behavior
 * honest instead of showing a project value that the retry path cannot use. */
const GLOBAL_ONLY_KEYS: ReadonlySet<keyof Settings> = new Set([
  "stateRoot",
  "mainModelFallbacks",
  "mainModelRetryMinutes",
  "mainModelFailback",
  "mainModelPrimaryProbeMinutes",
  "hourlyRetryProbe",
  "autoResume",
  "drafterModel",
  "drafterThinkingLevel",
  "drafterModelFallbacks",
  "compactorModel",
  "compactorModelFallbacks",
  "auditorModelFallbacks",
  "auditorToolTimeoutMs",
  "auditorStallMs",
  "auditJobRetentionMs",
  "auditorInspection",
]);

export const DEFAULT_SETTINGS: Settings = {
  // cwd/.pi-glla preserves historical behavior; sessionDir is explicit opt-in.
  stateRoot: "workingDir",
  // Main-agent fallback models are opt-in: an empty list preserves pi's normal
  // session model behavior, while the recovery cadence still protects an
  // active supervised goal from provider failures.
  mainModelFallbacks: [],
  // v0.34.115: the default policy list is empty — no model is forbidden
  // unless the user explicitly configures forbiddenModels. The blocking gate
  // remains enabled for any explicit list.
  forbiddenModels: [...DEFAULT_FORBIDDEN_MODELS],
  blockForbiddenModelSwitches: true,
  // Vision-assist guidance is on by default: prefer native vision in the
  // current model; never assume an external provider or switch models solely
  // to see (note.md 2026-08-30).
  visionAssist: true,
  mainModelRetryMinutes: 15,
  mainModelFailback: "auto",
  mainModelPrimaryProbeMinutes: DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES,
  // Unset = inherit the session thinking level while the temporary drafter
  // agent is active; the original session level is restored afterward.
  drafterThinkingLevel: undefined,
  // v0.36.0: the default is the fully isolated auditor — no extension is
  // loaded unless the user explicitly allow-lists it (GitHub issue:
  // extension-based model providers otherwise cannot run in the detached
  // auditor).
  auditorAllowedExtensions: [],
  // Unset = inherit the live session thinking level. This keeps the detached
  // auditor's reasoning dial aligned with the parent by default (including
  // max), while an explicit auditorThinkingLevel remains an intentional
  // override. v0.31.4: picked alongside the model in /glla → Auditor model;
  // v0.34.127 adds the standalone Auditor thinking row.
  auditorThinkingLevel: undefined,
  // The auditor fallback chain follows the same ordered, bounded picker style
  // as the main-agent chain. The session model is still the final last resort.
  auditorModelFallbacks: [],
  // v0.34.66: final-only auditor stream is the default — the HUD never
  // shows the report assembling word-by-word again (note.md #4).
  auditorSilent: true,
  // v0.34.86: progress signals are on by default — silent audits still
  // show a phase label + byte counter (note.md Screenshots 161837/175627).
  auditorProgressSignals: true,
  // v0.37.0: auditor timeout bases default to the watchdog constants; users
  // on slow local models raise them via /glla → Auditor rows. Escalation
  // (×2 per retried attempt, cap 4×) applies on top of whatever base is set.
  auditorToolTimeoutMs: DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  auditorStallMs: DEFAULT_AUDITOR_STALL_MS,
  // v0.38.3: dead audit job dirs (and their transcripts) survive this long
  // after the worker dies before `/glla audits health cleanup` reaps them.
  auditJobRetentionMs: AUDIT_JOB_CLEANUP_MIN_AGE_MS,
  // v0.38.3: opt-in live inspection — the auditor's pi becomes a normal
  // persistent session you can tail/resume. Off = the original --no-session.
  auditorInspection: false,
  // v0.34.142: an extra blind retry at :00:30 after every hour starts.
  // It never checks provider state; it simply gives parked recovery another
  // opportunity to make progress.
  hourlyRetryProbe: true,
  // v0.24.6: subagents inherit the session model by default, avoiding a
  // surprise provider/model pin from the upstream default agent.
  subagentModelStrategy: "inherit-parent",
  auditFeedbackChars: DEFAULT_AUDIT_FEEDBACK_CHARS,
  // v0.34.141: keep-going is the production default. Set false explicitly
  // for the conservative pause-first policy; the dial flips DEFAULTS, never
  // explicit per-key user settings.
  aggressiveMode: true,
  // v0.35.64: warn at the short detection thresholds, then take one
  // child-specific action after a much longer confirmed frozen interval.
  subagentHangEscalationMinutes: 30,
  // v0.35.x: repeated Pi-core busy/no-stream recovery is useful for a
  // transient retry sleeper, but must remain finite and user-configurable.
  zombieRetryMaxAttempts: DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS,
};

// Re-exported for compatibility; the dependency-free state-root module owns
// this path so goal-loop-core can resolve piGlaDir without a settings cycle.
export { globalSettingsPath } from "./glla-state-root.js";

export function projectSettingsPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "settings.json");
}

export function readSettingsFile(file: string): Partial<Settings> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Partial<Settings> : {};
  } catch {
    return {};
  }
}

function normalizeLoadedSettings(settings: Settings): Settings {
  // Settings files can be edited by hand or survive an older UI. Normalize
  // the main fallback chain at every read so runtime, display, and persistence
  // all see the same bounded value.
  settings.mainModelFallbacks = normalizeMainModelFallbackRefs(settings.mainModelFallbacks);
  settings.drafterModelFallbacks = normalizeMainModelFallbackRefs(settings.drafterModelFallbacks);
  settings.compactorModelFallbacks = normalizeMainModelFallbackRefs(settings.compactorModelFallbacks);
  settings.auditorModelFallbacks = normalizeMainModelFallbackRefs(settings.auditorModelFallbacks);
  // v0.35.115 parity: subagent fallback chains use the same bounded,
  // case-insensitive dedup as the main chain so ordering/fallback
  // strategy stays coherent across scopes.
  if (settings.subagentFallbacks && typeof settings.subagentFallbacks === "object") {
    for (const [key, chain] of Object.entries(settings.subagentFallbacks)) {
      const normalized = normalizeMainModelFallbackRefs(chain);
      if (normalized.length) settings.subagentFallbacks[key] = normalized;
      else delete (settings.subagentFallbacks as Record<string, string[]>)[key];
    }
    if (Object.keys(settings.subagentFallbacks).length === 0) delete (settings as any).subagentFallbacks;
  }
  // v0.36.0: the auditor extension allowlist is a plain string[] of pi
  // extension specs. Hand-edited files may carry junk; keep it bounded and
  // deterministic so the request hash is stable.
  settings.auditorAllowedExtensions = normalizeAuditorAllowedExtensions(settings.auditorAllowedExtensions);
  if (settings.stateRoot !== "sessionDir" && settings.stateRoot !== "workingDir") {
    settings.stateRoot = "workingDir";
  }
  if (settings.mainModelFailback !== "auto" && settings.mainModelFailback !== "sticky") {
    settings.mainModelFailback = "auto";
  }
  if (typeof settings.mainModelPrimaryProbeMinutes !== "number"
      || !Number.isFinite(settings.mainModelPrimaryProbeMinutes)
      || settings.mainModelPrimaryProbeMinutes <= 0) {
    settings.mainModelPrimaryProbeMinutes = DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES;
  }
  // v0.35.64: a positive child-action threshold must leave the short
  // detection windows meaningful; zero is the explicit warning-only opt-out.
  if (typeof settings.subagentHangEscalationMinutes !== "number"
      || !Number.isInteger(settings.subagentHangEscalationMinutes)
      || (settings.subagentHangEscalationMinutes !== 0 && settings.subagentHangEscalationMinutes < 5)) {
    settings.subagentHangEscalationMinutes = 30;
  }
  if (typeof settings.zombieRetryMaxAttempts !== "number"
      || !Number.isInteger(settings.zombieRetryMaxAttempts)
      || settings.zombieRetryMaxAttempts < 0
      || settings.zombieRetryMaxAttempts > MAX_ZOMBIE_RETRY_ATTEMPTS) {
    settings.zombieRetryMaxAttempts = DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS;
  }
  // v0.37.0: auditor timeout bases — hand-edited files may carry junk or
  // out-of-range values. Clamp into [min, max]; non-finite falls back to
  // the watchdog default. The escalation schedule multiplies these bases,
  // so the bounds apply to the BASE, not the escalated value.
  if (
    typeof settings.auditorToolTimeoutMs !== "number" ||
    !Number.isFinite(settings.auditorToolTimeoutMs)
  ) {
    settings.auditorToolTimeoutMs = DEFAULT_AUDITOR_TOOL_TIMEOUT_MS;
  } else {
    settings.auditorToolTimeoutMs = Math.min(
      MAX_AUDITOR_TOOL_TIMEOUT_MS,
      Math.max(MIN_AUDITOR_TOOL_TIMEOUT_MS, Math.floor(settings.auditorToolTimeoutMs)),
    );
  }
  if (
    typeof settings.auditorStallMs !== "number" ||
    !Number.isFinite(settings.auditorStallMs)
  ) {
    settings.auditorStallMs = DEFAULT_AUDITOR_STALL_MS;
  } else {
    settings.auditorStallMs = Math.min(
      MAX_AUDITOR_STALL_MS,
      Math.max(MIN_AUDITOR_STALL_MS, Math.floor(settings.auditorStallMs)),
    );
  }
  // v0.38.3: retention is a review window, not a watchdog budget — 0 means
  // "reap proven-dead dirs immediately", so the floor is 0, not a minute.
  if (
    typeof settings.auditJobRetentionMs !== "number" ||
    !Number.isFinite(settings.auditJobRetentionMs)
  ) {
    settings.auditJobRetentionMs = AUDIT_JOB_CLEANUP_MIN_AGE_MS;
  } else {
    settings.auditJobRetentionMs = Math.min(
      MAX_AUDIT_JOB_RETENTION_MS,
      Math.max(0, Math.floor(settings.auditJobRetentionMs)),
    );
  }
  // v0.34.142: these old policy knobs no longer control recovery. Drop
  // them from the effective object so stale files cannot resurrect the old
  // behavior or make the settings UI imply that quota inspection exists.
  const legacy = settings as unknown as Record<string, unknown>;
  if (legacy.hourlyRetryProbe === undefined && typeof legacy.hourlyQuotaProbe === "boolean") {
    legacy.hourlyRetryProbe = legacy.hourlyQuotaProbe;
  }
  delete legacy.hourlyQuotaProbe;
  delete legacy.mainModelFallbackOnRateLimit;
  delete legacy.quotaRetryMinutes;
  return settings;
}

function migrateLegacySettings(value: Partial<Settings>): Record<string, unknown> {
  const migrated = { ...(value as Record<string, unknown>) };
  // v0.36.0: preserve the old one-slot auditor pin while moving every read
  // and write to the ordered array used by the main-agent picker. An
  // explicitly present array wins, including [] (the user's clear action).
  if (migrated.auditorModelFallbacks === undefined
      && Object.prototype.hasOwnProperty.call(value, "auditorModelFallback")) {
    migrated.auditorModelFallbacks = typeof migrated.auditorModelFallback === "string"
      ? [migrated.auditorModelFallback]
      : undefined;
  }
  delete migrated.auditorModelFallback;
  if (migrated.hourlyRetryProbe === undefined && typeof migrated.hourlyQuotaProbe === "boolean") {
    migrated.hourlyRetryProbe = migrated.hourlyQuotaProbe;
  }
  delete migrated.hourlyQuotaProbe;
  delete migrated.mainModelFallbackOnRateLimit;
  delete migrated.quotaRetryMinutes;
  return migrated;
}

export function loadSettings(cwd: string): Settings {
  const project = migrateLegacySettings(readSettingsFile(projectSettingsPath(cwd)));
  const global = migrateLegacySettings(readSettingsFile(globalSettingsPath()));
  for (const key of GLOBAL_ONLY_KEYS) delete project[key];
  return normalizeLoadedSettings(mergeSettings(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    global,
    project as Record<string, unknown>,
  ) as unknown as Settings);
}

/**
 * v0.29.5: autoResume is GLOBAL-only (user directive 2026-07-30: "we are
 * not supporting project level setting for it now, just global"). Launch-
 * time restore reads this, never the project file — a stale autoResume
 * key in a project's settings.json is ignored (junk-runner field case: a
 * project-local opt-in from the unattended-audit era kept auto-firing the
 * list at every bare `pi` launch after the global default flipped off).
 */
export function loadGlobalSettings(): Settings {
  return normalizeLoadedSettings(mergeSettings(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    migrateLegacySettings(readSettingsFile(globalSettingsPath())),
  ) as unknown as Settings);
}

/** Every provenance-tracked key (the /glla headless display + UI). */
export const SETTINGS_KEYS: Array<keyof Settings> = [
  "stateRoot",
  "mainModelFallbacks",
  "drafterModel",
  "drafterThinkingLevel",
  "drafterModelFallbacks",
  "compactorModel",
  "compactorModelFallbacks",
  "mainModelRetryMinutes",
  "mainModelFailback",
  "mainModelPrimaryProbeMinutes",
  "forbiddenModels",
  "blockForbiddenModelSwitches",
  "visionAssist",
  "auditorModel",
  "auditorModelFallbacks",
  "auditorAllowedExtensions",
  "auditorSameSessionSwap",
  "auditorThinkingLevel",
  "auditorToolTimeoutMs",
  "auditorStallMs",
  "auditJobRetentionMs",
  "auditorInspection",
  "notifyCmd",
  "tokenLimit",
  "wedgeAlertMinutes",
  "autoResume",
  "decisionPopup",
  "carryover",
  "autoAcceptDrafts",
  "auditCap",
  "auditFeedbackChars",
  "auditorSilent",
  "auditorProgressSignals",
  "hourlyRetryProbe",
  "subagentModelStrategy",
  "subagentModelOverrides",
  "subagentFallbacks",
  "aggressiveMode",
  "stuckMaxInterventions",
  "subagentHangEscalationMinutes",
  "stallEscalationRefires",
  "zombieRetryMaxAttempts",
  "stallShortWords",
  "stallSimilarityThreshold",
  "postaudit",
  "toolOverrides",
  "reviewer", // v0.33.1: legacy alias — menu saves can write it; provenance must know it exists
];

/** Where each effective setting comes from (for the /glla display). */
export function settingsProvenance(cwd: string): Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }> {
  const proj = migrateLegacySettings(readSettingsFile(projectSettingsPath(cwd)));
  const glob = migrateLegacySettings(readSettingsFile(globalSettingsPath()));
  const effective = loadSettings(cwd);
  const out: Record<string, { value: unknown; source: "project" | "global" | "default" }> = {};
  for (const k of SETTINGS_KEYS) {
    const projectValue = GLOBAL_ONLY_KEYS.has(k) ? undefined : (proj as Record<string, unknown>)[k];
    if (projectValue !== undefined) out[k] = { value: projectValue, source: "project" };
    else if ((glob as Record<string, unknown>)[k] !== undefined) out[k] = { value: (glob as any)[k], source: "global" };
    else out[k] = { value: (effective as any)[k], source: "default" };
  }
  return out as Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }>;
}

/** Persist settings as one complete file. A picker save must never leave a
 * truncated JSON document that a later session interprets as "missing" and
 * replaces with an older/default fallback chain. */
function writeSettingsAtomically(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      try { fs.fsyncSync(fd); } catch { /* fsync is best effort on unusual filesystems */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve original error */ }
    throw err;
  }
}

const SETTINGS_LOCK_TIMEOUT_MS = 5_000;
const SETTINGS_LOCK_STALE_MS = 30_000;

function sleepSettingsLock(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

/** Serialize read/modify/write across simultaneous pi processes. Atomic
 * rename prevents torn JSON; this lock prevents an older snapshot from
 * writing a stale fallback array after another process cleared it. */
function withSettingsFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const started = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > SETTINGS_LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // A competing process may have released the lock between stat/rm.
      }
      if (Date.now() - started >= SETTINGS_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for settings lock: ${file}`);
      }
      sleepSettingsLock(10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function saveSettings(scope: "global" | "project", cwd: string, patch: Partial<Settings>): void {
  if (scope === "project" && stateRootPending()) {
    throw new Error("state root pending (sessionDir mode, no session dir yet) — project settings save deferred");
  }
  const file = scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
  withSettingsFileLock(file, () => {
    const current = migrateLegacySettings(readSettingsFile(file));
    const next: Record<string, unknown> = { ...current };
    if (scope === "project") {
      for (const key of GLOBAL_ONLY_KEYS) delete next[key];
    }
    const migratedPatch = migrateLegacySettings(patch);
    for (const [k, v] of Object.entries(migratedPatch)) {
      // Main recovery settings are global-only. If an old project file still
      // carries one, remove it rather than leaving a setting that appears saved
      // but can never affect the runtime.
      if (scope === "project" && GLOBAL_ONLY_KEYS.has(k as keyof Settings)) {
        delete next[k];
        continue;
      }
      if (v === undefined) delete next[k]; // key=unset removes the key
      else if (k === "mainModelFallbacks" || k === "drafterModelFallbacks" || k === "compactorModelFallbacks" || k === "auditorModelFallbacks") next[k] = normalizeMainModelFallbackRefs(v);
      else if (k === "subagentFallbacks" && v && typeof v === "object") {
        const normalized: Record<string, string[]> = {};
        for (const [agent, chain] of Object.entries(v as Record<string, unknown>)) {
          const refs = normalizeMainModelFallbackRefs(chain);
          if (refs.length) normalized[agent] = refs;
        }
        if (Object.keys(normalized).length) next[k] = normalized; else delete next[k];
      } else next[k] = v;
    }
    writeSettingsAtomically(file, next);
  });
}
