// pi-goal-list-loop-audit — v0.38.93
// tests/recovery-status-format.test.ts
//
// Better monitoring: the shared recovery status block (widget, status
// line, /goal status) carries trajectory facts — attempts + failing-since
// answer "is it getting better or worse?", and the deterministic class is
// named when classified (a held 400 with a bare countdown reads like a
// transient that will clear). Pure formatter tests over fabricated
// recovery records.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { formatMainModelRecoveryStatus } from "../extensions/goal-loop-core.js";
import type { MainModelRecovery } from "../extensions/goal-loop-core.js";

const NOW = Date.parse("2026-09-22T12:00:00Z");

function recovery(over: Partial<MainModelRecovery> = {}): MainModelRecovery {
  return {
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 0,
    reason: "main model transient",
    kind: "goal",
    ...over,
  } as MainModelRecovery;
}

test("trajectory: attempts and failing-since render when present", () => {
  const lines = formatMainModelRecoveryStatus(
    recovery({ attempts: 5, firstFailureAt: new Date(NOW - 7 * 3_600_000).toISOString() }),
    [],
    NOW,
  );
  const row = lines.find((l) => l.includes("Attempts:"));
  assert.ok(row, `trajectory row present:\n${lines.join("\n")}`);
  assert.match(row!, /Attempts: 5 · failing 7h/, `attempts + elapsed:\n${row}`);
});

test("trajectory: absent counters render no row", () => {
  const lines = formatMainModelRecoveryStatus(recovery(), [], NOW);
  assert.ok(!lines.some((l) => l.includes("Attempts:")), "no trajectory row without counters");
});

test("cause: deterministic class is named, transients stay unlabeled", () => {
  const held = formatMainModelRecoveryStatus(
    recovery({ attempts: 9, providerErrorDiagnostic: 'BadRequestError: Image count 12 exceeds limit 4. "code":"400"' }),
    [],
    NOW,
  );
  assert.ok(
    held.some((l) => l.includes("Cause: deterministic client error")),
    `deterministic cause named:\n${held.join("\n")}`,
  );
  const transient = formatMainModelRecoveryStatus(
    recovery({ attempts: 3, providerErrorDiagnostic: "429 Too Many Requests" }),
    [],
    NOW,
  );
  assert.ok(!transient.some((l) => l.includes("Cause:")), "transient stays unlabeled");
});

test("existing rows keep their shape", () => {
  const lines = formatMainModelRecoveryStatus(
    recovery({ attempts: 2, firstFailureAt: new Date(NOW - 90 * 60_000).toISOString() }),
    [],
    NOW,
  );
  assert.ok(lines[0]!.includes("primary selected"));
  assert.ok(lines.some((l) => l.includes("Attempts: 2 · failing 1h 30m")));
});
