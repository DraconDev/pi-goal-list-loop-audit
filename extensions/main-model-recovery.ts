// pi-goal-list-loop-audit — main-session model recovery helpers.
//
// These helpers deliberately contain no pi runtime calls. The orchestration
// layer owns model switching and durable state; this module only normalizes
// configured candidates, recognizes positively non-recoverable failures, and
// computes a bounded-but-persistent retry cadence.

import { DEFAULT_QUOTA_RETRY_SEC, parseQuotaError, quotaSignal } from "./quota-retry.js";

export const MAIN_MODEL_MAX_RETRY_DELAY_MS = 5 * 60 * 60_000;
export const MAIN_MODEL_AUTO_RETRY_HORIZON_MS = 24 * 60 * 60_000;
export const DEFAULT_MAIN_MODEL_PRIMARY_PROBE_MINUTES = 15;
/** Keep a fallback chain useful and bounded even when settings are edited
 * outside the UI. Ten alternatives is enough to cross providers/model pools
 * without turning one failure into an unbounded registry walk. */
export const MAX_MAIN_MODEL_FALLBACKS = 10;
/** A detached audit can carry one pinned primary, ten configured fallback
 * refs, and the session model as its final last resort. Cursor persistence
 * needs room for that complete chain across a host restart. */
export const MAX_AUDITOR_CANDIDATE_REFS = MAX_MAIN_MODEL_FALLBACKS + 2;

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
  /** Set only for the provider's explicit prompt-policy refusal event. */
  nonRecoverableReason?: "prompt-policy";
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

/** Normalize an ordered ref list with an explicit case-insensitive bound.
 * The generic list parser remains unbounded for callers that need to report
 * or inspect all user input; bounded settings/state callers opt in here. */
export function normalizeBoundedModelRefs(value: unknown, max: number): string[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  if (limit === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of normalizeModelRefs(value)) {
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= limit) break;
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
  return normalizeBoundedModelRefs(value, MAX_MAIN_MODEL_FALLBACKS);
}

/** Render the persisted chain exactly as the runtime walks it. Numbering is
 * deliberately part of the display so a settings row, headless /glla dump,
 * and picker all answer the same question: which backup is tried first? */
export function formatMainModelFallbacks(value: unknown): string {
  const refs = normalizeMainModelFallbackRefs(value);
  return refs.length ? refs.map((ref, index) => `${index + 1}. ${ref}`).join(" → ") : "none";
}

/**
 * Recognize only the explicit provider event observed in the main-model
 * failure stream. Keep this marker narrow: generic "invalid prompt",
 * content/filter words, policy prose, and HTTP status codes also occur in
 * ordinary diagnostics and must remain recoverable under the generic policy.
 * The marker may be wrapped by normalizeProviderErrorText with a status
 * prefix, so it is intentionally not anchored to the beginning of the text.
 */
export function isPromptPolicyRejection(error: string | undefined): boolean {
  const raw = typeof error === "string" ? error.trim() : "";
  return /\bcodex error event:\s*invalid prompt\b/i.test(classificationEvidence(raw));
}

/** Classify error payload, not opaque trace ids or unrelated metadata. Raw
 * diagnostics stay on MainModelFailure for the existing display/storage path. */
function classificationEvidence(raw: string): string {
  const withoutIds = (text: string) => text.replace(/["']?request[ _-]?id["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;})]+)/gi, "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const payload = JSON.parse(raw.slice(start, end + 1));
      const parts: string[] = [withoutIds(raw.slice(0, start))];
      const read = (value: unknown, depth: number): void => {
        if (depth > 6) return;
        if (typeof value === "string") { parts.push(value); return; }
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        for (const [key, field] of Object.entries(value)) {
          if (["message", "errorMessage", "error_message", "detail", "error", "type"].includes(key)) read(field, depth + 1);
          else if (["code", "status", "statusCode", "status_code"].includes(key)) {
            if ((typeof field === "number" || typeof field === "string") && /^[1-5]\d{2}$/.test(String(field))) parts.push(`HTTP ${field}`);
            else if (typeof field === "string") parts.push(field);
          }
        }
      };
      read(payload, 0);
      return parts.join(" ");
    } catch { /* Malformed provider JSON retains textual error evidence. */ }
  }
  return withoutIds(raw);
}

function hasHttpStatus(text: string, status: RegExp): boolean {
  const codes = text.matchAll(/(?:^|\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+(?:status|error))?|status(?:[ _-]?code)?|error)\s*[:=]?\s*)([1-5]\d{2})(?=$|[\s:;,])/gi);
  return [...codes].some(match => status.test(match[1]!));
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
  const evidence = classificationEvidence(raw);
  const text = evidence.toLowerCase();
  if (!raw) return { kind: "unknown", raw };
  // Auditor timeouts / watchdog stalls are transient infrastructure failures, not user aborts.
  if (/^(?:auditor (?:exceeded|stalled)|.*(?:timed?\s*out|timeout|inactivity|no session activity))/i.test(evidence)) {
    return { kind: "transient", raw };
  }
  if (/^(?:auditor aborted\.?$|user (?:interrupt|abort)|cancelled by user)/i.test(evidence) || /user interrupt/.test(text)) {
    return { kind: "non-recoverable", raw };
  }
  if (isPromptPolicyRejection(evidence)) {
    return { kind: "non-recoverable", raw, nonRecoverableReason: "prompt-policy" };
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
  if (hasHttpStatus(text, /^413$/) || /request entity too large|payload too large|image content cannot exceed/.test(text)) {
    return { kind: "transient", raw };
  }
  if (hasHttpStatus(text, /^40[13]$/) || /unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication|no api key|credential/.test(text)) {
    return { kind: "auth", raw };
  }
  if (hasHttpStatus(text, /^5\d{2}$/) || /overload|temporarily unavailable|service unavailable|timeout|timed? ?out|network|fetch failed|socket|econn|gateway|upstream|internal server/.test(text)) {
    return { kind: "transient", raw };
  }
  return { kind: "unknown", raw };
}

/** A successful tool invocation can still carry a provider/network failure
 * in its output. Only strong pane-shaped markers are eligible here; the loop
 * caller additionally requires the same tool/result fingerprint to repeat
 * before turning this into model recovery, so a one-off `503` in a searched
 * document is not enough to park a loop. */
const IN_BAND_PROVIDER_FAILURE_PATTERN = /\b(?:http\s*)?(?:429|5\d\d)\b|rate[_ -]?limit|too many requests|network[_ -]?error|upstream(?:\s+(?:error|failure|unavailable))?|service unavailable|fetch failed|econn(?:reset|refused)|gateway(?:\s+(?:error|timeout))?/i;

export function classifyInBandProviderFailure(output: string | undefined): MainModelFailure | undefined {
  const raw = typeof output === "string" ? output.trim() : "";
  if (!raw) return undefined;
  // A structured provider policy event is eligible immediately; unlike the
  // generic status/network pane below it is not a repeated-fingerprint
  // heuristic.
  if (isPromptPolicyRejection(raw)) return classifyMainModelFailure(raw);
  if (!IN_BAND_PROVIDER_FAILURE_PATTERN.test(raw)) return undefined;
  const failure = classifyMainModelFailure(raw);
  // Unlike generic non-recoverable classes, the explicit policy event is
  // useful to the orchestration layer even when it arrived as a successful
  // tool_result/in-band provider pane. All other non-recoverable text is
  // intentionally ignored here to avoid promoting arbitrary tool output.
  return failure.nonRecoverableReason === "prompt-policy"
    ? failure
    : failure.kind === "non-recoverable" ? undefined : failure;
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
 * Retry-After prose are not trusted to choose a cadence — EXCEPT one
 * Antigravity-ported carve-out (v0.38.69): a quota-class failure
 * (rate-limit/plan-quota signal) carrying an EXPLICIT upstream reset hint
 * sleeps exactly until reset instead of laddering blindly into a known
 * wall. The hint never widens the envelope (5h per-attempt cap), the eager
 * first retry stays eager, and non-quota signals (transient, billing,
 * unknown) keep the blind ladder — billing still heads for its park.
 * Every other recoverable failure gets the same eager first retry, then
 * the bounded configured ladder; the separate hourly retry adds the
 * :00:30 slot. */
/** v0.38.104: an EMPTY provider response is a transient glitch, not a wall.
 *
 * Field 2026-09-27 (darklord): `Provider returned an empty response` matched
 * no quota signal and no deterministic-client marker, so it fell to the blind
 * ladder — 15m, then 30m, then 60m. The goal sat at 0/29 tasks with
 * "last host activity 49m 21s ago" and looked completely unretried, which is
 * the field report this fixes. An empty completion typically succeeds on an
 * IMMEDIATE retry, so it gets the eager quantum for a few attempts instead of
 * the exponential wall.
 *
 * Markers are narrow on purpose: a message merely CONTAINING the word
 * "empty" ("empty array", "empty test fixture") is not a provider glitch. */
const EMPTY_PROVIDER_RESPONSE = /(?:returned|produces?|produced|gave|sent|got)\s+(?:an?\s+)?empty\s+(?:response|completion|result|message|output|content)|empty\s+(?:response|completion)\s+from\s+(?:the\s+)?(?:provider|api|model)|no\s+(?:response|completion)\s+(?:was\s+)?(?:returned|received)|zero[- ]token\s+(?:response|completion)/i;

/** v0.38.104: transient failures retry EAGERLY, not on the 15-minute
 * ladder. Field direction (operator 2026-09-28): most errors are transient
 * — a 5xx/timeout/empty blip must be hammered for ~a minute before any
 * backoff, on the main lane and every retry lane that shares this function
 * (auditor fallback, model selector, recovery probes). Attempts that get
 * the eager quantum before any ladder takes over. Bounded on purpose: ten
 * 5s probes ride out a transient burst without spinning forever against a
 * genuinely dead endpoint — the short ladder, the 24h horizon, and the
 * error-brake backstops below still terminate a real wall. */
export const TRANSIENT_EAGER_ATTEMPTS = 10;
/** Compat alias: the v0.38.104 empty-response window is now the general
 * transient window. */
export const EMPTY_RESPONSE_EAGER_ATTEMPTS = TRANSIENT_EAGER_ATTEMPTS;
/** Post-eager ladder for transient failures: 1m base (never above the
 * configured base), doubling, capped well below the 5h wall envelope — a
 * flaky provider gets probed every few minutes, not parked for hours. */
export const TRANSIENT_LADDER_BASE_MINUTES = 1;
export const TRANSIENT_LADDER_CAP_MINUTES = 30;

export function isEmptyProviderResponse(raw: string | undefined): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return EMPTY_PROVIDER_RESPONSE.test(raw);
}

/** Failures that retry eagerly rather than climbing the wall ladder.
 * v0.38.104 covered transient weather plus empty blips; v0.38.104 fails
 * OPEN (operator direction 2026-09-28: retry any error aggressively, most
 * are transient): unclassified prose retries eagerly too. What stays on
 * the ladder is exactly what hammering cannot help — auth failures,
 * user aborts and policy refusals (non-recoverable), context overflow —
 * plus anything carrying an explicit quota signal, hinted or not: when
 * the provider says "slow down", 5s probes would be backpressure
 * violation, not diligence. */
export function isEagerRetryFailure(failure: MainModelFailure | undefined): boolean {
  if (!failure) return false;
  if (failure.kind !== "transient" && failure.kind !== "unknown" && !isEmptyProviderResponse(failure.raw)) return false;
  if (quotaSignal(failure.raw)) return false;
  return true;
}

/** Post-eager cadence for transient failures. The rung rebases at the end
 * of the eager window (attempt 11 is rung 1 = 1m), so a blip that survives
 * the hammering backs off from minutes, not from wherever the wall ladder
 * would have put attempt 11. Honors a sub-1m configured base; never
 * exceeds the transient cap. */
export function transientRetryDelayMs(attempt: number, baseMinutes = 15): number {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? Math.min(baseMinutes, TRANSIENT_LADDER_BASE_MINUTES) : TRANSIENT_LADDER_BASE_MINUTES;
  const rung = Math.max(1, attempt - TRANSIENT_EAGER_ATTEMPTS);
  const minutes = Math.min(base * 2 ** (rung - 1), TRANSIENT_LADDER_CAP_MINUTES);
  return Math.round(minutes * 60_000);
}

export function mainModelFailureDelayMs(failure: MainModelFailure, attempt: number, baseMinutes = 15, nowMs = Date.now()): number {
  // v0.38.104: a real wall outranks the eager glitch path. An upstream reset
  // hint means the provider told us when it will accept requests again;
  // shortening that to 5s would hammer a rate-limited endpoint, which is the
  // opposite of what this branch is for. Checked BEFORE the eager rule, never
  // after.
  //
  // v0.38.104: the order was a lie — `attempt <= 1` returned 5s above this
  // check, so the FIRST failure carrying "429 … Retry-After: 14400" slept 5
  // seconds and probed the wall the provider had just named. The hint now
  // wins for every attempt; the eager quantum remains for everything else.
  const resetSleep = quotaResetSleepMs(failure, nowMs);
  if (resetSleep !== undefined) return resetSleep;
  if (attempt <= 1) return 5_000;
  // v0.38.104: transient weather hammers eagerly, then backs off on the
  // short ladder — never the 15m-base wall ladder. Attempt 2 of a 503 used
  // to sleep 30m; the field reads that as "gave up on a blip".
  // v0.38.104: fails open to unclassified prose too (see
  // isEagerRetryFailure); explicit quota signals still veto eager.
  if (isEagerRetryFailure(failure)) {
    if (attempt <= TRANSIENT_EAGER_ATTEMPTS) return 5_000;
    return transientRetryDelayMs(attempt, baseMinutes);
  }
  return mainModelRetryDelayMs(attempt, baseMinutes);
}

/** v0.38.104: kind-aware delay for recovery PROBES, which only carry the
 * episode's durable diagnostic text (no live failure object). The probe
 * path used the blind wall ladder for everything — 7 empty responses
 * parked our own repo goal 300m. v0.38.104: an empty/missing diagnostic
 * fails open to eager like any unclassified error — a probe with no
 * evidence of a wall is a cheap local re-check, and a mid-flight config
 * fix recovers in minutes instead of hours. */
export function probeRetryDelayMs(diagnostic: string | undefined, attempt: number, baseMinutes = 15, nowMs = Date.now()): number {
  const raw = typeof diagnostic === "string" ? diagnostic : "";
  const failure = raw.trim() ? classifyMainModelFailure(raw) : { kind: "unknown", raw: "" } as MainModelFailure;
  return mainModelFailureDelayMs(failure, attempt, baseMinutes, nowMs);
}

/** v0.38.69 (Antigravity port): quota waits never park at the horizon.
 * A rate-limit/plan-quota wall is transient by definition — agy
 * busy-retries it until reset — so the 24h automatic-recovery hold must
 * not end a quota wait. Billing (account wall, not a transient) and every
 * non-quota failure keep their horizon park. Derived from the episode
 * diagnostic text at the hold site, so no new durable state is needed and
 * reloads classify identically. */
export function isQuotaHorizonExempt(raw: string | undefined): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  const signal = quotaSignal(raw);
  return signal === "rate-limit" || signal === "plan-quota";
}

// v0.38.92 classifier lives in quota-retry.ts (shared with the display
// layer); re-exported here so existing importers keep working.
export { isDeterministicProviderError } from "./quota-retry.js";

/** v0.38.69 (Antigravity port): sleep-until-reset for quota-class failures
 * with an explicit upstream reset hint. Returns undefined (keep the blind
 * ladder) unless ALL hold: a rate-limit/plan-quota signal, an upstream
 * hint (header, JSON field, or explicit retry prose — never the silent
 * fallback), and a finite non-negative window. The result is floored at
 * the eager-retry quantum and capped at the per-attempt envelope, so a
 * "retry in 1 week" wall sleeps 5h and re-evaluates instead of parking
 * blind or sleeping unbounded. */
export function quotaResetSleepMs(failure: MainModelFailure, nowMs = Date.now()): number | undefined {
  if (!failure || typeof failure.raw !== "string" || !failure.raw.trim()) return undefined;
  const parsed = parseQuotaError(failure.raw, DEFAULT_QUOTA_RETRY_SEC, nowMs);
  if (!parsed.fromUpstream) return undefined;
  if (parsed.signal !== "rate-limit" && parsed.signal !== "plan-quota") return undefined;
  if (!Number.isFinite(parsed.retryAfterSec) || parsed.retryAfterSec < 0) return undefined;
  return Math.min(Math.max(Math.round(parsed.retryAfterSec * 1000), 5_000), MAIN_MODEL_MAX_RETRY_DELAY_MS);
}

/** Bound for positively-identified in-flight compaction. session_before_compact
 * arms the marker and session_compact (or the next live host event) clears
 * it; the cap only bounds a lost clear (cancelled compaction with no event,
 * crashed host). Auto-compactions run minutes, never tens of minutes. */
export const COMPACTION_IN_FLIGHT_MAX_MS = 30 * 60_000;

/** True only while a positively-identified compaction is in flight. Silence
 * alone never counts — the marker must have been armed by
 * session_before_compact and not yet settled or expired. */
export function isCompactionInFlightSince(since: number | null | undefined, nowMs = Date.now()): boolean {
  return typeof since === "number" && since > 0 && nowMs - since < COMPACTION_IN_FLIGHT_MAX_MS;
}
