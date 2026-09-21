// pi-goal-list-loop-audit — v0.38.74
// tests/stats-outcomes.test.ts
//
// /glla stats outcomes: completion/abort/open counts, rounds-to-approval,
// wall-clock and tokens per completed goal, run-to-done vs supervised
// split. Pure rollupEntries tests over fabricated ledger entries —
// unknowns stay unknown (skipped, never zero-filled), empty ledgers
// produce zeros without NaN.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  formatOutcomesJson,
  formatOutcomesTable,
  rollupEntries,
  type LedgerEntry,
} from "../extensions/goal-loop-stats.ts";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const H = 3_600_000;

function created(id: string, at: number): LedgerEntry {
  return { type: "goal_created", at: iso(at), value: { goalId: id } };
}

function snapshot(id: string, at: number, goal: Record<string, unknown>): LedgerEntry {
  return { type: "state", at: iso(at), value: { goal: { id, ...goal } } };
}

function archived(id: string, at: number, status: string): LedgerEntry {
  return { type: "goal_archived", at: iso(at), value: { goalId: id, status } };
}

function verdict(approved: boolean): { approved?: boolean; disapproved?: boolean } {
  return approved ? { approved: true } : { disapproved: true };
}

test("outcomes: completed/aborted/open counts with the run-to-done split", () => {
  const entries = [
    created("g1", T0),
    snapshot("g1", T0 + H, { status: "active", runToDone: true, auditHistory: [verdict(false), verdict(true)], usage: { tokensUsed: 1000 } }),
    archived("g1", T0 + 2 * H, "complete"),
    created("g2", T0),
    snapshot("g2", T0 + H, { status: "active", auditHistory: [verdict(true)], usage: { tokensUsed: 3000 } }),
    archived("g2", T0 + H, "complete"),
    created("g3", T0),
    snapshot("g3", T0 + H, { status: "paused" }),
    archived("g3", T0 + 3 * H, "aborted"),
    created("g4", T0),
    snapshot("g4", T0 + H, { status: "active", runToDone: true }),
  ];
  const r = rollupEntries("proj", entries).outcomes;
  assert.equal(r.completed, 2);
  assert.equal(r.aborted, 1);
  assert.equal(r.open, 1);
  assert.equal(r.runToDoneCompleted, 1);
  assert.equal(r.runToDoneAborted, 0);
  // g2 carries no flag (legacy shape) and g3 aborted supervised.
  assert.equal(r.supervisedCompleted, 1);
  assert.equal(r.supervisedAborted, 1);
});

test("outcomes: rounds, wall-clock, and tokens average over known data only", () => {
  const entries = [
    created("g1", T0),
    snapshot("g1", T0 + H, { status: "active", auditHistory: [verdict(false), verdict(true)], usage: { tokensUsed: 1000 } }),
    archived("g1", T0 + 2 * H, "complete"),
    created("g2", T0),
    snapshot("g2", T0 + H, { status: "active", auditHistory: [verdict(false), verdict(false), verdict(false), verdict(true)], usage: { tokensUsed: 3000 } }),
    archived("g2", T0 + H, "complete"),
    // No history, no usage, no created event: contributes to the
    // completed count but to no mean.
    archived("g3", T0 + H, "complete"),
  ];
  const r = rollupEntries("proj", entries).outcomes;
  assert.equal(r.completed, 3);
  assert.equal(r.avgRoundsToApproval, 3, "(2 + 4) / 2 — the unknown goal is skipped, not zero");
  assert.equal(r.avgWallClockHrs, 1.5, "(2h + 1h) / 2");
  assert.equal(r.tokensPerCompleted, 2000);
});

test("outcomes: unknown archive statuses are ignored, empty ledgers are zeroed", () => {
  const weird = rollupEntries("proj", [
    created("g1", T0),
    archived("g1", T0 + H, "migrated"),
  ]).outcomes;
  assert.equal(weird.completed, 0);
  assert.equal(weird.aborted, 0);
  const empty = rollupEntries("proj", []).outcomes;
  assert.deepEqual(empty, {
    completed: 0,
    aborted: 0,
    open: 0,
    avgRoundsToApproval: 0,
    avgWallClockHrs: 0,
    tokensPerCompleted: 0,
    runToDoneCompleted: 0,
    runToDoneAborted: 0,
    supervisedCompleted: 0,
    supervisedAborted: 0,
  });
});

test("outcomes: table and JSON formats mirror the schema", () => {
  const r = rollupEntries("my-proj", [
    created("g1", T0),
    snapshot("g1", T0 + H, { status: "active", runToDone: true, auditHistory: [verdict(true)], usage: { tokensUsed: 500 } }),
    archived("g1", T0 + 2 * H, "complete"),
  ]);
  const table = formatOutcomesTable([r]);
  assert.match(table, /\| project \| done \| aborted \| open \| rate \| rounds \| hrs \| tok\/done \| r2d done\/abort \| sup done\/abort \|/);
  assert.match(table, /my-proj \| 1 \| 0 \| 0 \| 100% \| 1 \| 2 \| 500 \| 1\/0 \| 0\/0/);
  const json = JSON.parse(formatOutcomesJson([r]) as string) as Array<Record<string, unknown>>;
  assert.equal(json[0]!.completed, 1);
  assert.equal(json[0]!.completion_rate, "100%");
  assert.deepEqual(json[0]!.run_to_done, { completed: 1, aborted: 0 });
  assert.deepEqual(json[0]!.supervised, { completed: 0, aborted: 0 });
});
