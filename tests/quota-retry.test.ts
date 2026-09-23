// pi-goal-list-loop-audit — v0.25.0
// tests/quota-retry.test.ts
//
// Eager-continuation contract item 12 (Section C): quota-aware retry.
// Tests 1-2 cover parseQuotaError exactly as the contract specifies.
// Tests 3-4 as drafted asserted orchestrator branch behavior (goal status
// after a 429 audit) which lives inline in complete_goal — not reachable
// without a pi harness. The deterministic core is tested instead: the
// schedule/fire/cancel mechanics and the error-pattern recognition the
// branch keys on. The branch itself is pinned by source-text assertions
// in tests/eager-continuation-core.test.ts.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  capQuotaRetrySeconds,
  isBillingError,
  isQuotaError,
  normalizeProviderErrorText,
  parseQuotaError,
  quotaSignal,
  quotaRetryDelaySeconds,
  scheduleQuotaRetry,
  cancelQuotaRetry,
  isQuotaRetryPending,
  providerErrorFingerprint,
  providerErrorPresentation,
  sanitizeProviderAuditReport,
  sanitizeProviderDisplayText,
  resetQuotaRetryNoticeDedup,
} from "../extensions/quota-retry.ts";
import { formatAuditLog, formatGoalAuditHistory } from "../extensions/goal-loop-core.ts";

const fakeCtx = { ui: { notify: () => {} } } as any;

test("structured HTTP status is normalized before provider classification", () => {
  const raw = { statusCode: 429, errorMessage: { message: "limit exceeded", request_id: "abc123" } };
  const normalized = normalizeProviderErrorText(raw);
  assert.match(normalized, /HTTP 429/);
  assert.match(normalized, /limit exceeded/);
  assert.equal(quotaSignal(normalized), "rate-limit");
  const plan = normalizeProviderErrorText({ response: { status: 429 }, error: { message: "Token Plan exhausted" } });
  assert.equal(quotaSignal(plan), "rate-limit", "an HTTP 429 remains a request-rate signal even when the provider includes Token Plan wording");
  const providerError = new Error("limit exceeded");
  Object.defineProperty(providerError, "statusCode", { value: 429 });
  assert.match(normalizeProviderErrorText(providerError), /HTTP 429.*limit exceeded/);
  assert.equal(quotaSignal(normalizeProviderErrorText(providerError)), "rate-limit", "native Error fields are classified too");
  const stringStatus = normalizeProviderErrorText({ statusCode: "429", errorMessage: "limit exceeded" });
  assert.match(stringStatus, /HTTP 429.*limit exceeded/);
  assert.equal(quotaSignal(stringStatus), "rate-limit", "numeric-string HTTP statuses are classified too");
});

test("provider-wall copy separates safe display/action text from durable diagnostics", () => {
  const raw = '429 {"error":{"message":"Token Plan rate limit reached: upgrade your Token Plan"},"request_id":"abc123"}';
  const copy = providerErrorPresentation(raw, "completion");
  assert.match(copy.diagnostic, /Token Plan/);
  assert.doesNotMatch(`${copy.display} ${copy.action}`, /429|Token Plan|request_id|abc123/);
  assert.doesNotMatch(sanitizeProviderDisplayText(`auditor retry: ${raw}`), /429|Token Plan|request_id/);
  const variant = '429 {"error":{"message":"Token Plan rate limit reached: upgrade your Token Plan"},"retry_after":30,"request_id":"abc789"}';
  assert.equal(providerErrorFingerprint(raw), providerErrorFingerprint(variant), "changing counters/hints/ids stay in one logical episode");
  for (const spelling of ["requestId", "request-id", "request id", "req_id", "requestIdentifier"]) {
    const spellingVariant = raw.replace("request_id", spelling).replace("abc123", "different-id");
    assert.equal(providerErrorFingerprint(spellingVariant), providerErrorFingerprint(raw), `${spelling} is normalized`);
  }
});

test("non-sensitive provider text projects a bounded display while staying redaction-capable", () => {
  const copy = providerErrorPresentation('connection reset by peer after a long idle', "recovery");
  assert.equal(copy.sensitive, false);
  assert.match(copy.display, /connection reset by peer/);
  assert.match(copy.display, /^[^\n]{1,160}$/, "display is a bounded single line");
  const hostile = providerErrorPresentation("plain\u001b[2J\u001b]0;pwned\u0007 text", "recovery");
  assert.doesNotMatch(hostile.display, /\u001B|\u0007/);
  assert.doesNotMatch(sanitizeProviderDisplayText("plain\u001b[2Jtext"), /\u001B/);
  const empty = providerErrorPresentation("", "recovery");
  assert.equal(empty.display, "provider error", "empty input falls back to the generic copy");
  const multiline = providerErrorPresentation("line one\n\nline two", "recovery");
  assert.match(multiline.display, /^line one line two$/, "newlines collapse to one line");
});

test("bare 403 provider payloads are sensitive diagnostics, not raw display copy", () => {
  const raw = '403 {"error":{"message":"upstream denied this request"},"request_id":"auth-sensitive-id"}';
  const copy = providerErrorPresentation(raw, "completion");
  assert.equal(copy.signal, undefined, "a bare 403 is not automatically called a quota wall");
  assert.equal(copy.sensitive, true, "HTTP 403 is still untrusted provider payload");
  assert.match(copy.diagnostic, /auth-sensitive-id/);
  assert.doesNotMatch(`${copy.display} ${copy.action}`, /403|upstream denied|auth-sensitive-id/);
  assert.doesNotMatch(sanitizeProviderDisplayText(`auditor retry: ${raw}`), /403|upstream denied|auth-sensitive-id/);
});

test("full auditor reports redact raw provider payload lines while preserving safe findings", () => {
  const report = [
    "## Audit report",
    "The implementation is otherwise correct.",
    '403 {"error":{"message":"upstream denied this request"},"request_id":"auth-sensitive-id"}',
    "A safe conclusion remains visible.",
    "{",
    '  "status": 429,',
    '  "error": { "message": "Token Plan rate limit reached" }',
    "}",
  ].join("\n");
  const sanitized = sanitizeProviderAuditReport(report);
  assert.match(sanitized, /implementation is otherwise correct/);
  assert.match(sanitized, /safe conclusion remains visible/);
  assert.doesNotMatch(sanitized, /403|429|upstream denied|Token Plan|auth-sensitive-id/);
  assert.match(sanitized, /provider diagnostic redacted/);

  const hostile = sanitizeProviderAuditReport("safe\u001b[2J finding\n\u001b]0;pwned\u0007 title");
  assert.doesNotMatch(hostile, /\u001B|\u0007/);
  assert.match(hostile, /safe finding/);
});

test("multiline provider markers redact the following arbitrary JSON payload", () => {
  const report = [
    "## Audit",
    "403",
    "{",
    '  "account": "secret-account",',
    '  "organization": "secret-organization",',
    '  "nested": { "request_id": "secret-request", "message": "Token Plan rate limit reached" }',
    "}",
    "## Required fixes",
    "- keep the safe finding",
  ].join("\n");
  const sanitized = sanitizeProviderAuditReport(report);
  assert.match(sanitized, /safe finding/);
  assert.doesNotMatch(sanitized, /403|secret-account|secret-organization|secret-request|Token Plan|rate limit/);
  assert.match(sanitized, /provider diagnostic redacted/);
});

test("audit history projections sanitize provider diagnostics", () => {
  const raw = '429 Token Plan request_id=abc123';
  const bare403 = '403 {"error":{"message":"upstream denied this request"},"request_id":"auth-sensitive-id"}';
  const line = formatAuditLog([{
    at: new Date().toISOString(), goalId: "goal-123456", objective: "provider wall", verdict: "error",
    model: "provider/model", thinkingLevel: "high", report: "", error: raw,
  }, {
    at: new Date().toISOString(), goalId: "goal-auth", objective: "provider auth wall", verdict: "error",
    model: "provider/model", thinkingLevel: "high", report: "", error: bare403,
  }]);
  const history = formatGoalAuditHistory({ id: "goal-123456", auditHistory: [{
    at: new Date().toISOString(), approved: false, disapproved: false, model: "provider/model", error: raw,
  }, {
    at: new Date().toISOString(), approved: false, disapproved: false, model: "provider/model", error: bare403,
  }] });
  assert.doesNotMatch(`${line}\n${history}`, /429|Token Plan|abc123|403|upstream denied|auth-sensitive-id/);
  assert.match(`${line}\n${history}`, /provider error/);
});

test("scheduleQuotaRetry deduplicates one notice key within an episode", () => {
  resetQuotaRetryNoticeDedup();
  const notifies: string[] = [];
  const ctx = { ui: { notify: (message: string) => notifies.push(message) } } as any;
  scheduleQuotaRetry(ctx, 3600, "429 Token Plan limit reached", () => {}, "Auditor retry", {
    episodeKey: "episode-1",
    noticeKey: "episode-1:retry",
  });
  cancelQuotaRetry();
  scheduleQuotaRetry(ctx, 3600, "429 Token Plan limit reached; retry_after=30", () => {}, "Auditor retry", {
    episodeKey: "episode-1",
    noticeKey: "episode-1:retry",
  });
  assert.equal(notifies.length, 1);
  cancelQuotaRetry();
  resetQuotaRetryNoticeDedup();
});

test("parseQuotaError: 429 with Retry-After: 5 → retryAfterSec 5 (item 12 test 1)", () => {
  const q = parseQuotaError("Error: 429 Too Many Requests\nRetry-After: 5");
  assert.equal(q.retryAfterSec, 5);
  assert.equal(q.fromUpstream, true);
});

test("parseQuotaError: 429 without hint → default 3600 (item 12 test 2)", () => {
  const q = parseQuotaError("Error: 429 quota exceeded");
  assert.equal(q.retryAfterSec, 3600);
  assert.equal(q.fromUpstream, false);
});

test("parseQuotaError: prose hints (retry in 2m / retry after 30 seconds)", () => {
  assert.equal(parseQuotaError("temporarily rate-limited upstream, retry in 2m").retryAfterSec, 120);
  assert.equal(parseQuotaError("retry after 30 seconds").retryAfterSec, 30);
  assert.equal(parseQuotaError("Retry in 1h please").retryAfterSec, 3600);
  assert.equal(parseQuotaError("plan limit; retry in 1 week").retryAfterSec, 7 * 24 * 3600);
});

test("v0.34.125: temporary-window prose is honored — no give-up until the bigger reset", () => {
  // note.md 2026-08-10: a temporary quota message must retry at its own
  // short window, not park hour-aligned "until quota reset".
  assert.equal(parseQuotaError("429 Too Many Requests — try again in 30 seconds").retryAfterSec, 30);
  assert.equal(parseQuotaError("Rate limit exceeded, please wait 1 minute").retryAfterSec, 60);
  assert.equal(parseQuotaError("quota exceeded — rate limit resets in 15 seconds").retryAfterSec, 15);
  assert.equal(parseQuotaError("limit reached. Available again in 2 minutes").retryAfterSec, 120);
  const allUpstream = ["try again in 30 seconds", "please wait 1 minute", "rate limit resets in 15 seconds", "Available again in 2 minutes"]
    .map((text) => parseQuotaError(text).fromUpstream);
  assert.ok(allUpstream.every(Boolean), `all temporary windows are upstream facts: ${allUpstream.join(", ")}`);
});

test("v0.34.125: 'temporarily over quota' is a retryable rate-limit, plain 'temporarily unavailable' stays ambiguous", () => {
  assert.equal(quotaSignal("temporarily over quota, try again shortly"), "rate-limit");
  assert.equal(isQuotaError("temporarily over quota"), true);
  assert.equal(isQuotaError("temporarily above the rate limit"), true);
  // A plan wall that merely says "over quota" is not explicitly temporary;
  // it must retain the plan-quota label instead of taking the short-window
  // rate-limit branch.
  assert.equal(quotaSignal("You are over your monthly quota — upgrade"), "plan-quota");
  assert.equal(isQuotaError("You are over your monthly quota — upgrade"), true);
  // no numeric hint → the conservative fallback (3600s) — the bounded
  // cadence owns the wait, never a manual give-up.
  assert.equal(parseQuotaError("temporarily over quota").retryAfterSec, 3600);
  assert.equal(parseQuotaError("temporarily over quota").fromUpstream, false);
  // still conservative: an ordinary outage is NOT a quota wall.
  assert.equal(isQuotaError("temporarily unavailable, please try later"), false);
  assert.equal(isQuotaError("503 Service Unavailable"), false);
});

test("quota classification stays conservative around ambiguous provider errors", () => {
  assert.equal(isQuotaError("503 temporarily unavailable"), false);
  assert.equal(isQuotaError("403 forbidden"), false);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
  assert.equal(isBillingError("insufficient credits"), true);
  assert.equal(isBillingError("429 Too Many Requests"), false);
});

test("every explicit 429/rate-limit marker stays a retryable request-rate wall", () => {
  assert.equal(quotaSignal("429 rate limit exceeded"), "rate-limit");
  assert.equal(quotaSignal("429 Too Many Requests"), "rate-limit");
  assert.equal(quotaSignal("too-many-requests"), "rate-limit");
  assert.equal(quotaSignal("too_many_requests"), "rate-limit");
  assert.equal(quotaSignal("429 usage limit"), "rate-limit");
  assert.equal(quotaSignal("429 quota exceeded"), "rate-limit");
});

test("plan wording without a 429 remains distinct, while 429 Token Plan text is rate-limit", () => {
  const minimax = "429 {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Token Plan rate limit reached: Upgrade your Token Plan or switch to pay-as-you-go API usage. (2062)\"}}";
  assert.equal(quotaSignal(minimax), "rate-limit");
  assert.equal(parseQuotaError(minimax).signal, "rate-limit");
  assert.equal(quotaSignal("Token Plan usage limit reached"), "plan-quota");
  assert.equal(quotaSignal("429 insufficient_quota"), "rate-limit");
  assert.equal(quotaSignal("insufficient_quota"), "billing");
  assert.equal(quotaSignal("temporarily rate-limited upstream"), "rate-limit");
  assert.equal(quotaSignal("Model stopped because it reached the maximum output token limit"), undefined);
});

test("parseQuotaError: JSON reset fields and HTTP-date reset are understood", () => {
  const now = Date.parse("2026-08-03T00:00:00Z");
  const json = parseQuotaError('{"error":{"reset_at":"2026-08-03T02:00:00Z"}}', 3600, now);
  assert.equal(json.retryAfterSec, 2 * 3600);
  assert.equal(json.resetAt, "2026-08-03T02:00:00.000Z");
  const http = parseQuotaError("429\nRetry-After: Mon, 03 Aug 2026 02:00:00 GMT", 3600, now);
  assert.equal(http.retryAfterSec, 2 * 3600);
  assert.equal(http.fromUpstream, true);
});

test("parseQuotaError: digit-leading Retry-After ISO date is not truncated as seconds", () => {
  const now = Date.parse("2026-08-10T00:00:00Z");
  const iso = parseQuotaError("429\nRetry-After: 2026-08-10T12:00:00Z", 3600, now);
  assert.equal(iso.retryAfterSec, 12 * 3600);
  assert.equal(iso.resetAt, "2026-08-10T12:00:00.000Z");
  assert.equal(iso.fromUpstream, true);
});

test("quota retry cadence caps at five hours instead of retrying for a week", () => {
  assert.equal(quotaRetryDelaySeconds(1, 60), 60 * 60);
  assert.equal(quotaRetryDelaySeconds(2, 60), 2 * 60 * 60);
  assert.equal(quotaRetryDelaySeconds(3, 60), 4 * 60 * 60);
  assert.equal(quotaRetryDelaySeconds(4, 60), 5 * 60 * 60);
  assert.equal(capQuotaRetrySeconds(7 * 24 * 3600), 5 * 60 * 60);
});

test("isQuotaError: wild-caught shapes", () => {
  assert.equal(isQuotaError('403: {"message":"Key limit exceeded (total limit)"}'), true);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
  assert.equal(isQuotaError("temporarily rate-limited upstream"), true);
  assert.equal(isQuotaError("insufficient credits"), true);
  assert.equal(isQuotaError("model not found"), false);
  assert.equal(isQuotaError(undefined), false);
});

test("scheduleQuotaRetry: fires the callback after the window (item 12 test 3 core)", async () => {
  let fired = 0;
  scheduleQuotaRetry(fakeCtx, 1, "429 test", () => { fired++; });
  assert.equal(isQuotaRetryPending(), true);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(fired, 1);
  assert.equal(isQuotaRetryPending(), false);
});

test("cancelQuotaRetry: a pending retry does not fire (item 12 test 4 core)", async () => {
  let fired = 0;
  scheduleQuotaRetry(fakeCtx, 1, "429 test", () => { fired++; });
  cancelQuotaRetry();
  assert.equal(isQuotaRetryPending(), false);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(fired, 0);
});
