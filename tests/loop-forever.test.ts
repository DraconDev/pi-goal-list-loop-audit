// pi-goal-loop-audit — v0.3.0
// tests/loop-forever.test.ts
//
// Unit tests for loop 3 core: metric parsing, improvement comparison,
// plateau/termination logic, and /loop start arg parsing.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  applyMeasurement,
  doneCrossed,
  isImprovement,
  loopBranchName,
  parseLoopStartArgs,
  parseMetric,
  type LoopState,
} from "../extensions/goal-loop-forever.ts";

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

test("applyMeasurement: broken measure (null) is a stall", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, null, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.stallCount, 1);
  assert.equal(loop.lastValue, null);
});

test("applyMeasurement: plateau stops the loop", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 3, stallCount: 2, plateauWindow: 3 });
  const out = applyMeasurement(loop, 9, "t1");
  assert.equal(out.kind, "stop");
  assert.equal(loop.active, false);
  assert.match(loop.stopReason!, /plateau/);
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

test("parseLoopStartArgs: missing measure throws", () => {
  assert.throws(() => parseLoopStartArgs("target direction=min"), /measure/);
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

test("doneCrossed: min stops at or below threshold", () => {
  assert.equal(doneCrossed("min", 0, 0), true);
  assert.equal(doneCrossed("min", -1, 0), true);
  assert.equal(doneCrossed("min", 1, 0), false);
  assert.equal(doneCrossed("min", null, 0), false);
});

test("doneCrossed: max stops at or above threshold", () => {
  assert.equal(doneCrossed("max", 100, 100), true);
  assert.equal(doneCrossed("max", 101, 100), true);
  assert.equal(doneCrossed("max", 99, 100), false);
});

test("doneCrossed: no threshold means never done", () => {
  assert.equal(doneCrossed("min", -999, undefined), false);
});

test("applyMeasurement: done= stops immediately on crossing (min)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, doneAt: 0 });
  const out = applyMeasurement(loop, 0, "t1");
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /done — metric crossed 0/);
  assert.equal(loop.active, false);
  assert.equal(loop.bestValue, 0);
});

test("applyMeasurement: done= stops on crossing (max)", () => {
  const loop = freshLoop({ direction: "max", bestValue: 90, iteration: 4, doneAt: 100 });
  const out = applyMeasurement(loop, 100, "t1");
  assert.equal(out.kind, "stop");
  assert.equal(loop.bestValue, 100);
});

test("applyMeasurement: done= does not stop before crossing", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, doneAt: 0, plateauWindow: 3 });
  const out = applyMeasurement(loop, 2, "t1");
  assert.equal(out.kind, "continue");
});

test("applyMeasurement: done= beats plateau (crossing on a stall iteration still stops as done)", () => {
  const loop = freshLoop({ bestValue: 1, iteration: 3, stallCount: 2, plateauWindow: 3, doneAt: 0 });
  const out = applyMeasurement(loop, 0, "t1"); // improvement AND done-crossing
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /done/);
});

test("parseLoopStartArgs: done= parses as float", () => {
  const cfg = parseLoopStartArgs('t measure="cat x" direction=min done=0');
  assert.equal(cfg.doneAt, 0);
  const cfg2 = parseLoopStartArgs('t measure="cat x" direction=max done=99.5');
  assert.equal(cfg2.doneAt, 99.5);
  const cfg3 = parseLoopStartArgs('t measure="cat x" direction=min');
  assert.equal(cfg3.doneAt, undefined);
});

test("parseLoopStartArgs: force flag off by default, on with 1/true", () => {
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min').force, false);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=1').force, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=true').force, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=0').force, false);
});

// ---- loopBranchName ----

test("loopBranchName: format is pi-gla-loop/<timestamp>-<slug>", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "Reduce TODO count");
  assert.match(name, /^pi-gla-loop\/\d{14}-reduce-todo-count$/);
});

test("loopBranchName: empty slug falls back to 'loop'", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "!!!");
  assert.match(name, /^pi-gla-loop\/\d{14}-loop$/);
});

test("loopBranchName: slug is capped at 30 chars", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "a very long target description that goes on and on and on");
  const slug = name.split("-")[0] ? name.slice(name.indexOf("/") + 16) : "";
  assert.ok(slug.length <= 30, `slug too long: ${slug}`);
});
