// pi-goal-list-loop-audit — unreleased (GitHub #62 follow-up)
// tests/completion-audit-park.test.ts
//
// Field 2026-11-09: a list item sat at "completion audit: parked — no review
// recorded" and the action line said "Fix the auditor/session issue". The
// operator checked the auditor model against the session model, found them
// identical, and reported the diagnosis as wrong — which it was: the durable
// reason was a session boundary, and no auditor/model setup was implicated.
//
// One generic sentence was asserting a fault class the record did not support.
// These tests pin the per-cause copy and the cause line the cards now show.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  classifyCompletionAuditParkReason,
  completionAuditParkAction,
  formatCompletionAuditParkCause,
} from "../extensions/completion-audit-park.js";

test("a session boundary is classified as a session boundary, not an auditor fault", () => {
  for (const reason of ["session_shutdown:reload", "session_start:startup", "session_start:blank-load", "silent-host-successor:rebind", "host-rebind"]) {
    assert.equal(classifyCompletionAuditParkReason(reason), "session-boundary", reason);
  }
});

test("a session-boundary action says nothing needs fixing and points at the resume command", () => {
  const action = completionAuditParkAction("session_shutdown:reload", "/list resume");
  assert.match(action, /the session changed before the auditor finished/);
  assert.match(action, /nothing about your auditor or model setup is implicated/);
  assert.match(action, /\/list resume starts exactly one fresh audit/);
  assert.doesNotMatch(action, /Fix the auditor\/session issue/);
});

test("a provider failure names the provider instead of implying the wrong auditor model", () => {
  assert.equal(classifyCompletionAuditParkReason("Error: Request timed out."), "provider");
  assert.equal(classifyCompletionAuditParkReason("Error: 429 \"Rate limit exceeded\""), "provider");
  const action = completionAuditParkAction("Error: Request timed out.", "/goal resume");
  assert.match(action, /the provider failed the audit run/);
  assert.match(action, /Restore provider access/);
  assert.match(action, /another auditor model in \/glla settings/);
});

test("a watchdog recovery is its own cause — the worker stopped reporting, which is not a config mistake", () => {
  assert.equal(classifyCompletionAuditParkReason("heartbeat-recovery"), "watchdog");
  assert.equal(classifyCompletionAuditParkReason("stale-latch-recovery"), "watchdog");
  const action = completionAuditParkAction("heartbeat-recovery", "/goal resume");
  assert.match(action, /the auditor stopped reporting/);
  assert.match(action, /parked it rather than guess/);
  assert.doesNotMatch(action, /nothing about your auditor/);
});

test("a verdict that could not be applied is not described as a missing verdict", () => {
  assert.equal(classifyCompletionAuditParkReason("verdict-apply-gate"), "verdict-apply");
  const action = completionAuditParkAction("verdict-apply-gate", "/goal resume");
  assert.match(action, /verdict could not be applied/);
});

test("an unrecognized reason degrades to no-verdict, never to a model accusation", () => {
  // The closed caller vocabulary means an unknown string is the honest
  // "the auditor produced nothing" case. It must never become "your auditor is
  // broken" or "nothing is misconfigured" — both would assert facts the record
  // does not contain.
  assert.equal(classifyCompletionAuditParkReason("something unforeseen"), "no-verdict");
  assert.equal(classifyCompletionAuditParkReason(undefined), "no-verdict");
  const action = completionAuditParkAction("something unforeseen", "/goal resume");
  assert.match(action, /the auditor exited without a verdict/);
  assert.doesNotMatch(action, /nothing about your auditor/);
  assert.doesNotMatch(action, /provider failed/);
});

test("the cause line keeps the durable breadcrumb readable next to the phrase", () => {
  assert.equal(formatCompletionAuditParkCause("session_shutdown:reload"), "the session changed before the auditor finished (session_shutdown:reload)");
  assert.equal(formatCompletionAuditParkCause("heartbeat-recovery"), "the auditor stopped reporting (heartbeat-recovery)");
  assert.equal(formatCompletionAuditParkCause(""), "the auditor exited without a verdict", "an absent reason invents no parenthetical");
});

test("every cause states the claim is stored, so the copy never reads as lost work", () => {
  for (const reason of ["session_start:reload", "heartbeat-recovery", "Error: 429", "verdict-apply-gate", "unknown wording"]) {
    const action = completionAuditParkAction(reason, "/goal resume");
    assert.match(action, /The completion claim is stored/, reason);
    assert.match(action, /\/goal resume/, reason);
    assert.ok(action.length < 420, `${reason}: the action stays one readable sentence (${action.length} chars)`);
  }
});
