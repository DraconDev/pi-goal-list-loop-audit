import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractMechanicalCheckCommands,
  parseMechanicalPipeline,
  runMechanicalPreAuditChecks,
} from "../extensions/goal-loop-shield.ts";

// v0.38.18 track 1 (endless-td pipe-syntax wedge): contracts legitimately
// truncate noisy suites (`bun test 2>&1 | tail -n 4`). The checker used to
// 126-reject the `|` with no agent-side remedy, wedging finished work.

test("parseMechanicalPipeline: accepts the narrow pipeline shape", () => {
  assert.deepEqual(parseMechanicalPipeline("bun test 2>&1 | tail -n 4"), {
    head: "bun test",
    filters: ["tail -n 4"],
  });
  assert.deepEqual(parseMechanicalPipeline("node --version | head -n 2"), {
    head: "node --version",
    filters: ["head -n 2"],
  });
  assert.deepEqual(parseMechanicalPipeline("node --version|grep version"), {
    head: "node --version",
    filters: ["grep version"],
  });
});

test("parseMechanicalPipeline: rejects everything outside the shape", () => {
  // Note: bare-program choice matches the pre-existing single-command threat
  // model (shell metacharacters are the boundary, not the program name) —
  // the pipeline-specific guards are the filter allowlist and no redirects.
  assert.equal(parseMechanicalPipeline("node --version | tail -n 4 | tee x"), null); // second filter not allowlisted
  assert.equal(parseMechanicalPipeline("node --version | tee /tmp/glla-pipe-test"), null); // second program
  assert.equal(parseMechanicalPipeline("node --version | tail -n 2 > /tmp/glla-pipe-test"), null); // redirect
  assert.equal(parseMechanicalPipeline("node --version | tail -n 4; printf boom"), null); // chaining
  assert.equal(parseMechanicalPipeline("node --version |"), null); // empty segment
  assert.equal(parseMechanicalPipeline("| tail -n 4"), null); // empty head
  assert.equal(parseMechanicalPipeline("node --version"), null); // not a pipeline
  assert.equal(parseMechanicalPipeline("node --version | grep a b"), null); // grep with file operand
  assert.equal(parseMechanicalPipeline("node --version | grep 'a|b'"), null); // quote smuggling a pipe
});

test("extraction delivers the field pipeline string to the runner", () => {
  const cmds = extractMechanicalCheckCommands("1. `bun test 2>&1 | tail -n 4` shows 0 failures");
  assert.deepEqual(cmds, ["bun test 2>&1 | tail -n 4"]);
});

test("pipeline runs shell-free: green head passes, evidence truncated", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --version 2>&1 | tail -n 2"]);
  assert.equal(res.passed, true);
});

test("pipeline exit follows the head, never the filter", async () => {
  // tail exits 0 even when the suite is red — the tail's status is meaningless.
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --definitely-not-a-real-option | tail -n 4"]);
  assert.equal(res.passed, false);
  assert.notEqual(res.exitCode, 0);
  assert.match(res.output!, /pipeline head exited/);
});

test("unsafe pipeline stages never execute: 126 with no side effects", async () => {
  // Audit 2026-09-13: probe lives under os.tmpdir() (honors TMPDIR) with a
  // pid suffix so parallel checkouts/users cannot share one fixed path.
  const probe = path.join(os.tmpdir(), `glla-pipeline-must-not-exist-${process.pid}`);
  try { fs.unlinkSync(probe); } catch { /* absent is the point */ }
  const res = await runMechanicalPreAuditChecks(process.cwd(), [`node --version | tee ${probe}`]);
  assert.equal(res.passed, false);
  assert.equal(res.exitCode, 126);
  assert.match(res.output!, /only `command \| tail -n N`/);
  assert.equal(fs.existsSync(probe), false);
});

test("grep filter reads stdin only: no file operand, no leak", async () => {
  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --version | grep -i version"]);
  assert.equal(res.passed, true);
});
