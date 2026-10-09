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
  const row = lines.find((l) => l.includes("Recovery steps:"));
  assert.ok(row, `trajectory row present:\n${lines.join("\n")}`);
  assert.match(row!, /Recovery steps: 5 · episode age 7h/, `attempts + elapsed:\n${row}`);
});

test("trajectory: absent counters render no row", () => {
  const lines = formatMainModelRecoveryStatus(recovery(), [], NOW);
  assert.ok(!lines.some((l) => l.includes("Recovery steps:")), "no trajectory row without counters");
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
  assert.ok(lines.some((l) => l.includes("Recovery steps: 2 · episode age 1h 30m")));
});

test('zero steps with a five-hour episode never implies observed provider attempts or continuous failure', () => {
  const lines = formatMainModelRecoveryStatus(recovery({ attempts: 0, firstFailureAt: new Date(NOW - 5 * 3_600_000).toISOString() }), [], NOW);
  assert.ok(lines.some(line => line.includes('Recovery steps: 0 · episode age 5h')));
  assert.ok(lines.some(line => line.includes('not provider requests')));
  assert.ok(lines.some(line => line.includes('does not prove continuous failure')));
  assert.ok(lines.some(line => line.includes('no saved retry deadline')));
  assert.ok(!lines.some(line => /failing 5h|retrying now|probing.*now/.test(line)));
});

test('saved deadlines are not proof of a live timer or running probe', () => {
  const episode = recovery({ retryAt: new Date(NOW - 60_000).toISOString() });
  const absent = { retryTimerArmed: false, hourlyTimerArmed: false, switchInFlight: false };
  assert.match(formatMainModelRecoveryStatus(episode, [], NOW).join('\n'), /deadline overdue; live timer\/probe unconfirmed/);
  assert.match(formatMainModelRecoveryStatus(episode, [], NOW, absent).join('\n'), /no live timer.*stalled\/unarmed/);
  assert.match(formatMainModelRecoveryStatus(episode, [], NOW, { ...absent, retryTimerArmed: true }).join('\n'), /timer armed; deadline overdue — waiting for safe dispatch/);
  assert.match(formatMainModelRecoveryStatus(episode, [], NOW, { ...absent, hourlyTimerArmed: true }).join('\n'), /hourly timer only; regular probe not armed/);
  assert.match(formatMainModelRecoveryStatus(episode, [], NOW, { ...absent, switchInFlight: true }).join('\n'), /model selection in flight \(not provider success\)/);
  for (const hold of ['supervisor pause', 'session load hold', 'session context unavailable/restoring', 'persistence degraded']) {
    const text = formatMainModelRecoveryStatus(episode, [], NOW, { ...absent, hold }).join('\n');
    assert.ok(text.includes(`held — ${hold}`));
    assert.ok(!text.includes('stalled/unarmed'));
  }
  for (const key of ['turnActive', 'turnQueued'] as const) {
    const text = formatMainModelRecoveryStatus(episode, [], NOW, { ...absent, [key]: true }).join('\n');
    assert.match(text, /host turn (active|queued); recovery success unconfirmed/);
    assert.ok(!text.includes('stalled/unarmed'));
  }
  assert.match(formatMainModelRecoveryStatus({ ...episode, manualResumeRequired: true }, [], NOW, absent).join('\n'), /Automatic probes: stopped; explicit resume required/);
  assert.match(formatMainModelRecoveryStatus(recovery({ primaryProbeInFlight: true }), [], NOW, absent).join('\n'), /stalled\/unarmed/);
});
