import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildWidgetLines, buildStatusText, type AuditDisplayProgress } from "../extensions/goal-loop-display.js";
import type { Goal } from "../extensions/goal-loop-core.js";

const now = Date.parse("2026-10-03T18:25:00Z");
const goal: Goal = {
  id: "doomtap-audit", objective: "Fix audit finding: HIGH: the no probe runs in no gate guard counts a comment",
  status: "auditing", policy: "list", autoContinue: true,
  usage: { tokensUsed: 194_000, tokensLimit: 0 },
  createdAt: new Date(now - 70 * 60_000).toISOString(), updatedAt: new Date(now).toISOString(),
  pendingCompletion: { at: new Date(now - 8 * 60_000).toISOString(), phase: "running", attemptId: "glance-audit", auditorThinkingLevel: "max" },
};
const audit: AuditDisplayProgress = {
  phase: "thinking", elapsedMs: 8 * 60_000, lastActivityAt: now - 17_000,
  model: "openrouter/stealth/space-bunny-alpha",
  toolCalls: Array.from({ length: 11 }, () => ({ name: "bash", argsPrefix: "{}", finishedAt: now - 17_000 })),
};
const extras = {
  compactAuditCard: true,
  modelProvenance: { primary: audit.model!, primarySource: "inherited" as const, fallbackRefs: [], skippedForbiddenRefs: [], handledAudit: audit.model! },
  durableDeferRecommendation: { durableFix: "Implement the checker with quote-aware comment stripping", deferRecommendations: ["Wait"] },
};

test("screenshot regression: live audit facts and user action fit before Pi's ten-row cut", () => {
  for (const width of [40, 60, 80, 120, 190]) {
    const lines = buildWidgetLines({ goal, list: [] }, audit, now, undefined, width, extras)!;
    const text = lines.join("\n");
    assert.ok(lines.length <= 7, text);
    assert.match(text, /No action needed/);
    assert.match(text, /11 calls finished/);
    assert.match(text, /audit elapsed 8m/);
    assert.match(text, /activity 17s/);
    assert.match(text, /thinking/);
    assert.doesNotMatch(text, /reading source|Durable fix|selected:|model: primary|judgment:/);
    assert.match(text, /\/goal status/);
  }
});

test("narrow footer starts with audit state and real freshness", () => {
  const status = buildStatusText({ goal, list: [] }, audit, now, undefined, extras, 80)!;
  assert.match(status, /^glla: AUDIT RUNNING · activity 17s ago/);
});

test("quiet, blocked, settlement and recovery do not claim no action is needed", () => {
  const cases = [
    { goal, audit: { ...audit, lastActivityAt: now - 31 * 60_000, toolCalls: [] } },
    { goal, audit: { ...audit, label: "blocked" } },
    { goal: { ...goal, pendingCompletion: { ...goal.pendingCompletion!, phase: "settling" as const } }, audit: null },
    { goal: { ...goal, pendingCompletion: { ...goal.pendingCompletion!, phase: "recovery-pending" as const } }, audit: null },
  ];
  for (const scenario of cases) {
    const text = buildWidgetLines({ goal: scenario.goal, list: [] }, scenario.audit, now, undefined, 120, extras)!.join("\n");
    assert.doesNotMatch(text, /No action needed/, text);
    assert.match(text, /resume|cancel/, text);
  }
});

test("starting audit distinguishes waiting for first activity from recent activity", () => {
  const starting = { ...goal, pendingCompletion: { ...goal.pendingCompletion!, phase: "starting" as const } };
  const status = buildStatusText({ goal: starting, list: [] }, null, now, undefined, extras, 120)!;
  assert.match(status, /no worker activity yet/);
  assert.doesNotMatch(status, /activity 0s ago/);
});
