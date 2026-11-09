// pi-goal-list-loop-audit — provider diagnostics and bounded retry helpers.
//
// Provider errors are deliberately opaque to recovery policy, with one
// narrow exception (v0.38.105): a quota signal may select a monitored WAIT
// (pause_goal reroutes a quota-caused park to a supervised auto-retry wait),
// never an immediate retry. This module keeps safe diagnostic projections
// and a generic timer; legacy quota parser exports remain below for reading
// old records/tests.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText } from "./goal-loop-core.js";
import { isJsonContainerPrefix } from "./json-container-prefix.js";

export type QuotaSignal = "rate-limit" | "plan-quota" | "billing";

/** Never let one automatic provider retry schedule farther than five hours. */
export const MAX_AUTOMATIC_PROVIDER_RETRY_SEC = 5 * 60 * 60;
/** Compatibility default for callers that do not provide a delay. */
export const DEFAULT_PROVIDER_RETRY_SEC = 60 * 60;
/** @deprecated Use MAX_AUTOMATIC_PROVIDER_RETRY_SEC. */
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
// v0.38.104: the bare `5\d\d` was far too loose — it matches ANY number from
// 500 to 599, so an auditor report quoting `{"y":520.07}` or a byte count was
// treated as a provider payload line by line. A 5xx is only a sensitive marker
// with HTTP/status context around it. 401/403/408/409/429 are specific enough
// to keep standing alone (and are the ones that actually carry secrets).
const PROVIDER_SENSITIVE_MARKER = /\b(?:401|403|408|409|429)\b|api[\s_-]*key|authorization|token[\s_-]*plan|rate[\s_-]*limit|too[\s_-]+many[\s_-]+requests|usage[\s_-]*limit|quota|insufficient[\s_-]+(?:credits?|balance)|key[\s_-]*limit|retry[\s_-]*after|request[\s_-]*(?:id|identifier)|\b(?:https?\s*\/?\s*|status(?:[_\s-]?code)?\s*[:=]?\s*|code\s*[:=]\s*)(5\d\d)\b|\b5\d\d\s+(?:internal\s+server|server\s+error|bad\s+gateway|gateway\s+timeout|service\s+unavailable)\b/i;

/** Historical v0.38.104 preservation baselines, retained for compatibility.
 * Report redaction now uses explicit payload/field ownership, not a global
 * budget that can expire and release a later secret. */
export const SANITIZE_MAX_REDACTION_RATIO = 0.15;
export const SANITIZE_MIN_REDACTION_LINES = 12;

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
  const oneLine = sanitizeDisplayText(error).replace(/\s+/g, " ").trim();
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
  if (!presentation.sensitive) return presentation.display;
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
  // Reports discuss user authorization as a contract decision. Only an
  // authorization credential/header is sensitive here, not that ordinary word.
  // Keep the stricter short provider-error projection unchanged.
  const reportMarker = PROVIDER_SENSITIVE_MARKER.source.replace(
    "authorization",
    String.raw`authorization(?:["']?\s*[:=]|\s+(?:Bearer|Basic)\s)`,
  );
  const providerLine = new RegExp(
    `${reportMarker}|request[\\s_-]*(?:id|identifier)|rate_limit_error|insufficient_quota|["']?(?:status(?:[_\\s-]?code)?|code)["']?\\s*[:=]\\s*["']?5\\d\\d\\b`,
    "i",
  );
  const structuredLine = /["']?(?:status(?:code)?|error(?:message)?|message|detail|reason|request[\s_-]*(?:id|identifier)|retry[\s_-]*after|reset[\s_-]*(?:at|after))\b["']?\s*[:=]/i;
  // Syntactic key/value labels may carry an existing provider prefix, never
  // create one. Anchoring excludes narrative/list annotations such as [HIGH].
  const bodyLabel = /^\s*(?:["']?[\w.-]+(?:[ \t]+[\w.-]+)*["']?\s*[:=]\s*)?$/;
  // Canonical audit severities are HIGH/MED/LOW (RequiredFixSeverity), with
  // MEDIUM and priority-tag aliases retained for older/structured reports.
  const reportBoundary = /^(?:#{1,6}\s|```|\d+\.\s+(?:\*\*)?\[(?:HIGH|MED(?:IUM)?|LOW|P[0-3])\])/i;
  // Locate delimiters without treating braces in quoted values as structure.
  // Provider-prefix context can introduce a body across a short blank/fence gap.
  const jsonDelimiters = (line: string): Array<{ char: string; column: number }> => {
    const delimiters: Array<{ char: string; column: number }> = [];
    let quoted = false;
    let escaped = false;
    for (let column = 0; column < line.length; column++) {
      const char = line[column]!;
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
      if (char === "{" || char === "[" || char === "}" || char === "]") delimiters.push({ char, column });
    }
    return delimiters;
  };
  let pendingJsonLines = 0;
  const reportLines = report.split(/\r?\n/);
  // Resolve payload ownership once, at exact delimiter boundaries. The line
  // projection must not count braces again: trailing annotations are not part
  // of a completed body and cannot reopen its ownership.
  const providerPayloadLines = new Set<number>();
  const markPayload = (start: number, end: number): void => {
    for (let j = start; j <= end; j++) providerPayloadLines.add(j);
  };
  const jsonCandidates: Array<{ line: number; column: number; opener: string; owned: boolean }> = [];
  const finishTruncatedPayloads = (end: number): void => {
    for (const candidate of jsonCandidates) {
      if (candidate.owned) markPayload(candidate.line, end);
    }
    jsonCandidates.length = 0;
  };
  let providerPrefix = false;
  let prefixGapLines = 0;
  for (let i = 0; i < reportLines.length; i++) {
    const line = reportLines[i]!;
    const trimmed = line.trim();
    if (reportBoundary.test(trimmed)) {
      finishTruncatedPayloads(i - 1);
      // A finding/heading ends prefix ownership too; an opening JSON fence
      // alone may bridge the short marker-to-body gap.
      if (!/^```(?:json)?\s*$/i.test(trimmed)) providerPrefix = false;
    }
    let contextStart = 0;
    for (const { char, column } of jsonDelimiters(line)) {
      if (char === "{" || char === "[") {
        const prefix = line.slice(contextStart, column);
        jsonCandidates.push({
          line: i, column, opener: char,
          owned: (providerPrefix && bodyLabel.test(prefix))
            || providerLine.test(prefix) || jsonCandidates.some(candidate => candidate.owned),
        });
        providerPrefix = false;
        continue;
      }
      const candidate = jsonCandidates[jsonCandidates.length - 1];
      // A malformed closer cannot release an identified body early.
      if (!candidate || (candidate.opener === "{" ? char !== "}" : char !== "]")) continue;
      jsonCandidates.pop();
      providerPrefix = false;
      contextStart = column + 1;
      if (candidate.owned) {
        markPayload(candidate.line, i);
        continue;
      }
      const block = candidate.line === i
        ? line.slice(candidate.column, column + 1)
        : [reportLines[candidate.line]!.slice(candidate.column),
          ...reportLines.slice(candidate.line + 1, i), line.slice(0, column + 1)].join("\n");
      if (!providerLine.test(block)) continue;
      try {
        // Unmarked objects can acquire ownership from a later field, but only
        // if they are actual JSON, not ordinary status/reason-shaped prose.
        JSON.parse(block);
        markPayload(candidate.line, i);
      } catch { /* Ordinary/incomplete unmarked evidence is not a provider body. */ }
    }
    if (providerLine.test(line)) {
      for (let j = 0; j < jsonCandidates.length; j++) {
        const candidate = jsonCandidates[j]!;
        if (candidate.owned) continue;
        const prefix = [reportLines[candidate.line]!.slice(candidate.column),
          ...reportLines.slice(candidate.line + 1, i + 1)].join("\n");
        // Claim recognizable JSON before the transport finishes, even when
        // cut off inside a string, escape or scalar token. A real prefix grammar
        // rejects prose; guessing closing delimiters alone misses these cases.
        if (isJsonContainerPrefix(prefix)) candidate.owned = true;
      }
    }
    if (!trimmed || /^```(?:json)?\s*$/i.test(trimmed)) {
      if (++prefixGapLines > 2) providerPrefix = false;
    } else {
      // A consumed marker cannot introduce a later unrelated example or an
      // unmatched trailing annotation. A NEW marker after a body still can.
      providerPrefix = providerLine.test(line.slice(contextStart));
      prefixGapLines = 0;
    }
  }
  finishTruncatedPayloads(reportLines.length - 1);
  let credentialValuePending = false;
  // Explicit payload/field ownership replaces the old global line budget.
  // A budget could release later secrets, while generic status/reason keys
  // could consume it on innocent findings. Only actual provider markers and
  // their bounded field/payload continuations now initiate redaction. Payload
  // delimiters and report boundaries end ownership, not unrelated line counts.
  return reportLines.map((line, index) => {
    const trimmed = line.trim();
    if (reportBoundary.test(trimmed) && !/^```(?:json)?\s*$/i.test(trimmed)) pendingJsonLines = 0;
    const credentialValue = credentialValuePending && !!trimmed && !reportBoundary.test(trimmed);
    // A scheme on its own is not the credential; retain ownership of the next
    // value line. Request IDs and API-key assignments can split just as headers
    // do. Headings terminate the field so actual findings remain readable.
    if (trimmed && !/^```(?:json)?\s*$/i.test(trimmed)
      && !/^["']?(?:Bearer|Basic)["']?\s*$/i.test(trimmed)) credentialValuePending = false;
    if (/^\s*["']?(?:authorization|api[\s_-]*key|request[\s_-]*(?:id|identifier))["']?\s*[:=]\s*(?:["']?(?:Bearer|Basic)["']?)?\s*$/i.test(line)) credentialValuePending = true;
    const providerMarked = providerLine.test(line);
    const structuredMarked = structuredLine.test(line);
    const inPayload = providerPayloadLines.has(index);
    // Ordinary status/reason/message keys never initiate redaction. A known
    // body, sensitive field or directly marked line cannot spend a budget and
    // thereby release a later secret.
    const marked = providerMarked || inPayload || credentialValue
      || (pendingJsonLines > 0 && structuredMarked);

    if (!marked) {
      // Permit a blank line or a fenced-code opener between a standalone
      // provider marker and its JSON payload, but do not carry the pending
      // state across ordinary prose. Even unmarked provider prose crosses a
      // terminal boundary, so strip ANSI/OSC/control bytes before returning.
      if (pendingJsonLines > 0) {
        if (!trimmed || /^```(?:json)?\s*$/i.test(trimmed)) {
          pendingJsonLines--;
          return sanitizeDisplayText(line);
        }
        pendingJsonLines = 0;
      }
      return sanitizeDisplayText(line);
    }

    if (providerMarked && !inPayload) {
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
// v0.39.67 (field 2026-11-09): a CONCURRENCY wall, not a spent plan.
//
//   Error: 400: {"code":"tier_limit_exceeded","message":"[code=tier_limit_exceeded]
//   membership concurrency limit exceeded: 11/10 resets 2026-11-09T15:27:00Z"}
//
// The status is 400 and the wording contains "limit exceeded", which is why it
// is easy to file as a client error. It is neither: the account is allowed 10
// concurrent requests and one more was attempted. The wall lifts as soon as a
// slot frees, so it must be retried PROMPTLY (never slept to the reset the
// provider quotes, which can be hours away and is only an upper bound). Both
// halves need this vocabulary: `quotaSignal` so it is never classified
// `unknown`/deterministic, and the delay policy so it is not parked at the
// reset instant.
const CONCURRENCY_WALL = /\btier[_\s-]*limit|concurrency\s+(?:limit|cap|quota)|concurrent\s+(?:request|session|connection)s?\b|too\s+many\s+(?:concurrent|parallel|in[\s-]?flight)|(?:in[\s-]?flight|parallel|simultaneous)\s+(?:request|session)s?\s+(?:limit|cap|exceeded)/i;

/** True when the failure is an admission limit on simultaneous requests rather
 * than exhausted quota: retry promptly, do not sleep to the quoted reset. */
export function isConcurrencyWall(error: string | undefined): boolean {
  return typeof error === "string" && CONCURRENCY_WALL.test(error);
}

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
  // A concurrency admission limit is a wall of its own (see CONCURRENCY_WALL):
  // it is quota-shaped, so it must never fall through to `unknown`, but the
  // delay policy treats it as a short window. Checked before the plan-quota
  // branch because providers word it as "limit exceeded".
  if (CONCURRENCY_WALL.test(error)) return "plan-quota";
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

// v0.38.92 (field 2026-09-21: 12 images vs a 4-image model cap retried
// 7.5h): a deterministic HTTP 400 client error can never succeed on an
// identical retry — only a changed request (fewer images, different
// model, fixed params) can. Match the error-type markers, never a bare
// "400" (token counts and limits quote 400s constantly). Moved here from
// main-model-recovery.ts in v0.38.93 so the display layer can share the
// classifier without an import cycle (it is re-exported there).
const DETERMINISTIC_CLIENT_ERROR = /badrequesterror|invalid_request_error|"code"\s*:\s*"400"/i;

export function isDeterministicProviderError(raw: string | undefined): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return DETERMINISTIC_CLIENT_ERROR.test(raw);
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

  m = error.match(/(?:reset|resets|resetting|available)\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[^,;\n)]*)/i);
  const proseDate = absoluteReset(m?.[1], nowMs);
  if (proseDate) return { raw: error, ...proseDate, fromUpstream: true, signal };

  // v0.39.67 (field 2026-11-09): the reset instant is often written WITHOUT
  // "at" — `… concurrency limit exceeded: 11/10 resets 2026-11-09T15:27:00Z`.
  // The branch above requires the preposition, so that shape fell through to
  // the flat 3600s default and the provider's own deadline was discarded. The
  // token is an ISO instant or datetime; require the `T`/time part so a bare
  // "resets 2026-11-09" prose mention cannot be mistaken for a hint.
  m = error.match(/(?:reset|resets|resetting|available)\s+(?:at\s+|on\s+)?([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}[^,;\n)"']*)/i);
  const bareDate = absoluteReset(m?.[1], nowMs);
  if (bareDate) return { raw: error, ...bareDate, fromUpstream: true, signal };

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

/** v0.38.105 (note.md Next: quota-wait is monitoring): the compact quota
 * evidence a subagent tool error leaves on the goal. Consumed once by
 * pause_goal to reroute a quota-caused park into a supervised wait. */
export interface SubagentQuotaEvidence {
  signal: QuotaSignal;
  retryAfterSec: number;
  resetAt?: string;
  /** ISO timestamp of the tool error that produced this evidence. */
  at: string;
}

/** Evidence older than this never reroutes a park — the quota window it
 * described has long passed or the park is about something else. */
export const SUBAGENT_QUOTA_EVIDENCE_FRESH_MS = 30 * 60 * 1000;

export interface QuotaWaitReroute {
  /** Seconds until retry: upstream reset when known, else the parsed hint. */
  retryAfterSec: number;
  /** Absolute reset when the provider supplied one and it is still future. */
  resetAt?: string;
  /** "reason" when the pause reason itself carried the quota signal,
   * "evidence" when fresh subagent evidence supplied it. */
  source: "reason" | "evidence";
  signal: QuotaSignal;
}

/** v0.38.105: quota cause for a park — the pause reason's own quota wording
 * wins; otherwise fresh subagent evidence (observed, not guessed) supplies
 * it. Returns undefined when neither speaks quota, so ordinary parks are
 * untouched. Pure — pinned in tests/quota-retry.test.ts. */
export function selectQuotaWaitReroute(
  reason: string | undefined,
  evidence: SubagentQuotaEvidence | undefined,
  nowMs = Date.now(),
): QuotaWaitReroute | undefined {
  const reasonSignal = quotaSignal(reason);
  if (reasonSignal) {
    const parsed = parseQuotaError(reason ?? "", DEFAULT_QUOTA_RETRY_SEC, nowMs);
    const resetMs = parsed.resetAt ? Date.parse(parsed.resetAt) : Number.NaN;
    return {
      retryAfterSec: parsed.retryAfterSec,
      ...(Number.isFinite(resetMs) && resetMs > nowMs ? { resetAt: parsed.resetAt } : {}),
      source: "reason",
      signal: reasonSignal,
    };
  }
  if (evidence) {
    const ageMs = nowMs - Date.parse(evidence.at);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= SUBAGENT_QUOTA_EVIDENCE_FRESH_MS) {
      const resetMs = evidence.resetAt ? Date.parse(evidence.resetAt) : Number.NaN;
      if (Number.isFinite(resetMs) && resetMs > nowMs) {
        return { retryAfterSec: Math.ceil((resetMs - nowMs) / 1000), resetAt: evidence.resetAt, source: "evidence", signal: evidence.signal };
      }
      // No (future) absolute reset: the remaining window shrinks as the
      // evidence ages — never re-wait the full original window.
      return { retryAfterSec: Math.max(60, evidence.retryAfterSec - Math.floor(ageMs / 1000)), source: "evidence", signal: evidence.signal };
    }
  }
  return undefined;
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

/** v0.38.105: observed quota evidence from one subagent tool-error payload.
 * Returns undefined for non-quota errors. Lives in the quota domain (not
 * at the call site) so the loops/ runtime bundle keeps no raw
 * quota-branching identifiers — the uniform-provider-retry pin holds. */
export function subagentQuotaEvidenceFrom(text: string, nowMs = Date.now()): SubagentQuotaEvidence | undefined {
  const signal = quotaSignal(text);
  if (!signal) return undefined;
  const parsed = parseQuotaError(text, DEFAULT_QUOTA_RETRY_SEC, nowMs);
  return {
    signal,
    retryAfterSec: parsed.retryAfterSec,
    ...(parsed.resetAt ? { resetAt: parsed.resetAt } : {}),
    at: new Date(nowMs).toISOString(),
  };
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
