import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupEntries, formatReliabilityJson, formatReliabilityTable, type LedgerEntry } from "../extensions/goal-loop-stats.js";
import { unknownStatsArg } from "../extensions/goal-commands.js";

const at = (n: number) => new Date(n * 1000).toISOString();
const state = (goal: Record<string, unknown>, time: number): LedgerEntry => ({ type: "state", at: at(time), value: { goal } });

test("reliability derives an open failure episode and elapsed audit cost without counting repeated snapshots", () => {
  const history = [{ at: at(10), error: "transport", durationMs: 2000, challenge: "skipped: transport" }];
  const rollup = rollupEntries("project", [
    { type: "audit_started", at: at(1), value: { goalId: "g1", attemptId: "a1" } },
    { type: "audit_started", at: at(1), value: { goalId: "g1", attemptId: "a1" } },
    { type: "auditor_stalled", at: at(5), value: { goalId: "g1" } },
    { type: "audit_infra_retry", at: at(6), value: { goalId: "g1" } },
    state({ id: "g1", status: "paused", auditHistory: history }, 10),
    state({ id: "g1", status: "paused", auditHistory: history }, 12),
  ]);
  const row = JSON.parse(formatReliabilityJson([rollup], 20_000))[0];
  assert.equal(row.startsObserved, 1);
  assert.equal(row.retryEventsObserved, 1);
  assert.equal(row.openFailureEpisodes, 1);
  assert.equal(row.oldestOpenFailureAgeMs, 15_000);
  assert.equal(row.durationSamples, 1);
  assert.equal(row.meanObservedAuditDurationMs, 2000);
  assert.equal(row.skippedAttemptDurationMs, 2000);
  assert.equal(row.challengeSkipped, 1);
  assert.match(formatReliabilityTable([rollup], 20_000), /project.*1.*1.*1.*15s.*2s/);
});

test("successful semantic review or terminal archive resolves failure age; missing samples stay unknown", () => {
  for (const terminal of [false, true]) {
    const entries: LedgerEntry[] = [
      { type: "auditor_stalled", at: at(5), value: { goalId: "g1" } },
      state({ id: "g1", status: "active", auditHistory: terminal ? [] : [{ at: at(8), disapproved: true }] }, 9),
    ];
    if (terminal) entries.push({ type: "goal_archived", at: at(10), value: { goalId: "g1", status: "aborted" } });
    const row = JSON.parse(formatReliabilityJson([rollupEntries("project", entries)], 20_000))[0];
    assert.equal(row.openFailureEpisodes, 0);
    assert.equal(row.oldestOpenFailureAgeMs, null);
    assert.equal(row.meanObservedAuditDurationMs, null);
  }
});

test("recovery-only state preserves failure age and future/malformed timestamps remain unknown", () => {
  const rollup = rollupEntries("project", [state({ id: "g1", status: "paused", pendingCompletion: { phase: "recovery-pending", recoveryAt: at(5) } }, 10)]);
  assert.equal(JSON.parse(formatReliabilityJson([rollup], 20_000))[0].oldestOpenFailureAgeMs, 15_000);
  assert.equal(JSON.parse(formatReliabilityJson([rollup], 1000))[0].oldestOpenFailureAgeMs, null);
  const corrupt = rollupEntries("project", [{ type: "auditor_stalled", at: "bad", value: { goalId: "g1" } }, { type: "state", value: { goalId: "g1" } }]);
  assert.equal(corrupt.reliability?.openFailureEpisodes, 0);
  assert.equal(unknownStatsArg("reliability json project=/tmp/project"), null);
});
