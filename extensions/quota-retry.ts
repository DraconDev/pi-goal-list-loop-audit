// pi-goal-list-loop-audit — provider diagnostics and bounded retry helpers.
//
// Provider errors are deliberately opaque to recovery policy. This module
// keeps safe diagnostic projections and a generic timer; legacy quota parser
// exports remain below for reading old records/tests, but runtime scheduling
// never uses them.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type QuotaSignal = "rate-limit" | "plan-quota" | "billing";

/** Never let one automatic provider retry schedule farther than five hours. */
export const MAX_AUTOMATIC_PROVIDER_RETRY_SEC = 5 * 60 * 60;
/** Compatibility default for callers that do not provide a delay. */
export const DEFAULT_PROVIDER_RETRY_SEC = 60 * 60;
/** @deprecated Use MAX_AUTOMATIC_PROVIDER_RETRY_SEC. */
export const MAX_AUTOMATIC_QUOTA_RETRY_SEC = MAX_AUTOMATIC_PROVIDER_RETRY_SEC;
/** @deprecated Use DEFAULT_PROVIDER_RETRY_SEC. */
export const DEFAULT_QUOTA_RETRY_SEC = DEFAULT_PROVIDER_RETRY_SEC;

export interface QuotaError {
  raw: string;
  /** Seconds until retry, from the upstream hint or the default. */
  retryAfterSec: number;
  /** True when retryAfterSec came from the upstream (header, JSON, prose, or reset timestamp). */
  fromUpstream: boolean;
  /** Absolute reset time when the provider supplied one. */
  resetAt?: string;
  /** The reason family used for user-facing classification. */
  signal?: QuotaSignal;
}

export type ProviderErrorSurface = "recovery" | "completion" | "main";

/** Normalize the structured failure shapes emitted by different providers and
 * pi versions into one bounded diagnostic string. Status fields and provider
 * wording are retained for diagnostics only; they never select recovery.
 * Keep this helper display-agnostic; callers still pass the result through
 * providerErrorPresentation before showing anything to a user. */
export function normalizeProviderErrorText(...values: unknown[]): string {
  const statuses: number[] = [];
  const messages: string[] = [];
  const seen = new Set<object>();
  const statusKeys = new Set(["status", "statusCode", "status_code", "httpStatus", "http_status", "code"]);
  const messageKeys = new Set(["errorMessage", "message", "detail", "reason", "description", "finalError"]);
  const nestedKeys = new Set(["error", "response", "cause", "body", "details", "data"]);

  const visit = (value: unknown, depth: number): void => {
    if (value === undefined || value === null || depth > 4) return;
    if (typeof value === "string") {
      if (value.trim()) messages.push(value.trim());
      return;
    }
    if (typeof value === "number") {
      if (Number.isInteger(value) && value >= 100 && value <= 599) statuses.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (seen.has(object)) return;
    seen.add(object);
    // Error.message/statusCode are commonly non-enumerable own properties;
    // include descriptors as well as enumerable transport fields. Reading a
    // provider-defined getter is best effort and must never break recovery.
    const keys = new Set([
      ...Object.keys(object),
      ...Object.getOwnPropertyNames(object),
      ...statusKeys,
      ...messageKeys,
      ...nestedKeys,
    ]);
    for (const key of keys) {
      let child: unknown;
      try { child = object[key]; } catch { continue; }
      if (statusKeys.has(key)) {
        if (typeof child === "number" && Number.isInteger(child) && child >= 100 && child <= 599) statuses.push(child);
        else if (typeof child === "string" && /^\d{3}$/.test(child.trim())) statuses.push(Number(child));
      } else if (messageKeys.has(key)) {
        visit(child, depth + 1);
      } else if (nestedKeys.has(key)) {
        visit(child, depth + 1);
      }
    }
  };

  for (const value of values) visit(value, 0);
  const parts = [
    ...[...new Set(statuses)].map((status) => `HTTP ${status}`),
    ...messages,
  ];
  return [...new Set(parts)].join(" — ").slice(0, 4_000);
}

/** A provider failure has two deliberately separate projections: `diagnostic`
 * is durable for forensics, while `display` and `action` are safe to put in
 * chat, notifications, cards, or tool results. Never interpolate `diagnostic`
 * into a user-facing string. */
export interface ProviderErrorPresentation {
  diagnostic: string;
  display: string;
  action: string;
  fingerprint: string;
  /** Legacy diagnostic field; runtime recovery never branches on it. */
  signal?: QuotaSignal;
  sensitive: boolean;
}

// Provider payloads frequently contain account names, request ids, nested JSON,
// and raw HTTP text. These markers only decide whether raw text must be
// redacted; they never decide whether or when recovery retries.
const PROVIDER_SENSITIVE_MARKER = /\b(?:401|403|408|409|429|5\d\d)\b|api[\s_-]*key|authorization|token[\s_-]*plan|rate[\s_-]*limit|too[\s_-]+many[\s_-]+requests|usage[\s_-]*limit|quota|insufficient[\s_-]+(?:credits?|balance)|key[\s_-]*limit|retry[\s_-]*after|request[\s_-]*(?:id|identifier)/i;

function providerFingerprintText(error: string): string {
  return error
    .toLowerCase()
    .replace(/retry[\s_-]*(?:after|in)[^\s,;)}\]]+/gi, "retry-hint")
    .replace(/(?:reset|available|renews?)[\s_-]*(?:at|on|in)[^\s,;)}\]]+/gi, "reset-hint")
    .replace(/["']?\b(?:request|req)[\s_-]*(?:id|identifier)\b["']?\s*[:=]?\s*["']?[a-z0-9-]+["']?/gi, "request-id")
    .replace(/\b(?:0x)?[a-f0-9]{8,}\b/gi, "id")
    .replace(/\b\d+(?:\.\d+)?\b/g, "number")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bretry hint\b/g, "")
    .replace(/\brequest id (?:[a-z]+ )?number\b/g, "request-id")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/** Bounded single-line display projection for NON-sensitive provider text.
 * Sensitive payloads never reach this — the marker gate above keeps them
 * at the generic "provider error" copy. */
function providerDisplayText(error: string): string {
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine ? oneLine.slice(0, 160) : "provider error";
}

/** Stable logical identity for per-recovery-episode notice deduplication.
 * Retry-after values, counters, timestamps, and request ids are intentionally
 * removed so the same provider failure does not produce a new notice each time
 * the upstream changes a number. */
export function providerErrorFingerprint(error: string | undefined): string {
  const raw = typeof error === "string" ? error : "";
  return `provider:${providerFingerprintText(raw) || "unknown"}`;
}

/** Convert untrusted provider text into safe action/display copy while
 * retaining a bounded diagnostic projection for durable ledger/archive state. */
export function providerErrorPresentation(error: string | undefined, surface: ProviderErrorSurface = "recovery"): ProviderErrorPresentation {
  const diagnostic = typeof error === "string" ? error.slice(0, 4_000) : "";
  const sensitive = PROVIDER_SENSITIVE_MARKER.test(diagnostic);
  const display = sensitive ? "provider error" : providerDisplayText(diagnostic);
  const action = surface === "completion"
    ? "The stored completion claim is safe; fix the provider/model, then resume to retry the auditor."
    : surface === "main"
      ? "Automatic recovery uses bounded per-attempt backoff; wait for a later retry or switch to a configured backup model."
      : "Automatic recovery uses bounded per-attempt backoff; wait for a later retry or switch models if needed.";
  return {
    diagnostic,
    display,
    action,
    fingerprint: providerErrorFingerprint(diagnostic),
    sensitive,
  };
}

/** Display projection for legacy pause/recovery strings that were persisted
 * before provider diagnostics were separated from user-facing copy. */
export function sanitizeProviderDisplayText(value: string): string {
  const presentation = providerErrorPresentation(value, "recovery");
  if (!presentation.sensitive) return value;
  if (/completion audit timed out/i.test(value)) return "completion audit timed out — no verifier verdict was produced";
  if (/auditor retry/i.test(value)) return `auditor retry — ${presentation.display}`;
  if (/main model recovery.*automatic probes stopped/i.test(value)) {
    const match = value.match(/^main model recovery — automatic probes stopped \(([^)]*)\)/i);
    const why = match?.[1]?.trim() ?? "provider recovery horizon reached";
    const safeWhy = PROVIDER_SENSITIVE_MARKER.test(why) ? presentation.display : why;
    return `main model recovery — automatic probes stopped (${safeWhy}) · ${presentation.display}`;
  }
  if (/main model recovery/i.test(value)) {
    const safePrefix = value.match(/^main model recovery — [^(]*/i)?.[0]?.trim();
    return safePrefix ? `${safePrefix} (${presentation.display})` : `main model recovery — ${presentation.display}`;
  }
  if (/consecutive errors|output[ -]?token/i.test(value)) return `provider recovery — ${presentation.display}`;
  return presentation.display;
}

/**
 * Sanitize an entire auditor report before it crosses a user-facing history
 * surface. Short pause strings go through sanitizeProviderDisplayText, but a
 * full report can contain the original provider payload inside evidence or a
 * fenced JSON block. Redact marked payload lines (and their continued JSON)
 * while preserving the rest of the report for inspection.
 */
export function sanitizeProviderAuditReport(report: string | undefined): string {
  if (!report) return "";
  const providerLine = new RegExp(
    `${PROVIDER_SENSITIVE_MARKER.source}|request[\\s_-]*(?:id|identifier)|rate_limit_error|insufficient_quota`,
    "i",
  );
  const structuredLine = /["']?(?:status(?:code)?|error(?:message)?|message|detail|reason|request[\s_-]*(?:id|identifier)|retry[\s_-]*after|reset[\s_-]*(?:at|after))\b["']?\s*[:=]/i;
  // Count JSON delimiters without treating braces inside a quoted value as
  // structure. A provider marker is often emitted on its own line followed
  // by a multiline payload, so `pendingJsonLines` enters the next balanced
  // block instead of redacting only the marker line.
  const bracketDelta = (line: string): number => {
    let delta = 0;
    let quoted = false;
    let escaped = false;
    for (const char of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === String.fromCharCode(92) && quoted) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === "{" || char === "[") delta++;
      else if (char === "}" || char === "]") delta--;
    }
    return delta;
  };

  let jsonDepth = 0;
  let pendingJsonLines = 0;
  return report.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    const providerMarked = providerLine.test(line);
    const structuredMarked = structuredLine.test(line);
    const beginsJson = /^[{[]/.test(trimmed);
    const inJson = jsonDepth > 0;
    const entersPendingJson = pendingJsonLines > 0 && beginsJson;
    const marked = inJson || providerMarked || structuredMarked || entersPendingJson;

    if (!marked) {
      // Permit a blank line or a fenced-code opener between a standalone
      // provider marker and its JSON payload, but do not carry the pending
      // state across ordinary prose.
      if (pendingJsonLines > 0) {
        if (!trimmed || /^```(?:json)?\s*$/i.test(trimmed)) return line;
        pendingJsonLines = 0;
      }
      return line;
    }

    const delta = bracketDelta(line);
    if (inJson || entersPendingJson) {
      jsonDepth = Math.max(0, jsonDepth + delta);
      pendingJsonLines = 0;
    } else if (providerMarked && delta > 0) {
      jsonDepth = delta;
      pendingJsonLines = 0;
    } else if (providerMarked && delta === 0 && !beginsJson) {
      // A bare `403`/`429` or `Token Plan` line may introduce the payload on
      // the next line. Only wait a couple of lines so a later unrelated JSON
      // example is never swallowed by an old marker.
      pendingJsonLines = 2;
    } else {
      pendingJsonLines = 0;
    }
    // v0.35.4: the marker is a FIXED generic tag. It previously interpolated
    // presentation.display, which since the display-projection fix can carry
    // bounded raw text for non-sensitive lines — interpolating that here
    // would turn the redaction itself into a leak for structured lines that
    // contain account/org names.
    return `[provider diagnostic redacted — provider error]`;
  }).join("\n");
}

// Do not classify every "temporarily" or every 403 as a quota wall. Those
// patterns include ordinary outages and auth failures. These signals are
// deliberately explicit enough to survive provider wording changes without
// turning an arbitrary transient error into a week-long retry loop.
const RATE_LIMIT = /\b429\b|too[\s_-]+many[\s_-]+requests|rate[\s_-]*limit|throttl(?:e|ed|ing)|requests?\s+per\s+(?:second|minute)|\b(?:rpm|tpm)\b/i;
// Account/plan markers are intentionally specific. A generic "429 rate limit
// exceeded" contains the words "limit exceeded", but it is a request-rate
// response, not evidence that the account's quota is exhausted. Keep the
// generic limit phrase separate so quotaSignal can preserve that distinction.
const PLAN_QUOTA = /(?:quota|usage[\s_-]*(?:limit|quota)|token[\s_-]*plan|plan[\s_-]*(?:limit|quota)|monthly\s+(?:limit|quota)|daily\s+(?:limit|quota)|weekly\s+(?:limit|quota)|key[\s_-]*(?:limit|quota)(?:\s+exceeded)?)/i;
const PLAN_QUOTA_REVERSE = /(?:monthly|daily|weekly|key|usage|token[\s_-]*plan|plan).{0,80}(?:limit\s+(?:reached|exceeded|exhausted|depleted)|quota|exhausted|depleted)/i;
const GENERIC_LIMIT_WALL = /\blimit\s+(?:reached|exceeded|exhausted|depleted)\b/i;
const BILLING = /insufficient[\s_-]+(?:credits?|balance|quota)|(?:credits?|balance)\s+(?:exhausted|depleted|used\s+up)|billing\s+(?:required|issue|failure)|payment\s+required|buy\s+credits?/i;
// v0.34.125: explicitly-TEMPORARY quota wording (note.md 2026-08-10 "we
// received some quota message that would have been temporary but we gave up
// and waited for a bigger reset"). "temporarily over quota" / "temporarily
// unavailable due to a rate limit" are retryable short windows, NOT
// long-lived walls — and plain "temporarily unavailable" stays ambiguous
// (ordinary outage) so we never turn a random transient into a quota wall.
const TEMPORARY_QUOTA = /temporar(?:y|ily)[^.\n]{0,60}(?:quota|limit|throttl|too[\s_-]+many[\s_-]+requests)/i;

/** Return the strongest explicit provider signal, or undefined for an
 * ambiguous/transient message. An explicit HTTP 429 / "too many requests" /
 * rate-limit marker is always a request-rate wall, even if a provider also
 * includes billing, quota, or "Token Plan" wording. It is never relabeled as
 * a token-limit wall. Account/plan/billing wording without a 429 or
 * rate-limit marker remains in its own family. */
export function quotaSignal(error: string | undefined): QuotaSignal | undefined {
  if (!error) return undefined;
  // Explicitly-temporary wording wins over every account-wall pattern:
  // "temporarily over quota" is a short retry window, not a plan wall.
  if (TEMPORARY_QUOTA.test(error)) return "rate-limit";
  // An explicit 429/rate-limit signal is never a token-limit label. The
  // recovery path keeps retrying it and the optional hourly ticker can add a
  // probe after the start of each hour.
  if (RATE_LIMIT.test(error)) return "rate-limit";
  if (BILLING.test(error)) return "billing";
  if (PLAN_QUOTA.test(error) || PLAN_QUOTA_REVERSE.test(error)) return "plan-quota";
  if (GENERIC_LIMIT_WALL.test(error)) return "plan-quota";
  return undefined;
}

export function isBillingError(error: string | undefined): boolean {
  return quotaSignal(error) === "billing";
}

/** Match recoverable provider rate/plan walls and explicit billing walls.
 * Ambiguous `temporarily unavailable`, ordinary 403s, and generic network
 * failures intentionally return false. */
export function isQuotaError(error: string | undefined): boolean {
  return quotaSignal(error) !== undefined;
}

function numericHint(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function absoluteReset(value: string | undefined, nowMs: number): { retryAfterSec: number; resetAt: string } | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return undefined;
  const retryAfterSec = Math.max(0, Math.ceil((ms - nowMs) / 1000));
  return { retryAfterSec, resetAt: new Date(ms).toISOString() };
}

/** Parse the retry window out of provider text/JSON. Understands:
 *  - `Retry-After: 5` and HTTP-date headers
 *  - JSON `retry_after`, `retryAfter`, `reset_at`, `resetAt`
 *  - `retry after 30 seconds`, `retry in 2h`, `retry in 1 week`
 *  - default 3600s when no hint (the historical contract). */
export function parseQuotaError(error: string, defaultRetryAfterSec = DEFAULT_QUOTA_RETRY_SEC, nowMs = Date.now()): QuotaError {
  const signal = quotaSignal(error);
  const fallback = Number.isFinite(defaultRetryAfterSec) && defaultRetryAfterSec >= 0
    ? Math.round(defaultRetryAfterSec)
    : DEFAULT_QUOTA_RETRY_SEC;

  // Capture one complete Retry-After header value before deciding whether it
  // is delta-seconds or a date. The numeric form must be whole-value matched:
  // an ISO reset such as `Retry-After: 2026-08-10T12:00:00Z` starts with digits
  // but is an absolute date, not a ~34-minute delta.
  let m = error.match(/retry-after:\s*([^\r\n]+)/i);
  const headerValue = m?.[1]?.trim();
  const numeric = numericHint(headerValue && /^\d+(?:\.\d+)?$/.test(headerValue) ? headerValue : undefined);
  if (numeric !== undefined) return { raw: error, retryAfterSec: Math.round(numeric), fromUpstream: true, signal };

  // RFC 7231 Retry-After date. Keep this separate from the numeric match so
  // a comma in the HTTP date cannot consume the next line of the error.
  const headerDate = absoluteReset(headerValue, nowMs);
  if (headerDate) return { raw: error, ...headerDate, fromUpstream: true, signal };

  // Providers often serialize one of these fields inside a larger wrapper.
  m = error.match(/["'](?:retry_after|retryAfter|retry_after_seconds|reset_after|resetAfter)["']\s*:\s*(\d+(?:\.\d+)?)/i);
  const jsonSeconds = numericHint(m?.[1]);
  if (jsonSeconds !== undefined) return { raw: error, retryAfterSec: Math.round(jsonSeconds), fromUpstream: true, signal };

  m = error.match(/["'](?:reset_at|resetAt|resets_at|quota_reset_at)["']\s*:\s*["']([^"']+)["']/i);
  const jsonDate = absoluteReset(m?.[1], nowMs);
  if (jsonDate) return { raw: error, ...jsonDate, fromUpstream: true, signal };

  m = error.match(/retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const prose = retryWindow(m);
  if (prose !== undefined) return { raw: error, retryAfterSec: prose, fromUpstream: true, signal };

  m = error.match(/(?:reset|resets|available)\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[^,;\n)]*)/i);
  const proseDate = absoluteReset(m?.[1], nowMs);
  if (proseDate) return { raw: error, ...proseDate, fromUpstream: true, signal };

  // v0.34.125: short-window prose (note.md 2026-08-10 — a temporary quota
  // message must not park until the hour-aligned "bigger reset"). Providers
  // phrase short windows as "try again in 30 seconds" / "please wait 1
  // minute" / "rate limit resets in 15 seconds" / "available again in 2
  // minutes" — the same factual Retry-After claim, just prose.
  m = error.match(/\b(?:try again|retry|available again|try back|come back)\s+in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const again = retryWindow(m);
  if (again !== undefined) return { raw: error, retryAfterSec: again, fromUpstream: true, signal };

  m = error.match(/\b(?:wait|back off|pause|hold|sleep)\b\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const waited = retryWindow(m);
  if (waited !== undefined) return { raw: error, retryAfterSec: waited, fromUpstream: true, signal };

  m = error.match(/\b(?:resets?|refreshes?|renews?|recovers?|available)\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const resetIn = retryWindow(m);
  if (resetIn !== undefined) return { raw: error, retryAfterSec: resetIn, fromUpstream: true, signal };

  return { raw: error, retryAfterSec: fallback, fromUpstream: false, signal };
}

/** Convert a "N <unit>" prose match to seconds, or undefined when the match
 * or unit is missing. Units: s / m / h / d / w (weeks/days included for
 * completeness; the 5h probe cap in mainModelFailureDelayMs still applies). */
function retryWindow(m: RegExpMatchArray | null): number | undefined {
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit.startsWith("w") ? 7 * 24 * 3600
    : unit.startsWith("d") ? 24 * 3600
      : unit.startsWith("h") ? 3600
        : unit.startsWith("m") ? 60
          : 1;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * mult) : undefined;
}

/** Clamp one automatic retry delay. The bound is a safety envelope, not a
 * provider/quota decision. */
export function capProviderRetrySeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_PROVIDER_RETRY_SEC;
  return Math.min(Math.max(1, Math.round(seconds)), MAX_AUTOMATIC_PROVIDER_RETRY_SEC);
}

/** Exponential automatic retry cadence, capped at five hours. */
export function providerRetryDelaySeconds(attempt: number, baseMinutes = 60): number {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes * 60 : DEFAULT_PROVIDER_RETRY_SEC;
  return capProviderRetrySeconds(base * 2 ** Math.max(0, attempt - 1));
}

let providerRetryTimer: NodeJS.Timeout | null = null;
let lastProviderRetryNoticeKey: string | null = null;

export interface ProviderRetryScheduleOptions {
  /** Stable persisted recovery episode identity, if the caller has one. */
  episodeKey?: string;
  /** Stable notice identity; excludes changing retry-after/counter values. */
  noticeKey?: string;
  /** Caller already applied a durable per-episode notice fence. */
  suppressNotice?: boolean;
}

/** Test hook — reset process-local notice deduplication between isolated rigs. */
export function resetProviderRetryNoticeDedup(): void {
  lastProviderRetryNoticeKey = null;
}

/** Test hook — is a provider retry currently scheduled? */
export function isProviderRetryPending(): boolean {
  return providerRetryTimer !== null;
}

/** Cancel any pending provider retry (e.g. the user resumed manually). */
export function cancelProviderRetry(): void {
  if (providerRetryTimer) {
    clearTimeout(providerRetryTimer);
    providerRetryTimer = null;
  }
}

/** Schedule a one-shot automatic provider retry. The caller's callback owns
 * the durable-state guard; this helper only owns timer fencing and safe copy. */
export function scheduleProviderRetry(
  ctx: ExtensionContext,
  retryAfterSec: number,
  reason: string,
  fire: () => void,
  label = "Provider retry",
  options: ProviderRetryScheduleOptions = {},
): void {
  cancelProviderRetry();
  const requestedSec = Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? Math.round(retryAfterSec) : DEFAULT_PROVIDER_RETRY_SEC;
  const safeSec = capProviderRetrySeconds(requestedSec);
  const capped = safeSec !== requestedSec;
  const ms = Math.max(1_000, safeSec * 1_000);
  providerRetryTimer = setTimeout(() => {
    providerRetryTimer = null;
    try {
      fire();
    } catch {
      /* session may be gone; session_start will re-evaluate */
    }
  }, ms);
  providerRetryTimer.unref?.();
  const presentation = providerErrorPresentation(reason, "recovery");
  const noticeKey = options.noticeKey
    ?? `${options.episodeKey ?? "session"}:${presentation.fingerprint}:${label}`;
  if (!options.suppressNotice && noticeKey !== lastProviderRetryNoticeKey) {
    lastProviderRetryNoticeKey = noticeKey;
    ctx.ui.notify(
      `${label} in ${Math.round(safeSec / 60)}m${capped ? ` (automatic retry capped at ${Math.round(safeSec / 3600)}h)` : ""} (${presentation.display}). /goal resume retries now.`,
      "info",
    );
  }
}

/** A failed subagent-spawn/wait result is a provider/runtime failure. Keep
 * this generic: no status, quota, billing, or message parsing is used to
 * choose a path. v0.38.16: the legacy `Agent` name missed the current
 * `subagent` tool entirely — real spawn failures never took this path. */
export function isSubagentProviderFailure(toolName: string, isError: boolean, payload: unknown): boolean {
  if (!isError) return false;
  if (!["Agent", "agent", "subagent", "subagent_wait"].includes(toolName)) return false;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return text.trim().length > 0;
}

/** @deprecated Use capProviderRetrySeconds. */
export const capQuotaRetrySeconds = capProviderRetrySeconds;
/** @deprecated Use providerRetryDelaySeconds. */
export const quotaRetryDelaySeconds = providerRetryDelaySeconds;
/** @deprecated Use ProviderRetryScheduleOptions. */
export type QuotaRetryScheduleOptions = ProviderRetryScheduleOptions;
/** @deprecated Use resetProviderRetryNoticeDedup. */
export const resetQuotaRetryNoticeDedup = resetProviderRetryNoticeDedup;
/** @deprecated Use isProviderRetryPending. */
export const isQuotaRetryPending = isProviderRetryPending;
/** @deprecated Use cancelProviderRetry. */
export const cancelQuotaRetry = cancelProviderRetry;
/** @deprecated Use scheduleProviderRetry. */
export const scheduleQuotaRetry = scheduleProviderRetry;
/** @deprecated Use isSubagentProviderFailure. */
export const isSubagentQuotaResult = isSubagentProviderFailure;
