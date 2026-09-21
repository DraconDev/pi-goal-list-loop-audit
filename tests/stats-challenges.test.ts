// pi-goal-list-loop-audit — v0.38.80
// tests/stats-challenges.test.ts
//
// /glla stats challenges: is the falsification round worth its latency?
// Counts over every verdict in every project's final goal snapshots —
// confirmed / flipped / skipped — with the flip rate over challenged
// runs only. Skipped challenges (round 2 never ran) are unknown, not
// negative; legacy verdicts without the field are unchallenged, not
// zero. Pure rollupEntries tests mirroring stats-outcomes.test.ts.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  formatChallengesJson,
  formatChallengesTable,
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

function verdict(approved: boolean, challenge?: string): Record<string, unknown> {
  return { ...(approved ? { approved: true } : { disapproved: true }), ...(challenge ? { challenge } : {}) };
}

test("challenges: confirmed/flipped/skipped counts over all verdicts, legacy ignored", () => {
  const r = rollupEntries("proj", [
    created("g1", T0),
    snapshot("g1", T0 + H, {
      status: "active",
      auditHistory: [
        verdict(false, "not-applicable"),
        verdict(true, "confirmed"),
      ],
    }),
    archived("g1", T0 + 2 * H, "complete"),
    created("g2", T0),
    snapshot("g2", T0 + H, {
      status: "active",
      auditHistory: [
        verdict(false, "flipped"),
        verdict(true, "skipped: challenge round settled without a verdict"),
        verdict(true),
      ],
    }),
  ]).challenges;
  assert.equal(r.confirmed, 1);
  assert.equal(r.flipped, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.challenged, 2, "confirmed + flipped only — skipped never ran, legacy never recorded");
});

test("challenges: empty ledgers zero out, flip rate renders em-dash without challenged runs", () => {
  const empty = rollupEntries("proj", []).challenges;
  assert.deepEqual(empty, { challenged: 0, confirmed: 0, flipped: 0, skipped: 0 });
  const table = formatChallengesTable([rollupEntries("proj", [])]);
  assert.match(table, /—/, "no challenged runs renders unknown, not 0%");
});

test("challenges: table and JSON formats mirror the schema", () => {
  const r = rollupEntries("my-proj", [
    created("g1", T0),
    snapshot("g1", T0 + H, {
      status: "active",
      auditHistory: [verdict(true, "confirmed"), verdict(true, "confirmed"), verdict(false, "flipped")],
    }),
    archived("g1", T0 + 2 * H, "complete"),
  ]);
  const table = formatChallengesTable([r]);
  assert.match(table, /\| project \| challenged \| confirmed \| flipped \| skipped \| flip rate \|/);
  assert.match(table, /my-proj \| 3 \| 2 \| 1 \| 0 \| 33%/);
  const json = JSON.parse(formatChallengesJson([r]) as string) as Array<Record<string, unknown>>;
  assert.equal(json[0]!.challenged, 3);
  assert.equal(json[0]!.confirmed, 2);
  assert.equal(json[0]!.flipped, 1);
  assert.equal(json[0]!.skipped, 0);
  assert.equal(json[0]!.flip_rate, "33%");
});
