// pi-goal-list-loop-audit — v0.38.104 redaction cascade budget.
//
// Field 2026-09-28 (hellhunter, screenshot 111015): the goal was at 9 reviews /
// 9 disapproved, 13/13 tasks, 96h 37m, and the TUI showed
//
//   latest audit feedback: …[provider diagnostic redacted — provider error] x5
//   Inspect auditor feedback and fix the actual gap before calling complete_goal again
//
// …with no gap visible. The report was fine: 23 659 characters with two real
// [HIGH] required fixes. sanitizeProviderAuditReport had cut it to 12 614 with
// 185 redaction tags, and latestAuditFeedback's 320-char tail fell inside the
// redacted region, so the agent was handed a wall of identical tags instead of
// the objections it was supposed to fix. A blind rework loop: 9/9 disapproved.
//
// Two causes, both structural:
//   1. `structuredLine` matches `reason:` / `message:` / `detail:` — vocabulary
//      an auditor report is full of when it QUOTES test output.
//   2. once a line is marked, `jsonDepth` follows braces through the rest of the
//      document, so a REPORT was treated as if it WERE a provider payload.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeProviderAuditReport,
  SANITIZE_MAX_REDACTION_RATIO,
  SANITIZE_MIN_REDACTION_LINES,
} from "../extensions/quota-retry.ts";

/** The hellhunter shape: a real report quoting error-shaped test output. */
function auditorReport(requiredFixes: string, quoteLines = 120): string {
  const quotes = Array.from({ length: quoteLines }, (_, i) =>
    `  sample reason: page.evaluate: Error: dungeon walk deadline at {"x":${i}.5,"y":520.07} — gate missed`,
  ).join("\n");
  return [
    "I inspected the evidence and the harness.",
    "## Evidence",
    quotes,
    "## Required fixes",
    requiredFixes,
    "<!-- end -->",
  ].join("\n");
}

test("v0.38.104 an auditor report survives sanitizing instead of being deleted", () => {
  const fixes = "1. [HIGH] Re-run the playable loop and publish the artifact.\n2. [HIGH] Reconcile the movement fix with the evidence.";
  const report = auditorReport(fixes);
  const safe = sanitizeProviderAuditReport(report);
  assert.ok(safe.length > report.length * (1 - SANITIZE_MAX_REDACTION_RATIO),
    `kept only ${Math.round(safe.length / report.length * 100)}% of the report`);
  assert.ok(safe.includes("[HIGH] Re-run the playable loop"), "the real required fixes must survive");
  assert.ok(safe.includes("[HIGH] Reconcile the movement fix"), "both of them");
});

test("v0.38.104 the required-fixes section is always recoverable", () => {
  // The whole point: the agent is shown this section as its actionable
  // feedback. If sanitizing removes it, the rework loop is blind.
  const report = auditorReport("1. [HIGH] Close the loop and publish evidence.");
  const safe = sanitizeProviderAuditReport(report);
  const idx = safe.indexOf("Required fixes");
  assert.ok(idx >= 0, "the Required fixes header must survive");
  assert.ok(safe.slice(idx).includes("Close the loop and publish evidence"),
    "and the fixes under it");
});

test("v0.38.104 a genuine provider payload still redacts IN FULL", () => {
  // The budget bounds a cascade; it must never let a real leak through. This
  // is the case the redaction exists for.
  for (const payload of [
    '{"error":{"message":"429 rate limit, api_key sk-abc123","request_id":"req-99"}}',
    "authorization: Bearer sk-secret-token-value-here",
    '{"error":{"message":"insufficient_quota for key key-abc"}}',
  ]) {
    const safe = sanitizeProviderAuditReport(payload);
    assert.equal(safe, "[provider diagnostic redacted — provider error]", payload);
    assert.ok(!/sk-|Bearer|api_key/i.test(safe), "no secret survives: " + safe);
  }
});

test("v0.38.104 a payload-heavy blob redacts in full regardless of length", () => {
  // Long, but every line is a marked payload line — this IS a provider blob,
  // not a report, and it must be redacted rather than released by the budget.
  const blob = Array.from({ length: 60 }, (_, i) => `error: {"request_id":"req-${i}","message":"429 rate limit"}`).join("\n");
  const safe = sanitizeProviderAuditReport(blob);
  assert.ok(!/req-\d+/.test(safe), "request ids must not survive a payload blob");
});

test("v0.38.104 the budget is a real fraction with an absolute floor", () => {
  assert.ok(SANITIZE_MAX_REDACTION_RATIO > 0 && SANITIZE_MAX_REDACTION_RATIO < 1, "a ratio, not an unbounded allowance");
  assert.ok(SANITIZE_MIN_REDACTION_LINES > 0, "a short report still redacts a few lines fully");
});

test("v0.38.104 a marked line is always redacted, even after the budget", () => {
  // Past the budget only a DIRECT marker still redacts. A bare secret line is
  // a direct marker, so it cannot be released.
  const long = auditorReport("1. fix", 400);
  const withSecret = `${long}\nauthorization: Bearer sk-late-secret-should-not-survive`;
  const safe = sanitizeProviderAuditReport(withSecret);
  assert.ok(!safe.includes("sk-late-secret"), "a direct marker past the budget must still redact");
});

test("v0.38.104 a bare 5xx-shaped number is not a provider marker", () => {
  // The real over-redaction trigger: `\b5\d\d\b` matched any number 500-599,
  // so a report quoting `{"y":520.07}` was redacted line by line. A 5xx needs
  // HTTP/status context to count.
  const numbers = auditorReport("1. [HIGH] fix it", 60).replace(/Error: dungeon walk deadline/g, "step at");
  const withNumbers = numbers.replace(/520\.07/g, "520.07");
  const safe = sanitizeProviderAuditReport(withNumbers);
  assert.ok(safe.length > withNumbers.length * 0.85, "numeric report text must survive");
  assert.ok(safe.includes("[HIGH] fix it"), "and the required fixes with it");
});

test("v0.38.104 a 5xx WITH http context still redacts", () => {
  for (const raw of [
    "HTTP 503 Service Unavailable",
    '{"status":500,"message":"internal"}',
    "status_code: 500",
  ]) {
    const safe = sanitizeProviderAuditReport(raw);
    assert.equal(safe, "[provider diagnostic redacted — provider error]", raw);
  }
});
