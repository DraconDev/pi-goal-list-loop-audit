/**
 * pi-goal-list-loop-audit — v0.24.5
 * extensions/goal-loop-core.ts
 *
 * Shared types, state machine, JSONL persistence, helpers.
 *
 * Design: see docs/DESIGN.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { normalizeProviderErrorText, providerErrorFingerprint, providerErrorPresentation, sanitizeProviderAuditReport, sanitizeProviderDisplayText, type QuotaSignal } from "./quota-retry.js";
import { MAX_AUDITOR_CANDIDATE_REFS, MAX_MAIN_MODEL_FALLBACKS, normalizeBoundedModelRefs } from "./main-model-recovery.js";
import { resolveGllaStateDir, stateRootPending } from "./glla-state-root.js";
export { normalizeProviderErrorText, providerErrorFingerprint, providerErrorPresentation, sanitizeProviderAuditReport, sanitizeProviderDisplayText } from "./quota-retry.js";
export { globalSettingsPath, resolveRuntimeSessionDir, setRuntimeSessionDir, setRuntimeSessionDirFromSessionManager, stateRootPending, type GllaStateRoot } from "./glla-state-root.js";

/** One primary + the ten configured auditor fallbacks + the session-model
 * last resort. This is separate from the ten-slot settings bound because the
 * durable cursor must survive the complete runtime chain. */
export { MAX_AUDITOR_CANDIDATE_REFS } from "./main-model-recovery.js";

/** v0.26.1: consecutive heartbeat refires without a real agent turn
 * before the supervisor gives up (pauses the goal / stops the loop).
 * 0 = never escalate (legacy silent-spin behavior). */
export const DEFAULT_STALL_ESCALATION_REFIRES = 5;

/** v0.26.1: pure gate — has the refire streak hit the escalation
 * threshold? threshold 0 disables escalation entirely. */
export function shouldEscalateStall(consecutiveStalls: number, threshold: number): boolean {
  return threshold > 0 && consecutiveStalls >= threshold;
}

/** The next top-of-hour (:00:00.000) strictly after now — the hourly
 *
 * v0.34.92: superseded by nextHourlyProbeMs for the actual probe ticker
 * (the prompt slot is no longer used — the v0.34.58/v0.34.90 prompt
 * machinery is removed). Kept here so any external caller (older
 * extensions, the LEGACY hourlyPromptMs that may be referenced elsewhere)
 * still compiles. */
export function nextHourlyPromptMs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

/** v0.34.92: the next :00:30 strictly after now — the hourly retry ticker
 * slot. We use :00:30 (not :00:00) to leave a small clock-skew margin before
 * the extra attempt. The slot is per-hour: at 14:00:01 the next slot is
 * 14:00:30 (29s away); at 14:00:31 the next slot is 15:00:30. */
export function nextHourlyProbeMs(now = Date.now()): number {
  const d = new Date(now);
  // Start with this hour's :00:30
  d.setMinutes(0, 30, 0);
  if (d.getTime() <= now) {
    // Already past this hour's :00:30 — jump to next hour
    d.setHours(d.getHours() + 1);
  }
  return d.getTime();
}

// =================================================================
// Types
// =================================================================

export type Status =
  | "active"
  | "auditing"
  | "complete"
  | "paused"
  | "aborted";

export type Policy = "goal" | "list"; // v0.3.0: "loop".

/** Explicit specialist routing requested by the user or by a task plan. */
export type AgentRole = "designer";

/** User-facing controls whose command root follows the active goal policy. */
export type ModeCommand = "pause" | "tweak" | "resume";

/** Return the command root for a supervised work surface. */
export function workCommandRoot(mode: Policy | "loop" | undefined): "/goal" | "/list" | "/loop" {
  if (mode === "list") return "/list";
  if (mode === "loop") return "/loop";
  return "/goal";
}

/** Build a mode-correct pause/tweak/resume command for a goal or list item. */
export function modeCommand(mode: Policy | undefined, command: ModeCommand): string {
  return `${workCommandRoot(mode)} ${command}`;
}

/** Build a command for a goal, list item, or metric loop. */
export function workCommand(mode: Policy | "loop" | undefined, command: string): string {
  return `${workCommandRoot(mode)} ${command}`;
}

export interface Task {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete";
  /** Optional specialist hand-off for this task. */
  agentRole?: AgentRole;
  /** Optional verification gate for milestone-checked tasks. */
  verificationContract?: string;
  subtasks?: Task[];
}

export interface TaskList {
  version: 1;
  tasks: Task[];
}

// =================================================================
// Task-list proposal validation (used by the propose_task_list tool)
//
// The caps are the fix for pi-goal-x flaw #4: the agent could grow subtasks
// indefinitely, drifting into self-generated busywork. Hard limits keep a
// breakdown a breakdown.
// =================================================================

export const MAX_TOP_LEVEL_TASKS = 20;
export const MAX_SUBTASKS_PER_TASK = 5;

export interface TaskProposal {
  title: string;
  agentRole?: AgentRole;
  verificationContract?: string;
  subtasks?: string[];
}

/** Validate a proposed breakdown. Returns an error string or null. */
export function validateTaskProposal(tasks: TaskProposal[]): string | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return "Empty task list.";
  if (tasks.length > MAX_TOP_LEVEL_TASKS) {
    return `Too many top-level tasks (${tasks.length}); max ${MAX_TOP_LEVEL_TASKS}. Coarser granularity, please.`;
  }
  for (const t of tasks) {
    if (!t.title || !t.title.trim()) return "Every task needs a non-empty title.";
    const n = t.subtasks?.length ?? 0;
    if (n > MAX_SUBTASKS_PER_TASK) {
      return `Task "${t.title}" has ${n} subtasks; max ${MAX_SUBTASKS_PER_TASK}. Merge or split into coarser tasks.`;
    }
  }
  return null;
}

/** Assign hierarchical ids ("1", "1.1", …) and pending statuses to a proposal. */
export function buildTaskList(tasks: TaskProposal[]): TaskList {
  return {
    version: 1,
    tasks: tasks.map((t, i) => ({
      id: String(i + 1),
      title: t.title.trim(),
      status: "pending" as const,
      ...(t.agentRole ? { agentRole: t.agentRole } : {}),
      ...(t.verificationContract ? { verificationContract: t.verificationContract } : {}),
      subtasks: (t.subtasks ?? []).map((s, j) => ({
        id: `${i + 1}.${j + 1}`,
        title: s.trim(),
        status: "pending" as const,
      })),
    })),
  };
}

export interface AuditVerdict {
  at: string;
  approved: boolean;
  disapproved: boolean;
  /** v0.24.2: the auditor's third verdict — the goal can NEVER be satisfied as stated. */
  impossible?: boolean;
  impossibleReason?: string;
  model: string;
  thinkingLevel?: string;
  report?: string;
  /** Infrastructure failure detail (abort, auth, no model). Verdicts only — an entry with error and no report is not a real audit. */
  error?: string;
  /** regression_shield outcome when the goal had a verification contract. */
  regressionShieldPassed?: boolean;
  /** Contract items the shield found unreferenced (fed into the next audit's prompt, v0.22.6). */
  regressionShieldMissing?: string[];
  /** v0.34.60 (steal #3): the goal revision this audit ran against. An
   * approval recorded here is only valid for that contract revision —
   * complete_goal gates on the latest audited revision matching the
   * goal's current revision so an old approval can never be cited
   * against a tweaked contract. Legacy entries lack the field and pass
   * the gate unchanged. */
  revision?: number;
  /** v0.38.21 (objection pinning): round scoping for disapprovals. A new
   * disapproval supersedes all older live disapprovals (their objections
   * are settled context, not live); a clean approval clears the pin.
   * Legacy entries lack the field and count as live. */
  superseded?: boolean;
  /** What retired this round: `disapproval:<at>` of the superseding
   * round, or `approval:<at>` when a later approval cleared the pin. */
  supersededBy?: string;
  /** Wall-clock audit duration. Read by the audit-history formatter. */
  durationMs?: number;
}

/** The display classification for one stored auditor result. Keep semantic
 * verdicts separate from operational failures: a shield-blocked approval is
 * not a disapproval, and an infrastructure error is not a verdict at all. */
export type AuditVerdictLabel =
  | "approved"
  | "disapproved"
  | "impossible"
  | "shield-blocked"
  | "infrastructure failure"
  | "no verdict";

export function auditVerdictLabel(v: Pick<AuditVerdict, "approved" | "disapproved" | "impossible" | "error" | "regressionShieldPassed">): AuditVerdictLabel {
  if (v.approved && v.regressionShieldPassed === false) return "shield-blocked";
  if (v.approved) return "approved";
  if (v.impossible) return "impossible";
  if (v.disapproved) return "disapproved";
  if (v.error) return "infrastructure failure";
  return "no verdict";
}

/**
 * Sum token usage across assistant messages, counting each message once.
 * `agent_end` events may include already-seen history, so callers pass a
 * dedup set keyed by timestamp+tokens (good-enough identity for counting).
 *
 * v0.12.0: counts input+output (real spend) when the usage object carries
 * the split; totalTokens includes cache reads, which inflate 10-50× on long
 * sessions (a day-long goal "used" 216M while real spend was a fraction).
 */
export function sumNewAssistantTokens(messages: unknown[], seen: Set<string>): number {
  let total = 0;
  for (const m of messages) {
    const msg = m as {
      role?: string;
      timestamp?: unknown;
      usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
    };
    if (msg?.role !== "assistant") continue;
    const u = msg.usage;
    const split = (typeof u?.input === "number" ? u.input : 0) + (typeof u?.output === "number" ? u.output : 0);
    const tokens = split > 0 ? split : (typeof u?.totalTokens === "number" ? u.totalTokens : 0);
    if (tokens <= 0) continue;
    const key = `${String(msg.timestamp ?? "?")}:${tokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += tokens;
  }
  return total;
}

export type CompletionAuditPhase = "running" | "recovery-pending" | "retry-waiting" | "quota-waiting";
export type AuditorRecoveryFailureClass = "transport" | "timeout" | "no-verdict" | "provider";

/** Durable completion claim metadata. The claim itself is the user's exact
 * completion assertion; the lifecycle fields make an interrupted isolated
 * audit distinguishable from one that is actively running. Fields beyond
 * `at` are optional so v0.34.20 and older claims remain recoverable. */
export interface PendingCompletion {
  completionSummary?: string;
  verificationSummary?: string;
  /** When the completion claim was first persisted. */
  at: string;
  /** Current audit lifecycle. Missing = legacy claim, treated as recovery-pending. */
  phase?: CompletionAuditPhase;
  /** Identifies the isolated-auditor attempt, not the goal. */
  attemptId?: string;
  /** Start time for the current isolated-auditor attempt. */
  startedAt?: string;
  /** Why the claim is waiting for a fresh attempt. */
  recoveryAt?: string;
  recoveryReason?: string;
  /** Durable due time for the one bounded no-verdict recovery retry. */
  recoveryRetryAt?: string;
  /** Bounded raw provider/auditor diagnostic retained for forensics only. */
  providerErrorDiagnostic?: string;
  /** Stable identity for one detached-auditor provider recovery episode. */
  recoveryEpisodeKey?: string;
  /** Durable per-episode notice fence; display projections must consult it. */
  recoveryNoticeKeys?: string[];
  /**
   * Durable one-shot recovery fence. A parked claim may receive one
   * automatic retry after a validated healthy lifecycle/recovery event;
   * manual /goal resume remains available after that attempt. Missing on
   * legacy claims means "not yet consumed".
   */
  automaticRecoveryAttempted?: boolean;
  automaticRecoveryAt?: string;
  automaticRecoveryGeneration?: number;
  /** Legacy horizon field. Conservative mode uses it; aggressive mode leaves
   * it absent and continues from lifecycle/progress signals until a state-based
   * stop applies. */
  automaticRecoveryAttempts?: number;
  automaticRecoveryFirstAt?: string;
  automaticRecoveryUntil?: string;
  /** v0.36.1: bounded detached-auditor candidate cursor. Refs are model
   * identifiers only — never model objects or credentials. The current ref
   * is retried at most once; attemptedRefs contains only candidates already
   * exhausted before it. */
  auditorCandidateRefs?: string[];
  auditorCandidateRef?: string;
  /** Set only after the first transient failure; a restart uses this marker
   * to spend the already-authorized second call, never a third call. */
  auditorRetryCandidateRef?: string;
  /** Set immediately before launching that second call. If the host restarts
   * after this point, the unknown call is consumed rather than replayed. */
  auditorRetryAttemptStartedAt?: string;
  auditorAttemptedRefs?: string[];
  /** 0 = first call in flight, 1 = first failure/retry in flight, 2 = a
   * terminal second failure. State loading clamps this to [0, 2]. */
  auditorFailureCount?: number;
  auditorFailureClass?: AuditorRecoveryFailureClass;
  auditorFallbackExhausted?: boolean;
  auditorFailureAt?: string;
  /** v0.37.0: adaptive-timeout escalation index. Incremented once per
   * launched detached attempt (persisted through the same cursor writes as
   * the candidate position), so the ×2-per-attempt budget schedule survives
   * host restarts and candidate fallbacks. A NEW completion claim starts at
   * 0 (undefined); a retried claim keeps its escalated position — a slow
   * model is a machine fact, not an attempt fact. Clamped to [0, 100] on
   * load. */
  timeoutEscalation?: number;
  /** Durable generic retry accounting; survives reloads and worker restarts. */
  retryAttempts?: number;
  retryFirstAt?: string;
  retryUntil?: string;
  /** @deprecated v0.34.142: migrated to the generic retry fields on load. */
  quotaAttempts?: number;
  quotaFirstAt?: string;
  quotaAutoRetryUntil?: string;
  /** @deprecated v0.34.142: retained only when reading older state. */
  quotaSignal?: QuotaSignal;
  /** @deprecated v0.34.142: upstream hints never control scheduling. */
  retryAfterSec?: number;
  retryFromUpstream?: boolean;
  resetAt?: string;
}

export interface ObjectiveRepairTarget {
  /** Queue/goal identity of the malformed intent that needs a replan. */
  id: string;
  objective: string;
  verificationContract?: string;
  reasons: string[];
  source: string;
  /** Durable one-shot guard: the repair bootstrap turn was already sent.
   * A user-confirmed task-list redraft clears the whole target; an explicit
   * resume may clear this timestamp to retry one bounded bootstrap turn. */
  replanPromptedAt?: string;
}

export interface ObjectiveRepairRecord {
  at: string;
  action: "auto-applied" | "queued";
  originalObjective: string;
  replacementObjective?: string;
  originalContract?: string;
  replacementContract?: string;
  source: string;
  reason: string;
  evidence: string;
  confidence: "best-effort" | "fallback";
  revisionBefore: number;
  revisionAfter: number;
}

/** Durable intent captured before an objective can be overwritten by a
 * reviewer fragment, transcript replay, or malformed queue restore. */
export interface ObjectiveProvenance {
  originalObjective: string;
  originalContract?: string;
  userSeeds?: string[];
}

export interface Goal {
  id: string;
  objective: string;
  status: Status;
  policy: Policy;
  /** Explicit specialist routing requested for this goal/list item. */
  agentRole?: AgentRole;
  verificationContract?: string;
  autoContinue: boolean;
  /** v0.34.81 (LIGHT parent/child): set ONLY when this goal was activated
   * from a queue item that declared `Subtask of: <parent objective>`. The
   * parent is identified by its queue item id so the cascade on completion
   * can locate it without resolving objectives at archive time. Persists in
   * state.json (the durable goal .md is a render projection and intentionally
   * does not carry this — a crash-restart that drops it leaves the parent
   * visible as a plain queue item rather than mis-handling the cascade). */
  parentId?: string;
  /** v0.35.1: a control goal created to re-plan suspicious saved intent.
   * It is cleared only after a confirmed task-list re-draft, so the generic
   * repair card cannot complete repeatedly while the original target remains
   * opaque in the queue. */
  repairTarget?: ObjectiveRepairTarget;
  taskList?: TaskList;
  auditHistory?: AuditVerdict[];
  stopReason?: string;
  /** v0.34.91/v0.36.0: the six-label user-facing completion recap. Valid
   * executor claims are preserved; terminal archive finalization supplies a
   * recorded-facts-only fallback for missing, generic, incomplete, aborted,
   * or legacy claims. */
  completionSummary?: string;
  pauseReason?: string;
  pauseSuggestedAction?: string;
  /** v0.28.22: pause classification — drives the widget/status rendering
   * (a decision pause, an operational failure, a time-gated wait, and a
   * generic block must not look alike). Undefined = legacy flat card. */
  pauseKind?: "decision" | "error" | "wait" | "blocked";
  /** v0.28.22: decision pauses — the options the user picks between. */
  pauseOptions?: string[];
  /** v0.28.22: 1-based index into pauseOptions the agent recommends. */
  pauseRecommended?: number;
  /** v0.28.22: ISO time a wait-pause becomes resumable (countdown shown). */
  pauseResumeAt?: string;
  /** v0.35.28 (issue #16): set when glla AUTO-resumed a lapsed wait — the
   * continuation prompt renders a recovery notice from it so the agent
   * understands IT was the session that was disconnected and recovered
   * (issue #16 part 2: agents waited "for themselves to be recovered").
   * Cleared by an explicit manual /goal resume. */
  autoResumedAt?: string;
  autoResumedEvent?: string;
  /** v0.28.1 (S1/S2): stale-handle interrupt marker. Set INSTEAD of pausing
   * when pi invalidates the extension handle mid-goal — the goal stays
   * active so a fresh session auto-resumes it via the restore gate. Cleared
   * on that auto-resume. */
  interruptedAt?: string;
  interruptedReason?: string;
  /** v0.28.5 (E2): trailing auditor INFRA-structure errors (not verdicts).
   * At 3 the goal pauses loudly — a broken auditor model must not spin a
   * silent retry-forever loop. Cleared on any real auditor run. */
  auditInfraStreak?: number;
  /** v0.34.15: persisted error-brake rung — survives /reload so the 6-brake park can engage. */
  errorBrakeStreak?: number;
  /** v0.28.26: the completion claim captured when an audit attempt stops
   * before a verdict. The stored-claim retry re-runs the AUDITOR directly
   * instead of re-engaging the agent — re-engaging produced a
   * hallucinated-closure repetition loop in the field (π-games 2026-07-29:
   * the agent concluded the goal was closed, stopped calling complete_goal,
   * and repeated the same essay until the stall brake fired). Cleared when
   * the retry resolves. Only consumed while paused in the auditor-retry
   * lifecycle, so a stale value is unreachable by construction. */
  pendingCompletion?: PendingCompletion;
  /** v0.28.28: provenance — who created this goal ("user", "list-cascade",
   * "draft-confirmed", "draft-autoaccepted"). Ledgered on goal_created so
   * "where did this come from" is answerable after the fact. */
  createdVia?: string;
  /** v0.25.0 (contract item 22): auditor objections extracted as TODOs when
   * aggressiveMode keeps the goal active past the disapproval cap. Rendered
   * into every continuation prompt until the next audit clears them. */
  pendingTasks?: string[];
  /** v0.36.1: explicit durable-vs-defer facts retained with the active goal
   * so every UI refresh can project the same recommendation the agent
   * recorded in the ledger, including after a reload. */
  durableDeferRecommendation?: DurableDeferRecommendationInput;
  activePath?: string;
  archivedPath?: string;
  usage: {
    tokensUsed: number;
    tokensLimit: number;
  };
  createdAt: string;
  updatedAt: string;
  /** Bounded raw provider diagnostic retained for the active/archive record;
   * user-facing projections use the sanitized pause/recovery copy instead. */
  providerErrorDiagnostic?: string;
  /** Stable provider recovery episode identity for goal-level error brakes. */
  recoveryEpisodeKey?: string;
  /** Durable per-episode notice fence for goal-level recovery messages. */
  recoveryNoticeKeys?: string[];
  /** v0.25.2: per-goal telemetry for /glla stats premature-success
   * detection. Bumped live: turns on agent_end, fileWrites/bashCalls on
   * tool_result while the goal is active. */
  telemetry?: { turns: number; fileWrites: number; bashCalls: number };
  /** v0.34.59: focus token / revision counter on every goal mutation.
   * Persisted alongside the goal; bumped on every persistState. Detached
   * workers capture (goalId, revision) at dispatch and refuse to apply
   * their result if the captured revision no longer matches — a stale
   * handle cannot silently overwrite a goal that moved on. */
  revision?: number;
  /** v0.35.x: durable record of suspicious-objective recovery decisions. */
  objectiveRepairHistory?: ObjectiveRepairRecord[];
  /** v0.35.x: original/user-supplied intent retained for repair after a
   * reviewer fragment or stale state overwrites the live objective. */
  objectiveProvenance?: ObjectiveProvenance;
}

/**
 * Route `/goal` args (v0.8.0 top-level consolidation). Subcommands match ONLY
 * on exact word (except tweak/archive which take args) — an objective that
 * starts with "pause" ("/goal pause the pipeline and fix it") must set a
 * goal, not pause one.
 */
export type GoalRoute =
  | { kind: "draft" }
  | { kind: "set"; text: string }
  | { kind: "sub"; name: "status" | "pause" | "resume" | "cancel" | "decide" | "verify" | "audit" | "tweak" | "archive" | "start" | "plan"; rest: string };

// v0.29.8: "audit" moved to ARG subs ("/goal audit [focus]" is the one-shot
// project audit — user: "/goal audit IS the audit goal"); the v0.28.27
// manual current-goal verification moved to "verify" (it happens
// automatically at completion anyway — verify is the on-demand handle).
const GOAL_EXACT_SUBS = new Set(["status", "pause", "resume", "cancel", "decide", "verify"]);
const GOAL_ARG_SUBS = new Set(["audit", "tweak", "archive", "start", "plan"]);

export function routeGoalArgs(raw: string): GoalRoute {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "draft" };
  const space = trimmed.indexOf(" ");
  const first = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  if (GOAL_EXACT_SUBS.has(first) && rest === "") {
    return { kind: "sub", name: first as "status" | "pause" | "resume" | "cancel" | "decide" | "verify", rest: "" };
  }
  if (GOAL_ARG_SUBS.has(first)) {
    return { kind: "sub", name: first as "audit" | "tweak" | "archive" | "start" | "plan", rest };
  }
  return { kind: "set", text: trimmed };
}

/** v0.35.33: drafting depth. "plan" is the EXTENDED DRAFT — research-first
 * (read the code before asking), multi-round interviewing, and a structured
 * expanded objective. It changes the PROMPT, never the trust machinery: the
 * Confirm card still gates activation and the regular draft stays the fast
 * path. No separate artifact — the objective itself is the single truth
 * (the respec lesson: a second document always goes stale). */
export type DraftingDepth = "normal" | "plan";

export function draftingTemplateFile(target: "goal" | "list" | "loop", depth: DraftingDepth): string {
  if (depth === "plan") return target === "loop" ? "goal-loop-plan-loop.md" : "goal-loop-plan.md";
  return target === "loop" ? "goal-loop-forever-draft.md" : "goal-loop-draft.md";
}

/**
 * Parse a bulk list-import file (v0.8.1): markdown checklists (`- [ ]`,
 * `- [x]`), bullets (`-`, `*`, `•`), numbered items (`1.`, `2)`), and plain
 * lines all become list items. Headings (`# …`), blank lines, and HTML
 * comments are skipped. A sisyphus-style plan file should import clean.
 */
export function parseListImport(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split("\n")) {
    let t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue;                    // headings
    if (t.startsWith("<!--")) continue;                 // html comments
    if (/^[-=_*]{3,}$/.test(t)) continue;               // hr rules
    t = t.replace(/^-\s*\[[ xX]\]\s*/, "");              // - [ ] / - [x]
    t = t.replace(/^[-*•]\s+/, "");                      // bullets
    t = t.replace(/^\d+[.)]\s+/, "");                    // 1. / 2)
    t = t.trim();
    if (t) items.push(t);
  }
  return items;
}

/** v0.35.35 (audit finding 2026-08-23): the v0.35.31 user-seed trust compared
 * the CLEANED goal.objective against RAW stored seeds with exact equality —
 * but createGoal strips "Done when:" clauses and @agent roles out of the
 * objective while keeping the raw arg as the seed, so any seeded goal WITH a
 * clause/role silently no-op'd the trust and still parked behind the
 * suspicious-objective heuristic. Fix: normalize BOTH sides through the SAME
 * extraction pipeline the creation path applies (role first, then contract,
 * mirroring createGoal). This widens nothing about WHO authored the text —
 * agent-authored seeds stay untrusted (createdVia gate unchanged). */
export function objectiveIsUserSeeded(goal: Pick<Goal, "objective" | "createdVia" | "objectiveProvenance">): boolean {
  if (goal.createdVia !== "user") return false;
  const target = goal.objective.trim();
  if (!target) return false;
  return !!(goal.objectiveProvenance?.userSeeds ?? []).some((seed) => {
    const raw = seed.trim();
    if (raw === target) return true;
    const cleaned = extractVerificationContract(extractAgentRole(raw).objective).objective.trim();
    return cleaned === target;
  });
}

/**
 * A long-running goal whose next turn is a health check should not look like
 * a wedged queue. Keep this predicate pure and shared by scheduling and both
 * TUI surfaces so a goal cannot be throttled without receiving the matching
 * monitoring icon (or vice versa).
 */
export function isMonitorGoal(goal: Pick<Goal, "objective" | "createdAt">, now = Date.now()): boolean {
  const objective = goal.objective.toLowerCase();
  if (/daemon|supervisor|keep.*running|monitor|healthz|book-daemon/.test(objective)) return true;
  const started = Date.parse(goal.createdAt);
  return Number.isFinite(started) && now - started > 60 * 60 * 1000;
}

/**
 * During a LIST drafting session the agent must not add items one by one
 * with list_add/list_activate — that bypasses the user's Confirm gate
 * (observed in the wild: the agent decomposed a dump and ACTIVATED the first
 * item with zero confirmation). The batch path is propose_goal_draft's
 * items[]: one Confirm for the whole list. User commands (/list add) are
 * unaffected — only the agent tools are gated.
 */
export function listMutationBlocked(draftingTarget: string | null): boolean {
  return draftingTarget === "list";
}

export const LIST_DRAFTING_BLOCK_MESSAGE =
  "LIST DRAFTING IN PROGRESS — do not add items one by one. Decompose the request into an items[] array and call propose_goal_draft ONCE: the user confirms the whole batch in a single dialog. list_add / list_activate work again after the drafting session ends.";

/**
 * v0.34.51: /list subcommands that persist or activate work — refused on a
 * stale extension handle by cmdList's entry probe. Read-only verbs (show,
 * depth, status) stay available so the user can still inspect the queue
 * while the lifecycle replacement is pending. The natural-language dump
 * fallthrough is always mutating and is gated separately at the call site.
 */
export const LIST_MUTATING_SUBCOMMANDS = new Set([
  "audit",
  "plan", // v0.35.33: extended draft — sends a seed, same mutation class as add
  "tweak",
  "pause",
  "resume",
  "add",
  "import",
  "clear",
  "cancel",
  "next",
  "start", // explicit queue-head activation or bounded context fallback
  "remove",
  "rm",
]);

/**
 * v0.34.52: /glla verbs that open a settings surface or persist config —
 * refused on a stale extension handle by cmdSettings' entry probe, mirroring
 * the /list gate. Bare /glla (verb "ui") is the settings entry itself: every
 * table choice writes state. wipe/reset/cancel/resume/reviewer/postaudit/
 * tooloverride mutate directly. Read-only surfaces (status, log, stats,
 * audits) and the unknown-action notice stay available for inspection.
 */
export const SETTINGS_MUTATING_ACTIONS = new Set([
  "wipe",
  "reset",
  "cancel",
  "fallbacks",
  "resume",
  "pause",
  "reviewer",
  "postaudit",
  "tooloverride",
]);

/**
 * Route natural-language text handed to `/list` with no subcommand verb
 * (v0.18.0). The user typed a dump — "fix x, do y, write docs" — not a
 * command. Flexible by detection, never a usage error:
 *   file path        → bulk import (sisyphus/Ralph plan file)
 *   multi-line paste → batch add (structure is already explicit)
 *   has "Done when:" → one direct item (explicit contract)
 *   anything else    → conversational decomposition (drafting session;
 *                      the agent shapes it into items[], one Confirm)
 * The explicit verb `/list add` stays the direct escape hatch (symmetric
 * with `/goal start`): it skips the draft branch.
 */
export type ListTextRoute =
  | { kind: "file"; path: string }
  | { kind: "batch"; items: string[] }
  | { kind: "direct"; text: string }
  | { kind: "draft"; seed: string };

export function routeListText(cwd: string, raw: string): ListTextRoute {
  const importFile = resolveImportFile(cwd, raw);
  if (importFile) return { kind: "file", path: importFile };
  if (raw.includes("\n")) {
    const pasted = parseListImport(raw);
    if (pasted.length > 1) return { kind: "batch", items: pasted };
  }
  if (!goalArgsNeedDrafting(raw)) return { kind: "direct", text: raw };
  return { kind: "draft", seed: raw };
}

/**
 * Detect whether a `/list add` argument is a readable file (v0.8.2). File
 * detection, not a separate verb: `/list add plan.md` bulk-imports when the
 * path exists, and is an objective when it doesn't. Returns the absolute
 * path or null. Directories return null.
 */
export function resolveImportFile(cwd: string, arg: string): string | null {
  const trimmed = arg.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  // Cheap short-circuit: objectives rarely look like paths; require a path
  // separator or a file-extension-ish suffix before hitting the filesystem.
  if (!/[\\/]/.test(trimmed) && !/\.[A-Za-z0-9]{1,8}$/.test(trimmed)) return null;
  try {
    const abs = path.resolve(cwd, trimmed);
    const stat = fs.statSync(abs);
    return stat.isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Layered settings merge (v0.7.0): later layers win, but only for keys they
 * actually define — an `undefined` value in a layer means "not set here",
 * never "set to undefined". Used for defaults → global → project resolution.
 */
export function mergeSettings<T extends Record<string, unknown>>(base: T, ...layers: Array<Partial<T> | null | undefined>): T {
  const out: Record<string, unknown> = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out as T;
}

/**
 * Default for executor-visible auditor feedback. 0 = no cap: the executor
 * gets the FULL disapproval report (v0.24.9 — truncating by default cut
 * exactly the actionable tail of multi-item <evidence> blocks; a few KB of
 * report is negligible next to a wasted re-attempt). Set a positive
 * auditFeedbackChars to cap.
 */
export const DEFAULT_AUDIT_FEEDBACK_CHARS = 0;

/**
 * Bound the auditor report returned to the executor after disapproval.
 * A limit of 0 explicitly means "show the full report".
 */
/** Executor-visible excerpt of a disapproval report. Full by default
 * (maxChars 0). When capped, keep the TAIL: since v0.25.4 the auditor
 * ends disapprovals with the actionable `## Required fixes` section —
 * head-slicing would cut exactly what the executor needs. */
export function auditFeedbackExcerpt(output: string, maxChars: number): string {
  const safeOutput = sanitizeProviderAuditReport(output);
  if (maxChars === 0 || safeOutput.length <= maxChars) return safeOutput;
  return `[head truncated — full report via /goal status]
…${safeOutput.slice(-maxChars)}`;
}

export interface ListItem {
  id: string;
  objective: string;
  /** Explicit specialist routing requested for this queued item. */
  agentRole?: AgentRole;
  verificationContract?: string;
  /** v0.34.76 (OPEN-ISSUES 1.11): parallel-execution metadata DECLARATION.
   * Parsed from a `Parallel: yes|no` clause on the item text; surfaced in
   * /list show and list_status. A DECLARATION ONLY — the queue still runs
   * serially; parallel dispatch of parallelSafe items is a later milestone
   * (see audit/DESIGN-LIST-PARALLEL-2026-08-07.md). */
  parallelSafe?: boolean;
  /** v0.34.81 (LIGHT parent/child): one-level subtask binding. Set when a
   * declaration opened with `Subtask of: <parent objective> — <child…>`;
   * points at the QUEUE item whose objective matched. A parent with at least
   * one child (queued or currently active) is a GROUP, not a work item —
   * the auto-advance skips it (its first open child runs next, in order) and
   * `/list show` renders it as `[group: N open]`. When the last child closes,
   * the cascade in archiveCurrentGoal removes the group from the queue and
   * ledger-records `list_group_closed`. One level only — a parent that is
   * itself a child is refused at enqueue time (nesting is a later milestone
   * parked behind focus/unfocus in the runtime). */
  parentId?: string;
  /** Durable link from a repair/replan queue item back to the malformed item. */
  repairTarget?: ObjectiveRepairTarget;
  /** Monotonic queue position persisted with the sidecar. Legacy items omit it
   * and fall back to addedAt/id ordering during recovery. */
  queueOrder?: number;
  addedAt: string;
}

/**
 * Should /goal args go through contract drafting instead of direct activation?
 * Rule (v0.11.0): any objective WITHOUT an explicit "Done when:" clause is
 * vague enough to grill first — the pi-goal-x lesson (arg + Enter is worse
 * than a 5-minute draft). An explicit contract clause activates instantly.
 */
export function goalArgsNeedDrafting(args: string): boolean {
  const t = args.trim();
  if (!t) return false; // no-args is already the drafting path
  // v0.23.7: any "done when" phrase counts — requiring the colon to
  // immediately follow made "Done when ALL of the following are true:"
  // route to the interview even though the user wrote a contract.
  return !/\bdone\s+when\b/i.test(t);
}

/**
 * Build the seeded drafting message (v0.14.0). v0.13.0 had the PLUGIN ask
 * three canned questions — a questionnaire, not a grilling: it accepted
 * non-answers ("not sure", "none") and produced weak contracts. The LLM
 * does the interviewing (its strength); the plugin only enforces the floor
 * via draftProposalBlock: propose is blocked until the user has replied.
 */
export function buildSeedGrillMessage(tmpl: string, seed: string, tool: string): string {
  return `${tmpl}\n\n${LONG_RUNNING_JUDGMENT_POLICY}\n\nThe user's initial objective (verbatim): ${seed}\n\nGRILL THEM ABOUT THIS SEED BEFORE PROPOSING. ${tool} is BLOCKED until the user has replied to at least one of your questions — proposing without interviewing returns an error.\n\nHow to grill:\n- Ask 2-4 sharp, seed-specific questions UP FRONT in ONE batched ask_user_question call when multiple unknowns exist — about THIS objective, not generic filler. Each question ships with a recommended default the user can accept with "yes" (one picker, 2-4 concrete options per question). If only one unknown remains, one focused question is fine. Prefer the structured ask_user_question picker; plain conversation is fine for free-form answers.\n- Probe what matters in that single upfront batch: what "done" concretely looks like (checkable evidence — files, commands, behaviors), scope boundaries (what is explicitly OUT), constraints (what must not change), and priorities when the seed bundles several wishes. One well-batched interview up front eliminates mid-execution interruptions — do not dribble questions out one by one during execution.\n- A non-answer ("not sure", "none", "whatever") is a trigger to offer 2-3 concrete options to pick from — never silently proceed on a non-answer.\n- Do targeted read-only research first when it makes your questions sharper (repo layout, existing docs).\n- Do NOT activate the raw seed. Do NOT implement anything. When the contract is concrete, call ${tool}.`;
}

/**
 * The drafting floor (v0.14.0): the propose tools call this before opening
 * the user's Confirm dialog. 0 user replies since drafting started → the
 * agent is attempting a contract dump; block it with instructions. The
 * mechanism guarantees an interview HAPPENED; question quality is the
 * model's job (shaped by buildSeedGrillMessage).
 */
export function draftProposalBlock(userReplies: number, blockedAttempts = 0): string | null {
  if (userReplies > 0) return null;
  const base = "INTERVIEW FIRST — you have not received a single user reply since drafting started. Ask the user ONE sharp question about their objective (seed-specific, with a recommended default; challenge non-answers by offering concrete options), wait for the answer, and only then call the propose tool again. The Confirm dialog stays closed until the user has actually been heard.";
  // v0.15.1 escape hatch: typed chat replies AND answered ask_user_question
  // dialogs both count. If we have blocked 3+ proposals, the replies are
  // arriving through a path this plugin cannot see — hand the user a manual
  // unlock instead of manufacturing yet another interview round.
  if (blockedAttempts >= 3) {
    return base + " NOTE: proposals have been blocked repeatedly despite interviewing — the reply counter may not see your channel. Tell the user plainly: 'type any chat message (e.g. \"go on\") to unlock the Confirm dialog', wait for it, then propose again. Do NOT ask another interview question first.";
  }
  return base;
}

/**
 * v0.15.1: an ask_user_question tool result counts as a user reply during
 * drafting — dialog answers arrive as tool results, not chat messages.
 * Answered = not cancelled (Esc) with at least one answer recorded.
 */
export function askUserQuestionAnswered(toolName: string, details: unknown): boolean {
  if (toolName !== "ask_user_question") return false;
  if (!details || typeof details !== "object") return false;
  const d = details as { answers?: unknown; cancelled?: unknown };
  return d.cancelled === false && Array.isArray(d.answers) && d.answers.length > 0;
}

/**
 * Take item at 1-based index n out of the list (v0.10.0 pick-any-item
 * activation). n=1 is the head (FIFO default). Returns [taken, rest] or
 * null when n is out of range.
 */
export function takeAt<T>(items: T[], n: number): [T, T[]] | null {
  if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
  const taken = items[n - 1]!;
  return [taken, items.filter((_, i) => i !== n - 1)];
}

export interface MainModelRecovery {
  /** The model selected when this recovery episode was first observed. */
  primary: string;
  /** Bounded raw provider diagnostic retained for ledger/archive forensics. */
  providerErrorDiagnostic?: string;
  /** Stable identity for one main-model provider recovery episode. */
  recoveryEpisodeKey?: string;
  /** Durable per-episode notice fence for recovery notifications. */
  recoveryNoticeKeys?: string[];
  /** The model currently selected after one or more failovers. */
  active?: string;
  /** Candidates already tried in this recovery cycle. */
  attempted: string[];
  /** Next safe probe time; persisted so reloads do not forget the wait. */
  retryAt?: string;
  /** Next preferred-primary health probe while a fallback is serving. */
  primaryProbeAt?: string;
  /** A preferred-primary switch was accepted and awaits one supervised turn. */
  primaryProbeInFlight?: boolean;
  /** Number of completed recovery waits; drives the bounded per-attempt exponential cadence. */
  attempts: number;
  /** Human-readable provider failure excerpt. */
  reason: string;
  /** First failure in this automatic recovery episode (legacy horizon anchor). */
  firstFailureAt?: string;
  /** Conservative-mode deadline; aggressive mode omits this legacy field and
   * uses state-based stop rules instead. */
  autoRetryUntil?: string;
  /** Set only when conservative recovery reaches its horizon or an explicit
   * state-based hold requires user action. */
  manualResumeRequired?: boolean;
  /** Legacy provider hint retained only when reading old state. */
  resetAt?: string;
  /** Legacy provider family retained only when reading old state. */
  quotaSignal?: QuotaSignal;
  /** Legacy retry metadata; canonical scheduling uses retryAt/attempts. */
  retryAfterSec?: number;
  retryFromUpstream?: boolean;
  /** Storm failover can resume the selected backup before probing primary. */
  resumeCurrent?: boolean;
  /** Candidate currently crossing the async setModel boundary. A short-lived
   * parked deadline keeps a crash during switching recoverable on reload. */
  pendingModelSwitch?: string;
  /** Refs rejected while walking the ordered chain, retained for status and
   * reload diagnostics rather than silently disappearing. */
  skipped?: Array<{ ref: string; reason: "forbidden" | "unregistered" }>;
  /** Whether the suspended supervisor is a goal/list item or a loop. */
  kind: "goal" | "loop";
}

/** Compact, truthful status shared by /goal status and /list show. */
export function formatMainModelRecoveryStatus(recovery: MainModelRecovery | undefined, configuredBackups: string[] = []): string[] {
  if (!recovery) return [];
  const safeBackups = configuredBackups.filter((ref) => typeof ref === "string" && ref.trim()).slice(0, MAX_MAIN_MODEL_FALLBACKS);
  const chain = [recovery.primary, ...safeBackups];
  const current = recovery.active ?? recovery.primary;
  const currentIndex = chain.findIndex((ref) => ref.toLowerCase() === current.toLowerCase());
  const attempted = recovery.attempted.length ? recovery.attempted.join(", ") : "none";
  const skipped = recovery.skipped?.length
    ? recovery.skipped.map((entry) => `${entry.ref} (${entry.reason})`).join(", ")
    : "none";
  const lines = [
    `Main-model recovery: ${currentIndex >= 0 ? `${currentIndex === 0 ? "primary" : `backup ${currentIndex}/${safeBackups.length}`} selected` : "active model selected"}`,
    `  Order: ${chain.join(" → ")}`,
    `  Current: ${current}`,
    ...(recovery.pendingModelSwitch ? [`  Pending switch: ${recovery.pendingModelSwitch}`] : []),
    `  Attempted: ${attempted}`,
    `  Skipped: ${skipped}`,
  ];
  if (recovery.retryAt) lines.push(`  Retry at: ${recovery.retryAt}`);
  if (recovery.primaryProbeAt) lines.push(`  Preferred-primary probe at: ${recovery.primaryProbeAt}`);
  if (recovery.primaryProbeInFlight) lines.push("  Preferred-primary probe: supervised turn pending");
  if (recovery.manualResumeRequired) lines.push("  Automatic probes: stopped; explicit resume required");
  return lines;
}

/** Sanitize the durable main-model recovery projection before it reaches
 * timers or model-selection code. A truncated/hand-edited JSONL line must
 * never manufacture an unbounded retry list, invalid Date, or arbitrary
 * object that delayed lifecycle code later trusts. */
export function sanitizeMainModelRecovery(value: unknown): MainModelRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const primary = typeof raw.primary === "string" ? raw.primary.trim().slice(0, 300) : "";
  // Pre-kind recovery records were goal-owned; default them to goal rather
  // than silently discarding a saved recovery episode during an upgrade.
  const kind = raw.kind === "loop" ? "loop" : "goal";
  if (!primary) return undefined;
  const refs: string[] = [];
  const seen = new Set<string>();
  const addRef = (candidate: unknown): void => {
    if (typeof candidate !== "string") return;
    const ref = candidate.trim().slice(0, 300);
    const key = ref.toLowerCase();
    // The configured chain is capped at ten backups, but attempted also
    // includes the primary and stale/unavailable entries from a prior cycle.
    // Keep only a bounded projection; this is durable history, not a new
    // selection source.
    if (!ref || seen.has(key) || refs.length >= MAX_MAIN_MODEL_FALLBACKS + 1) return;
    seen.add(key);
    refs.push(ref);
  };
  addRef(primary);
  if (Array.isArray(raw.attempted)) for (const candidate of raw.attempted) addRef(candidate);
  const date = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate))) return undefined;
    return candidate;
  };
  const bounded = (candidate: unknown, max: number): string | undefined =>
    typeof candidate === "string" && candidate.trim() ? candidate.slice(0, max) : undefined;
  const attempts = typeof raw.attempts === "number" && Number.isSafeInteger(raw.attempts) && raw.attempts >= 0
    ? raw.attempts
    : 0;
  return {
    primary,
    ...(typeof raw.active === "string" && raw.active.trim() ? { active: raw.active.trim().slice(0, 300) } : {}),
    attempted: refs,
    attempts,
    reason: bounded(raw.reason, 600) ?? "main model recovery",
    kind,
    ...(bounded(raw.providerErrorDiagnostic, 2_000) ? { providerErrorDiagnostic: bounded(raw.providerErrorDiagnostic, 2_000) } : {}),
    ...(bounded(raw.recoveryEpisodeKey, 300) ? { recoveryEpisodeKey: bounded(raw.recoveryEpisodeKey, 300) } : {}),
    ...(Array.isArray(raw.recoveryNoticeKeys) ? { recoveryNoticeKeys: raw.recoveryNoticeKeys.filter((key): key is string => typeof key === "string").slice(-16).map((key) => key.slice(0, 300)) } : {}),
    ...(date(raw.retryAt) ? { retryAt: date(raw.retryAt) } : {}),
    ...(date(raw.primaryProbeAt) ? { primaryProbeAt: date(raw.primaryProbeAt) } : {}),
    ...(raw.primaryProbeInFlight === true ? { primaryProbeInFlight: true } : {}),
    ...(date(raw.firstFailureAt) ? { firstFailureAt: date(raw.firstFailureAt) } : {}),
    ...(date(raw.autoRetryUntil) ? { autoRetryUntil: date(raw.autoRetryUntil) } : {}),
    ...(raw.manualResumeRequired === true ? { manualResumeRequired: true } : {}),
    ...(raw.resumeCurrent === true ? { resumeCurrent: true } : {}),
    ...(typeof raw.pendingModelSwitch === "string" && raw.pendingModelSwitch.trim() ? { pendingModelSwitch: raw.pendingModelSwitch.trim().slice(0, 300) } : {}),
    ...(Array.isArray(raw.skipped) ? {
      skipped: raw.skipped
        .filter((entry): entry is { ref: string; reason: "forbidden" | "unregistered" } =>
          !!entry && typeof entry === "object"
          && typeof (entry as Record<string, unknown>).ref === "string"
          && ((entry as Record<string, unknown>).reason === "forbidden" || (entry as Record<string, unknown>).reason === "unregistered"))
        .slice(-16)
        .map((entry) => ({ ref: entry.ref.trim().slice(0, 300), reason: entry.reason }))
        .filter((entry) => entry.ref.length > 0),
    } : {}),
  };
}

export interface State {
  goal: Goal | null;
  /** Loop 2: list of pending goal items. Activated one at a time. */
  list?: ListItem[];
  /** Loop 3: metric-driven forever loop. */
  loop?: import("./goal-loop-forever.js").LoopState;
  /** Main-session provider recovery; independent of detached auditor state. */
  mainModelRecovery?: MainModelRecovery;
  /** v0.34.57: last provider/model ref the main session was observed on.
   * Persisted so the turn-boundary check can detect drift across sessions
   * (a fresh pi launch with a changed default model fires no model_select). */
  lastModelRef?: string;
  /** v0.34.97: epoch (ms) of the most recent session_compact event. The
   * status line paints a ⏳ compacting… chip while this is within the last
   * 3 minutes (COMPACTION_GRACE_MS). Persisted so the chip survives a
   * reload — without it, the chip vanishes on reload and the user thinks
   * the compaction didn't happen (Screenshot_20260808_003007/003024). */
  lastCompactionAt?: number;
  /** v0.35.15: `/glla pause` epoch (ms). Presence = the supervisor's
   * automatic machinery (heartbeat re-arms, recovery probes, auto-resume,
   * continuation dispatch, proactive auditor quiet notifies) is FROZEN by
   * explicit user request. The active goal/list item/loop and any detached
   * worker keep running untouched; `/glla resume` clears it. Persisted so
   * the pause survives session restarts — a restart must not silently
   * re-arm machinery the user explicitly stopped. */
  supervisorPausedAt?: number;
  /** v0.35.23 (note.md Next #2): set automatically by session_start when a
   * cold load restores pending durable state WITHOUT consent (no explicit
   * Auto-resume setting, no handoff/rebind/recovery). Same freeze semantics
   * as supervisorPausedAt — every dispatch point that checks
   * supervisorPaused() also holds for this — but DISTINCT from it: a manual
   * `/glla pause` is user intent and only `/glla resume` clears it, while
   * the load hold is released by ANY explicit work command (/goal resume,
   * /list resume, /list next, /loop resume|start, starting a new goal).
   * Persisted so the hold survives restarts until the user decides. */
  loadHoldAt?: number;
  /** v0.35.30 legacy terminal-outcome field. Older state files may still
   * contain it, so the reader keeps validating the shape for compatibility;
   * v0.35.72 no longer writes or paints it. Completion history remains in the
   * archived goal record and ledger, and /glla wipe still clears legacy data. */
  lastOutcome?: { at: string; ok: boolean; title: string; recap?: string };
}

/** v0.24.2: count TRAILING consecutive disapprovals (the disapproval-cap
 *  input). Shield-blocks (approved:true) and infra errors (neither flag)
 *  break the streak — they are not verdicts on the work. */
/** v0.24.2: count TRAILING consecutive disapprovals (the disapproval-cap
 *  input). Shield-blocks (approved:true) break the streak — the work was
 *  judged good. v0.25.4: pure infra errors (error set, neither verdict
 *  flag) are TRANSPARENT, not streak-breakers — the auditor never judged
 *  the work, so D,D,infra,D is still 3 trailing disapprovals (before, 39
 *  hegemon-style infra errors would reset the cap and re-open infinite
 *  re-continuation). */
export function countTrailingDisapprovals(history: AuditVerdict[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i]!;
    if (v.disapproved) n++;
    else if (v.error && !v.approved) continue; // infra: not a verdict
    else break;
  }
  return n;
}

/** Consecutive identical semantic objections are a state-based no-progress
 * signal. Infrastructure entries are transparent, but a changed contract
 * revision breaks the comparison because the auditor may now be judging new
 * work. */
/** v0.38.21 (objection pinning): the latest still-live disapproval — the
 * objection set the next retry must argue. Superseded rounds and
 * verdictless infrastructure entries are never live. A later clean
 * approval clears the pin, so a live entry is always the newest
 * verdict-bearing disapproval. */
export function liveDisapproval(history: AuditVerdict[]): AuditVerdict | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i]!;
    if (v.superseded) continue;
    if (v.disapproved) return v;
  }
  return undefined;
}

/** v0.38.21: retire every live disapproval in place. Returns the count
 * retired. Infrastructure entries are transparent (never verdicts, never
 * retired); approvals and impossibles are left for their own paths. */
export function markSupersededObjections(history: AuditVerdict[], byRef: string): number {
  let n = 0;
  for (const v of history) {
    if (v.disapproved && !v.superseded) {
      v.superseded = true;
      v.supersededBy = byRef;
      n++;
    }
  }
  return n;
}

/** v0.38.21: the single shared push path for completion-audit verdicts
 * (detached and manual-verify sites both call this — the two
 * hand-rolled push blocks drifted apart before). Scope transitions:
 * a new disapproval supersedes older live rounds (their objections are
 * settled context); a clean approval (`approved`, no error — shield
 * state irrelevant, the claim passed audit) clears the pin. Errors and
 * impossibles never touch the flags. Caps the history at 20, as before. */
export function appendAuditVerdict(history: AuditVerdict[], entry: AuditVerdict): AuditVerdict[] {
  if (entry.disapproved && !entry.error) {
    markSupersededObjections(history, `disapproval:${entry.at}`);
  } else if (entry.approved && !entry.error) {
    markSupersededObjections(history, `approval:${entry.at}`);
  }
  history.push(entry);
  if (history.length > 20) history.splice(0, history.length - 20);
  return history;
}

export const MAX_REPEATED_AUDIT_NO_PROGRESS = 3;

export function auditDisapprovalFingerprint(report: string | undefined): string {
  const text = typeof report === "string" ? report : "";
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}T[^\s]+/g, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 2_000);
}

export function countTrailingRepeatedDisapprovals(history: AuditVerdict[]): number {
  let n = 0;
  let fingerprint: string | undefined;
  let revision: number | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const verdict = history[i]!;
    if (verdict.error && !verdict.approved && !verdict.disapproved) continue;
    if (!verdict.disapproved) break;
    const currentFingerprint = auditDisapprovalFingerprint(verdict.report);
    if (!currentFingerprint) break;
    if (fingerprint === undefined) {
      fingerprint = currentFingerprint;
      revision = verdict.revision;
      n = 1;
      continue;
    }
    if (currentFingerprint !== fingerprint) break;
    if (typeof revision === "number" && typeof verdict.revision === "number" && verdict.revision !== revision) break;
    n++;
  }
  return n;
}

/** Default per-goal token budget (v0.9.7): a runaway threshold, not a
 * "big goal" threshold — real research/feature goals legitimately burn 2-4M.
 * Loop 3 doesn't rely on this cap (it has max-iterations + plateau brakes). */
export const DEFAULT_TOKEN_LIMIT = 0; // 0 = opt-in guard, off by default (v0.12.0)

export const DEFAULT_STATE: State = {
  goal: null,
  list: [],
};

// =================================================================
// Path helpers
// =================================================================

// Persisted IDs are path components. Runtime state can outlive the code that
// created it, so the JSON schema is not enough protection at this boundary.
// Keep legacy test/handwritten IDs such as `g1`, but reject separators and
// traversal syntax before a record can reach filesystem helpers.
const SAFE_PERSISTED_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafePersistedId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PERSISTED_ID.test(value);
}

function persistedPathSegment(id: string): string {
  if (isSafePersistedId(id)) return id;
  let encoded = "id";
  try { encoded = encodeURIComponent(id).slice(0, 96); } catch { /* invalid unicode */ }
  return `invalid-${encoded}`;
}

export function piGlaDir(cwd: string): string {
  const dir = resolveGllaStateDir(cwd);
  // v0.17.0: one-time migration of the pre-rename state dir (.pi-gla →
  // .pi-glla) applies only to the historical cwd root. Session-root mode
  // intentionally leaves every old project tree untouched. Pending
  // sessionDir resolution is also a no-migration read boundary.
  if (dir !== path.join(cwd, ".pi-glla") || stateRootPending()) return dir;
  const legacy = path.join(cwd, ".pi-gla");
  try {
    if (!fs.existsSync(dir) && fs.existsSync(legacy)) fs.renameSync(legacy, dir);
  } catch {
    // read-only fs or partial state — fall through and use the new dir
  }
  return dir;
}

export function goalMdPath(cwd: string, id: string): string {
  return path.join(piGlaDir(cwd), "goals", `${persistedPathSegment(id)}.md`);
}

export function archiveDir(cwd: string): string {
  return path.join(piGlaDir(cwd), "archive");
}

export function archivedGoalPath(cwd: string, id: string): string {
  return path.join(archiveDir(cwd), `${persistedPathSegment(id)}.md`);
}

export function ledgerPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "active.jsonl");
}

/** The live ledger is intentionally small enough for interactive tails and
 * cold-start recovery. Older events stay immutable in this directory so
 * forensic/history views retain their exact source without making the hot
 * file grow forever. */
export const LEDGER_ROTATION_BYTES = 8 * 1024 * 1024;
const LEDGER_SEGMENTS_DIR = "ledger-segments";
const LEDGER_ROTATION_LOCK = "ledger-rotation.lock";
const LEDGER_ROTATION_STALE_LOCK_MS = 5 * 60_000;

export function ledgerSegmentDir(cwd: string): string {
  return path.join(piGlaDir(cwd), LEDGER_SEGMENTS_DIR);
}

/** Return immutable ledger segments oldest-first, followed by the live file.
 * A missing segment directory is normal; permission/I/O failures are allowed
 * to reach the caller's persistence boundary instead of being mistaken for an
 * empty history. Symlinks are ignored so a state-root scan never follows an
 * arbitrary external tree. */
export function ledgerFiles(cwd: string): string[] {
  const segmentDir = ledgerSegmentDir(cwd);
  let names: string[] = [];
  try {
    const segmentStat = fs.lstatSync(segmentDir);
    if (!segmentStat.isSymbolicLink()) {
      if (!segmentStat.isDirectory()) throw new Error("ledger segment root is not a directory");
      names = fs.readdirSync(segmentDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("segment-") && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
        .sort();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const files = names.map((name) => path.join(segmentDir, name));
  const active = ledgerPath(cwd);
  try {
    const activeStat = fs.lstatSync(active);
    if (activeStat.isFile()) files.push(active);
    // An active-ledger symlink is ignored rather than followed outside the
    // selected state root. A directory/other node is an I/O failure that the
    // caller's persistence boundary should surface.
    else if (!activeStat.isSymbolicLink()) throw new Error("active ledger is not a regular file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return files;
}

/** Terminal archive journal. The archive markdown, terminal state snapshot,
 * and active-goal markdown are separate projections; this intent bridges a
 * crash between any two of them. It is deliberately one-record and
 * idempotent, so startup can finish a published archive without guessing. */
export type ArchiveIntentPhase = "prepared" | "published" | "state-persisted";

export interface ArchiveIntent {
  schema: 1;
  at: string;
  goalId: string;
  status: "complete" | "aborted";
  stopReason?: string;
  archivePath: string;
  terminalGoal: Goal;
  phase: ArchiveIntentPhase;
}

export function archiveIntentPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "archive-intent.json");
}

function validArchiveIntentPhase(value: unknown): value is ArchiveIntentPhase {
  return value === "prepared" || value === "published" || value === "state-persisted";
}

export function readArchiveIntent(cwd: string): ArchiveIntent | null {
  if (stateRootPending()) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(archiveIntentPath(cwd), "utf8")) as Record<string, unknown>;
    const terminalGoal = raw.terminalGoal;
    if (
      raw.schema !== 1
      || typeof raw.at !== "string"
      || Number.isNaN(Date.parse(raw.at))
      || typeof raw.goalId !== "string"
      || !isSafePersistedId(raw.goalId)
      || (raw.status !== "complete" && raw.status !== "aborted")
      || !validArchiveIntentPhase(raw.phase)
      || !terminalGoal
      || typeof terminalGoal !== "object"
      || Array.isArray(terminalGoal)
    ) return null;
    const goal = terminalGoal as Goal;
    if (goal.id !== raw.goalId || goal.status !== raw.status) return null;
    return {
      schema: 1,
      at: raw.at,
      goalId: raw.goalId,
      status: raw.status,
      ...(typeof raw.stopReason === "string" ? { stopReason: raw.stopReason } : {}),
      archivePath: archivedGoalPath(cwd, raw.goalId),
      terminalGoal: goal,
      phase: raw.phase,
    };
  } catch {
    return null;
  }
}

/** Write or refresh the one archive intent atomically. A different goal's
 * intent is never overwritten; that is a corruption/ownership signal and the
 * caller must leave the live goal untouched. */
export function writeArchiveIntent(
  cwd: string,
  intent: Pick<ArchiveIntent, "goalId" | "status" | "stopReason" | "terminalGoal" | "phase">,
): boolean {
  if (stateRootPending() || !isSafePersistedId(intent.goalId)) return false;
  const file = archiveIntentPath(cwd);
  let fileExists = false;
  try {
    fs.lstatSync(file);
    fileExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const prior = readArchiveIntent(cwd);
  // An unreadable or malformed existing journal is ambiguous ownership, not
  // permission to overwrite it with a new goal's intent.
  if (fileExists && !prior) return false;
  if (prior && prior.goalId !== intent.goalId) return false;
  const archivePath = archivedGoalPath(cwd, intent.goalId);
  const payload: ArchiveIntent = {
    schema: 1,
    at: new Date().toISOString(),
    goalId: intent.goalId,
    status: intent.status,
    ...(intent.stopReason !== undefined ? { stopReason: intent.stopReason } : {}),
    archivePath,
    terminalGoal: intent.terminalGoal,
    phase: intent.phase,
  };
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const landed = runPersistStep("writeArchiveIntent", () => {
    ensureDirs(cwd);
    try {
      fs.writeFileSync(temp, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, file);
      return true;
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  });
  return landed === true;
}

export function updateArchiveIntentPhase(cwd: string, phase: ArchiveIntentPhase): boolean {
  const prior = readArchiveIntent(cwd);
  if (!prior) return false;
  return writeArchiveIntent(cwd, { ...prior, phase });
}

/** Remove the old active markdown and then the intent. Missing markdown is a
 * successful cleanup; any other unlink or journal failure keeps the intent so
 * a later lifecycle boundary can retry it. */
export function finalizeArchiveIntent(cwd: string, goalId: string): boolean {
  const intent = readArchiveIntent(cwd);
  if (!intent || intent.goalId !== goalId) return false;
  const active = goalMdPath(cwd, goalId);
  try {
    fs.unlinkSync(active);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return clearArchiveIntent(cwd);
}

export function clearArchiveIntent(cwd: string): boolean {
  if (stateRootPending()) return false;
  const file = archiveIntentPath(cwd);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * v0.34.60: disk-first queue sidecar. Each list item gets a sidecar JSON
 * file in `.pi-glla/goals/<id>.queue.json` BEFORE any in-memory state is
 * mutated. This makes /list recoverable when the extension handle is stale
 * (e.g. after a /reload that wiped the plugin's state object before
 * `readState` was reparsed) — the disk is the source of truth, not RAM.
 *
 * The `.queue.json` suffix distinguishes queued-sidecar files from
 * `renderGoalMarkdown`-formatted active-goal `.md` files in the same dir,
 * so the scanner can read either format without parsing ambiguity. On
 * activation the sidecar is removed (`deleteQueueItemFile`) because the
 * active-goal `.md` takes over; on archive the sidecar was never created
 * because the item activated before its first read.
 *
 * Atomic: temp + rename. Idempotent on retry: writes land at distinct
 * `.tmp` paths via process.pid+randomBytes, and never trample an existing
 * sidecar (collision = skip, not overwrite).
 */
export function queueItemPath(cwd: string, id: string): string {
  return path.join(piGlaDir(cwd), "goals", `${persistedPathSegment(id)}.queue.json`);
}

export interface QueueItemWriteResult {
  path: string;
  wrote: boolean;
  /** True when the persistence boundary rejected the write. Collisions and
   * symlink refusals are failures because callers must not commit RAM state
   * while an older sidecar still owns the id. */
  failed?: boolean;
  collision?: boolean;
}

/** Write one queue sidecar atomically. The default is idempotent/no-overwrite;
 * repair metadata updates may explicitly request an atomic replacement. All
 * filesystem failures go through the persistence-degradation boundary and
 * clean up the temporary file before returning to the caller. */
export function writeQueueItemFile(cwd: string, item: ListItem, options: { replace?: boolean } = {}): QueueItemWriteResult {
  const file = queueItemPath(cwd, item.id);
  if (stateRootPending()) return { path: file, wrote: false, failed: true };
  if (!isSafePersistedId(item.id)) {
    return { path: file, wrote: false, failed: true };
  }
  const replace = options.replace === true;
  if (!replace && fs.existsSync(file)) return { path: file, wrote: false, failed: true, collision: true }; // never overwrite an existing id
  const result = runPersistStep("writeQueueItemFile", () => {
    if (replace) {
      try {
        if (fs.lstatSync(file).isSymbolicLink()) return { path: file, wrote: false, failed: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempPath = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ schema: 1, type: "queue-item", ...item }), "utf-8");
      fs.renameSync(tempPath, file);
      return { path: file, wrote: true };
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // The landing write already succeeded or the original error is more
        // useful; a later cleanup pass can remove an orphaned temp file.
      }
    }
  });
  return result ?? { path: file, wrote: false, failed: true };
}

export interface QueueItemDeleteResult {
  path: string;
  /** No sidecar existed at the time of the check. This is a successful
   * no-op for destructive queue callers: the state has no durable twin to
   * resurrect. */
  present: boolean;
  removed: boolean;
  /** The caller must keep RAM/ledger state unchanged when this is true. */
  failed: boolean;
}

/** Inspect and remove one queue sidecar without collapsing "absent" and
 * "unlink failed" into the same boolean. The distinction is essential for
 * destructive commands: an EACCES/EISDIR sidecar must remain represented in
 * RAM until a later retry, otherwise a reload resurrects the user's item. */
export function deleteQueueItemFileResult(cwd: string, id: string): QueueItemDeleteResult {
  const file = queueItemPath(cwd, id);
  if (stateRootPending() || !isSafePersistedId(id)) {
    return { path: file, present: false, removed: false, failed: true };
  }
  let present = false;
  try {
    fs.lstatSync(file);
    present = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: file, present: false, removed: false, failed: false };
    }
    return { path: file, present: false, removed: false, failed: true };
  }
  try {
    fs.unlinkSync(file);
    return { path: file, present: true, removed: true, failed: false };
  } catch {
    return { path: file, present, removed: false, failed: true };
  }
}

/** Compatibility wrapper for activation and older callers. New destructive
 * paths should use deleteQueueItemFileResult so they can fail closed. */
export function deleteQueueItemFile(cwd: string, id: string): boolean {
  return deleteQueueItemFileResult(cwd, id).removed;
}

/** v0.35.0: clear every queue sidecar, including orphaned files that are
 * absent from the in-memory queue after a stale handle or torn reload. */
export function queueItemSidecarCount(cwd: string): number {
  const dir = path.join(piGlaDir(cwd), "goals");
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".queue.json")).length; } catch { return 0; }
}

export function clearQueueItemFiles(cwd: string): { removed: number; failed: string[] } {
  if (stateRootPending()) return { removed: 0, failed: ["<state-root-pending>"] };
  const dir = path.join(piGlaDir(cwd), "goals");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (err) {
    // A missing goals directory means there are no sidecars. Any other
    // failure is an unreadable durable queue and must block state clearing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, failed: [] };
    return { removed: 0, failed: ["<queue-directory>"] };
  }
  let removed = 0;
  const failed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".queue.json")) continue;
    const result = deleteQueueItemFileResult(cwd, name.slice(0, -".queue.json".length));
    if (result.removed) removed++;
    else if (result.failed) failed.push(name);
  }
  return { removed, failed };
}

/**
 * v0.34.60: read the queue from disk (sidecar files in `.pi-glla/goals/`)
 * when the in-memory list is missing or empty — the stale-handle fallback
 * for /list after /reload, plugin re-init, or process restart with a
 * damaged RAM state.
 *
 * Each sidecar file is a small JSON record; parse failures are skipped
 * (a torn temp-file mid-rename never blocks the read). Files matching a
 * known-active or known-archived goalId are excluded so activated items
 * don't reappear in the queue after archive.
 */
export function readQueueFromDisk(cwd: string, excludeIds: ReadonlySet<string> = new Set()): ListItem[] {
  const dir = path.join(piGlaDir(cwd), "goals");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  // readdir order is filesystem-dependent; parse every sidecar first and
  // apply compareQueueItems below so durable queue order survives recovery.
  names.sort();
  const out: ListItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".queue.json")) continue;
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, name), "utf-8"); } catch { continue; }
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    if (!e || e.schema !== 1 || e.type !== "queue-item") continue;
    if (typeof e.id !== "string" || typeof e.objective !== "string") continue;
    if (!isSafePersistedId(e.id)) continue;
    if (excludeIds.has(e.id)) continue;
    const repairTarget = e.repairTarget && typeof e.repairTarget === "object"
      && typeof e.repairTarget.id === "string"
      && typeof e.repairTarget.objective === "string"
      && typeof e.repairTarget.source === "string"
      && Array.isArray(e.repairTarget.reasons)
      && e.repairTarget.reasons.every((reason: unknown) => typeof reason === "string")
      ? {
          id: e.repairTarget.id,
          objective: e.repairTarget.objective,
          ...(typeof e.repairTarget.verificationContract === "string" ? { verificationContract: e.repairTarget.verificationContract } : {}),
          reasons: e.repairTarget.reasons,
          source: e.repairTarget.source,
          ...(typeof e.repairTarget.replanPromptedAt === "string" ? { replanPromptedAt: e.repairTarget.replanPromptedAt } : {}),
        } satisfies ObjectiveRepairTarget
      : undefined;
    out.push({
      id: e.id,
      objective: e.objective,
      ...(e.agentRole === "designer" ? { agentRole: "designer" as const } : {}),
      ...(typeof e.verificationContract === "string" && e.verificationContract ? { verificationContract: e.verificationContract } : {}),
      ...(typeof e.parallelSafe === "boolean" ? { parallelSafe: e.parallelSafe } : {}),
      // v0.34.81: subtask binding round-trips from the sidecar the same way
      // parallelSafe does — must be a string id matching another queue item.
      ...(typeof e.parentId === "string" && e.parentId ? { parentId: e.parentId } : {}),
      ...(repairTarget ? { repairTarget } : {}),
      ...(typeof e.queueOrder === "number" && Number.isFinite(e.queueOrder) && e.queueOrder >= 0 ? { queueOrder: e.queueOrder } : {}),
      addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
    });
  }
  return out.sort(compareQueueItems);
}

// =================================================================
// Persistence
// =================================================================

export function ensureDirs(cwd: string): void {
  // In sessionDir mode the lifecycle must register the session root before
  // any write can choose a durable location. Reads may safely fall back to
  // cwd; writes must not recreate an ambiguous cwd state tree.
  if (stateRootPending()) return;
  fs.mkdirSync(path.join(piGlaDir(cwd), "goals"), { recursive: true });
  fs.mkdirSync(archiveDir(cwd), { recursive: true });
}

// =================================================================
// Persistence degradation (v0.28.6, audit E1)
// =================================================================
// A disk failure (ENOSPC, EACCES, a wedged mount) used to THROW out of
// appendLedger/writeGoalMd mid-handler — killing the orchestrator turn and
// silently diverging RAM from disk. Now every persistence step runs
// through runPersistStep: failures are caught, the session-wide degraded
// flag latches (the TUI shows it; the first failure notifies loudly), RAM
// state stays authoritative, and the next SUCCESSFUL step auto-clears the
// flag (self-healing — the "dirty" marker that write-then-mutate ordering
// cannot otherwise provide).

export interface PersistenceFailure {
  what: string;
  error: string;
  at: string;
}

let persistenceDegraded = false;
let lastFailure: PersistenceFailure | null = null;

export function isPersistenceDegraded(): boolean {
  return persistenceDegraded;
}

export function lastPersistenceFailure(): PersistenceFailure | null {
  return lastFailure;
}

/** Run one persistence step. On failure: latch the degraded flag, remember
 * the error, return undefined (NEVER throw into an orchestrator handler).
 * On success: clear the flag — a landing write means the disk is back. */
export function runPersistStep<T>(what: string, fn: () => T): T | undefined {
  try {
    const out = fn();
    if (persistenceDegraded) {
      persistenceDegraded = false;
      lastFailure = null;
    }
    return out;
  } catch (err) {
    persistenceDegraded = true;
    lastFailure = { what, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
    return undefined;
  }
}

/** Read a JSONL file a line at a time without materialising the whole file.
 * GLLA's active ledger is append-only and can live for months; a cold load
 * must not briefly hold both a multi-megabyte string and a split-line array in
 * the main pi process. The callback runs synchronously to preserve the
 * existing persistence ordering/error contract. */
export function scanLedgerLines(file: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) break;
      const data = carry.length > 0
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let start = 0;
      while (true) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        onLine(data.subarray(start, newline).toString("utf8"));
        start = newline + 1;
      }
      carry = start === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    }
    if (carry.length > 0) onLine(carry.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** Find one matching ledger line from the end using bounded chunks. This is
 * the hot path for goal-state transactions: looking up the last durable state
 * must remain proportional to the recent tail, not the complete ledger. */
export function scanLedgerLinesReverse(file: string, matches: (line: string) => boolean): string | undefined {
  const fd = fs.openSync(file, "r");
  const chunkSize = 64 * 1024;
  let position = fs.fstatSync(fd).size;
  let carry = Buffer.alloc(0);
  try {
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const requested = position - start;
      const chunk = Buffer.alloc(requested);
      const bytesRead = fs.readSync(fd, chunk, 0, requested, start);
      if (bytesRead <= 0) break;
      const data = carry.length > 0
        ? Buffer.concat([chunk.subarray(0, bytesRead), carry])
        : chunk.subarray(0, bytesRead);
      let end = data.length;
      while (true) {
        const newline = data.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const line = data.subarray(newline + 1, end).toString("utf8");
        if (line && matches(line)) return line;
        end = newline;
      }
      carry = Buffer.from(data.subarray(0, end));
      position = start;
    }
    const firstLine = carry.toString("utf8");
    return firstLine && matches(firstLine) ? firstLine : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Parsed transport shape shared by command/stat/reviewer readers. Keeping
 * this scanner in the persistence core prevents each consumer from
 * independently reintroducing `readFileSync(...).split(...)` on the active
 * ledger. The value remains intentionally open because ledger events are an
 * extensible public forensic format. */
export interface LedgerRecord {
  type: string;
  at?: string;
  value?: any;
}

export function parseLedgerRecord(line: string): LedgerRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && typeof parsed.type === "string"
      ? parsed as LedgerRecord
      : undefined;
  } catch {
    return undefined;
  }
}

/** Stream all historical records in chronological file/line order. Older
 * rotated segments are included before the live tail. Callers should reduce
 * into bounded maps/counters rather than retaining the records. */
export function scanLedgerRecords(cwd: string, onRecord: (entry: LedgerRecord) => void): void {
  for (const file of ledgerFiles(cwd)) {
    scanLedgerLines(file, (line) => {
      const entry = parseLedgerRecord(line);
      if (entry) onRecord(entry);
    });
  }
}

/** Read at most `limit` matching records from the newest end of all ledger
 * segments. The returned records are chronological (oldest selected first),
 * which preserves the old `slice(-N)` command semantics while stopping as
 * soon as the requested tail is collected. */
export function readLedgerTail(
  cwd: string,
  limit: number,
  matches: (entry: LedgerRecord) => boolean = () => true,
): LedgerRecord[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const out: LedgerRecord[] = [];
  const files = ledgerFiles(cwd);
  for (let i = files.length - 1; i >= 0 && out.length < limit; i--) {
    scanLedgerLinesReverse(files[i]!, (line) => {
      const entry = parseLedgerRecord(line);
      if (entry && matches(entry)) out.push(entry);
      return out.length >= limit;
    });
  }
  return out.reverse();
}

function rotationProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Rotation is a maintenance operation for the owning host only. The owner
 * record is advisory for ordinary writes, but an active foreign owner is
 * enough reason to leave the ledger untouched; a stale/dead record may be
 * replaced by the normal session-start owner claim. */
function ledgerRotationOwned(cwd: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(piGlaDir(cwd), "owner.json"), "utf8")) as { pid?: unknown; shutdownAt?: unknown };
    const pid = typeof owner.pid === "number" ? owner.pid : Number(owner.pid);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && owner.shutdownAt === undefined && rotationProcessAlive(pid)) return false;
  } catch {
    // No owner record is normal in pure/core tests and on the first write.
  }
  return true;
}

function acquireLedgerRotationLock(cwd: string): number | undefined {
  const lock = path.join(piGlaDir(cwd), LEDGER_ROTATION_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      // A host can die after creating the lock and before the rename. Only
      // reclaim an old lock whose recorded PID is proven dead; malformed or
      // young locks stay in place to avoid deleting an ambiguous operator
      // artifact.
      let reclaim = false;
      try {
        const stat = fs.statSync(lock);
        const record = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: unknown };
        const pid = typeof record.pid === "number" ? record.pid : Number(record.pid);
        reclaim = Date.now() - stat.mtimeMs >= LEDGER_ROTATION_STALE_LOCK_MS
          && Number.isInteger(pid)
          && pid > 1
          && !rotationProcessAlive(pid);
      } catch {
        reclaim = false;
      }
      if (!reclaim) return undefined;
      try { fs.unlinkSync(lock); } catch { return undefined; }
    }
  }
  return undefined;
}

/** Rotate the live ledger after a state append. The append happens first, so
 * if the process dies after the segment rename but before the new active
 * snapshot lands, the segment still contains the newest complete state and
 * `readState` can recover it. The fresh active file contains only that full
 * projection, keeping future cold loads bounded. */
export function rotateLedgerIfNeeded(cwd: string, latestStateLine: string, thresholdBytes = LEDGER_ROTATION_BYTES): boolean {
  if (stateRootPending() || !ledgerRotationOwned(cwd)) return false;
  const active = ledgerPath(cwd);
  let size: number;
  try { size = fs.statSync(active).size; } catch { return false; }
  if (size <= thresholdBytes) return false;
  const lockFd = acquireLedgerRotationLock(cwd);
  if (lockFd === undefined) return false;
  try {
    // Another owner may have rotated while this process was acquiring the
    // lock. Recheck before moving anything.
    if (fs.statSync(active).size <= thresholdBytes) return false;
    const segmentDir = ledgerSegmentDir(cwd);
    fs.mkdirSync(segmentDir, { recursive: true });
    const segment = path.join(segmentDir, `segment-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
    fs.renameSync(active, segment);
    const temp = `${active}.${process.pid}.${Date.now()}.rotation.tmp`;
    try {
      fs.writeFileSync(temp, latestStateLine + "\n", { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, active);
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* recovery scans the segment */ }
    }
    return true;
  } catch {
    // A successful rename with a later write failure is recoverable: the
    // segment is immutable and contains the state line. Keep the lock cleanup
    // best-effort and let the next append recreate active.jsonl.
    return false;
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(path.join(piGlaDir(cwd), LEDGER_ROTATION_LOCK)); } catch {}
  }
}

export function readState(cwd: string): State {
  const file = ledgerPath(cwd);
  // v0.28.6 (E1): an unreadable ledger (EACCES, EIO) degrades loudly
  // instead of throwing out of session_start.
  const loaded = runPersistStep("readState", () => {
    const parsed: Partial<State> = {};
    let lastStateAt: string | undefined;
    let lastStateLine: string | undefined;
    const files = ledgerFiles(cwd);
    const hasSegments = files.some((candidate) => candidate !== file);
    if (hasSegments) {
      // After rotation the active file begins with a complete state snapshot.
      // Find the newest snapshot from the end instead of replaying every
      // historical state record on every session start. If a process died
      // between the segment rename and the fresh active snapshot, the newest
      // segment still contains the state line and is the next search target.
      for (let i = files.length - 1; i >= 0 && !lastStateLine; i--) {
        const found = scanLedgerLinesReverse(files[i]!, (line) => {
          const evt = parseLedgerRecord(line);
          return evt?.type === "state" && typeof evt.at === "string";
        });
        if (found) {
          const evt = parseLedgerRecord(found);
          if (evt?.type === "state") {
            Object.assign(parsed, evt.value ?? {});
            lastStateAt = evt.at;
            lastStateLine = found;
          }
        }
      }
    } else if (fs.existsSync(file)) {
      // Preserve legacy merge semantics until a project has a rotated
      // snapshot: older hand-written state lines may contain partial fields.
      scanLedgerLines(file, (line) => {
        const evt = parseLedgerRecord(line);
        if (evt?.type !== "state") return;
        Object.assign(parsed, evt.value ?? {});
        if (typeof evt.at === "string") {
          lastStateAt = evt.at;
          lastStateLine = line;
        }
      });
    }
    return { parsed, lastStateAt, lastStateLine };
  });
  // Do not return early for an empty/missing ledger: a process can die after
  // writing the first complete transaction snapshot but before the first
  // active.jsonl state line. The transaction reader below is the recovery
  // source for that initial projection.
  let parsed = loaded?.parsed ?? {};
  const lastStateAt = loaded?.lastStateAt;
  const lastStateLine = loaded?.lastStateLine;
  // A goal projection can land between the markdown and ledger writes when
  // the process dies. Prefer the complete transaction snapshot when it is
  // still fenced to the last durable state line; otherwise an old orphan is
  // already committed and must not roll back later unrelated state changes.
  const transaction = readGoalStateTransaction(cwd);
  const transactionAt = transaction ? Date.parse(transaction.at) : Number.NaN;
  const stateAt = lastStateAt ? Date.parse(lastStateAt) : Number.NaN;
  const transactionBaseMatches = !!transaction?.baseStateLineHash
    && !!lastStateLine
    && transaction.baseStateLineHash === stateLineFingerprint(lastStateLine);
  const transactionIsNewer = transaction && (
    !lastStateLine
    // A hashed transaction was created from this exact state line. It is
    // still the interrupted successor even when a wall-clock adjustment
    // makes its timestamp appear older; a different line must never be
    // rolled back by an orphaned transaction, even if its timestamp is newer.
    || transactionBaseMatches
    // Legacy transactions predate baseStateLineHash. Keep their historical
    // timestamp rule for backward compatibility, but never apply them over
    // an invalid/unrelated hashed state boundary.
    || (
      !transaction.baseStateLineHash
      && (!lastStateAt || Number.isNaN(stateAt) || transactionAt > stateAt)
    )
  );
  if (transactionIsNewer) {
    parsed = { ...parsed, ...transaction.state };
  }
  // Archive intent is the recovery half of terminal archival. If the archive
  // was published before a crash, prefer its complete terminal projection so
  // a reload can never resurrect the pre-archive ACTIVE goal. The lifecycle
  // boundary finalizes the journal and removes the old markdown after the
  // terminal state has been persisted.
  const archiveIntent = readArchiveIntent(cwd);
  if (archiveIntent && fs.existsSync(archivedGoalPath(cwd, archiveIntent.goalId))) {
    const currentGoalId = parsed.goal && typeof parsed.goal === "object"
      ? (parsed.goal as { id?: unknown }).id
      : undefined;
    if (currentGoalId === undefined || currentGoalId === archiveIntent.goalId) {
      parsed = { ...parsed, goal: archiveIntent.terminalGoal };
    }
  }
  const goal = parsed.goal && typeof parsed.goal === "object" && isSafePersistedId((parsed.goal as { id?: unknown }).id)
    ? {
      ...parsed.goal,
      ...(parsed.goal.pendingCompletion && typeof parsed.goal.pendingCompletion === "object"
        ? { pendingCompletion: normalizePendingCompletion(parsed.goal.pendingCompletion) }
        : {}),
    }
    : null;
  const loop = parsed.loop && typeof parsed.loop === "object"
    ? {
      ...parsed.loop,
      // Legacy/manual loop snapshots sometimes omitted history. The loop
      // supervisor reads and appends it on every measured turn, so normalize
      // the durable boundary instead of allowing one malformed snapshot to
      // crash the continuous checker mid-turn.
      history: Array.isArray((parsed.loop as { history?: unknown }).history) ? (parsed.loop as { history: unknown[] }).history : [],
    } as State["loop"]
    : undefined;
  return {
    goal: goal as State["goal"],
    list: Array.isArray(parsed.list) ? parsed.list : [],
    loop,
    mainModelRecovery: sanitizeMainModelRecovery(parsed.mainModelRecovery),
    lastModelRef: typeof parsed.lastModelRef === "string" ? parsed.lastModelRef : undefined,
    lastCompactionAt: typeof parsed.lastCompactionAt === "number" && Number.isFinite(parsed.lastCompactionAt) ? parsed.lastCompactionAt : undefined,
    supervisorPausedAt: typeof parsed.supervisorPausedAt === "number" && Number.isFinite(parsed.supervisorPausedAt) && parsed.supervisorPausedAt > 0 ? parsed.supervisorPausedAt : undefined,
    loadHoldAt: typeof parsed.loadHoldAt === "number" && Number.isFinite(parsed.loadHoldAt) && parsed.loadHoldAt > 0 ? parsed.loadHoldAt : undefined,
    lastOutcome: sanitizeLastOutcome(parsed.lastOutcome),
  };
}

/** v0.35.34: strict shape validation for the legacy last-outcome record —
 * a corrupt/garbage line degrades to absent; older state remains readable even
 * though the v0.35.72 renderer no longer paints this field. */
function sanitizeLastOutcome(value: unknown): State["lastOutcome"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== "string" || !v.at) return undefined;
  if (typeof v.ok !== "boolean") return undefined;
  if (typeof v.title !== "string" || !v.title) return undefined;
  return {
    at: v.at,
    ok: v.ok,
    title: v.title,
    ...(typeof v.recap === "string" && v.recap ? { recap: v.recap } : {}),
  };
}

/** v0.35.23 (note.md Next #2): true while a cold session load is holding
 * automation for an explicit decision. Part of the SAME single choke point
 * as supervisorPaused — every dispatch gate that consults one consults
 * both — but cleared by explicit work commands, never by timers. */
export function loadHoldActive(state: State): boolean {
  return typeof state?.loadHoldAt === "number";
}

/** Release the load hold in-place; returns true when a hold was actually
 * cleared (callers ledger + persist only on true). Manual `/glla pause`
 * freezes are deliberately NOT touched — only `/glla resume` clears those. */
export function clearLoadHold(state: State): boolean {
  if (typeof state?.loadHoldAt !== "number") return false;
  delete (state as { loadHoldAt?: number }).loadHoldAt;
  return true;
}

/** True while `/glla pause` has frozen the supervisor's automatic side-
 * effects. A single source of truth for every dispatch-point gate so a
 * future automatic path cannot forget the check.
 * v0.35.23: the automatic LOAD HOLD (set by session_start on a consent-less
 * cold load with pending durable state) freezes through the same gates —
 * see loadHoldActive/clearLoadHold. */
export function supervisorPaused(state: State): boolean {
  return typeof state?.supervisorPausedAt === "number" || typeof state?.loadHoldAt === "number";
}

/** Migrate the old quota-named completion retry fields at the state boundary.
 * Runtime policy only sees the generic names; old records remain readable. */
function normalizePendingCompletion(value: unknown): PendingCompletion {
  const raw = value as Record<string, unknown>;
  const {
    quotaAttempts: _quotaAttempts,
    quotaFirstAt: _quotaFirstAt,
    quotaAutoRetryUntil: _quotaAutoRetryUntil,
    quotaSignal: _quotaSignal,
    retryAfterSec: _retryAfterSec,
    retryFromUpstream: _retryFromUpstream,
    resetAt: _resetAt,
    phase: _phase,
    auditorCandidateRefs: _auditorCandidateRefs,
    auditorCandidateRef: _auditorCandidateRef,
    auditorRetryCandidateRef: _auditorRetryCandidateRef,
    auditorRetryAttemptStartedAt: _auditorRetryAttemptStartedAt,
    auditorAttemptedRefs: _auditorAttemptedRefs,
    auditorFailureCount: _auditorFailureCount,
    auditorFailureClass: _auditorFailureClass,
    auditorFallbackExhausted: _auditorFallbackExhausted,
    auditorFailureAt: _auditorFailureAt,
    timeoutEscalation: _timeoutEscalation,
    ...canonicalOrUnknown
  } = raw;
  const phase = _phase === "quota-waiting" ? "retry-waiting" : _phase;
  const boundedRefs = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return normalizeBoundedModelRefs(
      value.map((entry) => typeof entry === "string" ? entry.trim().slice(0, 200) : entry),
      MAX_AUDITOR_CANDIDATE_REFS,
    );
  };
  const auditorCandidateRefs = boundedRefs(_auditorCandidateRefs);
  const auditorAttemptedRefs = boundedRefs(_auditorAttemptedRefs);
  const auditorCandidateRef = typeof _auditorCandidateRef === "string" && _auditorCandidateRef.trim()
    ? _auditorCandidateRef.trim().slice(0, 200)
    : undefined;
  const auditorRetryCandidateRef = typeof _auditorRetryCandidateRef === "string" && _auditorRetryCandidateRef.trim()
    ? _auditorRetryCandidateRef.trim().slice(0, 200)
    : undefined;
  const auditorRetryAttemptStartedAt = auditorRetryCandidateRef
    && typeof _auditorRetryAttemptStartedAt === "string"
    && Number.isFinite(Date.parse(_auditorRetryAttemptStartedAt))
    ? new Date(Date.parse(_auditorRetryAttemptStartedAt)).toISOString()
    : undefined;
  const auditorFailureCount = typeof _auditorFailureCount === "number" && Number.isFinite(_auditorFailureCount)
    ? Math.min(2, Math.max(0, Math.trunc(_auditorFailureCount)))
    : undefined;
  const auditorFailureClasses: AuditorRecoveryFailureClass[] = ["transport", "timeout", "no-verdict", "provider"];
  const auditorFailureClass = typeof _auditorFailureClass === "string" && auditorFailureClasses.includes(_auditorFailureClass as AuditorRecoveryFailureClass)
    ? _auditorFailureClass as AuditorRecoveryFailureClass
    : undefined;
  const auditorFallbackExhausted = _auditorFallbackExhausted === true;
  const auditorFailureAt = typeof _auditorFailureAt === "string" && Number.isFinite(Date.parse(_auditorFailureAt))
    ? new Date(Date.parse(_auditorFailureAt)).toISOString()
    : undefined;
  // v0.37.0: escalation index — hand-edited/corrupt state must not produce a
  // negative or astronomical budget multiplier.
  const timeoutEscalation =
    typeof _timeoutEscalation === "number" &&
    Number.isInteger(_timeoutEscalation) &&
    _timeoutEscalation >= 0 &&
    _timeoutEscalation <= 100
      ? _timeoutEscalation
      : undefined;
  return {
    ...canonicalOrUnknown,
    ...(auditorCandidateRefs !== undefined ? { auditorCandidateRefs } : {}),
    ...(auditorCandidateRef ? { auditorCandidateRef } : {}),
    ...(auditorRetryCandidateRef ? { auditorRetryCandidateRef } : {}),
    ...(auditorRetryAttemptStartedAt ? { auditorRetryAttemptStartedAt } : {}),
    ...(auditorAttemptedRefs !== undefined ? { auditorAttemptedRefs } : {}),
    ...(auditorFailureCount !== undefined ? { auditorFailureCount } : {}),
    ...(auditorFailureClass ? { auditorFailureClass } : {}),
    ...(auditorFallbackExhausted ? { auditorFallbackExhausted: true } : {}),
    ...(auditorFailureAt ? { auditorFailureAt } : {}),
    ...(timeoutEscalation !== undefined ? { timeoutEscalation } : {}),
    ...(phase === "running" || phase === "recovery-pending" || phase === "retry-waiting" ? { phase } : {}),
    ...(typeof raw.retryAttempts === "number"
      ? { retryAttempts: raw.retryAttempts }
      : typeof raw.quotaAttempts === "number" ? { retryAttempts: raw.quotaAttempts } : {}),
    ...(typeof raw.retryFirstAt === "string"
      ? { retryFirstAt: raw.retryFirstAt }
      : typeof raw.quotaFirstAt === "string" ? { retryFirstAt: raw.quotaFirstAt } : {}),
    ...(typeof raw.retryUntil === "string"
      ? { retryUntil: raw.retryUntil }
      : typeof raw.quotaAutoRetryUntil === "string" ? { retryUntil: raw.quotaAutoRetryUntil } : {}),
    quotaAttempts: undefined,
    quotaFirstAt: undefined,
    quotaAutoRetryUntil: undefined,
  } as PendingCompletion;
}

/** Claim one display/action notice in a durable recovery episode. The caller
 * must persist the containing record after this returns true. */
export function claimRecoveryNotice(record: { recoveryNoticeKeys?: string[] }, key: string): boolean {
  const prior = Array.isArray(record.recoveryNoticeKeys) ? record.recoveryNoticeKeys : [];
  if (prior.includes(key)) return false;
  record.recoveryNoticeKeys = [...prior.slice(-15), key];
  return true;
}

export function appendLedger(cwd: string, type: string, value: unknown): boolean {
  // v0.28.6 (E1): guarded — a disk failure degrades loudly, never throws
  // into an orchestrator handler.
  const landed = runPersistStep("appendLedger", () => {
    if (stateRootPending()) return false;
    ensureDirs(cwd);
    const line = JSON.stringify({ type, value, at: new Date().toISOString() });
    fs.appendFileSync(ledgerPath(cwd), line + "\n");
    if (type === "state") rotateLedgerIfNeeded(cwd, line);
    return true;
  });
  return landed === true;
}

/** Canonical state projection used by the normal writer and archive recovery.
 * Every field is written on every snapshot so a rotated active file is a
 * complete replacement, not a partial delta. */
export function stateLedgerValue(s: State): Record<string, unknown> {
  return {
    goal: s.goal,
    list: s.list ?? [],
    loop: s.loop ?? null,
    mainModelRecovery: s.mainModelRecovery ?? null,
    lastModelRef: s.lastModelRef,
    ...(typeof s.lastCompactionAt === "number" ? { lastCompactionAt: s.lastCompactionAt } : { lastCompactionAt: null }),
    ...(typeof s.supervisorPausedAt === "number" ? { supervisorPausedAt: s.supervisorPausedAt } : { supervisorPausedAt: null }),
    ...(typeof s.loadHoldAt === "number" ? { loadHoldAt: s.loadHoldAt } : { loadHoldAt: null }),
    ...(s.lastOutcome ? { lastOutcome: s.lastOutcome } : { lastOutcome: null }),
  };
}

export function appendStateSnapshot(cwd: string, s: State): boolean {
  return appendLedger(cwd, "state", stateLedgerValue(s));
}

// =================================================================
// Model-switch ledger (v0.34.57 — bug #1.14, unauthorized model switches)
// =================================================================

/** The canonical `model_switch` ledger payload (v0.34.57).
 * `from`/`to` are canonical "provider/id" refs; unknown sides are omitted.
 * `reason`: one of "manual" | "cycle" | "restore" | "turn-boundary" |
 * "recovery" — how the change reached the session. */
export interface ModelSwitchRecord {
  from?: string;
  to?: string;
  reason: string;
  /** ISO timestamp. */
  at: string;
}

/** Build the canonical `model_switch` ledger payload (v0.34.57). Pure —
 * the turn-boundary hook (extensions/loops/goal.ts) writes the entry via
 * appendLedger after applying the forbidden-model gate. */
export function modelSwitch(from: string | undefined, to: string | undefined, reason: string, at: number = Date.now()): ModelSwitchRecord {
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    reason,
    at: new Date(at).toISOString(),
  };
}

/** v0.34.57: model refs/ids that must never be selected — the policy guard.
 * v0.34.115: default is empty. The previous default of ["gpt-5.5",
 * "sonnet", "opus"] was an opinionated expense-policy safety net that
 * shipped as a default and conflicted with users on rigs where these
 * models are valid (e.g. an OpenRouter key with budget to spare, a local
 * rig that runs sonnet fine, an Anthropic-only rig where opus is the
 * primary model). The blockForbiddenModelSwitches gate is still ON by
 * default — when the user adds a model to forbiddenModels, switches to
 * it are reverted; but the DEFAULT no longer bans anything. Users can
 * restore the previous safety net by setting forbiddenModels via
 * /glla settings (now driven by a multi-select picker, not a typed dump).
 * Matched case-insensitively as a substring against the full
 * "provider/id" ref, so "gpt-5.5" covers "openai/gpt-5.5" and "sonnet"
 * covers "anthropic/claude-sonnet-4-5". */
export const DEFAULT_FORBIDDEN_MODELS: string[] = [];

/** v0.34.142: hourly retry ticker default — fires at :00:30 every hour
 * while main-model recovery is parked. This is an unconditional retry slot,
 * not a provider-status probe. The default is ON (opt-out) so work gets an
 * extra attempt shortly after each hour starts. */
export const DEFAULT_HOURLY_RETRY_PROBE = true;

/** v0.34.57: forbidden-model matcher. Empty/unknown refs are never
 * forbidden; an empty forbidden list forbids nothing. */
export function isForbiddenModel(ref: string | undefined, forbiddenModels: readonly string[] = DEFAULT_FORBIDDEN_MODELS): boolean {
  if (!ref) return false;
  const needle = ref.toLowerCase();
  return forbiddenModels.some((f) => typeof f === "string" && f.trim() !== "" && needle.includes(f.trim().toLowerCase()));
}

export function writeGoalMd(cwd: string, goal: Goal): string {
  const file = goalMdPath(cwd, goal.id);
  // A pending sessionDir has no durable destination yet. Returning the
  // intended path mirrors the existing persistence-degradation contract, but
  // unlike ensureDirs this guard must happen before writeFileSync: an old cwd
  // goals directory may already exist and would otherwise accept the fallback.
  if (stateRootPending()) return file;
  if (!isSafePersistedId(goal.id)) {
    runPersistStep("writeGoalMd", () => {
      throw new Error("refused unsafe persisted goal id");
    });
    return file;
  }
  runPersistStep("writeGoalMd", () => {
    ensureDirs(cwd);
    fs.writeFileSync(file, renderGoalMarkdown(goal));
  });
  // Return the intended path even on failure so activePath stays sane —
  // the degraded flag carries the truth that the write did not land.
  return file;
}

/** Crash-recovery journal for the two-file goal projection. `setGoal` and
 * `updateGoal` write this complete state snapshot before updating the goal
 * markdown and JSONL ledger. On restart, readState adopts it only when its
 * timestamp is newer than the last state line; a later unrelated state write
 * therefore cannot be rolled back by an orphaned journal. */
const GOAL_STATE_TRANSACTION_FILE = "goal-state.transaction.json";

export interface GoalStateTransaction {
  at: string;
  state: State;
  /** Hash of the last committed state line when this transaction was made.
   * It disambiguates same-millisecond writes from an unrelated later state
   * update, while older transactions without the field remain readable. */
  baseStateLineHash?: string;
}

function stateLineFingerprint(line: string): string {
  return createHash("sha256").update(line, "utf-8").digest("hex");
}

function lastDurableStateLine(cwd: string): string | undefined {
  if (stateRootPending()) return undefined;
  try {
    const files = ledgerFiles(cwd);
    for (let i = files.length - 1; i >= 0; i--) {
      const found = scanLedgerLinesReverse(files[i]!, (line) => {
        const evt = parseLedgerRecord(line);
        return evt?.type === "state" && typeof evt.at === "string";
      });
      if (found) return found;
    }
  } catch {
    // An absent/unreadable base ledger is represented by no hash.
  }
  return undefined;
}

export function goalStateTransactionPath(cwd: string): string {
  return path.join(piGlaDir(cwd), GOAL_STATE_TRANSACTION_FILE);
}

export function writeGoalStateTransaction(cwd: string, snapshot: State): boolean {
  if (stateRootPending()) return false;
  const file = goalStateTransactionPath(cwd);
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const baseStateLine = lastDurableStateLine(cwd);
  const landed = runPersistStep("writeGoalStateTransaction", () => {
    ensureDirs(cwd);
    try {
      fs.writeFileSync(temp, JSON.stringify({
        schema: 1,
        at: new Date().toISOString(),
        state: snapshot,
        ...(baseStateLine ? { baseStateLineHash: stateLineFingerprint(baseStateLine) } : {}),
      }), { encoding: "utf-8", flag: "wx" });
      fs.renameSync(temp, file);
      return true;
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
    }
  });
  return landed === true;
}

export function readGoalStateTransaction(cwd: string): GoalStateTransaction | null {
  if (stateRootPending()) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(goalStateTransactionPath(cwd), "utf-8")) as Record<string, unknown>;
    if (raw.schema !== 1 || typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
    if (raw.baseStateLineHash !== undefined && typeof raw.baseStateLineHash !== "string") return null;
    if (!raw.state || typeof raw.state !== "object" || Array.isArray(raw.state)) return null;
    const snapshot = raw.state as Partial<State>;
    if (snapshot.goal !== null && (typeof snapshot.goal !== "object" || !isSafePersistedId((snapshot.goal as { id?: unknown }).id))) return null;
    return {
      at: raw.at,
      state: { goal: snapshot.goal ?? null, ...snapshot } as State,
      ...(typeof raw.baseStateLineHash === "string" ? { baseStateLineHash: raw.baseStateLineHash } : {}),
    };
  } catch {
    return null;
  }
}

export function clearGoalStateTransaction(cwd: string): boolean {
  if (stateRootPending()) return false;
  const file = goalStateTransactionPath(cwd);
  if (!fs.existsSync(file)) return true;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

export function readGoalMd(cwd: string, id: string): string | null {
  if (!isSafePersistedId(id)) return null;
  const file = goalMdPath(cwd, id);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf-8");
}

/** v0.34.68 (bug 1.7 — "list/goal drafting disallows until we restart",
 * Screenshot_20260804_212233): parse the durable Policy marker from a
 * renderGoalMarkdown-formatted active-goal .md. Returns undefined when
 * the file is absent or the marker is missing/unrecognized. */
export function parseGoalPolicyFromMd(cwd: string, goalId: string): Policy | undefined {
  const md = readGoalMd(cwd, goalId);
  if (!md) return undefined;
  const m = md.match(/\*\*Policy\*\*:\s*(goal|list)/);
  return m ? (m[1] as Policy) : undefined;
}

/** v0.34.68 (bug 1.7): self-heal a corrupted in-memory state.goal.policy.
 * readState trusts the active.jsonl `state` event verbatim, so a parse
 * failure (truncated write, torn merge, old schema) can leave policy
 * outside {goal,list}; every mode gate branching on
 * `state.goal.policy === "list"` then silently refuses the wrong surface
 * until a restart re-reads the ledger. Re-derive policy from the durable
 * active-goal .md (`**Policy**: …`) and repair state in place (the goal
 * object is shared by reference). Returns the healed policy when
 * repaired; undefined when there is nothing to heal or no durable source
 * exists (a heal_failed ledger entry records the unfixable case). */
export function healCorruptedGoalPolicy(state: State, cwd: string): Policy | undefined {
  const g = state.goal;
  if (!g) return undefined;
  if (g.policy === "goal" || g.policy === "list") return undefined;
  const healed = parseGoalPolicyFromMd(cwd, g.id);
  if (!healed) {
    appendLedger(cwd, "goal_policy_heal_failed", { goalId: g.id, policy: g.policy });
    return undefined;
  }
  const from = g.policy;
  g.policy = healed;
  appendLedger(cwd, "goal_policy_healed", { goalId: g.id, from, to: healed });
  return healed;
}

// =================================================================
// Renderer — replace pi-goal-x's hand-concat detailedSummary
// =================================================================

export function renderGoalMarkdown(goal: Goal): string {
  const lines: string[] = [];
  lines.push(`# Goal`);
  lines.push("");
  lines.push(`**Status**: ${statusLabel(goal.status)}`);
  lines.push(`**Policy**: ${goal.policy}`);
  if (goal.agentRole) lines.push(`**Agent role**: ${goal.agentRole}`);
  lines.push(`**Auto-continue**: ${goal.autoContinue ? "on" : "off"}`);
  if (goal.activePath) lines.push(`**File**: \`${path.relative(path.dirname(goal.activePath), goal.activePath) || goal.activePath}\``);
  if (goal.archivedPath) lines.push(`**Archive**: \`${path.relative(path.dirname(goal.archivedPath), goal.archivedPath) || goal.archivedPath}\``);
  if (goal.stopReason) lines.push(`**Stop reason**: ${sanitizeProviderDisplayText(goal.stopReason)}`);
  if (goal.pauseReason) lines.push(`**Pause reason**: ${sanitizeProviderDisplayText(goal.pauseReason)}`);
  if (goal.pauseSuggestedAction) lines.push(`**Agent suggests**: ${sanitizeProviderDisplayText(goal.pauseSuggestedAction)}`);
  if (goal.providerErrorDiagnostic) {
    lines.push("## Provider diagnostic (forensics)");
    lines.push("");
    lines.push("```text");
    lines.push(goal.providerErrorDiagnostic.replace(/```/g, "'''"));
    lines.push("```");
    lines.push("");
  }
  if (goal.pendingCompletion) {
    const phase = goal.pendingCompletion.phase ?? "recovery-pending";
    lines.push(`**Completion audit**: ${phase}`);
    if (goal.pendingCompletion.attemptId) lines.push(`**Completion audit attempt**: \`${goal.pendingCompletion.attemptId}\``);
  }
  lines.push("");
  lines.push("## Objective");
  lines.push("");
  lines.push("> " + goal.objective);
  lines.push("");
  if (goal.repairTarget) {
    lines.push("## Replan target (preserved)");
    lines.push("");
    lines.push(`- Source item: \`${goal.repairTarget.id}\``);
    lines.push(`- Original objective: ${goal.repairTarget.objective}`);
    if (goal.repairTarget.verificationContract) lines.push(`- Original contract: ${goal.repairTarget.verificationContract}`);
    lines.push(`- Detected reasons: ${goal.repairTarget.reasons.join(", ")}`);
    lines.push("");
  }
  if (goal.completionSummary) {
    // v0.34.91: the agent's completion recap lands in the durable record
    // (active goal .md → archive), so the one-line widget recap has a
    // full-length home after the goal leaves the surface.
    lines.push("## Completion summary");
    lines.push("");
    lines.push(goal.completionSummary);
    lines.push("");
  }
  if (goal.verificationContract) {
    lines.push("## Verification contract");
    lines.push("");
    lines.push(goal.verificationContract);
    lines.push("");
  }
  if (goal.taskList && goal.taskList.tasks.length > 0) {
    lines.push("## Tasks");
    lines.push("");
    renderTaskTreeMarkdown(goal.taskList.tasks, lines, 0);
    lines.push("");
  }
  if (goal.auditHistory && goal.auditHistory.length > 0) {
    lines.push("## Audit history");
    lines.push("");
    for (const v of goal.auditHistory) {
      lines.push(`- ${v.at} — ${auditVerdictLabel(v)} — \`${v.model}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderTaskTreeMarkdown(tasks: Task[], out: string[], depth: number): void {
  for (const t of tasks) {
    const indent = "  ".repeat(depth);
    const bullet = t.status === "complete" ? "- [x]" : t.status === "in_progress" ? "- [~]" : "- [ ]";
    out.push(`${indent}${bullet} ${t.title}${t.agentRole ? ` [${t.agentRole}]` : ""} \`${t.id}\``);
    if (t.subtasks && t.subtasks.length > 0) {
      renderTaskTreeMarkdown(t.subtasks, out, depth + 1);
    }
  }
}

// =================================================================
// Status helpers
// =================================================================

export function statusLabel(status: Status | null | undefined): string {
  switch (status) {
    case "active": return "active";
    case "auditing": return "auditing";
    case "complete": return "complete";
    case "paused": return "paused";
    case "aborted": return "aborted";
    default: return "no goal";
  }
}

// =================================================================
// ID generation
// =================================================================

/**
 * Strip terminal/control formatting from text before it crosses a user-facing
 * display boundary. This is deliberately projection-only: persisted
 * objectives, verification contracts, prompts, and audit inputs retain the
 * user's exact text.
 */
const TERMINAL_ESCAPE_SEQUENCES = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;
const DISPLAY_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
export function sanitizeDisplayText(value: string): string {
  return value.replace(TERMINAL_ESCAPE_SEQUENCES, "").replace(DISPLAY_CONTROL_CHARS, " ");
}

/** Inline display projection used by notifications and one-line status text. */
export function compactDisplayText(value: string): string {
  return sanitizeDisplayText(value).replace(/\s+/g, " ").trim();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A freshness marker is valid only when it was emitted already, not merely
 * within the upper age bound. Rejecting negative ages prevents future-dated
 * sidecars from bypassing restart/replay fences. */
export function isFreshPastTimestamp(at: number, windowMs: number, now = Date.now()): boolean {
  const age = now - at;
  return Number.isFinite(at) && Number.isFinite(windowMs) && windowMs > 0 && age >= 0 && age < windowMs;
}

/** Stable queue ordering: new sidecars use queueOrder; legacy sidecars fall
 * back to their durable timestamp and id instead of filesystem enumeration. */
export function compareQueueItems(a: Pick<ListItem, "id" | "addedAt" | "queueOrder">, b: Pick<ListItem, "id" | "addedAt" | "queueOrder">): number {
  const aOrder = typeof a.queueOrder === "number" && Number.isFinite(a.queueOrder) ? a.queueOrder : undefined;
  const bOrder = typeof b.queueOrder === "number" && Number.isFinite(b.queueOrder) ? b.queueOrder : undefined;
  if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
  const added = a.addedAt.localeCompare(b.addedAt);
  if (added !== 0) return added;
  if (aOrder !== undefined && bOrder === undefined) return -1;
  if (aOrder === undefined && bOrder !== undefined) return 1;
  return a.id.localeCompare(b.id);
}

/** Assign durable positions to newly enqueued items. Existing positions are
 * retained, so a reload/recovery cannot reorder a confirmed batch. */
export function assignQueueOrder<T extends ListItem>(items: readonly T[], existing: readonly ListItem[] = []): T[] {
  let next = existing.reduce((max, item) => {
    const order = typeof item.queueOrder === "number" && Number.isFinite(item.queueOrder) ? item.queueOrder : -1;
    return Math.max(max, order);
  }, -1) + 1;
  return items.map((item) => item.queueOrder === undefined ? { ...item, queueOrder: next++ } : item);
}

/** Visible queue positions used by /list show/list_status and their actions.
 * Top-level items are numbered `1`, `2`, … and children are addressable as
 * `1.1`, `1.2`, …; the returned flat index is the storage index consumed by
 * the existing activation/removal machinery. */
export interface VisibleListPosition {
  label: string;
  item: ListItem;
  flatIndex: number;
}

export function visibleListPositions(queue: readonly ListItem[]): VisibleListPosition[] {
  const out: VisibleListPosition[] = [];
  let top = 0;
  for (let flatIndex = 0; flatIndex < queue.length; flatIndex++) {
    const item = queue[flatIndex]!;
    if (item.parentId) continue;
    top++;
    out.push({ label: String(top), item, flatIndex });
    let child = 0;
    for (let childIndex = 0; childIndex < queue.length; childIndex++) {
      const candidate = queue[childIndex]!;
      if (candidate.parentId !== item.id) continue;
      child++;
      out.push({ label: `${top}.${child}`, item: candidate, flatIndex: childIndex });
    }
  }
  return out;
}

export function parseVisibleListPosition(value: string | number): string | null {
  const raw = String(value).trim();
  return /^\d+(?:\.\d+)?$/.test(raw) && !raw.startsWith("0") && !raw.endsWith(".0") ? raw : null;
}

export function visibleListPosition(queue: readonly ListItem[], value: string | number): VisibleListPosition | undefined {
  const label = parseVisibleListPosition(value);
  return label ? visibleListPositions(queue).find((entry) => entry.label === label) : undefined;
}

/**
 * v0.34.59: revision token — return {goalId, revision} for use as a
 * (focus-token, sandbox-check) at async boundaries. The orchestrator
 * captures this before spawning a detached worker, the worker echoes it
 * back through result.json, and the parent re-validates it before
 * applying the verdict. A mismatched token refuses to apply rather than
 * silently overwriting a goal that moved on.
 */
export interface GoalRevisionToken {
  goalId: string;
  revision: number;
}

export function captureGoalRevision(goal: Goal | null | undefined): GoalRevisionToken | null {
  if (!goal || !goal.id) return null;
  return { goalId: goal.id, revision: goal.revision ?? 0 };
}

export function isGoalRevisionCurrent(captured: GoalRevisionToken | null, current: Goal | null | undefined): boolean {
  if (!captured) return true; // v0.34.59: pre-revision goals pass through unchanged
  const cur = current?.revision ?? 0;
  if (!current || current.id !== captured.goalId) return false;
  return cur === captured.revision;
}

/**
 * Bump the goal's revision in-place. Persist path calls this before
 * appendLedger so the on-disk state.goal.revision strictly increases on
 * every committed write. The returned object is a fresh reference so the
 * surrounding spread propagates the new revision.
 */
export function bumpGoalRevision(goal: Goal): Goal {
  return { ...goal, revision: (goal.revision ?? 0) + 1 };
}

export function newGoalId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

// =================================================================
// Task helpers
// =================================================================

export function findNextPendingTask(tasks: Task[]): { id: string; title: string; agentRole?: AgentRole } | undefined {
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.status === "pending") return { id: t.id, title: t.title, ...(t.agentRole ? { agentRole: t.agentRole } : {}) };
    // Push subtasks regardless of parent status; we want BFS to find
    // the first pending task anywhere in the tree. A parent's status
    // does not preclude one of its subtasks being pending.
    if (t.subtasks && t.subtasks.length > 0) queue.push(...t.subtasks);
  }
  return undefined;
}

export function buildTaskSummary(tasks: Task[]): string {
  let total = 0;
  let complete = 0;
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    total++;
    if (t.status === "complete") complete++;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return `${complete}/${total} done`;
}

// =================================================================
// Lightweight structural clone (we don't need deepcopy for our shape)
// =================================================================

export function cloneGoal(goal: Goal): Goal {
  return JSON.parse(JSON.stringify(goal));
}

/**
 * Session-restore gate (v0.21.0): a session that carries conversation
 * history ("resume" | "reload" | "fork") IS the goal's own context —
 * auto-resuming work there is natural. A fresh session ("startup" | "new",
 * or an older pi that reports no reason) has no context — restored state
 * HOLDS until an explicit /goal resume (or Auto-resume = on in the /glla
 * settings table, for unattended restarts). One mechanical predicate; no heuristics.
 */
export function shouldAutoResumeOnSessionStart(reason: string | undefined, autoResume: boolean | undefined): boolean {
  // v0.28.21: the DEFAULT flipped to hold-everything (user directive:
  // "load it on session load but not auto start it"). Tri-state:
  //   true      → auto-resume on EVERY session start (unattended rigs;
  //               /glla settings → Auto-resume = on — this is the ONLY
  //               auto-resume path).
  //   false     → never auto-resume; always hold for an explicit resume.
  //   undefined → DEFAULT: never auto-resume either — whatever the reason
  //               ("startup"/"new"/"resume"/"reload"/"fork"/none), the
  //               item is LOADED (visible, state intact) but HELD until an
  //               explicit /goal resume, /list resume, or /loop.
  // Mid-session continuation (agent_end chains, heartbeat refires,
  // post-compaction, list/loop transitions) is not gated here at all — it
  // auto-continues forever unless a super-stuck brake (stall escalation,
  // stale-api terminal, pending-latch watchdog) stops it loudly.
  void reason; // retained for the signature; no reason auto-resumes by default anymore
  return autoResume === true;
}

export type DurableChoice = "deferred" | "inline";

export interface DurableChoiceRecord {
  choice: DurableChoice;
  reason: string;
  followUp?: string;
}

/** Build the bounded payload used by the explicit durable-vs-defer ledger
 * tool. Keep model-authored rationale single-line and small: ledger entries
 * are durable diagnostics, not a second transcript. */
export function buildDurableChoiceRecord(
  choice: DurableChoice,
  reason: string,
  followUp?: string,
): DurableChoiceRecord {
  const compact = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 500);
  const cleanReason = compact(reason);
  const cleanFollowUp = followUp ? compact(followUp) : "";
  return {
    choice,
    reason: cleanReason,
    ...(cleanFollowUp ? { followUp: cleanFollowUp } : {}),
  };
}

/**
 * The semantic order for the durable-vs-defer decision surface. This is a
 * domain invariant, not a string-search convention: every prompt/UI
 * projection must render the durable action before the fallback.
 */
export const DURABLE_DEFER_PLAQUE_ORDER = ["durable", "defer"] as const;
export type DurableDeferPlaqueKind = typeof DURABLE_DEFER_PLAQUE_ORDER[number];

export interface DurableDeferRecommendationInput {
  /** The maintainable action the confirmed contract calls for. */
  durableFix: string;
  /** Earlier workaround/defer recommendations, retained as bounded evidence. */
  deferRecommendations: readonly string[];
  /** True only when the durable action is unsafe, impossible, or blocked now. */
  durableBlocked?: boolean;
}

export interface DurableDeferPlaque {
  kind: DurableDeferPlaqueKind;
  title: string;
  body: string;
  recommended: boolean;
}

export interface DurableDeferRecommendation {
  choice: DurableChoice;
  deferCount: number;
  plaques: DurableDeferPlaque[];
}

function compactDurableDeferText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Normalize the bounded facts persisted with a goal and projected into the
 * UI. The recommendation surface is evidence-bearing state, not a transcript
 * dump: keep one durable action and at most eight compact fallback notes. */
export function normalizeDurableDeferRecommendationInput(
  input: DurableDeferRecommendationInput,
): DurableDeferRecommendationInput {
  const durableFix = compactDurableDeferText(input.durableFix);
  const deferRecommendations = input.deferRecommendations
    .map((recommendation) => compactDurableDeferText(recommendation))
    .filter(Boolean)
    .slice(0, 8);
  return {
    durableFix,
    deferRecommendations,
    ...(input.durableBlocked !== undefined ? { durableBlocked: input.durableBlocked } : {}),
  };
}

/**
 * Resolve the long-running recommendation from its actual decision facts.
 * Previous defer recommendations do not demote a safe durable fix; only an
 * explicit unsafe/impossible/blocked fact permits the reversible fallback.
 */
export function recommendDurableDeferChoice(input: DurableDeferRecommendationInput): DurableChoice {
  return input.durableBlocked === true ? "deferred" : "inline";
}

/**
 * Build the ordered recommendation plaques consumed by prompt and UI
 * projections. The returned order is driven by DURABLE_DEFER_PLAQUE_ORDER so
 * a future wording change cannot make a first-occurrence test look semantic.
 */
export function buildDurableDeferRecommendation(input: DurableDeferRecommendationInput): DurableDeferRecommendation {
  const facts = normalizeDurableDeferRecommendationInput(input);
  const durableFix = facts.durableFix || "the durable root-cause fix";
  const deferCount = facts.deferRecommendations.length;
  const choice = recommendDurableDeferChoice(facts);
  const plaques: Record<DurableDeferPlaqueKind, DurableDeferPlaque> = {
    durable: {
      kind: "durable",
      title: "Durable fix",
      body: choice === "inline"
        ? `Implement ${durableFix} now; prior defer recommendations do not move it behind the fallback.`
        : `Keep ${durableFix} as the follow-up; it is blocked for this turn, so use only a reversible workaround.`,
      recommended: choice === "inline",
    },
    defer: {
      kind: "defer",
      title: "Defer / workaround",
      body: "Use only when the durable action is unsafe, impossible, or blocked, and record its bounded follow-up.",
      recommended: choice === "deferred",
    },
  };
  return {
    choice,
    deferCount,
    plaques: DURABLE_DEFER_PLAQUE_ORDER.map((kind) => plaques[kind]),
  };
}

/** Stable policy projection generated from the same recommendation path used
 * by the inspectable decision surface. The example deliberately contains
 * three defer recommendations, matching the field-reported regression. */
export function formatDurableDeferPolicyLine(): string {
  const example = buildDurableDeferRecommendation({
    durableFix: "the durable design",
    deferRecommendations: ["defer one", "defer two", "defer three"],
  });
  const order = example.plaques.map((plaque) => plaque.kind).join(" → ");
  return `- Defer vs durable — long-term focused action outranks defer: after ${example.deferCount} defer recommendations, the inline choice is still the durable fix, not a defer; call 'record_goal_judgment' with choice='inline' for that durable action or choice='deferred' only for a genuinely unsafe, impossible, or currently blocked fix, and include the reason (plus a follow-up for a defer). The ledger distinguishes deferred vs inline. Recommendation plaques render in semantic order ${order}; the plaque collision regression (N=31 i%2 wrap between the-ember-throne and the-frost-beneath) must never wrap durable ordering.`;
}

/**
 * Canonical judgment policy for unattended and multi-turn work. This is a
 * product rule, not a user preference toggle: changing it between sessions
 * would make the same verification contract produce different decisions.
 */
export const LONG_RUNNING_JUDGMENT_POLICY = `LONG-RUNNING JUDGMENT POLICY:
- Preserve the objective and verification contract as the source of truth. The default answer is the durable, maintainable root-cause fix — decide it and proceed; do not stop at a cosmetic workaround merely because it is faster.
- "Band-aid now vs do it proper" is NEVER a question: when the durable fix is the clearly best call, do it — no ask_user_question, no pause_goal, no "which do you prefer" framing. Record the choice and the reasoning in the turn.
${formatDurableDeferPolicyLine()}
- Use an opportunistic workaround only when the durable fix is genuinely unsafe, impossible, or blocked right now; the workaround must be reversible and testable, and its durable follow-up is recorded (ledger or comment) instead of silently treated as final.
- Premium engineering standards are mandatory: code must be cleanly typed, tested, architecturally sound, and resilient across lifecycle boundaries. Never lower test standards, fake assertions, or bypass types.
- Autonomous pivot strategy: if an implementation approach fails verification after 2 attempts, do not loop on the same failing line. Autonomously step back, diagnose the root invariant, and pivot to a clean alternative architecture.
- Non-interruption & sensible defaults: never pause a multi-hour run for obvious choices, cosmetic naming, or non-blocking secondary questions. Pick the sensible architectural default, implement it, record the rationale, and continue. Defer non-blocking notes to the final completion summary. Compensate for zero mid-run questions by asking MORE up front: during drafting, batch 2-4 critical scope/acceptance questions with recommended defaults via a single ask_user_question invocation, so active execution needs no further clarification.
- Decide autonomously through local implementation choices without interrupting the user. Ask one focused question ONLY at a genuine trade-off where the user's preference materially changes the outcome: an irreversible/destructive external action, a missing permission/credential, or two options with comparable real cost.
- In unattended mode, choose the safest contract-preserving path and continue. If no safe choice exists, raise a concrete DECIDE question with a recommended default; never ask a vague progress question or wait on a guessed provider/quota reset.`;

/**
 * Guidance specific to an already-confirmed goal. Drafting is the place to
 * resolve scope and acceptance questions; active execution should not reopen
 * reversible local choices or turn them into user-facing pauses.
 */
export const ACTIVE_EXECUTION_QUESTION_GUIDANCE = `ACTIVE-EXECUTION QUESTION DISCIPLINE:
- Drafting is the ONLY place to gather scope, acceptance criteria, constraints, and trade-offs — batch 2-4 sharp questions up front with recommended defaults via one ask_user_question call. Once active, treat the confirmed objective and verification contract as sufficient context and do NOT reopen reversible local choices.
- During active execution, do NOT ask about reversible implementation choices, naming, formatting, test shape, or whether to continue. Choose the maintainable contract-preserving option, record the rationale, and proceed. The target is zero mid-execution questions unless proceeding would cross an irreversible/destructive external boundary, require a missing permission/credential, or face two genuinely comparable options with materially different results.
- Defer non-blocking preferences and alternatives to the completion summary (or a durable note); do not turn them into a pause or question.
- For the rare necessary mid-run question, state the exact impact, include a recommended default, and pause only the dependent action; continue independent work when possible.
- Never ask a vague progress or "what next?" question, and never wait on a guessed provider or quota reset; use bounded recovery or choose the safe default. If drafting left an ambiguity, pick the safest contract-preserving default and record it rather than interrupting a multi-hour run.`;

/**
 * v0.23.5: normalize a drafter-supplied verification contract for the
 * Confirm dialog AND for storage. Three cleanups, all mechanical:
 *  1. Drop bare introducer lines ("Done when:", "Done when ALL of the
 *     following are true:") — the dialog adds its own "Done when" header;
 *     a model-supplied one renders doubled (field-observed) and pollutes
 *     the shield's item list.
 *  2. Strip a glued "Done when: " prefix on a content line.
 *  3. Renumber bullet/numbered lines sequentially ("1.", "2.", ...) so the
 *     dialog reads as a checklist and reject-feedback can cite item
 *     numbers. Non-bullet prose lines pass through untouched.
 */
export function normalizeDraftContract(raw: string): string {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !/^(?:done when|verified when|verify|verification)\b[^:]*:\s*$/i.test(l))
    .map((l) => l.replace(/^(?:done when|verified when)\s*:\s+/i, ""))
    .filter((l) => l.length > 0);
  let n = 0;
  return lines
    .map((l) => {
      const m = l.match(/^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/);
      return m ? `${++n}. ${m[1]}` : l;
    })
    .join("\n");
}

/** Count the numbered checklist items in a normalized contract. */
export function draftContractItemCount(normalized: string): number {
  return normalized.split("\n").filter((l) => /^\d+\.\s/.test(l)).length;
}

/**
 * Split raw objective text into { objective, verificationContract } at the
 * first "Done when…:"-family marker (line-start preferred, inline fallback
 * for one-liners). v0.23.7: the marker family accepts ANY text between the
 * keyword and the colon ("Done when ALL of the following are true:") —
 * the shield's contractItems already drops such introducer lines
 * (v0.23.4), and goalArgsNeedDrafting recognizes the same phrase, so the
 * three "done when" parsers can no longer drift apart. Lives in the pure
 * module so tests exercise THIS function, not a copy (the pre-0.23.7 test
 * re-implemented it and silently went stale).
 */
/**
 * v0.34.76 (OPEN-ISSUES 1.11): the `Parallel:` declaration marker.
 * Line-start OR inline, case-insensitive; truthy values yes|true|1|safe|parallel,
 * falsy no|false|0|none|off. Mirrors the `Done when:` marker style so a
 * one-liner like "Create x.txt. Parallel: yes. Done when: grep -q ok x.txt"
 * parses the same way a drafted multi-line item does. The marker is CONSUMED
 * from the text — it is a property of the item, not part of the objective or
 * the verification contract.
 */
export const PARALLEL_MARKER = /[ \t]*\bparallel\b\s*:\s*(yes|true|1|safe|parallel|no|false|0|none|off)\b[.,;]?[ \t]*/i;

/**
 * v0.34.81 (LIGHT parent/child): the `Subtask of: <parent objective>` marker.
 * Anchored at line start of the FIRST line of the declaration so a child
 * objective on subsequent lines is never mistaken for a parent. The parent
 * objective runs to the first spaced em-dash / en-dash / hyphen separator
 * ("Deploy the release pipeline — bump version" → parent "Deploy the release
 * pipeline", child "bump version"); absent the separator the entire line
 * after the colon is the parent and the child objective is empty (the
 * enqueue path refuses empty-objective items). The marker is CONSUMED —
 * parentObjective is a property of the item, not part of the objective.
 *
 * Case-insensitive; one-level only (a nested subtask is refused at enqueue).
 */
export const SUBTASK_MARKER = /^[ \t]*subtask of[ \t]*:[ \t]*(.*)$/i;

export function extractSubtaskParent(raw: string): { objective: string; parentObjective: string | undefined } {
  const lines = raw.split("\n");
  const first = lines[0] ?? "";
  const m = first.match(SUBTASK_MARKER);
  if (!m) return { objective: raw.trim(), parentObjective: undefined };
  const rest = m[1] ?? "";
  // First spaced em/en/hyphen separator — require whitespace around it so a
  // hyphen inside a parent objective ("Fix A-B") does not split.
  const sep = rest.match(/^(.+?)[ \t]+[—–-][ \t]+(.*)$/);
  const parentObjective = ((sep ? sep[1] : rest) ?? "").trim() || undefined;
  const head = sep ? (sep[2] ?? "") : "";
  const objective = ([head, ...lines.slice(1)].join("\n")).trim();
  return { objective, parentObjective };
}

/**
 * Explicit specialist declaration for goals, list items, and task plans.
 * Natural-language mentions of design work are intentionally untouched; the
 * role is selected only by a declaration such as `Agent: Designer` or
 * `Role: designer` (the `Designer: yes` shorthand is also accepted).
 */
export const AGENT_ROLE_MARKER = /[ \t]*(?:\b(?:agent|role)\s*:\s*designer\b|\bdesigner\s*:\s*(?:yes|true|on)\b)[.,;]?[ \t]*/i;

export function extractAgentRole(raw: string): { objective: string; agentRole: AgentRole | undefined } {
  const m = raw.match(AGENT_ROLE_MARKER);
  if (!m) return { objective: raw.trim(), agentRole: undefined };
  const objective = (raw.slice(0, m.index ?? 0) + " " + raw.slice((m.index ?? 0) + m[0].length))
    .replace(/[ \t]{2,}/g, " ")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .trim();
  return { objective, agentRole: "designer" };
}

export function extractParallelFlag(raw: string): { objective: string; parallelSafe: boolean | undefined } {
  const m = raw.match(PARALLEL_MARKER);
  if (!m) return { objective: raw.trim(), parallelSafe: undefined };
  const value = m[1]!.toLowerCase();
  const parallelSafe = !["no", "false", "0", "none", "off"].includes(value);
  // Reconstruct the objective around the cut: join with a single space, then
  // collapse doubles, re-space a comma/semicolon that lost its follower
  // ("first,then" → "first, then"), and trim each line so a line-final marker
  // never leaves trailing whitespace.
  const objective = (raw.slice(0, m.index ?? 0) + " " + raw.slice((m.index ?? 0) + m[0].length))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([,;])([A-Za-z])/g, "$1 $2")
    .split("\n").map((l) => l.trimEnd()).join("\n")
    .trim();
  return { objective, parallelSafe };
}

/**
 * v0.34.76: full list-item declaration parse in the right order — strip the
 * `Parallel:` marker FIRST, then split `Done when:` out of the cleaned text.
 * A marker inside the contract block still gets stripped before the contract
 * text is captured, so the contract never carries the declaration.
 *
 * v0.34.81 (LIGHT parent/child): the `Subtask of:` marker is stripped BEFORE
 * the parallel/contract pass, so the child objective (the remainder) still
 * gets its own `Parallel:` and `Done when:` clauses parsed normally. The
 * resolved parent OBJECTIVE is returned for the enqueue path to bind by
 * match; the binding itself (queue-item id lookup) lives in goal.ts where
 * the queue context exists.
 */
export function parseListItemDeclaration(raw: string): { objective: string; agentRole: AgentRole | undefined; parallelSafe: boolean | undefined; verificationContract: string; parentObjective: string | undefined } {
  const { objective, parentObjective } = extractSubtaskParent(raw);
  const { objective: obj1, agentRole } = extractAgentRole(objective);
  const { objective: obj2, parallelSafe } = extractParallelFlag(obj1);
  const ext = extractVerificationContract(obj2);
  return { objective: ext.objective, agentRole, parallelSafe, verificationContract: ext.verificationContract, parentObjective };
}

export function extractVerificationContract(raw: string): { objective: string; verificationContract: string; explicitClear: boolean } {
  // Line-based first: a marker at line start begins the contract block.
  const lines = raw.split("\n");
  let mode: "obj" | "verify" = "obj";
  const objParts: string[] = [];
  const verifyParts: string[] = [];
  // v0.34.51: a BARE contract marker ("Done when:" with nothing after it) is
  // an explicit CLEAR signal — the caller wipes the stored contract instead
  // of preserving or replacing it. The bare marker line is consumed, never
  // kept as contract text; later lines after a bare marker still belong to
  // the contract block.
  let explicitClear = false;
  // v0.35.53 (note.md Now): "verify"/"verification" are also ordinary
  // imperative verbs — the marker form requires the colon IMMEDIATELY after
  // (optionally "verify when:"). The old unbounded `verify\b[^:]*:` swallowed
  // a whole imperative sentence as a marker ("Verify the shipped X pass (...):
  // confirm ..."), leaving the objective EMPTY and the entire intent inside
  // the verification contract — the field item then tripped the activation
  // gate's "empty" reason into an endless repair-card loop (neonbreak:
  // faulty_objective_list_activation_blocked ×42 over 22h). "done"/"done
  // when"/"verified when" keep a bounded decorated-marker gap (they are not
  // imperative openers), now capped at 60 chars so prose tails cannot
  // masquerade as markers either.
  const MARKER_START = /^\s*(?:(?:done|verified)\s+when\b[^:]{0,60}:|done\b[^:]{0,60}:|verify(?:\s+when)?\s*:|verification\s*:)/i;
  for (const line of lines) {
    const m = line.match(MARKER_START);
    if (m) {
      mode = "verify";
      if (!line.slice(m[0].length).trim()) {
        explicitClear = true;
        continue;
      }
    }
    if (mode === "obj") objParts.push(line);
    else verifyParts.push(line);
  }
  let objective = objParts.join("\n").trim();
  let verificationContract = verifyParts.join("\n").trim();

  // Inline fallback: users write one-liners like
  //   "Create x.txt. Done when: grep -q ok x.txt"
  // where the marker is mid-line. Split at the first inline marker. Keep
  // bare `verify` out of the broad marker alternative: it is also a normal
  // imperative (`Run the audit and verify ... Done when: ...`) and must not
  // truncate the objective before the actual Done when marker. `Verify:`
  // remains supported as the explicit short marker form.
  if (!verificationContract) {
    const m = raw.match(/^(.*?)(?:\.|;)?\s+(?:(?:done when|verified when|verification)\b[^:]*:|verify\s*:)\s*(.+)$/is);
    if (m) {
      objective = (m[1] ?? "").trim().replace(/[.;]\s*$/, "");
      verificationContract = (m[2] ?? "").trim();
    } else if (!explicitClear) {
      // Trailing bare marker mid-line: "Do x. Done when:" — explicit clear.
      const empty = raw.match(/^(.*?)\s+(?:done when|verified when|verify|verification)\b[^:]*:\s*$/is);
      if (empty) {
        objective = (empty[1] ?? "").trim().replace(/[.;]\s*$/, "");
        explicitClear = true;
      }
    }
  }
  return { objective, verificationContract, explicitClear };
}

/**
 * v0.23.8: subagent-session ownership. pi-subagents binds extensions in
 * subagent sessions too, so glla's session_start/handlers fire there with
 * the same module state. The MAIN session owns the goal/loop; subagent
 * sessions are workers — they must never clobber the loop's ctx handle
 * (a headless subagent ctx would silently kill the heartbeat/wedge
 * machinery), never receive continuation injection, and never mutate goal
 * state. pi hands a FRESH ctx wrapper per event (verified in
 * dist/core/extensions/runner.js — createContext() per emit), so object
 * identity is useless; ctx.sessionManager is the stable per-session
 * discriminator (each subagent gets its own SessionManager).
 */
export type OwnerClaim = "claim" | "refresh" | "foreign";
export function classifySessionCtx(ownerSession: unknown, ownerLive: boolean, sessionManager: unknown): OwnerClaim {
  if (!ownerSession || !ownerLive) return "claim";
  return sessionManager === ownerSession ? "refresh" : "foreign";
}

// =================================================================
// v0.24.5: tool-visibility self-heal
// =================================================================
//
// Root cause (INCIDENT-COMPLETION-BLACKHOLE-2026-07-23): external
// extensions like pi-plugin-list-selector-modlist call pi.setActiveTools
// with a frozen tool snapshot at session_start. When glla's session_start
// handler runs BEFORE theirs (load order), our lazily-registered agent
// tools get registered, briefly auto-activated, then wiped from the
// model-facing active set on the very next pi.setActiveTools call from
// modlist. Commands, widget, watchdog keep working (they don't go
// through the tool registry), but every agent tool — complete_goal,
// propose_loop_draft, etc. — answers "Tool not found" to the model.
//
// Self-heal: any handler that triggers registerAgentTools must also
// ensure the registered tool names are present in pi.getActiveTools(),
// re-adding any missing ones via pi.setActiveTools. Once per session,
// notify the user naming the external allowlist as the likely culprit
// so they can fix their profile once and silence it.

export const GLLA_TOOL_NAMES = [
  "complete_goal",
  "pause_goal",
  "complete_task",
  "update_task_status",
  "record_goal_judgment",
  "propose_goal_draft",
  "propose_loop_draft",
  "propose_loop_refine",
  "list_add",
  "list_activate",
  "list_status",
  "propose_task_list",
] as const;

export type GllaToolName = (typeof GLLA_TOOL_NAMES)[number];

export function missingGllaTools(activeNames: readonly string[]): readonly GllaToolName[] {
  const active = new Set(activeNames);
  return GLLA_TOOL_NAMES.filter((n) => !active.has(n));
}

/** pi's own wording when a model calls a tool pi cannot dispatch. A pause
 * reason quoting this is evidence of a genuine tool outage — the pause
 * must be accepted, never refused as confabulation. */
export const PI_TOOL_NOT_FOUND_QUOTE = /tool\s+\S+\s+not found/i;

/** A pause reason that claims a GLLA tool does not exist in this session
 * (`no complete_goal tool`, `complete_goal is missing`, …). Ordinary
 * mentions of a tool (results, instructions, summaries) never match —
 * absence language is required. */
export function claimedMissingGllaTool(reason: string): GllaToolName | null {
  const text = (reason ?? "").replace(/\s+/g, " ");
  if (!text) return null;
  for (const name of GLLA_TOOL_NAMES) {
    const absence = new RegExp(
      `\\bno\\s+${name}\\s+tool\\b|\\b${name}\\b[^.]{0,120}?\\b(missing|not found|not available|unavailable|doesn'?t exist|isn'?t available|is not available|no longer (?:available|exists|present))\\b`,
      "i",
    );
    if (absence.test(text)) return name;
  }
  return null;
}

// -----------------------------------------------------------------
// v0.25.0 — eager-continuation contract helpers
// -----------------------------------------------------------------

/** Base defaults (explicit aggressiveMode OFF). auditCap base raised 3 → 5
 * in v0.25.0 (contract item 7 — the "fairly eager" baseline). */
export const BASE_AUDIT_CAP = 5;
export const BASE_STUCK_MAX_INTERVENTIONS = 5;
/** aggressiveMode defaults (contract item 5). Explicit per-key settings
 * always win over these — aggressiveMode flips DEFAULTS, not user choices. */
export const AGGRESSIVE_AUDIT_CAP = 10;
export const AGGRESSIVE_STUCK_MAX_INTERVENTIONS = 10;

export interface EffectiveAggressiveSettings {
  auditCap: number;
  stuckMaxInterventions: number;
  /** 0 = wedge alerts off. */
  wedgeAlertMinutes: number;
  /** Tri-state: true = always auto-resume; false = never; undefined =
   * DEFAULT (hold on human session loads, resume on reload/fork).
   * v0.28.7: must stay tri-state here — coercing unset→false broke the
   * restore gate's default branch (the 0.28.3 regression the behavioral
   * harness caught). */
  autoResume: boolean | undefined;
  aggressiveMode: boolean;
}

/** Layered resolution: explicit per-key value > aggressiveMode default >
 * base default for keep-going limits. autoResume is intentionally excluded
 * from that coercion: it is an explicit global consent for cold restore.
 * Missing aggressiveMode is ON; false is the explicit conservative opt-out.
 * Pure so tests can assert the matrix without a settings file. */
export function resolveEffectiveAggressiveSettings(s: {
  aggressiveMode?: boolean;
  auditCap?: number;
  stuckMaxInterventions?: number;
  wedgeAlertMinutes?: number;
  autoResume?: boolean;
}): EffectiveAggressiveSettings {
  const aggressiveMode = s.aggressiveMode !== false;
  return {
    aggressiveMode,
    auditCap: s.auditCap ?? (aggressiveMode ? AGGRESSIVE_AUDIT_CAP : BASE_AUDIT_CAP),
    stuckMaxInterventions:
      s.stuckMaxInterventions ?? (aggressiveMode ? AGGRESSIVE_STUCK_MAX_INTERVENTIONS : BASE_STUCK_MAX_INTERVENTIONS),
    wedgeAlertMinutes: s.wedgeAlertMinutes ?? (aggressiveMode ? 0 : 30),
    // autoResume is a separate explicit global consent. Aggressive mode may
    // widen retry/stall defaults, but must not turn a cold restore into an
    // unattended launch without the user's autoResume:true setting.
    autoResume: s.autoResume,
  };
}

/** Extract up to `cap` actionable objection lines from an auditor report
 * (contract item 22): numbered/bulleted lines, most recent last-report
 * wins, longest tails trimmed. Pure — the audit-cap branch and its test
 * share this. */
export function extractPendingTasks(report: string, cap = 5): string[] {
  const out: string[] = [];
  for (const raw of report.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.{8,200})$/);
    if (!m) continue;
    const text = m[1]!.trim();
    // Skip pure-evidence bullets ("file X exists", "tests pass") — we want
    // OBJECTIONS: missing/failing/not-done language.
    if (!/miss|fail|not |no |lack|absent|doesn|didn|won|can'?t|remain|todo|fix|requir|incomplete|unverified/i.test(text)) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= cap) break;
  }
  return out;
}

/** Contract item 23: is the auditor's IMPOSSIBLE reason about the WHOLE
 * goal or only part of it? Default "full" (safe — keeps the pause);
 * partial only on explicit subset language. */
export function classifyImpossibleReason(reason: string): "partial" | "full" {
  if (/\b(partial|some items|subset|remaining items|narrow|only .{0,30}(item|part|section)|the rest|rest of)\b/i.test(reason)) {
    return "partial";
  }
  return "full";
}

/** Contract items 25/28: does this objective read as a full-audit /
 * survey pivot? */
export function isFullAuditObjective(objective: string): boolean {
  return /full audit|survey|find all|task ?list|enumerate|audit the (whole |entire )?project/i.test(objective);
}

// --- Auto-committer daemon sentinel (contract item 31) ---

/** Sentinel the auto-committer (dracon-sync) filter checks: when present,
 * the daemon must not rewrite/commit in this repo. The agent writes it
 * after detecting filter-branch damage (see DETACHED COMMIT DETECTION in
 * the continuation prompt). */
export const PAUSE_AUTO_COMMIT_SENTINEL = ".pause-auto-commit";

export function pauseAutoCommit(cwd: string, reason: string): string {
  const dir = piGlaDir(cwd);
  if (stateRootPending()) return path.join(dir, PAUSE_AUTO_COMMIT_SENTINEL);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PAUSE_AUTO_COMMIT_SENTINEL);
  fs.writeFileSync(file, `pausedAt: ${nowIso()}\nreason: ${reason}\n`, "utf-8");
  return file;
}

export function resumeAutoCommit(cwd: string): boolean {
  if (stateRootPending()) return false;
  const file = path.join(piGlaDir(cwd), PAUSE_AUTO_COMMIT_SENTINEL);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function isAutoCommitPaused(cwd: string): boolean {
  try {
    fs.accessSync(path.join(piGlaDir(cwd), PAUSE_AUTO_COMMIT_SENTINEL));
    return true;
  } catch {
    return false;
  }
}

// --- Heartbeat ship-suppression (contract item 27) ---

/** Suppress the heartbeat when work shipped very recently — a session
 * that just committed is transitioning, not stalled. Pure; the tick
 * gathers the timestamps. */
/** @deprecated v0.26.6: no longer called by the heartbeat (self-sustaining
 * under ledger writes / auto-commit daemons). Kept for API compatibility. */
export function shouldSuppressHeartbeatForRecentShip(args: {
  nowMs: number;
  lastShippedAtMs: number | null;
  windowMs?: number;
}): boolean {
  const windowMs = args.windowMs ?? 5 * 60_000;
  if (args.lastShippedAtMs === null) return false;
  return args.nowMs - args.lastShippedAtMs < windowMs;
}

/** Best-effort "when did work last ship" for a repo: newest of the HEAD
 * commit time and the .pi-glla state file mtime. Null when unknown. */
/** v0.26.7: pi's exact stale-runtime error signature — thrown by every
 * runtime-bound method after pi invalidates the extension. v0.29.12 source
 * audit (pi 0.83.0 dist): the ONLY invalidate() caller is AgentSession
 * .dispose(), reachable solely via session replacement (newSession/
 * switchSession/fork/quit). COMPACTION NEVER DISPOSES — manual, auto, and
 * overflow compaction all rebuild context in place. Field note 2026-07-30:
 * 10 stale events in 4 days in endless-td, repeatedly ~3 min after
 * compactions with NO new session file and zombie command handlers still
 * answering — a replacement that disposed but never re-ran factories (or
 * a same-file switchSession); the disposing path is unidentified pi-side. */
export function isStaleApiError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("stale after session replacement");
}

export function lastShippedAtMs(cwd: string): number | null {
  // v0.26.6: the .pi-glla/active.jsonl MTIME term was REMOVED — the
  // heartbeat's own ledger writes refreshed it every 15s, which made the
  // 0.25.0 ship-suppression self-sustaining (darklord: 9.1h / 2,184
  // suppressed ticks). Only a real git commit counts as a ship now.
  let best: number | null = null;
  try {
    const out = execSync("git log -1 --format=%ct", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const sec = Number(out);
    if (Number.isFinite(sec) && sec > 0) best = sec * 1000;
  } catch {
    /* not a git repo or no commits */
  }
  return best;
}

// =================================================================
// v0.25.3: list-philosophy rework — cross-mode recommendation +
// /list depth rollups
// =================================================================

/**
 * Detect a mode mismatch between what the user described and the mode
 * they invoked. Returns a recommendation string for the drafting
 * injection, or undefined when the seed fits the mode.
 *
 * The canonical failure this prevents (real incidents 2026-07-24):
 * "close 76 weak points, one commit each" folded into ONE wrapper goal
 * with an aggregate "≥ 76 commits" contract → auto-committer squash →
 * literal count fails → auditor correctly disapproves finished work.
 */
export function crossRecommendMode(seed: string, mode: "goal" | "list"): string | undefined {
  const s = seed.trim();
  if (!s) return undefined;
  // Aggregate seed: "N items/findings/weak points/screens/todos/fixes"
  // (+ "each" / "one commit" flavor) — the wrapper-goal anti-pattern.
  const aggregate = s.match(/(\d+)\s*(?:items?|findings?|weak[\s-]points?|screens?|todos?|fix(?:es)?|tasks?|issues?)/i);
  const n = aggregate ? Number(aggregate[1]) : 0;
  if (n >= 5) {
    return (
      `[MODE CHECK — this seed names ${n} discrete items${/each|one commit|as a tasklist/i.test(s) ? ' ("each"/"tasklist" phrasing)' : ""}. ` +
      `Do NOT fold them into ONE wrapper ${mode === "list" ? "list item" : "goal"} with an aggregate contract ("≥ ${n} commits") — ` +
      `the auto-committer squashes commits and the literal count fails even when the work is done (the 2026-07-24 76-weak-points incident). ` +
      `Propose ${n} SHORT /list items via propose_goal_draft items[] — each item closes exactly ONE finding with its own per-item contract. ` +
      `Any aggregate re-audit becomes the FINAL /goal, not the first.]`
    );
  }
  if (mode === "list") {
    if (/\b(?:take|takes|taking)\s+(?:a\s+)?(?:few|several|\d+)\s+hours?\b/i.test(s) || /\b(?:multi-hour|deep (?:audit|research|dive)|all day|over the weekend)\b/i.test(s)) {
      return (
        `[MODE CHECK — this seed sounds like multi-hour work. /list items are SHORT (minutes, one focused change). ` +
        `Either break it into ≤ 30-minute items via items[], or tell the user this fits /goal better — one big task, ` +
        `ends on auditor approval. If the user overrides ("as a list item anyway"), comply.]`
      );
    }
  } else {
    if (/^(?:fix|typo|rename|bump|remove|delete|clean ?up|tweak)\b/i.test(s) && s.length < 80 && !/\bhours?\b|\ball\b|\bevery\b|\beach\b/i.test(s)) {
      return (
        `[MODE CHECK — this seed sounds like a five-minute cleanup. A full audited /goal may be overkill; ` +
        `suggest /list (queue of short items) or the tasklist plugin. If the user wants the audit anyway, comply.]`
      );
    }
  }
  return undefined;
}

/** /list depth rollup: how deep is the queue, how stale is the head,
 * how long do items actually take (from archived list-policy goals). */
export interface ListDepthStats {
  queueDepth: number;
  oldestItemId?: string;
  oldestAgeMs?: number;
  avgDurationMs?: number;
  durationSamples: number;
}

export function computeListDepth(
  queue: Array<{ id: string; addedAt: string }>,
  ledgerEntries: Array<{ type: string; value?: any }>,
  nowMs: number,
): ListDepthStats {
  let oldestItemId: string | undefined;
  let oldestAgeMs: number | undefined;
  for (const item of queue) {
    const added = Date.parse(item.addedAt);
    if (Number.isNaN(added)) continue;
    const age = nowMs - added;
    if (oldestAgeMs === undefined || age > oldestAgeMs) {
      oldestAgeMs = age;
      oldestItemId = item.id;
    }
  }
  // Average item duration from the ledger's list-policy goals (most
  // recent 10 with both timestamps).
  const finals = new Map<string, { createdAt?: string; updatedAt?: string; policy?: string; status?: string }>();
  for (const e of ledgerEntries) {
    if (e.type === "state" && e.value?.goal?.id) {
      finals.set(String(e.value.goal.id), e.value.goal);
    }
  }
  const durations: number[] = [];
  for (const g of finals.values()) {
    if (g.policy !== "list") continue;
    if (g.status !== "complete" && g.status !== "archived") continue;
    const c = Date.parse(g.createdAt ?? "");
    const u = Date.parse(g.updatedAt ?? "");
    if (Number.isNaN(c) || Number.isNaN(u) || u < c) continue;
    durations.push(u - c);
  }
  const recent = durations.slice(-10);
  const avgDurationMs = recent.length > 0 ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : undefined;
  return {
    queueDepth: queue.length,
    oldestItemId,
    oldestAgeMs,
    avgDurationMs,
    durationSamples: recent.length,
  };
}

/** Streaming counterpart for the command surface. Only the last state
 * projection for each goal is retained (bounded by the number of goals), not
 * every event and not a second copy of the ledger text. */
export function computeListDepthFromLedger(
  queue: Array<{ id: string; addedAt: string }>,
  cwd: string,
  nowMs: number,
): ListDepthStats {
  const finalStates = new Map<string, { type: string; value?: any }>();
  try {
    scanLedgerRecords(cwd, (entry) => {
      if (entry.type === "state" && entry.value?.goal?.id) {
        finalStates.set(String(entry.value.goal.id), entry);
      }
    });
  } catch {
    // Match the old command's no-ledger behavior: queue age remains useful
    // even when historical duration data cannot be read.
  }
  return computeListDepth(queue, [...finalStates.values()], nowMs);
}

function fmtAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

/** Contract item 7's exact headline format, then detail lines. */
export function formatListDepth(stats: ListDepthStats): string {
  const oldest = stats.oldestAgeMs !== undefined ? fmtAge(stats.oldestAgeMs) : "—";
  const avg = stats.avgDurationMs !== undefined ? fmtAge(stats.avgDurationMs) : "—";
  const lines = [`queue depth: ${stats.queueDepth} · oldest: ${oldest} · avg duration: ${avg}`];
  if (stats.oldestItemId) lines.push(`oldest item: ${fmtAge(stats.oldestAgeMs!)} (id ${stats.oldestItemId})`);
  if (stats.durationSamples > 0) lines.push(`avg item duration: ${fmtAge(stats.avgDurationMs!)} (from last ${stats.durationSamples} archived)`);
  return lines.join("\n");
}

// =================================================================
// v0.25.4: auditor polish — durable audit log, think-block hygiene,
// actionable-tail slicing, infra-transparent streaks
// =================================================================

/** Strip think-block leakage from auditor reports before storage/display.
 * Motivation (wild, 2026-07-25): MiniMax-M3 reports arrive with
 * `<think>...</think>` bodies, stray `</think>` fragments, and non-English
 * reasoning spillover — the executor's feedback should be the verdict,
 * not the auditor's private monologue. */
export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/<200b>/g, "") // stray partial-tag artifact seen in the wild
    .replace(/^\s+/, "");
}

/** One durable audit-log entry — survives state-snapshot rotation, so
 * /glla audits can answer "where are we weak" across the whole project. */
export interface AuditLogEntry {
  at: string;
  goalId: string;
  objective: string;
  verdict: "approved" | "disapproved" | "impossible" | "shield_blocked" | "error";
  model: string;
  thinkingLevel: string;
  report: string;
  impossibleReason?: string;
  error?: string;
  /** v0.25.4 post-audit: how long the audit took, and whether the infra
   * retry fired. */
  durationMs?: number;
  retriedOnce?: boolean;
}

export function auditLogPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "audits.jsonl");
}

export function appendAuditLog(cwd: string, entry: AuditLogEntry): void {
  try {
    if (stateRootPending()) return;
    ensureDirs(cwd);
    fs.appendFileSync(auditLogPath(cwd), JSON.stringify(entry) + "\n");
  } catch {
    /* log best-effort — never block the verdict path */
  }
}

export function readAuditLog(cwd: string, limit?: number): AuditLogEntry[] {
  // The normal command path asks for a bounded newest tail. Read that tail
  // from the end so an append-only audit log cannot turn every `/glla audits`
  // invocation into a whole-file string allocation and JSON parse. Keep the
  // unbounded path below for reviewer curation, which intentionally needs the
  // complete history.
  if (limit !== undefined && Number.isInteger(limit) && limit > 0) {
    const newest: AuditLogEntry[] = [];
    try {
      scanLedgerLinesReverse(auditLogPath(cwd), (line) => {
        const t = line.trim();
        if (!t) return false;
        try {
          const e = JSON.parse(t);
          if (e && typeof e.goalId === "string" && typeof e.verdict === "string") newest.push(e as AuditLogEntry);
        } catch {
          /* skip malformed */
        }
        return newest.length >= limit;
      });
    } catch {
      return [];
    }
    return newest.reverse();
  }

  const out: AuditLogEntry[] = [];
  try {
    scanLedgerLines(auditLogPath(cwd), (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const e = JSON.parse(t);
        if (e && typeof e.goalId === "string" && typeof e.verdict === "string") out.push(e as AuditLogEntry);
      } catch {
        /* skip malformed */
      }
    });
  } catch {
    return [];
  }
  return limit !== undefined ? out.slice(-limit) : out;
}

/** Stream the audit log while retaining only one goal's history. Automatic
 * postaudit review needs the complete verdict order for its target, but it
 * must not first materialise every historical goal's report in the main
 * process. The unfiltered readAuditLog API remains for compatibility. */
export function readAuditLogForGoal(cwd: string, goalId: string): AuditLogEntry[] {
  const out: AuditLogEntry[] = [];
  try {
    scanLedgerLines(auditLogPath(cwd), (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const e = JSON.parse(t);
        if (e && e.goalId === goalId && typeof e.verdict === "string") out.push(e as AuditLogEntry);
      } catch {
        /* skip malformed */
      }
    });
  } catch {
    return [];
  }
  return out;
}

const VERDICT_GLYPH: Record<AuditLogEntry["verdict"], string> = {
  approved: "✔",
  disapproved: "✖",
  impossible: "⛔",
  shield_blocked: "🛡",
  error: "⚠",
};

/** /glla audits list view: one line per verdict, newest last. */
export function formatAuditLog(entries: AuditLogEntry[]): string {
  if (entries.length === 0) return "(no audits logged yet — the log starts with the next verdict)";
  return entries
    .map((e) => {
      const day = e.at.slice(5, 16).replace("T", " ");
      const firstLine = e.verdict === "error"
        ? sanitizeProviderDisplayText(providerErrorPresentation(e.error, "completion").display)
        : sanitizeProviderDisplayText((e.report.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 90));
      return `${VERDICT_GLYPH[e.verdict]} ${day} [${e.goalId.slice(-6)}] ${e.model} — ${firstLine}`;
    })
    .join("\n");
}

// =================================================================
// v0.25.4 (post-audit fix): infra-failure retry-once-with-backoff
// =================================================================

/** Which auditor infra errors are worth an automatic retry? User aborts
 * and missing-model config are NOT — retrying can't help them. Timeouts and
 * watchdog stalls are retriable infrastructure failures. */
export function isRetriableInfraError(error?: string): boolean {
  if (!error) return false;
  if (/^(?:Auditor (?:exceeded|stalled)|.*(?:timed?\s*out|timeout|inactivity))/i.test(error)) return true;
  if (/^(?:Auditor aborted\.?$|user (?:interrupt|abort)|cancelled by user)/i.test(error.trim())) return false;
  if (/no (?:auditor )?model/i.test(error)) return false;
  return true;
}

export interface InfraRetryOutcome<T> {
  result: T;
  retriedOnce: boolean;
}

/** Run the auditor; on any retriable infrastructure failure, wait
 * `backoffMs` and retry EXACTLY once before reporting "auditor
 * infrastructure error (retried once)". The failed pair is never a verdict
 * on the work; provider wording is not consulted to suppress this retry. */
export async function runWithInfraRetry<T extends { error?: string; approved: boolean; disapproved: boolean }>(
  run: () => Promise<T>,
  opts: {
    backoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: string) => void;
    /**
     * v0.34.20: delayed retry callers can fail closed across a session
     * replacement. The first attempt may finish after its ExtensionContext
     * was invalidated; never launch the second attempt unless the caller can
     * prove that its session/generation is still live.
     */
    shouldRetry?: () => boolean;
  } = {},
): Promise<InfraRetryOutcome<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const first = await run();
  if (first.approved || first.disapproved || !isRetriableInfraError(first.error)) {
    return { result: first, retriedOnce: false };
  }
  if (opts.shouldRetry) {
    try {
      if (!opts.shouldRetry()) return { result: first, retriedOnce: false };
    } catch {
      // A lifecycle probe that cannot establish liveness is a hard stop, not
      // permission to retry an old session.
      return { result: first, retriedOnce: false };
    }
  }
  opts.onRetry?.(first.error!);
  // v0.34.141: do not inspect provider families to decide whether the eager
  // retry is allowed. Provider text is retained by the caller for
  // sanitized diagnostics; this scheduler simply retries every retriable
  // infrastructure failure once, then the durable hourly plan takes over.
  await sleep(opts.backoffMs ?? 5000);
  if (opts.shouldRetry) {
    try {
      if (!opts.shouldRetry()) return { result: first, retriedOnce: false };
    } catch {
      return { result: first, retriedOnce: false };
    }
  }
  const second = await run();
  return { result: second, retriedOnce: true };
}

/** /glla audits default view: the ACTIVE goal's own audit history (the
 * surface the goal spec asked for), one line per verdict. */
export function formatGoalAuditHistory(goal: { id: string; auditHistory?: Array<any> }): string {
  const history = goal.auditHistory ?? [];
  if (history.length === 0) return "(no audits on this goal yet)";
  return history
    .map((v) => {
      const verdict = auditVerdictLabel(v);
      const glyph = verdict === "approved" ? "✔" : verdict === "shield-blocked" ? "🛡" : verdict === "impossible" ? "⛔" : verdict === "disapproved" ? "✖" : "⚠";
      const day = String(v.at ?? "").slice(5, 16).replace("T", " ");
      const elapsed = v.durationMs ? ` · ${Math.round(v.durationMs / 60000)}m` : "";
      const firstLine = auditVerdictLabel(v) === "infrastructure failure"
        ? sanitizeProviderDisplayText(providerErrorPresentation(v.error, "completion").display)
        : sanitizeProviderDisplayText((String(v.report ?? "").split("\n").find((l: string) => l.trim()) ?? "").trim().slice(0, 80));
      return `${glyph} ${day} ${v.model ?? "?"}${elapsed} — ${firstLine}`;
    })
    .join("\n");
}
