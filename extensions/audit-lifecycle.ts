/**
 * pi-goal-list-loop-audit — v0.38.99
 * extensions/audit-lifecycle.ts
 *
 * ONE durable lifecycle for the detached completion audit, projected from the
 * stored claim alone. Everything a reader needs to answer "is this still
 * running, is it stuck, is it finished, what do I do next?" comes from this
 * projection, so chat cards, the widget, the goal markdown, and restart
 * recovery cannot disagree about the audit's state.
 *
 * Why a separate projection instead of reading `pendingCompletion.phase` at
 * each call site: the durable claim used to carry three phases
 * (`running` / `recovery-pending` / `retry-waiting`) and an ABSENT phase,
 * where absent silently meant "interrupted". A brand-new claim, a claim whose
 * worker never booted, and a claim abandoned by a crashed host were therefore
 * indistinguishable, and the moment between "verdict approved" and "archive
 * landed" had no representation at all — the only truthful reading of a crash
 * inside that window was a claim that claimed to still be running.
 *
 * The objective-visible states, and the durable evidence for each:
 *
 *   starting        claim persisted, no detached worker event yet
 *                   (`phase: "starting"`, `startedAt`).
 *   running         a detached attempt is in flight and making progress
 *                   (`phase: "running"`, `lastActivityAt` refreshed by the
 *                   throttled progress writer).
 *   settling        a verdict was APPLIED durably and the terminal archive is
 *                   in progress (`phase: "settling"`, `verdictAt`) — this is
 *                   the window a crash used to hide, and the only state a
 *                   restart must re-drive.
 *   approved        the settlement is durable: archive landed, summary queued
 *                   (`settlementAllowsTerminalRender` is its gate). Reported by
 *                   the settlement driver itself, never inferred from a claim,
 *                   because an archived goal no longer carries its claim — an
 *                   unresolved claim must not be able to LOOK approved.
 *   recovery-needed parked after an interruption, a no-progress window, a
 *                   failed settlement, or a host restart with no worker
 *                   (`phase: "recovery-pending"`, `recoveryAt`).
 *   retry-waiting   a bounded automatic retry is armed and durably dated
 *                   (`phase: "retry-waiting"`, `recoveryRetryAt`).
 *
 * Terminality is a property of the settlement, never of the goal status: an
 * unresolved claim is NEVER terminal, no matter how the enclosing goal reads.
 *
 * Pure module: no state singleton, no filesystem, no clock of its own (the
 * caller passes `now`). It declares the claim fields it reads structurally,
 * so it can be imported by goal-loop-core without a runtime cycle.
 */

/** The structural claim fields the projection reads. */
export interface AuditClaimLike {
  at?: string;
  phase?: string;
  attemptId?: string;
  startedAt?: string;
  lastActivityAt?: string;
  verdictAt?: string;
  recoveryAt?: string;
  recoveryRetryAt?: string;
  recoveryReason?: string;
  providerErrorDiagnostic?: string;
  auditorThinkingLevel?: string;
  auditorCandidateRef?: string;
  auditorRetryCandidateRef?: string;
  auditorCandidateRefs?: string[];
}

/** Durable claim phases. `quota-waiting` is the pre-v0.34.142 spelling of
 * `retry-waiting` and is migrated on read, never persisted.
 *
 * There is deliberately NO `approved` phase: the terminal archive releases the
 * claim, so an approved claim cannot outlive its own settlement. `approved` is
 * a settlement state, reported by the settlement driver. */
export type DurableAuditPhase =
  | "starting"
  | "running"
  | "settling"
  | "recovery-pending"
  | "retry-waiting";

/** The lifecycle a reader sees. `recovery-needed` is the projection of the
 * stored `recovery-pending` phase; `approved` is a completed settlement. */
export type AuditLifecycleState =
  | DurableAuditPhase
  | "approved"
  | "recovery-needed";

/** Default no-progress window for an attempt this process owns. An attempt
 * with no durable activity for longer than this is reported as no-progress
 * (the live watchdog still kills the worker; this keeps the DURABLE
 * projection honest across a restart, where no watchdog is running). */
export const AUDIT_NO_PROGRESS_MS = 10 * 60_000;

/** How often a moving attempt may refresh its durable `lastActivityAt`. The
 * value is a heartbeat, not a log: a chatty auditor must not turn every token
 * into an append-only state line. */
export const AUDIT_ACTIVITY_PERSIST_MS = 30_000;

const PERSISTED_PHASES: readonly string[] = [
  "starting",
  "running",
  "settling",
  "recovery-pending",
  "retry-waiting",
];

/** Stored phase → the state a reader sees. */
const PHASE_STATE: Record<DurableAuditPhase, AuditLifecycleState> = {
  starting: "starting",
  running: "running",
  settling: "settling",
  "recovery-pending": "recovery-needed",
  "retry-waiting": "retry-waiting",
};

/** One entry per reader-visible state, so every surface renders the same word
 * for the same state. */
export const LIFECYCLE_LABELS: Record<AuditLifecycleState, string> = {
  starting: "starting",
  running: "running",
  settling: "settling",
  approved: "approved",
  "recovery-pending": "recovery needed",
  "recovery-needed": "recovery needed",
  "retry-waiting": "retry waiting",
};

/**
 * Normalize a persisted (or legacy) phase. Unknown and absent both degrade to
 * `recovery-pending`: a claim whose phase cannot be trusted is an interrupted
 * claim, and the recovery path is the truthful reading — never a terminal one.
 */
export function normalizeAuditPhase(phase: unknown): DurableAuditPhase {
  if (phase === "quota-waiting") return "retry-waiting";
  return typeof phase === "string" && PERSISTED_PHASES.includes(phase)
    ? (phase as DurableAuditPhase)
    : "recovery-pending";
}

/** True only when the claim is in a phase that still OWNS a detached attempt:
 * launched, settling, or not yet started. A crash or a stall in any of these
 * must demote the claim to `recovery-pending` rather than leave it looking
 * live. Everything else is already parked or terminal. */
export function auditPhaseOwnsAttempt(phase: unknown): boolean {
  const normalized = normalizeAuditPhase(phase);
  return normalized === "starting" || normalized === "running" || normalized === "settling";
}

export interface AuditLifecycleProjection {
  /** The state a reader sees. */
  state: AuditLifecycleState;
  /** Normalized durable phase backing the state. */
  phase: DurableAuditPhase;
  /** True when the stored claim carried no (or an unknown) phase — a
   * pre-lifecycle claim, which is by definition an interrupted one. */
  legacy: boolean;
  attemptId?: string;
  startedAt?: string;
  /** The freshest durable activity evidence, normalized to ISO. */
  lastActivityAt?: string;
  /** ms since that evidence; undefined when the claim has no usable
   * timestamp at all (never invented from the current clock). */
  idleMs?: number;
  /** ms since the claim was stored. */
  ageMs: number;
  /** An attempt this process owns with no durable progress past the window. */
  stale: boolean;
  /** Only a completed settlement is terminal. */
  terminal: boolean;
  /** Short display token. */
  label: string;
  /** A real, user-executable next step (never a promise the loop cannot keep). */
  nextAction: string;
}

function parseAt(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function iso(ms: number | undefined): string | undefined {
  return ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export interface AuditLifecycleOptions {
  now?: number;
  /** No-progress window in ms; defaults to AUDIT_NO_PROGRESS_MS. */
  noProgressMs?: number;
  /** The real resume command for the active surface (`/goal resume` or
   * `/list resume`) — display vocabulary only, never invented. */
  resumeCommand?: string;
  /** Durable evidence that the settlement for this claim COMPLETED (archive
   * landed and the summary is queued). Only the settlement driver knows this;
   * it is what separates the `approved` state from `settling`. */
  settled?: boolean;
}

/**
 * Project the durable lifecycle of a stored claim. `undefined` when there is
 * no claim at all (nothing to describe) — callers render their own "no audit"
 * surface rather than inventing a state.
 */
export function auditLifecycleProjection(
  claim: AuditClaimLike | null | undefined,
  opts: AuditLifecycleOptions = {},
): AuditLifecycleProjection | undefined {
  if (!claim) return undefined;
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const noProgressMs = typeof opts.noProgressMs === "number" && opts.noProgressMs > 0
    ? opts.noProgressMs
    : AUDIT_NO_PROGRESS_MS;
  const resumeCommand = opts.resumeCommand?.trim() || "/goal resume";

  const rawPhase = claim.phase;
  const phase = normalizeAuditPhase(rawPhase);
  const legacy = typeof rawPhase !== "string" || !PERSISTED_PHASES.includes(rawPhase);
  // An approved settlement is only ever reachable through the settlement
  // driver; a claim that merely says "settling" stays non-terminal.
  const state: AuditLifecycleState = opts.settled === true ? "approved" : PHASE_STATE[phase];

  // Freshest durable evidence, in trust order: the last activity the attempt
  // itself reported, when the claim was parked, when its verdict landed, then
  // the attempt start, then the claim's own creation. A future timestamp
  // (clock skew / hand-edited state) clamps to zero age instead of rendering
  // a negative age.
  const evidenceMs = [claim.lastActivityAt, claim.recoveryAt, claim.verdictAt, claim.startedAt, claim.at]
    .map(parseAt)
    .find((ms): ms is number => ms !== undefined);
  const storedMs = parseAt(claim.at);
  const idleMs = evidenceMs === undefined ? undefined : Math.max(0, now - evidenceMs);
  const ageMs = storedMs === undefined ? 0 : Math.max(0, now - storedMs);

  const owns = auditPhaseOwnsAttempt(phase);
  const stale = owns && idleMs !== undefined && idleMs >= noProgressMs;
  const retryInMs = parseAt(claim.recoveryRetryAt);
  const evidenceIso = iso(evidenceMs);
  const startedAtIso = iso(parseAt(claim.startedAt));
  const label = LIFECYCLE_LABELS[state];
  const nextAction = (() => {
    if (state === "approved") return "settlement durable — the summary is in .pi-glla/archive/";
    switch (phase) {
      case "starting": return "detached worker starting — /goal cancel discards the claim";
      case "running": return stale
        ? `no progress for ${fmtAge(idleMs ?? 0)} — ${resumeCommand} retries the stored claim`
        : "completion review applies automatically";
      case "settling": return "verdict applied — archiving the approved goal";
      case "retry-waiting": return retryInMs !== undefined && retryInMs > now
        ? `auto-retry in ${fmtAge(retryInMs - now)} — ${resumeCommand} retries now`
        : `${resumeCommand} retries now`;
      case "recovery-pending": return `${resumeCommand} retries the stored claim`;
    }
  })();

  return {
    state,
    phase,
    legacy,
    ageMs,
    stale,
    terminal: state === "approved",
    label,
    nextAction,
    ...(typeof claim.attemptId === "string" && claim.attemptId ? { attemptId: claim.attemptId } : {}),
    ...(evidenceIso ? { lastActivityAt: evidenceIso } : {}),
    ...(startedAtIso ? { startedAt: startedAtIso } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
  };
}

/** Age formatter local to this module so the projection never depends on the
 * display layer (and the display layer can depend on it). */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** One legible line for chat cards, the widget, and goal markdown:
 * `<label> · <evidence> [· no progress <age>]`. */
export function auditLifecycleLine(
  projection: AuditLifecycleProjection | undefined,
): string | undefined {
  if (!projection) return undefined;
  const parts: string[] = [projection.label];
  const idle = projection.idleMs;
  switch (projection.state) {
    case "starting":
      parts.push(`claim stored ${fmtAge(projection.ageMs)} ago`);
      break;
    case "running":
    case "settling":
      parts.push(idle === undefined ? "no activity recorded" : `last activity ${fmtAge(idle)} ago`);
      if (projection.stale) parts.push(`no progress for ${fmtAge(idle ?? 0)}`);
      break;
    case "approved":
      parts.push(idle === undefined ? "settlement durable" : `settled ${fmtAge(idle)} ago`);
      break;
    case "retry-waiting":
      parts.push(idle === undefined ? "retry armed" : `last activity ${fmtAge(idle)} ago`);
      break;
    case "recovery-needed":
      parts.push(`parked ${fmtAge(idle ?? projection.ageMs)} ago`);
      break;
  }
  return parts.join(" · ");
}

// =================================================================
// Settlement — the window between "verdict applied" and "archived"
// =================================================================

/** Durable progress of one approved settlement. Every field is backed by a
 * durable write, so the live path and the post-restart path can be handed the
 * same progress and run the same state machine. */
export interface SettlementProgress {
  /** The approved verdict is durably recorded on the claim
   * (`phase: "settling"`, `verdictAt`). Without it nothing may be archived
   * or rendered. */
  verdictPersisted: boolean;
  /** The terminal archive landed. */
  archived: boolean;
  /** The terminal summary is durably queued in the outbox. */
  renderPersisted: boolean;
  /** A live session confirmed the summary. */
  delivered: boolean;
}

/** The next durable step of an approved settlement. */
export type SettlementStep =
  | "persist-verdict"
  | "archive"
  | "persist-render"
  | "deliver-render"
  | "settled"
  | "park-verdict"
  | "park-archive";

export interface SettlementOutcome {
  step: SettlementStep;
  /** True when this step reached a terminal outcome the caller must not redo. */
  terminal: boolean;
  /** True when the caller must emit no success surface and surface the
   * recovery path instead (a failed durable write, or a failed archive). */
  parked: boolean;
}

/**
 * Decide the next settlement step. The ordering rule lives here, in one
 * place: nothing terminal is ever produced from an unresolved claim — the
 * verdict must be durable before an archive is attempted, and a failed archive
 * parks the APPROVED claim durably (so a restart can finish it) instead of
 * dropping it, which is what previously lost the ability to re-drive.
 */
export function settlementStep(progress: SettlementProgress): SettlementOutcome {
  if (!progress.verdictPersisted) return { step: "persist-verdict", terminal: false, parked: false };
  if (!progress.archived) return { step: "archive", terminal: false, parked: false };
  if (!progress.renderPersisted) return { step: "persist-render", terminal: false, parked: false };
  if (!progress.delivered) return { step: "deliver-render", terminal: false, parked: false };
  return { step: "settled", terminal: true, parked: false };
}

/** Failure outcomes, named so the live and restart paths report identically. */
export function settlementPark(step: "verdict" | "archive"): SettlementOutcome {
  return step === "verdict"
    ? { step: "park-verdict", terminal: false, parked: true }
    : { step: "park-archive", terminal: false, parked: true };
}

/**
 * The single gate every terminal surface (archive card, summary outbox,
 * external notification) must consult before claiming completion. An
 * unresolved audit — no durable verdict, or no archive — is never terminal.
 */
export function settlementAllowsTerminalRender(progress: SettlementProgress): boolean {
  return progress.verdictPersisted && progress.archived;
}

/** Does this stored claim owe terminal work for an approval it already has?
 * The restart path uses it to finish an interrupted settlement. */
export function isSettlingClaim(claim: AuditClaimLike | null | undefined): boolean {
  return !!claim && normalizeAuditPhase(claim.phase) === "settling";
}
