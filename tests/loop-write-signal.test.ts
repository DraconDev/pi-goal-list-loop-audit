// pi-goal-list-loop-audit — v0.25.1
// tests/loop-write-signal.test.ts
//
// Stuck-detection rework contract items 2/3/4: the orchestrator wiring.
// The handlers are inline in the extension (no pi harness) — the pure
// predicate is unit-tested and the wiring is pinned by source assertions.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { isLoopWriteTool, LOOP_WRITE_TOOLS } from "../extensions/goal-loop-forever.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const goalSrc = readGoalRuntimeSource();
const loopSrc = fs.readFileSync(path.resolve("extensions", "goal-loop.ts"), "utf-8"); // decomposition step 2

test("item 3: write/edit/multi_edit/write_file are the write-signal tools", () => {
  assert.deepEqual([...LOOP_WRITE_TOOLS], ["write", "edit", "multi_edit", "write_file"]);
  assert.equal(isLoopWriteTool("write"), true);
  assert.equal(isLoopWriteTool("edit"), true);
  assert.equal(isLoopWriteTool("multi_edit"), true);
  assert.equal(isLoopWriteTool("write_file"), true);
  assert.equal(isLoopWriteTool("read"), false);
  assert.equal(isLoopWriteTool("bash"), false);
});

test("item 3: the tool_result handler bumps fileWrites via isLoopWriteTool", () => {
  // Both event shapes are attested (toolName and name) — the counter reads
  // either, matching the call-time path recorder.
  assert.match(goalSrc, /if \(isLoopWriteTool\(String\(event\?\.toolName \?\? event\?\.name \?\? ""\)\)\) \{/);
  assert.match(goalSrc, /metrics\.fileWrites\+\+/);
});

test("item 2: the stuck dispatch calls isActuallyStuck (not detectLoopStuck directly)", () => {
  assert.match(loopSrc, /const stuckReason = isActuallyStuck\(\{/);
  assert.ok(!/const stuckReason = detectLoopStuck\(/.test(loopSrc));
});

test("item 4: git commits are counted once per iteration from HEAD advance", () => {
  assert.match(loopSrc, /rev-list", "--count", `\$\{iterStartHead\}\.\.HEAD`/);
  assert.match(loopSrc, /gitCommitCount: iterSignals\.gitCommits/);
});

test("item 6: spec_item_progress events are counted from the ledger since iteration start", () => {
  assert.match(loopSrc, /spec_item_progress/);
  assert.match(loopSrc, /specItemProgressCount: iterSignals\.specItemProgress/);
});
