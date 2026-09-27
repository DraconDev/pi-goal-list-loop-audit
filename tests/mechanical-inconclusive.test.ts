// pi-goal-list-loop-audit — v0.38.103
// tests/mechanical-inconclusive.test.ts
//
// A mechanical gate the host kills (timeout/limits) is evidence of nothing
// about the product: it must classify INCONCLUSIVE and route to infra retry,
// never to a disapproval verdict. Load scaling stretches budgets (capped 2×)
// instead of killing honest slow gates at the fixed line.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS,
  containmentReason,
  loadScaledTimeoutMs,
  mechanicalPreAuditVerdict,
  runMechanicalPreAuditChecks,
  scaledMechanicalTimeoutMs,
} from "../extensions/goal-loop-shield.ts";

// ---- loadScaledTimeoutMs: pure math ----

test("loadScaledTimeoutMs: 1× at or under cpu count", () => {
  assert.equal(loadScaledTimeoutMs(600_000, 0, 16), 600_000);
  assert.equal(loadScaledTimeoutMs(600_000, 8, 16), 600_000);
  assert.equal(loadScaledTimeoutMs(600_000, 16, 16), 600_000);
});

test("loadScaledTimeoutMs: linear past cpu count, capped at 2×", () => {
  assert.equal(loadScaledTimeoutMs(600_000, 24, 16), 900_000);
  assert.equal(loadScaledTimeoutMs(600_000, 32, 16), 1_200_000);
  assert.equal(loadScaledTimeoutMs(600_000, 113, 16), 1_200_000);
  assert.equal(loadScaledTimeoutMs(100, 1000, 4), 200);
});

test("loadScaledTimeoutMs: unusable inputs degrade to base, never unbounded", () => {
  assert.equal(loadScaledTimeoutMs(600_000, NaN, 16), 600_000);
  assert.equal(loadScaledTimeoutMs(600_000, -5, 16), 600_000);
  assert.equal(loadScaledTimeoutMs(600_000, 100, 0), 1_200_000);
  // Unusable base degrades to the default BASE; live load still scales it.
  assert.equal(loadScaledTimeoutMs(NaN, 0, 16), DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS);
  assert.equal(loadScaledTimeoutMs(NaN, 100, 16), DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS * 2);
  assert.equal(loadScaledTimeoutMs(-1, 100, 16), DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS * 2);
});

test("scaledMechanicalTimeoutMs: live-load wrapper stays within [base, 2×base]", () => {
  const scaled = scaledMechanicalTimeoutMs(600_000);
  assert.ok(scaled >= 600_000 && scaled <= 1_200_000, `scaled=${scaled}`);
});

// ---- containmentReason ----

test("containmentReason: maps flags in timeout-first order", () => {
  const none = { timedOut: false, aborted: false, outputLimit: false, processGroupLimit: false };
  assert.equal(containmentReason(none), null);
  assert.equal(containmentReason({ ...none, timedOut: true }), "timeout");
  assert.equal(containmentReason({ ...none, aborted: true }), "aborted");
  assert.equal(containmentReason({ ...none, outputLimit: true }), "output-limit");
  assert.equal(containmentReason({ ...none, processGroupLimit: true }), "process-group-limit");
  assert.equal(
    containmentReason({ timedOut: true, aborted: true, outputLimit: true, processGroupLimit: true }),
    "timeout",
  );
});

// ---- mechanicalPreAuditVerdict ----

test("mechanicalPreAuditVerdict: fail keeps the historical fast-fail shape", () => {
  const v = mechanicalPreAuditVerdict({
    passed: false,
    outcome: "fail",
    failedCommand: "bun run ci:gates",
    output: "1 fail",
    exitCode: 1,
  });
  assert.equal(v.approved, false);
  assert.equal(v.disapproved, true);
  assert.equal(v.impossible, false);
  assert.equal(v.error, undefined);
  assert.ok(v.output.startsWith("<disapproved/>\n\nDeterministic Pre-Audit Fast-Fail: Mechanical contract check failed: `bun run ci:gates` (exit code 1)"));
  assert.ok(v.output.includes("1 fail"));
});

test("mechanicalPreAuditVerdict: inconclusive becomes infra error, never disapproval", () => {
  const v = mechanicalPreAuditVerdict({
    passed: false,
    outcome: "inconclusive",
    inconclusiveReason: "timeout",
    failedCommand: "bun run ci:gates",
    output: "[mechanical check killed after 600s — process tree terminated; output tail below]",
  });
  assert.equal(v.approved, false);
  assert.equal(v.disapproved, false);
  assert.equal(v.impossible, false);
  assert.ok(v.error?.includes("timeout"), `error=${v.error}`);
  assert.ok(v.error?.includes("bun run ci:gates"), `error=${v.error}`);
  assert.ok(v.error?.includes("not a verdict"), `error=${v.error}`);
  assert.ok(!v.output.includes("<disapproved/>"), "must not carry a disapproval verdict line");
});

// ---- runMechanicalPreAuditChecks: live classification ----

test("mechanical run: green command passes", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --version"], 30_000, undefined, 256, { loadScale: false });
  assert.equal(res.passed, true);
  assert.equal(res.outcome, "pass");
});

test("mechanical run: red command fails (not inconclusive)", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --definitely-not-a-real-option"], 30_000, undefined, 256, { loadScale: false });
  assert.equal(res.passed, false);
  assert.equal(res.outcome, "fail");
  assert.equal(res.inconclusiveReason, undefined);
});

test("mechanical run: unsafe syntax fails (not inconclusive)", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --version; printf boom"], 30_000, undefined, 256, { loadScale: false });
  assert.equal(res.passed, false);
  assert.equal(res.outcome, "fail");
});

test("mechanical run: killed gate is inconclusive with reason", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["sleep 30"], 100, undefined, 256, { loadScale: false });
  assert.equal(res.passed, false);
  assert.equal(res.outcome, "inconclusive");
  assert.equal(res.inconclusiveReason, "timeout");
  assert.ok(res.output?.includes("killed after"), `output=${res.output?.slice(0, 120)}`);
});

test("mechanical run: empty command list passes", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), []);
  assert.equal(res.passed, true);
  assert.equal(res.outcome, "pass");
});
