// pi-goal-list-loop-audit — v0.3.0
// tests/loop-forever.test.ts
//
// Unit tests for loop 3 core: metric parsing, improvement comparison,
// plateau/termination logic, and /loop start arg parsing.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMeasurement,
  applyMetriclessTick,
  applyRefinement,
  isImprovement,
  loopBranchName,
  parseLoopStartArgs,
  parseMetric,
  resolveSpecFile,
  resolveSpecFiles,
  respecTarget,
  auditMeasureCmd,
  auditTarget,
  countOpenAuditFindings,
  topOpenAuditFinding,
  parseAuditFindingsForFanout,
  AUDIT_FINDINGS_REL,
  HELD_ON_RESTORE,
  isLifecycleHeldLoopReason,
  type LoopState,
} from "../extensions/goal-loop-forever.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const LOOP_RUNTIME = readFileSync("extensions/goal-loop.ts", "utf8");
const TOOLS_RUNTIME = readFileSync("extensions/loops/goal-tools.ts", "utf8");

function freshLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    target: "reduce failures",
    measureCmd: "grep -c FAIL report.txt",
    direction: "min",
    iteration: 0,
    maxIterations: 10,
    plateauWindow: 3,
    stallCount: 0,
    bestValue: null,
    lastValue: null,
    active: true,
    history: [],
    startedAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

test("isLifecycleHeldLoopReason separates recoverable lifecycle holds from deliberate/safety stops", () => {
  assert.equal(isLifecycleHeldLoopReason(HELD_ON_RESTORE), true);
  assert.equal(isLifecycleHeldLoopReason("extension api stale: host replacement"), true);
  assert.equal(isLifecycleHeldLoopReason("stalled: continuation refires landed no turn — the session is not continuing"), true);
  assert.equal(isLifecycleHeldLoopReason("stalled: continuation start acknowledgement timed out (dispatch-1) — /loop resume to retry explicitly"), true);
  assert.equal(isLifecycleHeldLoopReason("stalled: 3 consecutive unproductive turns (no tools, short or repetitive)"), false);
  assert.equal(isLifecycleHeldLoopReason("send-retry storm: no turn"), true);
  assert.equal(isLifecycleHeldLoopReason("stopped by user (/loop stop)"), false);
  assert.equal(isLifecycleHeldLoopReason("stopped by user — 3 consecutive aborts"), false);
  assert.equal(isLifecycleHeldLoopReason("provider errors — quota"), false);
  assert.equal(isLifecycleHeldLoopReason("plateau — no improvement"), false);
  assert.equal(isLifecycleHeldLoopReason("stuck — repeated output"), false);
});

// ---- parseMetric ----

test("parseMetric: plain integer", () => {
  assert.equal(parseMetric("42"), 42);
});

test("parseMetric: number inside text", () => {
  assert.equal(parseMetric("score: 3.75 points"), 3.75);
});

test("parseMetric: negative + scientific", () => {
  assert.equal(parseMetric("-12"), -12);
  assert.equal(parseMetric("1.5e3"), 1500);
});

test("parseMetric: no number → null (broken measure is a stall, not a crash)", () => {
  assert.equal(parseMetric("no output"), null);
  assert.equal(parseMetric(""), null);
});

test("parseMetric: takes the FIRST number", () => {
  assert.equal(parseMetric("7 passed, 2 failed"), 7);
});

// ---- isImprovement ----

test("isImprovement: first value is always baseline", () => {
  assert.equal(isImprovement("min", 100, null), true);
  assert.equal(isImprovement("max", 100, null), true);
});

test("isImprovement: min direction", () => {
  assert.equal(isImprovement("min", 5, 10), true);
  assert.equal(isImprovement("min", 10, 10), false);
  assert.equal(isImprovement("min", 15, 10), false);
});

test("isImprovement: max direction", () => {
  assert.equal(isImprovement("max", 15, 10), true);
  assert.equal(isImprovement("max", 10, 10), false);
  assert.equal(isImprovement("max", 5, 10), false);
});

// ---- applyMeasurement ----

test("v0.29.10 — applyMeasurement: null best (deferred audit baseline) seeds on first real measurement", () => {
  // The audit loop's pre-discovery baseline is degenerate (0 open findings
  // just means findings.md doesn't exist yet). With best pinned at 0 no
  // iteration could ever improve — junk-runner/hegemon 2026-07-30 stalled
  // on real progress and the prompt cried REGRESSED. deferBaseline leaves
  // bestValue null; the first REAL measurement becomes the baseline.
  const loop = freshLoop({ bestValue: null, lastValue: null, kind: "audit" });
  let out = applyMeasurement(loop, 23, "t1"); // discovery iteration
  assert.equal(out.kind, "continue");
  if (out.kind === "continue") assert.equal(out.improved, true); // null best = baseline, always "improved"
  assert.equal(loop.bestValue, 23);
  assert.equal(loop.stallCount, 0); // discovery is NOT a stall
  out = applyMeasurement(loop, 20, "t2"); // fixing iteration — real improvement
  if (out.kind === "continue") assert.equal(out.improved, true);
  assert.equal(loop.bestValue, 20);
  out = applyMeasurement(loop, 20, "t3"); // flat — now an honest stall
  if (out.kind === "continue") assert.equal(out.improved, false);
  assert.equal(loop.stallCount, 1);
  out = applyMeasurement(loop, 0, "t4"); // well dry — 0 IS an improvement once best is real
  if (out.kind === "continue") assert.equal(out.improved, true);
  assert.equal(loop.bestValue, 0);
});

// v0.35.39 (audit finding on commit 28131527): the audit-kind exemption in
// applyMeasurement — flats count from iteration 1, and the never-moved stop
// never fires for kind:"audit" — previously shipped with ZERO regression
// pin. These twin-loop tests fail if either guard is deleted. Both twins
// carry one prior flat history entry so the non-audit baseline-grace
// comparison (bestValue vs first numeric reading) is in play.
test("v0.35.31 exemption pin — audit flats count toward plateau from the start; non-audit pre-movement flats stay free", () => {
  const seed = [{ iteration: 1, value: 5, improved: false, at: "t0" }];
  // Non-audit twin: a flat reading before the metric ever moved is NOT a
  // stall (the baseline-forming grace).
  const plain = freshLoop({ direction: "max", bestValue: 5, lastValue: 5, maxIterations: 0, history: [...seed] });
  let out = applyMeasurement(plain, 5, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(plain.stallCount, 0, "non-audit: flat before any movement burns no plateau slots");
  // Audit twin, identical shape: legacy accounting — EVERY flat counts.
  const audit = freshLoop({ kind: "audit", direction: "max", bestValue: 5, lastValue: 5, maxIterations: 0, history: [...seed] });
  out = applyMeasurement(audit, 5, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(audit.stallCount, 1, "audit: the same flat IS a stall (verbatim legacy behavior)");
  out = applyMeasurement(audit, 5, "t2");
  out = applyMeasurement(audit, 5, "t3");
  assert.equal(out.kind, "stop");
  if (out.kind === "stop") assert.match(out.reason, /plateau/);
});

test("v0.35.31 exemption pin — an audit loop never gets the 'metric never moved' stop", () => {
  const seed = [{ iteration: 1, value: 5, improved: false, at: "t0" }];
  // Non-audit twin: a never-moving metric gets the loud dedicated stop.
  const plain = freshLoop({ direction: "max", bestValue: 5, lastValue: 5, maxIterations: 0, history: [...seed] });
  let out = applyMeasurement(plain, 5, "t1")!;
  for (let i = 2; i <= 8 && out.kind !== "stop"; i++) out = applyMeasurement(plain, 5, `t${i}`)!;
  assert.equal(out.kind, "stop");
  if (out.kind === "stop") assert.match(out.reason, /metric never moved/);
  // Audit twin, same dead metric: the never-moved stop must NEVER fire —
  // its deferred-baseline + reprieve plateau semantics own the ending.
  const audit = freshLoop({ kind: "audit", direction: "max", bestValue: 5, lastValue: 5, maxIterations: 0, history: [...seed] });
  let lastStop: string | null = null;
  for (let i = 1; i <= 8; i++) {
    const r = applyMeasurement(audit, 5, `t${i}`);
    if (r.kind === "stop") lastStop = r.reason;
  }
  assert.ok(lastStop !== null, "the audit loop still ends (plateau, not forever)");
  // The LAST stop matters: applyMeasurement keeps re-evaluating after a
  // stop, so deleting the kind guard would let a later 'metric never
  // moved' evaluation OVERWRITE the honest plateau verdict.
  assert.doesNotMatch(lastStop ?? "", /metric never moved/, "the dedicated never-moved stop stays audit-exempt (final verdict included)");
  assert.match(lastStop ?? "", /plateau/);
  // The never-moved guard itself is unreachable-by-construction for audits
  // (their stalls accrue from iteration 1, so plateau at `window` always
  // returns before the 2×window never-moved check is reached) — no purely
  // behavioral test can distinguish its deletion. Pin the guard in source,
  // matching DESIGN.md's promise that audit stall accounting stays verbatim.
  const foreverSrc = readFileSync(new URL("../extensions/goal-loop-forever.ts", import.meta.url), "utf-8");
  assert.match(foreverSrc, /if \(loop\.kind !== "audit"\) \{\s*\n\s*const numericHistory[\s\S]*?metric never moved/,
    "the never-moved stop stays wrapped in the kind !== audit guard");
});

test("v0.29.10 — audit loop source pins: deferred baseline, true-regression note, live-loop reseed migration", () => {
  const src = readFileSync(new URL("../extensions/goal-loop.ts", import.meta.url), "utf-8");
  const goalSrc = readGoalRuntimeSource();
  // The /loop audit route defers the baseline and tags the loop kind.
  assert.ok(src.includes("deferBaseline: true,"), "audit route defers the baseline");
  assert.ok(src.includes('kind: "audit",'), "audit route tags the loop kind");
  // startLoopFromConfig honours the flag (no baseline measure, null best).
  assert.ok(src.includes("metricless || cfg.deferBaseline ? null : await runMeasure"), "deferred baseline skips the start measure");
  assert.ok(src.includes("bestValue: cfg.deferBaseline ? null : baseline,"), "deferred baseline seeds null best");
  assert.ok(src.includes("deferred — the first real measurement seeds it"), "banner names the deferred baseline");
  // The regression note fires only on a TRUE regression (last two
  // measurements moved the wrong way) — never on a mere stall.
  assert.ok(src.includes("trueRegression"), "true-regression detection present");
  assert.ok(!src.includes("regressedLast"), "old any-stall-is-regression trigger gone");
  assert.ok(
    src.includes("The closed-findings count went DOWN last iteration — a checked finding was reopened or findings.md was rewritten (both forbidden)"),
    "audit loops get audit-flavoured regression wording (v0.29.14: closed-count/max semantics)",
  );
  // v0.29.14: live loops on the open-count/min metric migrate to
  // closed-count/max on session load (supersedes the baseline-0 reseed).
  assert.ok(goalSrc.includes("audit_loop_metric_migrated"), "migration ledgers the metric flip");
  assert.ok(goalSrc.includes('from: "open-count/min", to: "closed-count/max"'), "migration names both metrics");
  assert.ok(!goalSrc.includes("audit_loop_baseline_reseeded"), "v0.29.10 reseed superseded");
});


test("applyMeasurement: improvement resets stall, records best", () => {
  const loop = freshLoop();
  let out = applyMeasurement(loop, 10, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.bestValue, 10);
  out = applyMeasurement(loop, 7, "t2");
  assert.equal(out.kind, "continue");
  assert.equal(loop.bestValue, 7);
  assert.equal(loop.stallCount, 0);
  assert.equal(loop.iteration, 2);
});

test("applyMeasurement: non-improvement increments stall", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, 8, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.bestValue, 5); // best unchanged
  assert.equal(loop.stallCount, 1);
});

test("applyMeasurement: broken measure (null) is NOT a stall — tracked separately (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, null, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.stallCount, 0, "a null says nothing about improvement — plateau stays reserved for real numbers");
  assert.equal(loop.consecutiveNullMeasures, 1);
  assert.equal(loop.lastValue, null);
});

test("applyMeasurement: a numeric value resets the null streak (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, consecutiveNullMeasures: 2 });
  applyMeasurement(loop, 3, "t1"); // improves (min direction)
  assert.equal(loop.consecutiveNullMeasures, 0);
});

test("applyMeasurement: plateauWindow consecutive nulls stop with 'measure command broken', NOT plateau (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, plateauWindow: 3 });
  applyMeasurement(loop, null, "t1");
  applyMeasurement(loop, null, "t2");
  const out = applyMeasurement(loop, null, "t3");
  assert.equal(out.kind, "stop");
  assert.equal(loop.active, false);
  assert.match(loop.stopReason!, /measure command broken/);
  assert.match(loop.stopReason!, /3 consecutive iterations printed no number/);
  assert.doesNotMatch(loop.stopReason!, /plateau/);
});

test("applyMeasurement: an interleaved null does not move the real stall count (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, stallCount: 1, plateauWindow: 3 });
  applyMeasurement(loop, null, "t1"); // null — stall stays 1
  assert.equal(loop.stallCount, 1);
  applyMeasurement(loop, 9, "t2"); // real non-improvement — stall 2
  assert.equal(loop.stallCount, 2);
  const out = applyMeasurement(loop, 8, "t3"); // real non-improvement — stall 3 → plateau
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /plateau/);
});

test("applyMeasurement: plateau stops the loop", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 3, stallCount: 2, plateauWindow: 3 });
  const out = applyMeasurement(loop, 9, "t1");
  assert.equal(out.kind, "stop");
  assert.equal(loop.active, false);
  assert.match(loop.stopReason!, /plateau/);
});

// v0.35.31 (field: doomtap 2026-08-22, Screenshot_20260822_094423): a
// min-direction loop whose metric reads 0 before work exists (open findings
// at survey start) locked best at 0; the productive readings that followed
// (12 → 7 findings being worked down) all scored "flat" and burned five
// plateau slots → false stop while iterations were visibly fixing work.
test("v0.35.31 — a never-moved zero baseline does not false-plateau a working min loop", () => {
  const loop = freshLoop({ bestValue: 0, iteration: 0, stallCount: 0, plateauWindow: 5 });
  for (const [i, v] of [0, 0, 0, 12, 7, 7].entries()) {
    const out = applyMeasurement(loop, v, `t${i + 1}`);
    assert.equal(out.kind, "continue", `iteration ${i + 1} must not stop — baseline still forming`);
  }
  // The very first reading rides the conservative legacy path (an empty run
  // history cannot prove the baseline is degenerate), so at most ONE stall
  // tick accrues — never the five the old rule burned. The plateau window
  // can therefore not fire on this shape.
  assert.ok(loop.stallCount <= 1, `stall stays marginal (got ${loop.stallCount})`);
});

test("v0.35.31 — the never-moved grace is bounded by a loud distinct stop", () => {
  const loop = freshLoop({ bestValue: 0, iteration: 0, stallCount: 0, plateauWindow: 3 });
  let out: ReturnType<typeof applyMeasurement> = { kind: "continue", improved: false, value: 0 };
  for (let i = 0; i < 6 && out.kind === "continue"; i++) out = applyMeasurement(loop, 0, `t${i}`);
  assert.equal(out.kind, "stop");
  assert.match(out.reason, /metric never moved/);
  assert.doesNotMatch(out.reason, /plateau —/, "the old misleading reason is gone for this class");
});

test("v0.35.31 — a resumed run whose best differs from its first reading still plateaus honestly", () => {
  // History restarted but bestValue was carried from real prior movement:
  // flat readings count again (regression protection preserved).
  const loop = freshLoop({ bestValue: 5, iteration: 0, stallCount: 2, plateauWindow: 3 });
  const out = applyMeasurement(loop, 9, "t1"); // 9 > best 5 under min → flat, counts
  assert.equal(out.kind, "stop");
  assert.match(out.reason, /plateau/);
});

test("applyMeasurement: max iterations stops the loop", () => {
  const loop = freshLoop({ iteration: 9, maxIterations: 10, bestValue: 3, stallCount: 0 });
  const out = applyMeasurement(loop, 2, "t1"); // improving, but cap hit
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /max iterations/);
});

test("applyMeasurement: plateau wins over cap when both hit", () => {
  const loop = freshLoop({ iteration: 9, maxIterations: 10, stallCount: 4, plateauWindow: 5, bestValue: 1 });
  const out = applyMeasurement(loop, 5, "t1");
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /plateau/);
});

test("applyMeasurement: history is capped at 200", () => {
  const loop = freshLoop({ history: new Array(200).fill({ iteration: 0, value: 1, improved: true, at: "x" }) });
  applyMeasurement(loop, 1, "t1");
  assert.equal(loop.history.length, 200);
});

// ---- parseLoopStartArgs ----

test("parseLoopStartArgs: full form", () => {
  const cfg = parseLoopStartArgs('"reduce TODOs" measure="grep -c TODO src.txt" direction=min window=3 max=20');
  assert.equal(cfg.target, "reduce TODOs");
  assert.equal(cfg.measureCmd, "grep -c TODO src.txt");
  assert.equal(cfg.direction, "min");
  assert.equal(cfg.plateauWindow, 3);
  assert.equal(cfg.maxIterations, 20);
});

test("parseLoopStartArgs: defaults for window and max", () => {
  const cfg = parseLoopStartArgs('grow coverage measure="cat cov.txt" direction=max');
  assert.equal(cfg.plateauWindow, 5);
  assert.equal(cfg.maxIterations, 50);
});

test("parseLoopStartArgs: unquoted target works", () => {
  const cfg = parseLoopStartArgs('reduce the number in num.txt measure="cat num.txt" direction=min');
  assert.equal(cfg.target, "reduce the number in num.txt");
});

test("parseLoopStartArgs: bare start (no measure=) is the infinite metricless form (v0.23.6)", () => {
  const cfg = parseLoopStartArgs('"keep polishing the UI"');
  assert.equal(cfg.target, "keep polishing the UI");
  assert.equal(cfg.measureCmd, "");
  assert.equal(cfg.direction, undefined);
  assert.equal(cfg.maxIterations, 0); // unbounded — ends at time=/tokens= or /loop stop
});

test("parseLoopStartArgs: direction= without a measure throws", () => {
  assert.throws(() => parseLoopStartArgs('"x" direction=min'), /meaningless without a metric/);
});

test("parseLoopStartArgs: missing direction throws", () => {
  assert.throws(() => parseLoopStartArgs('target measure="cat x"'), /direction/);
});

test("parseLoopStartArgs: missing target throws", () => {
  assert.throws(() => parseLoopStartArgs('measure="cat x" direction=min'), /target/);
});

test("parseLoopStartArgs: measure with pipes/quotes survives", () => {
  const cfg = parseLoopStartArgs('t measure="grep -c x f.txt | head -1" direction=max');
  assert.equal(cfg.measureCmd, "grep -c x f.txt | head -1");
});

test("parseLoopStartArgs: branch flag off by default", () => {
  const cfg = parseLoopStartArgs('t measure="cat x" direction=min');
  assert.equal(cfg.branch, false);
});

test("parseLoopStartArgs: branch=1 / branch=true enable branch mode", () => {
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min branch=1').branch, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min branch=true').branch, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min branch=0').branch, false);
});

test("applyMeasurement: time bound stops when elapsed hours exceeded", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, timeLimitHours: 2, startedAt: "2026-07-21T00:00:00.000Z" });
  const out = applyMeasurement(loop, 4, "2026-07-21T03:00:00.000Z"); // 3h elapsed > 2h bound
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /time bound reached \(2h\)/);
  assert.equal(loop.active, false);
});

test("applyMeasurement: time bound does not stop before the limit", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, timeLimitHours: 2, startedAt: "2026-07-21T00:00:00.000Z" });
  const out = applyMeasurement(loop, 4, "2026-07-21T01:00:00.000Z");
  assert.equal(out.kind, "continue");
});

test("applyMeasurement: token budget stops when exhausted", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, tokenBudget: 1000, tokensUsed: 1200 });
  const out = applyMeasurement(loop, 4, "2026-07-21T00:00:00.000Z");
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /token budget exhausted/);
});

test("applyMeasurement: no bound = process never 'completes' (v0.15.0)", () => {
  // Even a perfect metric value does not stop the loop — there is no done=.
  const loop = freshLoop({ direction: "min", bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, 0, "2026-07-21T00:00:00.000Z");
  assert.equal(out.kind, "continue");
  assert.equal(loop.active, true);
});

test("parseLoopStartArgs: done= throws a teaching error (v0.15.0)", () => {
  assert.throws(
    () => parseLoopStartArgs('t measure="cat x" direction=min done=0'),
    /done= was removed.*GOAL/i,
  );
});

test("parseLoopStartArgs: time=, tokens=, and cadence= parse as bounded controls", () => {
  const cfg = parseLoopStartArgs('t measure="cat x" direction=min time=2.5 tokens=500000 cadence=90');
  assert.equal(cfg.timeLimitHours, 2.5);
  assert.equal(cfg.tokenBudget, 500000);
  assert.equal(cfg.minimumIterationIntervalMs, 90_000);
  const capped = parseLoopStartArgs('t cadence=999999');
  assert.equal(capped.minimumIterationIntervalMs, 24 * 60 * 60_000);
  const badCadence = parseLoopStartArgs('t cadence=0');
  assert.equal(badCadence.minimumIterationIntervalMs, undefined);
  const bare = parseLoopStartArgs('t measure="cat x" direction=min');
  assert.equal(bare.timeLimitHours, undefined);
  assert.equal(bare.tokenBudget, undefined);
  const bad = parseLoopStartArgs('t measure="cat x" direction=min time=0 tokens=-5');
  assert.equal(bad.timeLimitHours, undefined);
  assert.equal(bad.tokenBudget, undefined);
});

test("parseLoopStartArgs: force flag off by default, on with 1/true", () => {
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min').force, false);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=1').force, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=true').force, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=0').force, false);
});

// ---- loopBranchName ----

test("loopBranchName: format is pi-glla-loop/<timestamp>-<slug>", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "Reduce TODO count");
  assert.match(name, /^pi-glla-loop\/\d{14}-reduce-todo-count$/);
});

test("loopBranchName: empty slug falls back to 'loop'", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "!!!");
  assert.match(name, /^pi-glla-loop\/\d{14}-loop$/);
});

test("loopBranchName: slug is capped at 30 chars", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "a very long target description that goes on and on and on");
  const slug = name.split("-")[0] ? name.slice(name.indexOf("/") + 16) : "";
  assert.ok(slug.length <= 30, `slug too long: ${slug}`);
});

test("applyRefinement: target-only change keeps baseline and stall state", () => {
  const loop = freshLoop({ bestValue: 3, lastValue: 4, stallCount: 1, iteration: 7 });
  applyRefinement(loop, {
    at: "2026-07-21T01:00:00.000Z", iteration: 7,
    oldTarget: "reduce warnings", newTarget: "reduce eslint warnings in src/",
    oldMeasureCmd: "m1", newMeasureCmd: "m1",
  }, null);
  assert.equal(loop.target, "reduce eslint warnings in src/");
  assert.equal(loop.bestValue, 3);
  assert.equal(loop.stallCount, 1);
  assert.equal(loop.refinements!.length, 1);
});

test("applyRefinement: measure change re-baselines and resets stall", () => {
  const loop = freshLoop({ bestValue: 3, lastValue: 4, stallCount: 2, iteration: 7 });
  applyRefinement(loop, {
    at: "2026-07-21T01:00:00.000Z", iteration: 7,
    oldTarget: "t", newTarget: "t",
    oldMeasureCmd: "m1", newMeasureCmd: "m2",
  }, 42);
  assert.equal(loop.measureCmd, "m2");
  assert.equal(loop.bestValue, 42);
  assert.equal(loop.lastValue, 42);
  assert.equal(loop.stallCount, 0);
  assert.equal(loop.refinements!.length, 1);
});

// ---- v0.23.0: metricless spec loops (measure=none) ----

function freshMetriclessLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    target: "keep improving SPEC.md",
    iteration: 0,
    maxIterations: 10,
    plateauWindow: 3,
    stallCount: 0,
    bestValue: null,
    lastValue: null,
    active: true,
    history: [],
    startedAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

test("parseLoopStartArgs: measure=none yields a metricless config", () => {
  const cfg = parseLoopStartArgs('"keep improving SPEC.md" measure=none');
  assert.equal(cfg.target, "keep improving SPEC.md");
  assert.equal(cfg.measureCmd, "");
  assert.equal(cfg.direction, undefined);
  assert.equal(cfg.maxIterations, 0); // v0.23.6: metricless + no explicit max = unbounded
});

test("parseLoopStartArgs: measure=NONE is case-insensitive", () => {
  const cfg = parseLoopStartArgs('"work the spec" measure=NONE max=5');
  assert.equal(cfg.measureCmd, "");
  assert.equal(cfg.maxIterations, 5);
});

test("parseLoopStartArgs: direction with measure=none throws", () => {
  assert.throws(() => parseLoopStartArgs('"x" measure=none direction=min'), /direction= is meaningless/);
});

test("parseLoopStartArgs: explicit max= caps even a metricless loop", () => {
  const cfg = parseLoopStartArgs('"x" measure=none max=50');
  assert.equal(cfg.maxIterations, 50);
});

test("parseLoopStartArgs: max=0 = truly unbounded; absent max = 50", () => {
  assert.equal(parseLoopStartArgs('"x" measure="echo 1" direction=min max=0').maxIterations, 0);
  assert.equal(parseLoopStartArgs('"x" measure="echo 1" direction=min').maxIterations, 50);
});

test("applyMetriclessTick: iterates without plateau and never improves", () => {
  const loop = freshMetriclessLoop({ maxIterations: 0 });
  for (let i = 0; i < 20; i++) {
    const outcome = applyMetriclessTick(loop, "2026-07-20T01:00:00Z");
    assert.equal(outcome.kind, "continue");
    if (outcome.kind === "continue") assert.equal(outcome.improved, false);
  }
  assert.equal(loop.iteration, 20);
  assert.equal(loop.stallCount, 0); // no numbers, no stalls — plateau can never fire
  assert.equal(loop.active, true); // max=0 = unbounded: still going past 20
});

test("applyMetriclessTick: max iterations still stops the loop", () => {
  const loop = freshMetriclessLoop({ maxIterations: 3 });
  applyMetriclessTick(loop, "2026-07-20T01:00:00Z");
  applyMetriclessTick(loop, "2026-07-20T01:01:00Z");
  const outcome = applyMetriclessTick(loop, "2026-07-20T01:02:00Z");
  assert.equal(outcome.kind, "stop");
  assert.match(outcome.kind === "stop" ? outcome.reason : "", /max iterations reached \(3\)/);
  assert.equal(loop.active, false);
});

test("applyMetriclessTick: time and token bounds still stop the loop", () => {
  const byTime = freshMetriclessLoop({ maxIterations: 0, timeLimitHours: 1 });
  const t = applyMetriclessTick(byTime, "2026-07-20T02:00:00Z"); // 2h after start
  assert.equal(t.kind, "stop");
  assert.match(t.kind === "stop" ? t.reason : "", /time bound/);
  const byTokens = freshMetriclessLoop({ maxIterations: 0, tokenBudget: 1000, tokensUsed: 1500 });
  const tk = applyMetriclessTick(byTokens, "2026-07-20T00:30:00Z");
  assert.equal(tk.kind, "stop");
  assert.match(tk.kind === "stop" ? tk.reason : "", /token budget/);
});

test("v0.35.72: all loop measure entry points are bounded and reject failed numeric output", () => {
  const runMeasure = LOOP_RUNTIME.slice(LOOP_RUNTIME.indexOf("async function runMeasure"), LOOP_RUNTIME.indexOf("function loopPrompt"));
  assert.match(runMeasure, /const code = typeof r\?\.code === "number" \? r\.code : \(typeof r\?\.exitCode === "number" \? r\.exitCode : 0\)/);
  assert.match(runMeasure, /if \(code !== 0\) return null/);
  assert.match(runMeasure, /timeout: MEASURE_TIMEOUT_MS/);

  assert.match(TOOLS_RUNTIME, /async function probeLoopMeasure\(/);
  assert.match(TOOLS_RUNTIME, /extensionApi\?\.exec\("bash", \["-c", command\], \{ cwd: ctx\.cwd, timeout: MEASURE_TIMEOUT_MS \}\)/);
  assert.match(TOOLS_RUNTIME, /if \(code !== 0\)/);
  const tools = TOOLS_RUNTIME.slice(TOOLS_RUNTIME.indexOf('name: "propose_loop_draft"'), TOOLS_RUNTIME.indexOf('name: "list_add"'));
  assert.match(tools, /probeLoopMeasure\(liveCtx, p\.measureCmd!\)/);
  assert.match(tools, /probeLoopMeasure\(liveCtx, newMeasure\)/);
});

test("applyMeasurement: max=0 = no iteration cap for measured loops either", () => {
  const loop = freshLoop({ maxIterations: 0, plateauWindow: 100 });
  for (let i = 0; i < 15; i++) {
    const outcome = applyMeasurement(loop, 5, "2026-07-20T01:00:00Z");
    assert.equal(outcome.kind, "continue");
  }
  assert.equal(loop.active, true);
});

// ---- /loop respec (v0.24.3) ----

test("resolveSpecFile: finds SPEC.md in root, prefers it over spec.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "respec-"));
  try {
    writeFileSync(join(dir, "SPEC.md"), "# Spec\n");
    writeFileSync(join(dir, "spec.md"), "# other\n");
    assert.equal(resolveSpecFile(dir), join(dir, "SPEC.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpecFile: spec.md fallback; null when absent; root only (no subdir crawl)", () => {
  const dir = mkdtempSync(join(tmpdir(), "respec-"));
  try {
    assert.equal(resolveSpecFile(dir), null);
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "SPEC.md"), "# nested\n");
    assert.equal(resolveSpecFile(dir), null, "subdirectories are never searched");
    writeFileSync(join(dir, "spec.md"), "# Spec\n");
    assert.equal(resolveSpecFile(dir), join(dir, "spec.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("respecTarget: names the spec, reads critically, rotates implement/audit", () => {
  const t = respecTarget("SPEC.md");
  assert.ok(t.includes("SPEC.md"), "names the resolved spec file");
  assert.ok(/critically/.test(t), "spec-suck protection: read critically");
  assert.ok(/never force the code to match a bad spec/.test(t), "bad-spec escape");
  assert.ok(/one iteration implements/.test(t) && /the next audits/.test(t), "implement/audit rotation");
});

test("resolveSpecFiles: returns all root specs in priority order (v0.24.4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "respec-"));
  try {
    assert.deepEqual(resolveSpecFiles(dir), []);
    writeFileSync(join(dir, "spec.md"), "# a\n");
    assert.deepEqual(resolveSpecFiles(dir), [join(dir, "spec.md")]);
    writeFileSync(join(dir, "SPEC.md"), "# b\n");
    assert.deepEqual(resolveSpecFiles(dir), [join(dir, "SPEC.md"), join(dir, "spec.md")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.25.1: toolsamerepeat= kwarg (stuck-detection rework item 8) ----

test("parseLoopStartArgs: toolsamerepeat=N parses; 0 disables the legacy check", () => {
  const a = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min toolsamerepeat=0');
  assert.equal(a.toolSameRepeat, 0);
  const b = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min toolsamerepeat=7');
  assert.equal(b.toolSameRepeat, 7);
  // Absent = default (undefined → REPETITION.toolResultRepeat downstream):
  const c = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min');
  assert.equal(c.toolSameRepeat, undefined);
  // Non-numeric garbage degrades to default, never throws:
  const d = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min toolsamerepeat=abc');
  assert.equal(d.toolSameRepeat, undefined);
});

test("v0.29.0: /loop audit — metric loop over open findings; plateau = the well is dry", () => {
  // User design (2026-07-29): "the looper running audits to see where to
  // progress and what to fix" — the thing that fires at the end of goals
  // and lists. Unlike respec (metricless) this has an HONEST metric: the
  // orchestrator counts open findings, so the plateau stop terminates it.
  const SRC = readFileSync("extensions/goal-loop.ts", "utf-8");
  const GOAL = readGoalRuntimeSource();
  assert.match(SRC, /if \(sub === "audit"\) \{/);
  assert.match(SRC, /target: auditTarget\(ctx\.cwd\),\s*\n\s*measureCmd: auditMeasureCmd\(ctx\.cwd\),\s*\n\s*direction: "max",/);
  // v0.35.0: no stacking over an active goal or loop is silent; the shared
  // activation path offers update / replace / cancel after the loop spec is
  // confirmed.
  assert.match(SRC, /resolveLoopStartConflict\(ctx, cfg\.target\)/);
  assert.match(SRC, /chooseObjectiveConflict/);
  // drain suggestion (suggestion, not auto-start — consent per v0.28.28):
  assert.match(GOAL, /List complete\. \/loop audit to sweep the project for the next batch of work\./);
  // the measure is orchestrator-counted and single-number in all file states:
  const F = readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.match(F, /export const AUDIT_FINDINGS_REL = "\.pi-glla\/audit-loop\/findings\.md";/);
  assert.match(F, /export function auditMeasureCmd\(cwd = process\.cwd\(\)\): string/);
  assert.match(F, /export function auditTarget\(cwd = process\.cwd\(\)\): string/);
  const measureCmd = auditMeasureCmd();
  assert.ok(measureCmd.includes("grep -cE '^[[:space:]]*- \\[[xX]\\] FIX' .pi-glla/audit-loop/findings.md"), measureCmd);
  assert.ok(measureCmd.includes("echo ${c:-0}"), measureCmd);
  // the target carries the honesty laws:
  const t = auditTarget();
  assert.match(t, /Append every NEW finding as one checkbox line/);
  assert.match(t, /never delete, rewrite, or reorder existing lines/);
  assert.match(t, /never fabricate findings to look busy/);
  assert.match(t, /never mark a finding fixed without the fix commit existing/);
  assert.match(t, /plateau stop ends the loop when the well is dry/);
  // v0.29.18: FIX-FIRST — the backlog drains before new hunting (hegemon
  // iter 26: discovery 8-12/iter vs fixes 1/iter + "no new action" turns
  // with 18 open boxes). Fix is step 1; re-audit runs on cadence only;
  // a zero-closure iteration with open boxes is explicitly unacceptable.
  assert.match(t, /FIX-FIRST: the open backlog comes down before new hunting/);
  assert.match(t, /Every iteration: \(1\) FIX the highest-severity OPEN finding/);
  assert.match(t, /RE-AUDIT on cadence, not every iteration/);
  assert.match(t, /ONLY when no OPEN findings remain, when roughly ten iterations have passed/);
  assert.match(t, /"no new action this turn" is never an acceptable iteration while open boxes exist/);
  // the old audit-every-iteration template is gone:
  assert.ok(!t.includes("Every iteration: (1) run a FRESH audit pass"), "old template superseded");
  // live-loop migration pins (goal.ts — session-load path stays there):
  assert.match(GOAL, /audit_loop_target_migrated/);
  assert.match(GOAL, /state\.loop\?\.kind === "audit" && state\.loop\.target\?\.includes\("Every iteration: \(1\) run a FRESH audit pass"\)/);
  // reviewer: fire-audit-on-clean is OPT-IN, not default (the auditor already
  // verified the work — a reflexive re-scan pays for verification twice):
  const R = readFileSync("extensions/reviewer.ts", "utf-8");
  const defaultIdx = R.indexOf("export const DEFAULT_REVIEWER_CONFIG");
  const defaultBlock = R.slice(defaultIdx, defaultIdx + 900);
  assert.match(defaultBlock, /cascade: \["convert-findings-to-list", "queue-leftovers", "notify-and-idle"\]/);
  assert.doesNotMatch(defaultBlock, /fire-audit-on-clean/);
});

// ---- v0.35.4: findings-file counting + parse regression ----

test("v0.35.4: auditMeasureCmd counts closed FIX findings only (DECIDED/DEFERRED excluded)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "glla-measure-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-glla/audit-loop/findings.md"),
      [
        "# findings",
        "- [ ] FIX: LOW: open one",
        "- [x] FIX: MEDIUM: closed fix one — fixed in abc123",
        "- [x] FIX: LOW: closed fix two — fixed in def456",
        "  - [x] FIX: LOW: indented closed fix — fixed in ghi789",
        "- [x] DECIDED: a direction call was resolved (2026-08-11)",
        "- [x] DEFERRED: a direction call was parked (2026-08-11)",
        "- [?] DECIDE: still-open question",
      ].join("\n") + "\n",
    );
    const out = runIn(cwd, auditMeasureCmd(cwd));
    assert.equal(out, "3", "closed FIX boxes count, including the indented one");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.35.4: countOpenAuditFindings/topOpenAuditFinding tolerate aligned open boxes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "glla-open-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-glla/audit-loop/findings.md"),
      [
        "# findings",
        "- [ ] FIX: LOW: normal box",
        "- [  ] FIX: MEDIUM: aligned two-space box",
        "- [	] FIX: HIGH: tab box",
        "- [x] FIX: MEDIUM: closed one — fixed in aa11", 
      ].join("\n") + "\n",
    );
    assert.equal(countOpenAuditFindings(cwd), 3, "flat open box shapes count");
    const top = topOpenAuditFinding(cwd);
    assert.equal(top, "FIX: LOW: normal box", "top open finding is the first box line");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.38.33: indented boxes count and queue identically across all four readers", () => {
  // DECIDED 2026-09-08 normalize: the fan-out parser already queued
  // indented boxes while the counters ignored them (metric vs reprieve vs
  // queue disagreed). All four readers must see the same boxes.
  const cwd = mkdtempSync(join(tmpdir(), "glla-agree-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    const md = [
      "# findings",
      "- [ ] FIX: LOW: flat open box",
      "  - [ ] FIX: LOW: indented open box",
      "- [x] FIX: LOW: flat closed box — fixed in aa11",
      "   - [x] FIX: LOW: indented closed box — fixed in bb22",
      "  - [?] DECIDE: indented open question",
      "",
    ].join("\n");
    writeFileSync(join(cwd, ".pi-glla/audit-loop/findings.md"), md + "\n");
    assert.equal(countOpenAuditFindings(cwd), 2, "both open boxes count");
    assert.equal(topOpenAuditFinding(cwd), "FIX: LOW: flat open box", "reprieve names the flat first box");
    assert.equal(runIn(cwd, auditMeasureCmd(cwd)), "2", "both closed FIX boxes move the metric");
    const { open, decisions } = parseAuditFindingsForFanout(md);
    assert.equal(open.length, 2, "fan-out queues both open boxes");
    assert.ok(open.some((f) => f.text.includes("indented open box")), "fan-out queues the indented box");
    assert.equal(decisions.length, 1, "fan-out presents the indented decision");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.38.33: topOpenAuditFinding strips the indent, never the text", () => {
  const cwd = mkdtempSync(join(tmpdir(), "glla-top-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-glla/audit-loop/findings.md"),
      "\t- [ ] FIX: LOW: indented first box\n",
    );
    assert.equal(countOpenAuditFindings(cwd), 1, "tab-indented box counts");
    assert.equal(topOpenAuditFinding(cwd), "FIX: LOW: indented first box", "reprieve strips the indent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.35.4: parseLoopStartArgs keeps =-bearing text inside quotes and restores unknown keys", () => {
  const quoted = parseLoopStartArgs('"make a=b work" measure="echo 1" direction=min');
  assert.equal(quoted.target, "make a=b work", "an = pair inside the quoted target is not consumed as a key");
  assert.equal(quoted.measureCmd, "echo 1");
  assert.equal(quoted.direction, "min");
  const unknown = parseLoopStartArgs('fix x=y measure="echo 1" direction=min');
  assert.equal(unknown.target, "fix x=y", "an unknown key stays in the target instead of vanishing");
  assert.equal(unknown.direction, "min");
  // known keys are still consumed anywhere outside quotes:
  const mixed = parseLoopStartArgs('make b=c and d=e work measure="echo 1" direction=min branch=1');
  assert.equal(mixed.target, "make b=c and d=e work", "multiple unknown = pairs stay in the target");
  assert.equal(mixed.branch, true);
  // a typo'd key no longer silently disappears from the config AND target:
  const typo = parseLoopStartArgs('t direcion=min measure="echo 1" direction=min');
  assert.equal(typo.target, "t direcion=min", "the typo is visible in the target");
  assert.equal(typo.direction, "min");
});

function runIn(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

// v0.35.42 (audit finding): a measure-changing refinement starts a NEW
// metric era — applyRefinement re-baselines but keeps history, so OLD-era
// improvements made metricHasMoved permanently true for the new era and
// the v0.35.31 flat-reading grace could never apply after a refine.
test("v0.35.42 — the flat-reading grace applies in a NEW measure era despite old-era improvements", () => {
  const loop = freshLoop({ direction: "min", bestValue: null, lastValue: null, maxIterations: 0 });
  // Old era: real improvements on record (metric m1).
  applyMeasurement(loop, 9, "t1");
  applyMeasurement(loop, 5, "t2");
  assert.ok(loop.history.some((h) => h.improved), "precondition: old era has an improvement");
  // Measure-changing refinement at iteration 2 → next measured tick is 3.
  applyRefinement(loop, {
    at: "t2", iteration: loop.iteration,
    oldTarget: "t", newTarget: "t",
    oldMeasureCmd: "m1", newMeasureCmd: "m2",
  }, 42);
  assert.equal(loop.bestValue, 42);
  // New era: every reading flat against the fresh baseline.
  let out = applyMeasurement(loop, 42, "t3"); // era's first reading — indistinguishable from resumed
  assert.equal(out.kind, "continue");
  assert.equal(loop.stallCount, 1);
  out = applyMeasurement(loop, 42, "t4");
  assert.equal(out.kind, "continue");
  assert.equal(loop.stallCount, 1, "the grace applies in the new era: old improvements don't count as movement");
  out = applyMeasurement(loop, 42, "t5");
  assert.equal(out.kind, "continue", "no false plateau from old-era movement");
});

test("v0.35.42 — a dead NEW metric still earns its never-moved stop after a refine", () => {
  const loop = freshLoop({ direction: "min", bestValue: null, lastValue: null, maxIterations: 0 });
  applyMeasurement(loop, 9, "t1"); // old-era improvement
  applyRefinement(loop, {
    at: "t1", iteration: loop.iteration,
    oldTarget: "t", newTarget: "t",
    oldMeasureCmd: "m1", newMeasureCmd: "m2",
  }, 42);
  let out = applyMeasurement(loop, 42, "t2")!;
  for (let i = 3; i <= 14 && out.kind !== "stop"; i++) out = applyMeasurement(loop, 42, `t${i}`)!;
  assert.equal(out.kind, "stop");
  if (out.kind === "stop") {
    assert.match(out.reason, /metric never moved/, "the never-moved bound is era-scoped too: old improvements don't shield a dead metric forever");
  }
});
