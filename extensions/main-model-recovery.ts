// pi-goal-list-loop-audit — main-session model recovery helpers.
//
// These helpers deliberately contain no pi runtime calls. The orchestration
// layer owns model switching and durable state; this module only normalizes
// configured candidates, recognizes positively non-recoverable failures, and
// computes a bounded-but-persistent retry cadence.

export const MAIN_MODEL_MAX_RETRY_DELAY_MS = 5 * 60 * 60_000;
export const MAIN_MODEL_AUTO_RETRY_HORIZON_MS = 24 * 60 * 60_000;
export const DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES = 15;
/** Keep a fallback chain useful and bounded even when settings are edited
 * outside the UI. Ten alternatives is enough to cross providers/model pools
 * without turning one failure into an unbounded registry walk. */
export const MAX_MAIN_MODEL_FALLBACKS = 10;

export type MainModelFailbackPolicy = "auto" | "sticky";

/** Failback is deliberately opt-out: a configured fallback is temporary cover
 * unless the user explicitly keeps it sticky. Invalid/missing JSON values use
 * the safe default rather than disabling recovery by accident. */
export function isMainModelFailbackAuto(policy: unknown): boolean {
  return policy !== "sticky";
}

/** Convert the preferred-primary probe cadence to a timer delay. The settings
 * UI accepts positive minutes; the runtime still clamps hand-edited values to
 * a useful bounded default. */
export function mainModelPrimaryProbeDelayMs(minutes: unknown = DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES): number {
  const value = typeof minutes === "number" ? minutes : Number(minutes);
  const safeMinutes = Number.isFinite(value) && value > 0 ? value : DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES;
  return Math.max(1_000, Math.round(safeMinutes * 60_000));
}

export type MainModelFailureKind = "rate-limit" | "quota" | "billing" | "auth" | "transient" | "unknown" | "non-recoverable" | "context-overflow";

export interface MainModelFailure {
  kind: MainModelFailureKind;
  raw: string;
  /** Legacy provider-hint fields are accepted by old callers only; the
   * classifier and retry policy never populate or consult them. */
  retryAfterSec?: number;
  retryFromUpstream?: boolean;
  resetAt?: string;
  quotaSignal?: "rate-limit" | "plan-quota" | "billing";
}

/** Return a canonical provider/model reference for a pi model-like object. */
export function modelRef(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { provider?: unknown; id?: unknown };
  return typeof m.provider === "string" && typeof m.id === "string" && m.provider && m.id
    ? `${m.provider}/${m.id}`
    : undefined;
}

/** Split at the first slash: model ids such as openrouter/a/b remain intact. */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** Normalize an ordered list from JSON settings or a comma/semicolon string. */
export function normalizeModelRefs(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const ref = item.trim().replace(/^['"]|['"]$/g, "");
    if (!ref || ref.toLowerCase() === "unset" || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Canonical normalizer for the main-session fallback chain. Unlike the
 * generic model-ref normalizer this is a settings boundary: duplicate model
 * refs are compared case-insensitively and the persisted chain is capped at
 * MAX_MAIN_MODEL_FALLBACKS. The original spelling/order is retained for
 * registry lookup and display.
 */
export function normalizeMainModelFallbackRefs(value: unknown): string[] {
  const raw = normalizeModelRefs(value);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of raw) {
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= MAX_MAIN_MODEL_FALLBACKS) break;
  }
  return out;
}

/** Render the persisted chain exactly as the runtime walks it. Numbering is
 * deliberately part of the display so a settings row, headless /glla dump,
 * and picker all answer the same question: which backup is tried first? */
export function formatMainModelFallbacks(value: unknown): string {
  const refs = normalizeMainModelFallbackRefs(value);
  return refs.length ? refs.map((ref, index) => `${index + 1}. ${ref}`).join(" → ") : "none";
}

/**
 * Classify only provider failures. Context/output-token failures are
 * deterministic prompt-shape problems and must not trigger model rotation.
 *
 * v0.34.116: an override context — `isContextOverflow(raw)` — lets the
 * recovery caller (goal-recovery.ts::tryMainModelFallback / the
 * observeCompactFailure hook) distinguish a "the model is too small for the
 * prompt" failure from "the prompt is too big for any model". The override
 * is the dominant signal: when pi just told us the session_compact ALSO
 * failed and the prompt is STILL over the model's window, the prompt is
 * not the problem — the model is. Route through the fallback chain to a
 * larger-context ref. Without the override the classifier falls back to
 * the deterministic "non-recoverable" verb (a sample of a length cap
 * mid-stream MUST NOT silently rotate when the chain has no ref).
 */
export function classifyMainModelFailure(error: string | undefined, opts?: { isContextOverflow?: boolean }): MainModelFailure {
  const raw = typeof error === "string" ? error.trim() : "";
  const text = raw.toLowerCase();
  if (!raw) return { kind: "unknown", raw };
  // Auditor timeouts / watchdog stalls are transient infrastructure failures, not user aborts.
  if (/^(?:auditor (?:exceeded|stalled)|.*(?:timed?\s*out|timeout|inactivity|no session activity))/i.test(raw)) {
    return { kind: "transient", raw };
  }
  if (/^(?:auditor aborted\.?$|user (?:interrupt|abort)|cancelled by user)/i.test(raw) || /user interrupt/.test(text)) {
    return { kind: "non-recoverable", raw };
  }
  if (/context|output[ -]?token|max_?tokens|length limit|too many tokens|prompt too large|context window/.test(text)) {
    return opts?.isContextOverflow
      ? { kind: "context-overflow", raw }
      : { kind: "non-recoverable", raw };
  }
  // v0.35.51 (note.md Now): payload-size rejections are retryable, NOT a
  // reason to walk the fallback chain — every provider caps request size, so
  // rotation cannot heal a bloated history. The payload guard (context-event
  // projection) bounds image bytes before the next attempt, so the eager
  // first retry succeeds. Observed shapes: 413 {"message":"Downloaded image
  // content cannot exceed 30MB"...} and 413 {"code":"413","message":"Request
  // Entity Too Large"}.
  if (/\b413\b|request entity too large|payload too large|image content cannot exceed/.test(text)) {
    return { kind: "transient", raw };
  }
  if (/401|403|unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication|no api key|credential/.test(text)) {
    return { kind: "auth", raw };
  }
  if (/5\d\d|overload|temporarily unavailable|service unavailable|timeout|timed? ?out|network|fetch failed|socket|econn|gateway|upstream|internal server/.test(text)) {
    return { kind: "transient", raw };
  }
  return { kind: "unknown", raw };
}

/** v0.34.116: detect when a length-context failure happened AFTER the
 * session_compact already failed. The classifier maps this to
 * `context-overflow` (rollback path: rotate to a larger-context ref). The
 * call site is `observeCompactFailure` in goal-recovery.ts: when the next
 * send throws a stale-ctx / "This extension ctx is stale" error AFTER our
 * best-effort compact-and-retry, the prompt is not the problem — the
 * current chosen model cannot serve it. The orchestrator wraps the failure
 * with `isContextOverflow: true` so the selector walks the chain. */
export function isContextOverflowError(error: string | undefined): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return /context|output[ -]?token|max_?tokens|length limit|too many tokens|prompt too large|context window/.test(text);
}

/** Provider failures use one generic send-storm threshold. The old
 * quota/billing/rate-limit distinction is intentionally unused: wording is
 * too unreliable to justify a special escalation branch. */
export const SEND_REARM_GENERIC_ESCALATE_MS = 15 * 60_000;

/** Every recoverable provider failure may use the same configured backup
 * chain. No error family gets a special opt-in or fallback gate. */
export function isMainModelFallbackFailure(failure: MainModelFailure): boolean {
  return failure.kind !== "non-recoverable";
}

/** A provider failure can require durable recovery without implying that a
 * configured backup is available. All recoverable failures use the same
 * bounded retry envelope. */
export function requiresMainModelRecovery(failure: MainModelFailure): boolean {
  return failure.kind !== "non-recoverable";
}

/** Generic send-storm escalation threshold. The timestamp parameter remains
 * for compatibility with the runtime wiring; it is deliberately ignored. */
export function sendStormEscalateMs(): number {
  return SEND_REARM_GENERIC_ESCALATE_MS;
}

/** Return the next configured candidate that has not been attempted. */
export function nextUntriedModelRef(current: string | undefined, refs: string[], attempted: string[] = []): string | undefined {
  const key = (ref: string): string => ref.toLowerCase();
  const currentKey = current === undefined ? undefined : key(current);
  const tried = new Set(attempted.map(key));
  return refs.find((ref) => key(ref) !== currentKey && !tried.has(key(ref)));
}

/**
 * Retry slowly rather than spin: base → 2×base → 4×base → 8×base → 16×base
 * → 5h, then hold after the 24h automatic window. The base is the
 * mainModelRetryMinutes setting and is used by ordinary provider failures.
 */
export function mainModelRetryDelayMs(attempt: number, baseMinutes = 15): number {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes : 15;
  const minutes = Math.min(base * 2 ** Math.max(0, attempt - 1), MAIN_MODEL_MAX_RETRY_DELAY_MS / 60_000);
  return Math.round(minutes * 60_000);
}

/** Return the durable end of one automatic recovery window. Manual resume
 * starts a fresh window; a week-long provider cap therefore cannot cause a
 * week of unattended probes. */
export function mainModelAutoRetryUntil(firstFailureAtMs = Date.now(), horizonMs = MAIN_MODEL_AUTO_RETRY_HORIZON_MS): string {
  const first = Number.isFinite(firstFailureAtMs) ? firstFailureAtMs : Date.now();
  const horizon = Number.isFinite(horizonMs) && horizonMs > 0 ? horizonMs : MAIN_MODEL_AUTO_RETRY_HORIZON_MS;
  return new Date(first + horizon).toISOString();
}

/** Compute the optional top-of-hour probe independently from the configured
 * recovery ladder. The hourlyRetryProbe ticker can add a :00:30 attempt without changing the
 * meaning of mainModelRetryMinutes or the normal bounded backoff. */
export function hourAlignedRetryDelayMs(nowMs = Date.now()): number {
  const next = new Date(nowMs);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return Math.max(1_000, next.getTime() - nowMs);
}

/** One uniform envelope for EVERY provider failure. Error text and upstream
 * Retry-After prose are not trusted to choose a cadence. Every recoverable
 * failure gets the same eager first retry, then the bounded configured ladder;
 * the separate hourly retry adds the :00:30 slot. */
export function mainModelFailureDelayMs(failure: MainModelFailure, attempt: number, baseMinutes = 15, nowMs = Date.now()): number {
  void failure;
  void nowMs;
  if (attempt <= 1) return 5_000;
  return mainModelRetryDelayMs(attempt, baseMinutes);
}
