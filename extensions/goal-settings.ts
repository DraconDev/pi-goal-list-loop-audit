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
import { normalizeMainFallbackThinking } from "./main-fallback-thinking.js";

import { normalizeAuditorAllowedExtensions } from "./auditor-extensions.ts";
import { globalSettingsPath, stateRootPending } from "./glla-state-root.js";

import {
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_FORBIDDEN_MODELS,
  appendLedger,
  mergeSettings,
  piGlaDir,
} from "./goal-loop-core.ts";
import type { SubagentModelStrategy } from "./goal-loop-subagents.js";
/** v0.38.22: ambient worker display richness (see subagentDisplayRichness). */
export type SubagentDisplayRichness = "rich" | "compact" | "quiet";
import {
  DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES,
  DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES,
  MAX_MAIN_MODEL_SAME_MODEL_RETRIES,
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

/** v0.38.104: the one thinking ladder. normalizeLoadedSettings prunes every
 * level-bearing setting against this list — the per-agent override map and the
 * two scalar pins — so a hand-edited value can never reach an agent file as a
 * bogus `thinking:` key. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface Settings {
  /** Explicit roots for the on-demand read-only /glla fleet view.
   * Defaults to the current project; no background discovery. */
  fleetHealthRoots?: string[];
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
  /** Global-only per-fallback thinking overrides, keyed by lowercase provider/model. Unset inherits the primary session level. */
  mainModelFallbackThinkingLevels?: Record<string, import("./main-fallback-thinking.js").FallbackThinkingLevel>;
  /** Global-only primary model used temporarily for goal/list/loop drafting. */
  drafterModel?: string;
  /** Global-only thinking level for the temporary drafting agent. Unset means
   * inherit the session's current level for the duration of drafting. */
  drafterThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Global-only ordered drafting fallback agents; the current session model is the final fallback. */
  drafterModelFallbacks?: string[];
  /** Global-only explicit Designer enablement. true = keep the managed
   * Designer registered; false = never register it (dedicated model picks
   * are preserved); unset = on-demand (registers when a goal/list item/task
   * asks for Designer, or when any dedicated Designer value is set). */
  designerEnabled?: boolean;
  /** Global-only primary model for the read-only Designer role. Unset = session model. */
  designerModel?: string;
  /** Global-only thinking level for the Designer role. Unset = inherit session. */
  designerThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Global-only ordered Designer fallback agents; selection-time chain —
   * the first eligible ref is written into Designer.md, then session inherit. */
  designerModelFallbacks?: string[];
  /** Global-only primary model for the emergency compactor handoff brief. Unset → registry plan B. Never the session model (it is the stuck one). */
  compactorModel?: string;
  /** Global-only ordered emergency-compactor fallback agents; walked exactly like Main/drafter/auditor. No session last resort. */
  compactorModelFallbacks?: string[];
  /** Global-only positive context-token target; compact opportunistically when idle. */
  compactionTokenThreshold?: number;
  /** v0.34.115: per-subagent fallback chains. Keyed by current pi-subagents
   * role name (scout, researcher, worker, reviewer, oracle, delegate, …). When set, the subagent sync uses
   * the FIRST eligible ref in the chain via ModelSelector.selectNextValid;
   * when unset, behavior is byte-identical to v0.34.114 (inherit-parent or
   * per-type pin). */
  subagentFallbacks?: Record<string, string[]>;
  /** Global-only base minutes before main-session recovery; doubles per attempt, caps at 5h, and the automatic window ends at 24h. */
  mainModelRetryMinutes?: number;
  /** Global-only: number of consecutive retries the CURRENT main model gets
   * before the configured fallback chain is touched. Default 10 (the
   * TRANSIENT_EAGER_ATTEMPTS quantum) so most provider failures hammer the
   * model already chosen instead of rotating on the first blip. 0 restores
   * the legacy immediate rotation. Hand-edited values are clamped to
   * 0..MAX_MAIN_MODEL_SAME_MODEL_RETRIES. */
  mainModelSameModelRetries?: number;
  /** Global-only: after a fallback succeeds, automatically test the preferred
   * primary again, or keep the fallback for the rest of the session. */
  mainModelFailback?: "auto" | "sticky";
  /** Global-only minutes between preferred-primary health probes while a
   * fallback is serving successfully. */
  mainModelPrimaryProbeMinutes?: number;
  /** "provider/model-id" or bare "model-id". Unset → configured fallbacks,
   * then session model; with no configured chain, inherit session directly. */
  auditorModel?: string | null; // null explicitly inherits the live session pair, masking lower-layer pins
  /** Global-only ordered provider/model refs to try after the detached
   * auditor primary fails or is skipped. The session model remains the final
   * fallback. The shape and cap match mainModelFallbacks. */
  auditorModelFallbacks?: string[];
  /** @deprecated v0.36.0: singular compatibility alias. Reads and writes
   * migrate it to auditorModelFallbacks; new UI/runtime code uses the ordered
   * array. */
  auditorModelFallback?: string;
  /** @deprecated Compatibility-only; ignored. Explicit auditor selection
   * always wins, including when it matches the session model. */
  auditorSameSessionSwap?: boolean;
  /** v0.34.66: on → the auditor's report text renders FINAL-ONLY in the
   * widget: the live per-token tail is hidden while the detached worker
   * streams and the text surfaces at the verdict. Default ON — the
   * word-by-word HUD was the user complaint (note.md #4,
   * Screenshot_20260804_211341/211506). */
  auditorSilent?: boolean;
  /** v0.34.86: intermediate progress signals during silent audits — phase
   * label ("thinking…" / "writing report…") + report byte-counter.
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
  /** v0.38.81: fraction of light-tier audits silently escalated to full
   * (risk-tiered auditing spot-checks). Default 0.1; 0 disables.
   * Bounds 0–1. Global-only: calibration policy belongs to the rig,
   * not the project. Tune from the spot flip rate in
   * /glla stats challenges. */
  auditSpotCheckRate?: number;
  /** Require a successful falsification pass on full-tier approvals.
   * Opt-in for high-risk work; a failed challenge is infrastructure/no-verdict. */
  auditorStrictChallenge?: boolean;
  /** v0.38.3: on → the detached auditor's pi runs as a normal persistent
   * session (--session <jobDir>/session.jsonl) instead of --no-session, so
   * you can `tail -f` it live or resume it interactively after the audit.
   * Default ON (v0.39.55): a provider failure resumes the same transcript
   * instead of restarting the whole audit, and this setting is what makes
   * that possible — with it off, every retry restarts cold. Set false to
   * restore the original --no-session spawn. The session file lives inside
   * the job dir, so its lifetime = the job-dir retention window
   * (auditJobRetentionMs). */
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
  /** v0.38.65 (field 151158): on (default) → the detached auditor also
   * loads the session's own packages (user + project settings
   * packages[]/extensions[]) so a session-inherited auditor ref like
   * agnes/agnes-3.0-flash resolves in the worker exactly as it does in
   * the main session. Explicit false restores the pre-mirror behavior:
   * only auditorAllowedExtensions, possibly empty (fully isolated).
   * GLLA itself is never mirrored. Tools stay restricted regardless. */
  auditorMirrorSessionExtensions?: boolean;
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
  /** Budget for safe decline of promoted suggestions while unattended.
   * After N admitted decisions, a further eligible promotion keeps the goal
   * active WITHOUT executing the suggested command. The declined promotion
   * is retained in autoDefaultLog and `decision_budget_auto_default` (or
   * `run_to_done_auto_default` for run-to-done), and carried into Left out.
   * Unset = unlimited; `0` permits safe decline immediately. This never
   * supplies consent or waives criteria: material exceptions remain paused,
   * unclassified human decisions require classification, and authorized
   * mechanical/reversible work continues without a decision. */
  decisionPauseBudget?: number;
  /** v0.28.14: what happens to stale carryover (paused goal, waiting list,
   * held loop from before this session) when NEW work activates.
   * pause (default) = leave it + ONE summary; clear = drop it all honestly;
   * resume = legacy silent stacking. */
  carryover?: "resume" | "pause" | "clear";
  /** v0.24.2: pause the goal after N consecutive auditor disapprovals (0 = unlimited).
   * Default 5 (raised from 3 in v0.25.0, contract item 7). */
  auditCap?: number;
  /** v0.38.103: hard ceiling on consecutive auditor disapprovals — pauses
   * with a decision even under aggressiveMode (whose soft cap converts to
   * keep-going TODOs instead of pausing). Default 8: three grace rounds
   * past the soft cap 5, then a human looks. 0 = unlimited (legacy).
   * Global-only: treadmill policy belongs to the rig. */
  auditCapHard?: number;
  /** v0.38.103: scale mechanical pre-audit gate budgets with host load
   * (1× at load ≤ cpu count, linear to 2× past it). Default true; false
   * restores fixed budgets. Global-only: it describes machine speed. */
  mechanicalLoadScale?: boolean;
  /** Maximum auditor-report characters returned to the executor after a
   * disapproval (0 = full report). Default 0 (full report). */
  auditFeedbackChars?: number;
  /** v0.25.0: flip the continuation defaults toward keep-going
   * (contract item 5): auditCap 10, stuckMax 10, wedge off, and provider
   * errors auto-retry silently. autoResume remains a separate explicit
   * global consent because cold restore must hold by default. v0.34.140:
   * no-verdict auditor recovery also keeps retrying — unbounded while
   * aggressiveMode is on, inside its bounded 24-hour window otherwise.
   * Default ON since v0.34.141; set false for the
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
  /** v0.39.49: where the running GLLA version appears. One surface per fact —
   * "card" (default) folds it into the active card as a detail row, "status"
   * keeps it on the bottom status line, "off" hides it (/glla version remains
   * the explicit readout). Global-only: "how do I see my version" is a
   * preference about the user's UI, not a property of one repository. */
  versionDisplay?: "card" | "status" | "off";
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
  /** v0.38.22 (display unification): ambient worker richness. Audit
   * 2026-09-07 (DECIDED: exceptions-only by default — the native fleet
   * panel already shows healthy workers in more detail): `quiet`
   * (default) shows troubled (non-fresh) worker rows only; `rich` shows
   * all worker rows; `compact` shows the single count line. The count
   * line stays at every level (2026-09-06 ambient-awareness decision) —
   * `quiet` hides only when zero workers are tracked. HUNG is never
   * silent at any level. `/glla agents` keeps full detail regardless. */
  subagentDisplayRichness?: SubagentDisplayRichness;
  /** Per-agent-type model pin, e.g. { "scout": "minimax/MiniMax-M3" }.
   * Always wins over subagentModelStrategy — the managed override is written
   * WITH this pin regardless of strategy. */
  subagentModelOverrides?: Record<string, string>;
  /** Per-agent-type thinking pin, e.g. { "Designer": "high" }. Unset per
   * type (or wholly) means session inherit — the managed override carries no
   * `thinking:` key and pi-subagents runs the child at the session level. */
  subagentThinkingOverrides?: Record<string, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
  /** v0.27.9: per-tool overrides — allowlist (force tools visible despite
   * an external modlist), hidden (force tools hidden even when allowed by
   * the session), and per-tool config (Record<toolName, Record<key, value>>
   * — extensible for tool-specific knobs like timeouts, formats, etc.). */
  toolOverrides?: {
    /** Tools that MUST be active even when an external allowlist hides them. */
    allow?: string[];
    /** Tools that MUST be hidden even when the session allows them. */
    hide?: string[];
    /** Project overrides for registered optional tool arguments. Validated
     * against the complete parameter schema before each model-issued call. */
    perToolConfig?: Record<string, Record<string, unknown>>;
  };
  /** v0.38.54: on → the per-turn `context` hook replaces stale GLLA
   * continuation payloads with a bounded checkpoint (legacy behaviour).
   * Default off (unset): the hook leaves the transcript alone so the
   * provider prefix-cache stays valid across turns; the fresh
   * continuation prompt still carries live durable state every turn.
   * Explicit opt-in restores the per-turn splice. */
  contextCheckpointProjection?: boolean;
}

/** These settings describe global provider-recovery policy, not a project
 * artifact. The recovery runtime intentionally reads the global file for
 * them; ignoring project copies keeps the settings table and behavior
 * honest instead of showing a project value that the retry path cannot use.
 * v0.38.104: exported so docs/SETTINGS.md's "Global-only." annotations can be
 * pinned against the real set — two rows claimed it for keys that are NOT
 * in it, so a hand-edited project file silently overrode global policy. */
export const GLOBAL_ONLY_KEYS: ReadonlySet<keyof Settings> = new Set([
  "stateRoot",
  "mainModelFallbacks",
  "mainModelFallbackThinkingLevels",
  "mainModelRetryMinutes",
  "mainModelSameModelRetries",
  "mainModelFailback",
  "mainModelPrimaryProbeMinutes",
  "hourlyRetryProbe",
  "autoResume",
  "drafterModel",
  "drafterThinkingLevel",
  "drafterModelFallbacks",
  "designerEnabled",
  "designerModel",
  "designerThinkingLevel",
  "designerModelFallbacks",
  "compactorModel",
  "compactorModelFallbacks",
  "compactionTokenThreshold",
  "auditorModelFallbacks",
  "auditorToolTimeoutMs",
  "auditorStallMs",
  "auditJobRetentionMs",
  "auditSpotCheckRate",
  "auditorStrictChallenge",
  "auditorInspection",
  // v0.39.46: one system-wide auto-accept switch replacing the per-project one
  // (a project-scope write offered "for this project" and was forgotten in
  // every other tree). Global-only so the single switch truly governs.
  "autoAcceptDrafts",
  // v0.39.49: a UI preference about the user's own display, not a property of
  // one repository — setting it per project would silently differ by tree.
  "versionDisplay",
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
  mainModelSameModelRetries: DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES,
  mainModelFailback: "auto",
  mainModelPrimaryProbeMinutes: DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES,
  // Unset = inherit the session thinking level while the temporary drafter
  // agent is active; the original session level is restored afterward.
  drafterThinkingLevel: undefined,
  compactionTokenThreshold: DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  // v0.36.0: the default is the fully isolated auditor — no extension is
  // loaded unless the user explicitly allow-lists it (GitHub issue:
  // extension-based model providers otherwise cannot run in the detached
  // auditor).
  auditorAllowedExtensions: [],
  // v0.38.65: mirror on by default (field 151158) — absent/true both
  // mean on; only an explicit false restores full isolation. Stored only
  // when the user opts out so historical settings hash identically.
  auditorMirrorSessionExtensions: undefined,
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
  // v0.38.3 (default flipped in this goal): the auditor's pi is a normal
  // persistent session by default, so a provider failure can RESUME the same
  // transcript instead of restarting the whole audit cold. Field evidence
  // 2026-10-29: three auditor candidates failed in a row and 64 tool calls
  // over 1h46m were discarded on each switch, so no verdict was ever reached.
  // Set false to restore the original --no-session spawn.
  auditorInspection: true,
  // v0.38.81: 1-in-10 light audits silently run full (spot-checks).
  auditSpotCheckRate: 0.1,
  auditorStrictChallenge: false,
  // v0.34.142: an extra blind retry at :00:30 after every hour starts.
  // It never checks provider state; it simply gives parked recovery another
  // opportunity to make progress.
  hourlyRetryProbe: true,
  // v0.24.6: subagents inherit the session model by default, avoiding a
  // surprise provider/model pin from the upstream default agent.
  subagentModelStrategy: "inherit-parent",
  // v0.38.22 (display unification): full ambient worker rows; trimmable
  // to compact/quiet, never silent on hangs.
  // Audit 2026-09-07 (DECIDED: exceptions-only by default): quiet —
  // troubled rows + the count line; healthy fan-out lives on the native
  // fleet panel. Rich stays one setting flip away for full rows.
  subagentDisplayRichness: "quiet",
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

/** C10: a hand-edited value normalizeLoadedSettings dropped (invalid →
 * unset). Only top-level DELETES report: nested prunes (a bad chain entry,
 * a typo'd thinking-map level) still leave the key itself effective, so the
 * whole-value-ignored case is the reportable one. */
export interface InvalidSettingReport {
  key: string;
  /** JSON snippet of the ignored raw value (≤80 chars). No source file:
   * the normalizer sees the merged object; grep the two settings files. */
  raw: string;
}
let pendingInvalidSettingReports: InvalidSettingReport[] = [];
/** Once per process per distinct (key, raw value): loads are frequent and
 * junk is usually stable, so the ledger must not spam one line per tick. A
 * NEW junk value for the same key re-reports (distinct snippet). */
const reportedInvalidSettings = new Set<string>();

function noteDroppedSetting(key: string, raw: unknown): void {
  let snippet: string;
  try {
    snippet = (JSON.stringify(raw) ?? String(raw)).slice(0, 80);
  } catch {
    snippet = String(raw).slice(0, 80);
  }
  const dedupe = `${key} ${snippet}`;
  if (reportedInvalidSettings.has(dedupe)) return;
  reportedInvalidSettings.add(dedupe);
  pendingInvalidSettingReports.push({ key, raw: snippet });
}

/** Drain C10 reports queued by normalizeLoadedSettings since the last drain. */
export function drainInvalidSettingReports(): InvalidSettingReport[] {
  const out = pendingInvalidSettingReports;
  pendingInvalidSettingReports = [];
  return out;
}

/** Test-only: reset the C10 report queue + dedupe set between isolated rigs. */
export function __testOnlyResetInvalidSettingReports(): void {
  pendingInvalidSettingReports = [];
  reportedInvalidSettings.clear();
}

export function normalizeLoadedSettings(settings: Settings): Settings {
  // null is an intentional pair-level override, not invalid lower-layer
  // thinking. Apply that policy before collecting dropped-junk evidence.
  if (settings.auditorModel === null) delete settings.auditorThinkingLevel;
  // C10 snapshot: every key the checks below DELETE is a dead hand-edited
  // value (defaults are valid by construction, so merged-in file junk is
  // the only deletable content). Snapshot first, diff at the end.
  const before = new Map<string, unknown>(Object.entries(settings));
  if (settings.fleetHealthRoots !== undefined && (!Array.isArray(settings.fleetHealthRoots)
    || settings.fleetHealthRoots.some(root => typeof root !== 'string' || !root.trim()))) delete settings.fleetHealthRoots;
  // Settings files can be edited by hand or survive an older UI. Normalize
  // the main fallback chain at every read so runtime, display, and persistence
  // all see the same bounded value.
  settings.mainModelFallbacks = normalizeMainModelFallbackRefs(settings.mainModelFallbacks);
  settings.mainModelFallbackThinkingLevels = normalizeMainFallbackThinking(settings.mainModelFallbackThinkingLevels, settings.mainModelFallbacks);
  settings.drafterModelFallbacks = normalizeMainModelFallbackRefs(settings.drafterModelFallbacks);
  settings.designerModelFallbacks = normalizeMainModelFallbackRefs(settings.designerModelFallbacks);
  settings.compactorModelFallbacks = normalizeMainModelFallbackRefs(settings.compactorModelFallbacks);
  if (!Number.isSafeInteger(settings.compactionTokenThreshold) || (settings.compactionTokenThreshold ?? 0) <= 0) {
    delete settings.compactionTokenThreshold;
  }
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
  // Per-type thinking pins: keep only known levels; unknown strings and
  // non-string values drop so a hand-edited typo can never reach an agent
  // file as a bogus `thinking:` key (unset = session inherit).
  if (settings.subagentThinkingOverrides && typeof settings.subagentThinkingOverrides === "object") {
    const levels: readonly string[] = THINKING_LEVELS;
    for (const [key, level] of Object.entries(settings.subagentThinkingOverrides)) {
      if (typeof level !== "string" || !levels.includes(level)) delete (settings.subagentThinkingOverrides as Record<string, unknown>)[key];
    }
    if (Object.keys(settings.subagentThinkingOverrides).length === 0) delete (settings as any).subagentThinkingOverrides;
  }
  // Hand-edited policy arrays must not reach `.length`/`.join` consumers as
  // strings or objects. Keep only bounded, non-empty string entries; an
  // explicit [] remains the user's "no forbidden patterns" choice.
  if (!Array.isArray(settings.forbiddenModels)) {
    delete settings.forbiddenModels;
  } else {
    settings.forbiddenModels = settings.forbiddenModels
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  // v0.36.0: the auditor extension allowlist is a plain string[] of pi
  // extension specs. Hand-edited files may carry junk; keep it bounded and
  // deterministic so the request hash is stable.
  settings.auditorAllowedExtensions = normalizeAuditorAllowedExtensions(settings.auditorAllowedExtensions);
  // v0.38.65: the mirror flag is tri-state — true/undefined = on, only an
  // explicit false opts out. Hand-edited junk falls back to on (absent).
  if (settings.auditorMirrorSessionExtensions !== false) {
    delete (settings as any).auditorMirrorSessionExtensions;
  }
  if (settings.stateRoot !== "sessionDir" && settings.stateRoot !== "workingDir") {
    settings.stateRoot = "workingDir";
  }
  // v0.38.22: hand-edited richness falls back to quiet (the canonical
  // default) — unknown values must not blank the worker display.
  if (settings.subagentDisplayRichness !== "rich"
      && settings.subagentDisplayRichness !== "compact"
      && settings.subagentDisplayRichness !== "quiet") {
    settings.subagentDisplayRichness = "quiet";
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
  // v0.38.81: spot-check rate — a fraction, not a knob. Out-of-range
  // or non-numeric restores the default; 0 is the explicit off switch.
  if (
    typeof settings.auditSpotCheckRate !== "number" ||
    !Number.isFinite(settings.auditSpotCheckRate) ||
    settings.auditSpotCheckRate < 0 ||
    settings.auditSpotCheckRate > 1
  ) {
    settings.auditSpotCheckRate = 0.1;
  }
  settings.auditorStrictChallenge = settings.auditorStrictChallenge === true;
  // v0.34.142: these old policy knobs no longer control recovery. Drop
  // them from the effective object so stale files cannot resurrect the old
  // behavior or make the settings UI imply that quota inspection exists.
  //
  // v0.39.45 (audit 2026-10-22): dropping them SILENTLY left an operator
  // who set `mainModelFallbackOnRateLimit` believing the switch was live
  // (the shipped docs still described it). A retired key is reported like
  // any other ignored value — the throttled report names the key, so the
  // operator learns the setting is inert instead of wondering why it does
  // nothing.
  const legacy = settings as unknown as Record<string, unknown>;
  if (legacy.hourlyRetryProbe === undefined && typeof legacy.hourlyQuotaProbe === "boolean") {
    legacy.hourlyRetryProbe = legacy.hourlyQuotaProbe;
  }
  for (const retired of ["hourlyQuotaProbe", "mainModelFallbackOnRateLimit", "quotaRetryMinutes"] as const) {
    const raw = legacy[retired];
    if (raw !== undefined) noteDroppedSetting(retired, raw);
  }
  delete legacy.hourlyQuotaProbe;
  delete legacy.mainModelFallbackOnRateLimit;
  delete legacy.quotaRetryMinutes;
  // Audit 2026-09-06: hand-edited files may carry junk for the remaining
  // knobs. Invalid values reset to unset so the `??` consumer fallbacks
  // apply — a garbage string must never flow into arithmetic or an enum
  // comparison. Booleans reset to unset (undefined = default-on where
  // the consumer checks `=== false`).
  if (typeof settings.tokenLimit !== "number" || !Number.isFinite(settings.tokenLimit) || settings.tokenLimit < 0) {
    delete settings.tokenLimit;
  }
  if (typeof settings.auditCap !== "number" || !Number.isInteger(settings.auditCap) || settings.auditCap < 0) {
    delete settings.auditCap;
  }
  if (typeof settings.auditCapHard !== "number" || !Number.isInteger(settings.auditCapHard) || settings.auditCapHard < 0) {
    delete settings.auditCapHard;
  }
  // v0.38.104: two more members of the same family that had no guard, so a
  // hand-edited junk value was rendered as effective by provenance, the menu
  // and the headless /glla row while the RUNTIME silently substituted its
  // default (mainModelRetryDelayMs requires a finite number > 0;
  // auditFeedbackChars requires a non-negative integer). An operator setting
  // 30 minutes and watching a 15-minute ladder had no way to see the value
  // was dead.
  if (typeof settings.mainModelRetryMinutes !== "number" || !Number.isFinite(settings.mainModelRetryMinutes) || settings.mainModelRetryMinutes < 1) {
    delete settings.mainModelRetryMinutes;
  }
  if (typeof settings.mainModelSameModelRetries !== "number" || !Number.isInteger(settings.mainModelSameModelRetries) || settings.mainModelSameModelRetries < 0) {
    delete settings.mainModelSameModelRetries;
  } else if (settings.mainModelSameModelRetries > MAX_MAIN_MODEL_SAME_MODEL_RETRIES) {
    settings.mainModelSameModelRetries = MAX_MAIN_MODEL_SAME_MODEL_RETRIES;
  }
  if (typeof settings.auditFeedbackChars !== "number" || !Number.isInteger(settings.auditFeedbackChars) || settings.auditFeedbackChars < 0) {
    delete settings.auditFeedbackChars;
  }
  // v0.38.104: the same enum hole. subagentThinkingOverrides is pruned against
  // the ladder above; these two scalar pins were not, so a hand-edited
  // "turbo" survived load, printed as the current level in the menu, and was
  // stringified straight into a drafter/auditor agent file's thinking: key.
  const thinkingLadder: readonly string[] = THINKING_LEVELS;
  if (settings.drafterThinkingLevel !== undefined && (typeof settings.drafterThinkingLevel !== "string" || !thinkingLadder.includes(settings.drafterThinkingLevel))) {
    delete settings.drafterThinkingLevel;
  }
  if (settings.auditorThinkingLevel !== undefined && (typeof settings.auditorThinkingLevel !== "string" || !thinkingLadder.includes(settings.auditorThinkingLevel))) {
    delete settings.auditorThinkingLevel;
  }
  if (settings.designerThinkingLevel !== undefined && (typeof settings.designerThinkingLevel !== "string" || !thinkingLadder.includes(settings.designerThinkingLevel))) {
    delete settings.designerThinkingLevel;
  }
  if (typeof settings.designerEnabled !== "boolean") {
    delete settings.designerEnabled;
  }
  if (typeof settings.mechanicalLoadScale !== "boolean") {
    delete settings.mechanicalLoadScale;
  }
  if (typeof settings.stuckMaxInterventions !== "number" || !Number.isInteger(settings.stuckMaxInterventions) || settings.stuckMaxInterventions < 0) {
    delete settings.stuckMaxInterventions;
  }
  if (typeof settings.stallEscalationRefires !== "number" || !Number.isInteger(settings.stallEscalationRefires) || settings.stallEscalationRefires < 0) {
    delete settings.stallEscalationRefires;
  }
  // Audit 2026-09-07 (MEDIUM, findings 383-385): 0 = off is a legal saved
  // value (the editor promises it and the consumer honors it: wordCount < 0
  // never fires). Only negative/non-integer values normalize away.
  if (typeof settings.stallShortWords !== "number" || !Number.isInteger(settings.stallShortWords) || settings.stallShortWords < 0) {
    delete settings.stallShortWords;
  }
  if (typeof settings.stallSimilarityThreshold !== "number" || !Number.isFinite(settings.stallSimilarityThreshold) || settings.stallSimilarityThreshold < 0 || settings.stallSimilarityThreshold > 1) {
    delete settings.stallSimilarityThreshold;
  }
  if (typeof settings.wedgeAlertMinutes !== "number" || !Number.isFinite(settings.wedgeAlertMinutes) || settings.wedgeAlertMinutes < 0) {
    delete settings.wedgeAlertMinutes;
  }
  if (settings.carryover !== "resume" && settings.carryover !== "pause" && settings.carryover !== "clear") {
    delete settings.carryover;
  }
  if (typeof settings.decisionPopup !== "boolean") delete settings.decisionPopup;
  if (settings.decisionPauseBudget !== undefined && (!Number.isInteger(settings.decisionPauseBudget) || settings.decisionPauseBudget < 0)) delete settings.decisionPauseBudget;
  if (typeof settings.aggressiveMode !== "boolean") delete settings.aggressiveMode;
  if (typeof settings.autoResume !== "boolean") delete settings.autoResume;
  if (typeof settings.autoAcceptDrafts !== "boolean") delete settings.autoAcceptDrafts;
  if (settings.versionDisplay !== undefined && !["card", "status", "off"].includes(settings.versionDisplay)) delete settings.versionDisplay;
  if (typeof settings.contextCheckpointProjection !== "boolean") delete settings.contextCheckpointProjection;
  if (typeof settings.notifyCmd !== "string" || settings.notifyCmd.trim().length === 0) {
    delete settings.notifyCmd;
  }
  if (settings.auditorModel !== null && (typeof settings.auditorModel !== "string" || settings.auditorModel.trim().length === 0)) {
    delete settings.auditorModel;
  }
  if (typeof settings.drafterModel !== "string" || settings.drafterModel.trim().length === 0) {
    delete settings.drafterModel;
  }
  if (typeof settings.designerModel !== "string" || settings.designerModel.trim().length === 0) {
    delete settings.designerModel;
  }
  if (typeof settings.compactorModel !== "string" || settings.compactorModel.trim().length === 0) {
    delete settings.compactorModel;
  }
  // C10 diff: report every top-level delete (see InvalidSettingReport).
  // Explicit-undefined defaults (drafterThinkingLevel, the mirror flag)
  // delete as a matter of course — only a PRESENT raw value is dead junk.
  for (const [key, raw] of before) {
    if (raw !== undefined && !(key in settings)) noteDroppedSetting(key, raw);
  }
  return settings;
}

/** Read a settings file through the legacy migration (exported for per-layer
 * editors that must read one scope without merging the other). */
export function migrateLegacySettings(value: Partial<Settings>): Record<string, unknown> {
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
  // Audit 2026-09-06: migrate the legacy `reviewer` block to `postaudit`
  // (postaudit wins when both present) so stale reviewer-only config is
  // not immortal — reads already prefer postaudit.
  if (migrated.postaudit === undefined
      && Object.prototype.hasOwnProperty.call(value, "reviewer")
      && typeof migrated.reviewer === "object"
      && migrated.reviewer !== null) {
    migrated.postaudit = migrated.reviewer;
  }
  delete migrated.reviewer;
  if (migrated.hourlyRetryProbe === undefined && typeof migrated.hourlyQuotaProbe === "boolean") {
    migrated.hourlyRetryProbe = migrated.hourlyQuotaProbe;
  }
  // v0.39.45 (audit 2026-10-22): report the RETIRED recovery knobs instead
  // of dropping them silently — an operator who set one deserves to learn
  // it is inert. The report is throttled per distinct value.
  for (const retired of ["hourlyQuotaProbe", "mainModelFallbackOnRateLimit", "quotaRetryMinutes"] as const) {
    const raw = migrated[retired];
    if (raw !== undefined) noteDroppedSetting(retired, raw);
  }
  delete migrated.hourlyQuotaProbe;
  delete migrated.mainModelFallbackOnRateLimit;
  delete migrated.quotaRetryMinutes;
  // Designer parity: the generic per-type Designer pins were the pre-tab
  // configuration surface. Copy them into the dedicated Designer keys on
  // load (dedicated values win; an explicitly present dedicated fallback
  // array, including [], wins over the legacy chain) and drop the legacy
  // entries so the Subagents tab can never resurrect a second source of
  // truth. Persisted cleanup happens on the next save, like the aliases
  // above. The dedicated keys are global-only (Designer.md lives in the
  // global agent dir), so only the global file's legacy entries survive.
  const legacyOverrides = migrated.subagentModelOverrides as Record<string, unknown> | undefined;
  const legacyThinking = migrated.subagentThinkingOverrides as Record<string, unknown> | undefined;
  const legacyFallbacks = migrated.subagentFallbacks as Record<string, unknown> | undefined;
  // Junk dedicated values (null, wrong type) count as absent here —
  // normalization deletes them later, and the legacy pin must not be lost
  // just because a hand-edited dedicated key is dead.
  if ((typeof migrated.designerModel !== "string" || !migrated.designerModel.trim()) && typeof legacyOverrides?.Designer === "string" && legacyOverrides.Designer.trim()) {
    migrated.designerModel = legacyOverrides.Designer;
  }
  if (typeof migrated.designerThinkingLevel !== "string" && typeof legacyThinking?.Designer === "string") {
    migrated.designerThinkingLevel = legacyThinking.Designer;
  }
  if (!Array.isArray(migrated.designerModelFallbacks) && Array.isArray(legacyFallbacks?.Designer)) {
    migrated.designerModelFallbacks = legacyFallbacks.Designer;
  }
  const stripDesigner = (map: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!map || !("Designer" in map)) return map;
    const next = { ...map };
    delete next.Designer;
    return Object.keys(next).length > 0 ? next : undefined;
  };
  // A partial save patch must not manufacture undefined map entries: the
  // writer interprets those as explicit deletions of unrelated settings.
  if ("subagentModelOverrides" in migrated) migrated.subagentModelOverrides = stripDesigner(legacyOverrides);
  if ("subagentThinkingOverrides" in migrated) migrated.subagentThinkingOverrides = stripDesigner(legacyThinking);
  if ("subagentFallbacks" in migrated) migrated.subagentFallbacks = stripDesigner(legacyFallbacks);
  return migrated;
}

/**
 * v0.39.46 (audit item 3): delete global-only keys from a project settings
 * FILE. `loadSettings` already ignores them in memory; this removes the stale
 * bytes so the on-disk file cannot contradict the effective settings.
 *
 * Deliberately narrow: it only touches keys in GLOBAL_ONLY_KEYS, only when the
 * file actually contains one, and it never throws into a read path (an
 * unwritable file is a degraded-persistence concern, not a read failure).
 */
function cleanStaleGlobalOnlyProjectKeys(cwd: string, file: string): void {
  try {
    const raw = readSettingsFile(file) as Record<string, unknown>;
    const stale = Object.keys(raw).filter((k) => GLOBAL_ONLY_KEYS.has(k as keyof Settings));
    if (stale.length === 0) return;
    withSettingsFileLock(file, () => {
      const current = readSettingsFile(file) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...current };
      let removed = false;
      for (const key of GLOBAL_ONLY_KEYS) {
        if (key in next) { delete next[key]; removed = true; }
      }
      if (!removed) return;
      writeSettingsAtomically(file, next);
      // The cleanup is a real settings mutation; journal it so an operator
      // auditing why a project value vanished has a row to find.
      try {
        appendLedger(cwd, "settings_stale_global_only_removed", { keys: stale.sort(), scope: "project" });
      } catch { /* journal is best-effort on a read path */ }
    });
  } catch {
    // Unreadable/unwritable project file: loadSettings still returns the
    // correct effective value (the key is stripped in memory above).
  }
}

export function loadSettings(cwd: string): Settings {
  const project = migrateLegacySettings(readSettingsFile(projectSettingsPath(cwd)));
  const global = migrateLegacySettings(readSettingsFile(globalSettingsPath()));
  for (const key of GLOBAL_ONLY_KEYS) delete project[key];
  const merged = mergeSettings(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    global,
    project as Record<string, unknown>,
  ) as unknown as Settings;
  // v0.39.x: subagent fallback chains resolve per role — a project chain for
  // one role no longer shadows every global role. Each layer's chains are
  // normalized BEFORE spreading so a dead project entry (empty, whitespace,
  // junk) falls through to the live global role instead of shadowing it;
  // this keeps loadSettings in agreement with subagentFallbackRoleSources,
  // which attributes from normalized per-layer maps.
  const normalizeChainMap = (value: unknown): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    if (value && typeof value === "object") {
      for (const [role, chain] of Object.entries(value as Record<string, unknown>)) {
        const normalized = normalizeMainModelFallbackRefs(chain);
        if (normalized.length) out[role] = normalized;
      }
    }
    return out;
  };
  const globalFallbacks = normalizeChainMap(global.subagentFallbacks);
  const projectFallbacks = normalizeChainMap(project.subagentFallbacks);
  if (Object.keys(globalFallbacks).length || Object.keys(projectFallbacks).length) {
    merged.subagentFallbacks = { ...globalFallbacks, ...projectFallbacks };
  }
  // v0.39.45 (audit 2026-10-22): the per-role PIN maps merge per role too.
  // A project that pins ONE role's model made the whole global pin map
  // inert in that project (the project's object replaced the global one
  // wholesale) — the same shadowing the fallback-chain merge above already
  // prevents. A dead project entry (junk ref, unknown thinking level) falls
  // through to the live global role instead of shadowing it.
  const normalizePinMap = (value: unknown, allowed?: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    if (value && typeof value === "object") {
      for (const [role, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        if (allowed && !allowed.includes(trimmed)) continue;
        out[role] = trimmed;
      }
    }
    return out;
  };
  const globalModelPins = normalizePinMap(global.subagentModelOverrides);
  const projectModelPins = normalizePinMap(project.subagentModelOverrides);
  if (Object.keys(globalModelPins).length || Object.keys(projectModelPins).length) {
    merged.subagentModelOverrides = { ...globalModelPins, ...projectModelPins };
  }
  const globalThinkingPins = normalizePinMap(global.subagentThinkingOverrides, THINKING_LEVELS);
  const projectThinkingPins = normalizePinMap(project.subagentThinkingOverrides, THINKING_LEVELS);
  if (Object.keys(globalThinkingPins).length || Object.keys(projectThinkingPins).length) {
    merged.subagentThinkingOverrides = { ...globalThinkingPins, ...projectThinkingPins } as Settings["subagentThinkingOverrides"];
  }
  const out = normalizeLoadedSettings(merged);
  // C10: surface dead hand-edited values as ledger evidence (throttled once
  // per distinct junk value inside noteDroppedSetting). loadGlobalSettings
  // has no cwd to ledger to, so it leaves reports queued for the next
  // cwd-bearing load — the settings UI and session start always take this path.
  for (const report of drainInvalidSettingReports()) {
    appendLedger(cwd, "settings_invalid_ignored", { key: report.key, raw: report.raw });
  }
  return out;
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

export interface DesignerConfig {
  /** Explicit enablement: true = keep registered, false = never register,
   * undefined = on-demand (register when asked or when configured). */
  enabled?: boolean;
  /** Any dedicated (or legacy-migrated) Designer value is present. */
  configured: boolean;
  /** Dedicated primary model ref; unset inherits the session model. */
  model?: string;
  /** Dedicated thinking level; unset inherits the session level. */
  thinking?: Settings["designerThinkingLevel"];
  /** Ordered selection-time fallback refs (primary excluded). */
  fallbacks: string[];
}

/** Effective Designer configuration. Dedicated keys win per-field; the
 * generic per-type Designer pins are read only as the pre-migration legacy
 * shape (load-time migration normally folds them into the dedicated keys). */
export function resolveDesignerConfig(settings: Settings): DesignerConfig {
  const model = settings.designerModel ?? settings.subagentModelOverrides?.Designer;
  const thinking = settings.designerThinkingLevel ?? settings.subagentThinkingOverrides?.Designer;
  const fallbacks = normalizeMainModelFallbackRefs(settings.designerModelFallbacks ?? settings.subagentFallbacks?.Designer);
  const configured = model !== undefined
    || thinking !== undefined
    || fallbacks.length > 0
    || settings.designerEnabled === true;
  return { enabled: settings.designerEnabled, configured, model, thinking, fallbacks };
}

/** Every provenance-tracked key (the /glla headless display + UI). */
export const SETTINGS_KEYS: Array<keyof Settings> = [
  "stateRoot",
  "mainModelFallbacks",
  "mainModelFallbackThinkingLevels",
  "drafterModel",
  "drafterThinkingLevel",
  "drafterModelFallbacks",
  "designerEnabled",
  "designerModel",
  "designerThinkingLevel",
  "designerModelFallbacks",
  "compactorModel",
  "compactorModelFallbacks",
  "compactionTokenThreshold",
  "mainModelRetryMinutes",
  // v0.39.40: this key was a real global-only setting (GLOBAL_ONLY_KEYS,
  // validated, defaulted) and had its own /glla menu row, but it was never
  // listed here — so provenance reported "default" for it and the menu
  // showed the default value with the default source even when the global
  // file set a different one.
  "mainModelSameModelRetries",
  "mainModelFailback",
  "mainModelPrimaryProbeMinutes",
  "forbiddenModels",
  "blockForbiddenModelSwitches",
  "visionAssist",
  "auditorModel",
  "auditorModelFallbacks",
  "auditorAllowedExtensions",
  "auditorMirrorSessionExtensions",
  "auditorSameSessionSwap",
  "auditorThinkingLevel",
  "auditorToolTimeoutMs",
  "auditorStallMs",
  "auditJobRetentionMs",
  "auditSpotCheckRate",
  "auditorStrictChallenge",
  "auditorInspection",
  "notifyCmd",
  "tokenLimit",
  "wedgeAlertMinutes",
  "autoResume",
  "decisionPopup",
  "decisionPauseBudget",
  "carryover",
  "autoAcceptDrafts",
  "versionDisplay",
  "auditCap",
  "auditCapHard",
  "mechanicalLoadScale",
  "auditFeedbackChars",
  "auditorSilent",
  "auditorProgressSignals",
  "hourlyRetryProbe",
  "subagentModelStrategy",
  "subagentModelOverrides",
  "subagentThinkingOverrides",
  "subagentFallbacks",
  "subagentDisplayRichness",
  "aggressiveMode",
  "stuckMaxInterventions",
  "subagentHangEscalationMinutes",
  "stallEscalationRefires",
  "zombieRetryMaxAttempts",
  "stallShortWords",
  "stallSimilarityThreshold",
  "postaudit",
  "toolOverrides",
  "contextCheckpointProjection",
  "reviewer", // v0.33.1: legacy alias — menu saves can still write it (when postaudit is unset) and load-migration consolidates it into postaudit on the next read; provenance must know it exists or reviewer-sourced values report "unknown"
];

/** Per-role source of each subagent fallback chain: the layer whose map
 * actually defines that role after normalization (project role wins, else
 * global). Roles in neither map are absent from the result — the row
 * builder falls back to `default` for a chain-less role. */
export function subagentFallbackRoleSources(cwd: string): Record<string, "project" | "global"> {
  const normalizeLayer = (value: Record<string, unknown>): Record<string, unknown> =>
    normalizeLoadedSettings({ ...value } as Settings) as unknown as Record<string, unknown>;
  const proj = normalizeLayer(migrateLegacySettings(readSettingsFile(projectSettingsPath(cwd))));
  const glob = normalizeLayer(migrateLegacySettings(readSettingsFile(globalSettingsPath())));
  const projMap = (proj.subagentFallbacks ?? {}) as Record<string, string[]>;
  const globMap = (glob.subagentFallbacks ?? {}) as Record<string, string[]>;
  const out: Record<string, "project" | "global"> = {};
  for (const role of new Set([...Object.keys(projMap), ...Object.keys(globMap)])) {
    // Normalized layers prune empty chains, so presence means a live chain.
    out[role] = Object.prototype.hasOwnProperty.call(projMap, role) ? "project" : "global";
  }
  return out;
}

/** Where each effective setting comes from (for the /glla display). */
export function settingsProvenance(cwd: string): Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }> {
  const rawProject = migrateLegacySettings(readSettingsFile(projectSettingsPath(cwd)));
  const rawGlobal = migrateLegacySettings(readSettingsFile(globalSettingsPath()));
  // Normalize each explicitly configured layer independently before
  // precedence. Do not merge defaults into these layer objects: absence must
  // stay absent so a normalized project value can fall through to global.
  const normalizeLayer = (value: Record<string, unknown>): Record<string, unknown> =>
    normalizeLoadedSettings({ ...value } as Settings) as unknown as Record<string, unknown>;
  const proj = normalizeLayer(rawProject);
  const glob = normalizeLayer(rawGlobal);
  const effective = loadSettings(cwd);
  const out: Record<string, { value: unknown; source: "project" | "global" | "default" }> = {};
  for (const k of SETTINGS_KEYS) {
    const hasProject = !GLOBAL_ONLY_KEYS.has(k) && Object.prototype.hasOwnProperty.call(rawProject, k) && proj[k] !== undefined;
    const hasGlobal = Object.prototype.hasOwnProperty.call(rawGlobal, k) && glob[k] !== undefined;
    if (hasProject) out[k] = { value: proj[k], source: "project" };
    else if (hasGlobal) out[k] = { value: glob[k], source: "global" };
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

/** v0.39.46 (note.md): autoAcceptDrafts is now SYSTEM-WIDE (§3 of the
 * objective). It used to be a project-scope key: the draft dialog offered
 * "always auto-accept drafts for this project" and wrote it per project, so on
 * any other project the dialog reappeared and the user had to opt in again per
 * tree. Moving the key into GLOBAL_ONLY_KEYS makes one switch govern every
 * project; loadSettings() drops a stale project-scope copy so it can never
 * shadow the global truth.
 *
 * The scope move creates a silent-drop hazard, which is what this guard
 * removes: a caller that still writes the key at project scope would have its
 * value deleted by the cleanup loop below while reporting success (the exact
 * "looks saved, never applied" trap that comment warns about). Refuse loudly
 * instead — a save that cannot land must never look like one that did. Only an
 * explicit `undefined` (key unset) is tolerated: that is a deliberate removal,
 * and clearing a stray global-only key from a project file is precisely what
 * the cleanup loop is for.
 *
 * v0.39.46: this MUST receive the canonicalized patch. Migration can turn a
 * legacy alias into a global-only key (`auditorModelFallback` →
 * `auditorModelFallbacks`), and validating the raw argument missed that path
 * entirely. `givenKeys` lets the refusal name both the canonical key and the
 * alias the caller actually passed, since that is what they will search for. */
export function assertProjectSaveAllows(patch: Partial<Settings>, givenKeys: readonly string[] = []): void {
  const offending = Object.entries(patch)
    .filter(([k, v]) => v !== undefined && GLOBAL_ONLY_KEYS.has(k as keyof Settings))
    .map(([k]) => k)
    .sort();
  if (offending.length) {
    // Name the caller's own spelling when the offending key was produced by
    // migration from an alias — the canonical name may not appear anywhere in
    // their code.
    const aliased = offending.filter((k) => !givenKeys.includes(k));
    const aliasNote = aliased.length > 0 && givenKeys.length > 0
      ? ` (migrated from ${givenKeys.filter((g) => !offending.includes(g)).join(", ") || "a legacy alias"})`
      : "";
    throw new Error(
      `saveSettings("project") cannot persist global-only setting(s): ${offending.join(", ")}${aliasNote} — ` +
      `these are system-wide and must be saved with scope "global"`,
    );
  }
}

export function saveSettings(scope: "global" | "project", cwd: string, patch: Partial<Settings>): void {
  if (scope === "project" && stateRootPending()) {
    throw new Error("state root pending (sessionDir mode, no session dir yet) — project settings save deferred");
  }
  // v0.39.46 (audit round 4): validate the CANONICALIZED patch, not the raw
  // argument. Migration can CREATE a global-only key from a supported legacy
  // alias — `auditorModelFallback` migrates to the global-only
  // `auditorModelFallbacks` — so checking the raw patch let such a write reach
  // the cleanup loop below and be discarded while saveSettings returned
  // normally. That is the exact silent-drop the guard exists to prevent.
  const migratedPatch = migrateLegacySettings(patch);
  if (scope === "project") assertProjectSaveAllows(
    migratedPatch as unknown as Partial<Settings>,
    Object.keys(patch),
  );
  const file = scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
  withSettingsFileLock(file, () => {
    const current = migrateLegacySettings(readSettingsFile(file));
    const next: Record<string, unknown> = { ...current };
    if (scope === "project") {
      for (const key of GLOBAL_ONLY_KEYS) delete next[key];
    }
    for (const [k, v] of Object.entries(migratedPatch)) {
      // Main recovery settings are global-only. A stray value left in an old
      // project file is dropped so it cannot appear saved while being unable to
      // affect the runtime; an explicit undefined still reaches here as a
      // deliberate unset. A non-undefined global-only write never reaches this
      // branch — assertProjectSaveAllows() rejected it before the lock.
      if (scope === "project" && GLOBAL_ONLY_KEYS.has(k as keyof Settings)) {
        delete next[k];
        continue;
      }
      if (v === undefined) delete next[k]; // key=unset removes the key
      else if (k === "mainModelFallbacks" || k === "drafterModelFallbacks" || k === "designerModelFallbacks" || k === "compactorModelFallbacks" || k === "auditorModelFallbacks") next[k] = normalizeMainModelFallbackRefs(v);
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
  // v0.39.46 (audit item 3): a global-scope save is the moment the authoritative
  // value lands, so it is also the right moment to evict a stale project-scope
  // copy of the same key from disk. This lives on a MUTATING path by design —
  // the read path (loadSettings) must stay side-effect free, because read-only
  // surfaces (`/glla status`, `/list show`) are contractually forbidden from
  // writing settings.
  if (scope === "global") cleanStaleGlobalOnlyProjectKeys(cwd, projectSettingsPath(cwd));
}
