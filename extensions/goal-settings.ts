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
// natural-language conversation / completion / auditor / Explore
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
  /** v0.34.72: on (default) → continuation prompts carry the VISION-ASSIST
   * directive: agents that need to SEE something route the check to the
   * mmx vision CLI (mmx-cli skill) instead of switching models; a switch
   * is sanctioned only when the target is preapproved (not forbidden).
   * Off → no vision guidance is injected (the forbiddenModels gate still
   * stands). */
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
  /** v0.34.115: per-subagent fallback chains. Keyed by subagent name
   * (Explore, Plan, general-purpose, …). When set, the subagent sync uses
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
  /** v0.31.3/v0.34.25: next detached auditor candidate when the primary
   * model is the session model or fails at runtime. Unset → session model
   * remains the final fallback. */
  auditorModelFallback?: string;
  /** v0.31.6: when the pinned auditor IS the session model, walk the
   * fallback pin (verifier ≠ executor). Default ON (undefined); false =
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
   * (contract item 5): autoResume on, auditCap 10, stuckMax 10, wedge off,
   * provider errors auto-retry silently. v0.34.140: no-verdict auditor
   * recovery also keeps retrying inside its bounded 24-hour window. Default
   * ON since v0.34.141; set false for the conservative pause-first policy.
   * Explicit per-key settings still win. */
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
  /** v0.27.3: a turn with no tool calls whose text trigram-similarity to
   * the prior assistant turn exceeds this is a nudge. Default 0.6. Higher
   * = stricter (more pauses). */
  stallSimilarityThreshold?: number;
  /** on → propose_* drafts activate WITHOUT the Confirm dialog and the
   * interview floor is skipped — the seed carries the intent (unattended
   * rigs). Default off: nothing activates before the user confirms. */
  autoAcceptDrafts?: boolean;
  /** v0.24.6: subagent model strategy for pi-subagents default agents that
   * pin a model (Explore pins claude-haiku-4-5, which silently routes
   * subagents to a different provider/model than the session).
   * "inherit-parent" (default) writes a managed ~/.pi/agent/agents/Explore.md
   * override without the model pin so subagents share the session model;
   * "agent-default" restores upstream behavior. Applies to NEW
   * sessions (pi-subagents registers agents at session start). */
  /** v0.26.0: reviewer (post-completion follow-up enqueuer) config —
   * project-scoped; see extensions/reviewer.ts DEFAULT_REVIEWER_CONFIG.
   * v0.27.5: superseded by `postaudit` (same shape, terminology reflects
   * the auditor-adjacent role). Both keys are read; `postaudit` wins
   * when both are present. `reviewer` is kept for backwards compat. */
  reviewer?: Record<string, unknown>;
  /** v0.27.5: post-completion audit config. Same shape as `reviewer`. */
  postaudit?: Record<string, unknown>;
  subagentModelStrategy?: SubagentModelStrategy;
  /** v0.24.6: per-agent-type model pin, e.g. { "Explore": "minimax/MiniMax-M3" }.
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

/** These settings describe the main session's provider-recovery policy, not a
 * project artifact. The recovery runtime intentionally reads the global file
 * for them; ignoring project copies keeps the settings table and behavior
 * honest instead of showing a project value that the retry path cannot use. */
const GLOBAL_ONLY_KEYS: ReadonlySet<keyof Settings> = new Set([
  "stateRoot",
  "mainModelFallbacks",
  "mainModelRetryMinutes",
  "mainModelFailback",
  "mainModelPrimaryProbeMinutes",
  "hourlyRetryProbe",
  "drafterModel",
  "drafterThinkingLevel",
  "drafterModelFallbacks",
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
  // v0.34.72: vision-assist routing is the default — seeing is an mmx
  // vision CLI job, never a reason to switch models (note.md 2026-08-07).
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
  // Unset = "high" at the call site (v0.31.2). The auditor is the
  // verification gate: its depth must NOT ride the session's coding-speed
  // thinking dial (user 2026-07-31: "we should also select its thinking
  // level — we don't keep switching it"). v0.31.4: picked alongside the
  // model in /glla → Auditor model; v0.34.127 adds the standalone Auditor
  // thinking row (the claimed "/glla thinking=" action never existed).
  auditorThinkingLevel: undefined,
  // v0.34.66: final-only auditor stream is the default — the HUD never
  // shows the report assembling word-by-word again (note.md #4).
  auditorSilent: true,
  // v0.34.86: progress signals are on by default — silent audits still
  // show a phase label + byte counter (note.md Screenshots 161837/175627).
  auditorProgressSignals: true,
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
  "mainModelRetryMinutes",
  "mainModelFailback",
  "mainModelPrimaryProbeMinutes",
  "forbiddenModels",
  "blockForbiddenModelSwitches",
  "visionAssist",
  "auditorModel",
  "auditorModelFallback",
  "auditorAllowedExtensions",
  "auditorSameSessionSwap",
  "auditorThinkingLevel",
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
      else next[k] = k === "mainModelFallbacks" ? normalizeMainModelFallbackRefs(v) : v;
    }
    writeSettingsAtomically(file, next);
  });
}
