// pi-goal-list-loop-audit — activity-first auditing card + footer agreement.
//
// The auditing card leads with live state (phase, last-progress age,
// current tool + time budget, effective model + thinking, next action)
// before any historical rows; the card and the one-line footer share one
// phase interpretation so their labels agree. Fixtures mirror the field
// screenshots Screenshot_20260917_090729 (quiet/stale), _091526
// (awaiting verdict), and _110334 (blocked).

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildStatusText,
  buildWidgetLines,
  type DisplayTheme,
} from "../extensions/goal-loop-display.ts";
import {
  stampAuditorAttemptThinking,
  type Goal,
  type PendingCompletion,
} from "../extensions/goal-loop-core.ts";

const NOW = Date.parse("2026-09-17T12:00:00Z");

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260917120000-abcdef",
    objective: "Ship the activity-first card",
    status: "auditing",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-09-17T11:50:00Z",
    updatedAt: "2026-09-17T11:59:00Z",
    ...overrides,
  };
}

function claimOf(overrides: Partial<PendingCompletion> = {}): PendingCompletion {
  return {
    at: "2026-09-17T11:55:00Z",
    phase: "running",
    attemptId: "audit-activity-first",
    auditorCandidateRef: "test-auditor/model",
    auditorThinkingLevel: "high",
    ...overrides,
  };
}

/** A theme that records colour pairing instead of emitting ANSI. */
function recordingTheme(calls: Array<{ color: string; text: string }>): DisplayTheme {
  return { fg: (color, text) => { calls.push({ color, text }); return `<${color}>${text}</>`; } };
}

// ---- lead order: activity before history ----

test("activity-first: lead rows follow the head and precede all historical rows", () => {
  const g = goalOf({
    pendingCompletion: claimOf(),
    auditHistory: [
      { at: "2026-09-17T11:00:00Z", approved: true, disapproved: false, model: "test-auditor/model" },
    ],
  });
  const lines = buildWidgetLines(
    { goal: g, list: [] },
    {
      phase: "tool_executing",
      currentTool: "read",
      currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
      currentToolStartedAt: NOW - 2_000,
      toolTimeoutMs: 1_200_000,
      elapsedMs: 60_000,
      lastActivityAt: NOW - 1_000,
      model: "test-auditor/model",
    },
    NOW,
    undefined,
    120,
    {
      modelProvenance: {
        primary: "session/model",
        primarySource: "inherited",
        fallbackRefs: [],
        skippedForbiddenRefs: [],
        handledTurn: "session/model",
        handledAudit: "test-auditor/model",
      },
      durableDeferRecommendation: { durableFix: "fix the card", deferRecommendations: ["wait"] },
    },
  )!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /├─ auditor: /, "first content row is the auditor activity lead");
  assert.match(lines[2]!, /^│ tool: /, "second row carries tool/budget/model/thinking");
  assert.match(lines[3]!, /^│ next: /, "third row names the next action");
  const nextAt = lines.findIndex((l) => /^│ next: /.test(l));
  const auditsAt = lines.findIndex((l) => l.includes("audits:"));
  const modelAt = lines.findIndex((l) => l.includes("handled audit:"));
  const judgmentAt = lines.findIndex((l) => l.includes("1. Durable fix"));
  assert.ok(auditsAt > nextAt, `verdict tally follows the lead:\n${text}`);
  assert.ok(modelAt > nextAt, `provenance follows the lead:\n${text}`);
  assert.ok(judgmentAt > nextAt, `judgment follows the lead:\n${text}`);
  assert.doesNotMatch(text, /widget truncated/, "no truncation marker on core rows");
});

// ---- 090729-style: quiet/stale claim ----

test("activity-first: quiet card leads with phase, age, last tool, model, thinking, next action", () => {
  const g = goalOf({ pendingCompletion: claimOf({ auditorThinkingLevel: "max" }) });
  const lines = buildWidgetLines(
    { goal: g, list: [] },
    {
      phase: "running",
      currentTool: "read",
      currentToolStartedAt: NOW - 35 * 60_000,
      toolTimeoutMs: 20 * 60_000,
      elapsedMs: 40 * 60_000,
      lastActivityAt: NOW - 31 * 60_000,
      model: "test-auditor/model",
      toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: NOW - 31 * 60_000 }],
    },
    NOW,
    undefined,
    120,
  )!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /auditor: quiet · detached worker · last progress 31m/, `quiet phase + age lead:\n${text}`);
  assert.match(lines[2]!, /last tool: read/, "stale tool demoted to last-tool, still in the lead");
  assert.match(lines[2]!, /test-auditor\/model/, "effective model named in the lead");
  assert.match(lines[2]!, /thinking max/, "effective thinking named in the lead");
  assert.match(lines[3]!, /next: \/goal cancel discards the claim/, "quiet next action names the escape hatch");
  assert.match(text, /auditor quiet 31m/, "closer keeps its byte-identical quiet wording");
  const toolRows = lines.filter((l) => /tool:|last tool:/.test(l));
  assert.equal(toolRows.length, 1, "the card keeps its one-current-observation rule");
});

// ---- 091526-style: awaiting verdict ----

test("activity-first: awaiting-verdict card and footer agree on the phase words", () => {
  const g = goalOf({ pendingCompletion: claimOf() });
  const audit = {
    phase: "complete" as const,
    elapsedMs: 120_000,
    lastActivityAt: NOW - 5_000,
    model: "test-auditor/model",
  };
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW, undefined, 120)!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /auditor: awaiting verdict · detached worker · last progress/, `verdict phase leads:\n${text}`);
  assert.match(lines[2]!, /test-auditor\/model · thinking high/, "model + thinking in the lead");
  assert.match(lines[3]!, /next: verdict applying/, "verdict next action");
  const footer = buildStatusText({ goal: g, list: [] }, audit, NOW)!;
  assert.match(footer, /auditor ✓ awaiting verdict/, "footer names the same phase");
  assert.ok(text.includes("awaiting verdict") && footer.includes("awaiting verdict"), "card and footer agree: awaiting verdict");
  assert.doesNotMatch(footer, /next:|detached worker/, "footer stays liveness-only");
});

// ---- 110334-style: blocked claim ----

test("activity-first: blocked card and footer agree on the blocked label", () => {
  const g = goalOf({ pendingCompletion: claimOf() });
  const audit = {
    phase: "error" as const,
    label: "provider error: upstream timeout after 30s",
    elapsedMs: 90_000,
    lastActivityAt: NOW - 60_000,
    model: "test-auditor/model",
    toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: NOW - 60_000 }],
  };
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW, undefined, 120)!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /auditor: blocked · detached worker · last progress/, `blocked phase leads:\n${text}`);
  assert.match(lines[3]!, /next: \/goal resume retries the claim/, "blocked next action names resume");
  assert.match(text, /auditor blocked — provider error: upstream timeout/, "closer keeps its blocked wording");
  const footer = buildStatusText({ goal: g, list: [] }, audit, NOW)!;
  assert.match(footer, /auditor ✗ blocked — provider error: upstream timeout/, "footer names the same blocked label");
});

// ---- running live: tool + budget in the lead ----

test("activity-first: live running card carries tool elapsed/budget in the lead", () => {
  const g = goalOf({ pendingCompletion: claimOf() });
  const lines = buildWidgetLines(
    { goal: g, list: [] },
    {
      phase: "tool_executing",
      currentTool: "read",
      currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
      currentToolStartedAt: NOW - 2_000,
      toolTimeoutMs: 1_200_000,
      elapsedMs: 42_000,
      lastActivityAt: NOW - 1_000,
      model: "test-auditor/model",
    },
    NOW,
    undefined,
    120,
  )!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /auditor: tool executing · detached worker · last progress/, `live phase leads:\n${text}`);
  assert.match(lines[2]!, /tool: read → .*README\.md.*\/ 20m 00s budget/, "tool elapsed + budget in the lead");
  assert.match(lines[3]!, /next: verdict applies automatically/, "running next action");
  const narrow = buildWidgetLines(
    { goal: g, list: [] },
    {
      phase: "tool_executing",
      currentTool: "read",
      currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
      currentToolStartedAt: NOW - 2_000,
      toolTimeoutMs: 1_200_000,
      elapsedMs: 42_000,
      lastActivityAt: NOW - 1_000,
      model: "test-auditor/model",
    },
    NOW,
    undefined,
    80,
  )!;
  assert.ok(narrow.some((l) => /next: verdict applies automatically/.test(l)), "the next action survives an 80-column terminal");
});

// ---- legacy claims: absent stays absent ----

test("activity-first: legacy claim without thinking/model omits the segments, never invents", () => {
  const g = goalOf({
    pendingCompletion: { at: "2026-09-17T11:55:00Z", phase: "running", attemptId: "legacy-claim" },
  });
  const lines = buildWidgetLines(
    { goal: g, list: [] },
    { phase: "running", label: "queued", elapsedMs: 5_000 },
    NOW,
    undefined,
    120,
  )!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /auditor: queued · detached worker · last progress none yet/, `legacy lead:\n${text}`);
  assert.doesNotMatch(text, /thinking/, "no thinking segment without a stamped level");
  assert.match(lines[2]!, /next: worker starting/, "queued next action still renders");
});

// ---- colour paired with words, never instead of them ----

test("activity-first: phase colour wraps the words (quiet warns, live succeeds, queued stays neutral)", () => {
  const quietCalls: Array<{ color: string; text: string }> = [];
  const quiet = buildWidgetLines(
    { goal: goalOf({ pendingCompletion: claimOf() }), list: [] },
    {
      phase: "running",
      currentTool: "read",
      currentToolStartedAt: NOW - 35 * 60_000,
      toolTimeoutMs: 20 * 60_000,
      elapsedMs: 40 * 60_000,
      lastActivityAt: NOW - 31 * 60_000,
      model: "test-auditor/model",
    },
    NOW,
    recordingTheme(quietCalls),
    120,
  )!;
  assert.ok(quietCalls.some((c) => c.color === "warning" && c.text === "quiet"), `quiet paints warning around the word: ${JSON.stringify(quietCalls)}`);
  assert.ok(quiet.join("\n").includes("quiet"), "the word survives alongside the colour");

  const liveCalls: Array<{ color: string; text: string }> = [];
  buildWidgetLines(
    { goal: goalOf({ pendingCompletion: claimOf() }), list: [] },
    {
      phase: "tool_executing",
      currentTool: "read",
      currentToolStartedAt: NOW - 2_000,
      elapsedMs: 42_000,
      lastActivityAt: NOW - 1_000,
      model: "test-auditor/model",
    },
    NOW,
    recordingTheme(liveCalls),
    120,
  )!;
  assert.ok(liveCalls.some((c) => c.color === "success" && c.text === "tool executing"), `live work paints success: ${JSON.stringify(liveCalls)}`);

  const queuedCalls: Array<{ color: string; text: string }> = [];
  buildWidgetLines(
    { goal: goalOf({ pendingCompletion: claimOf() }), list: [] },
    { phase: "running", label: "queued" },
    NOW,
    recordingTheme(queuedCalls),
    120,
  )!;
  assert.ok(queuedCalls.some((c) => c.color === "accent" && c.text === "queued"), `queued stays neutral accent: ${JSON.stringify(queuedCalls)}`);
});

// ---- monitoring / awaiting footer labels come from one interpretation ----

test("activity-first: footer monitoring and awaiting labels agree with the card head", () => {
  const monitoringFooter = buildStatusText(
    { goal: goalOf({ status: "active" }), list: [] },
    null,
    NOW,
    undefined,
    { activity: "monitoring" },
  )!;
  assert.match(monitoringFooter, /👁 MONITORING/, "monitoring badge renders from the shared activity");
  const awaitingFooter = buildStatusText(
    { goal: goalOf({ status: "active" }), list: [] },
    null,
    NOW,
    undefined,
    { activity: "awaiting-first-turn" },
  )!;
  assert.match(awaitingFooter, /AWAITING FIRST TURN/, "awaiting badge renders from the shared activity");
});

// ---- stamp helper: pure, attempt-scoped, sanitized ----

test("stampAuditorAttemptThinking stamps only the owning attempt and sanitizes", () => {
  const base = claimOf({ auditorThinkingLevel: undefined });
  const stamped = stampAuditorAttemptThinking(base, "audit-activity-first", "high");
  assert.ok(stamped, "stamps a claim missing the level");
  assert.equal(stamped!.auditorThinkingLevel, "high");
  assert.equal(base.auditorThinkingLevel, undefined, "pure: input untouched");
  assert.equal(
    stampAuditorAttemptThinking(stamped, "audit-activity-first", "high"),
    undefined,
    "no-op when the value is unchanged (skips the state write)",
  );
  assert.equal(
    stampAuditorAttemptThinking(stamped, "other-attempt", "low"),
    undefined,
    "a stale callback never stamps another attempt's claim",
  );
  const sanitized = stampAuditorAttemptThinking(base, "audit-activity-first", "max\ninjected");
  assert.equal(sanitized?.auditorThinkingLevel, "max injected", "newlines degrade to spaces, never stored raw");
  const fallback = stampAuditorAttemptThinking(stamped, "audit-activity-first", "low");
  assert.equal(fallback?.auditorThinkingLevel, "low", "a fallback candidate renames the level");
});
