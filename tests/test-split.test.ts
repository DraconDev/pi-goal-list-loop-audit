// pi-goal-list-loop-audit — v0.38.82
// tests/test-split.test.ts
//
// Fast/slow suite split: the slow list stays valid (every entry exists,
// no duplicates, all test files) and the runner maps modes to bun args
// (fast excludes via repeated --path-ignore-patterns, explicit paths
// always win, slow/all pass through). The full suite stays the release
// gate — the split only changes the everyday loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { SLOW_TEST_FILES } from "./slow-files.mjs";
import { SERIAL_FLAGS, buildRunnerArgs } from "../scripts/run-tests.mjs";

test("test-split: every slow-listed file exists and is a test file", () => {
  assert.ok(SLOW_TEST_FILES.length > 0, "the slow list is populated from timing evidence");
  assert.deepEqual([...new Set(SLOW_TEST_FILES)], SLOW_TEST_FILES, "no duplicate entries");
  for (const file of SLOW_TEST_FILES) {
    assert.ok(existsSync(file), `slow entry exists on disk: ${file}`);
    assert.match(file, /\.test\.[mc]?[tj]s$/, `slow entry is a test file: ${file}`);
  }
});

test("test-split: fast mode excludes via one ignore pattern per slow file", () => {
  const { mode, bunArgs } = buildRunnerArgs([], ["tests/a.test.ts", "tests/b.test.ts"]);
  assert.equal(mode, "fast");
  assert.deepEqual(bunArgs.slice(0, SERIAL_FLAGS.length), SERIAL_FLAGS, "serial flags first, always");
  assert.deepEqual(
    bunArgs.slice(SERIAL_FLAGS.length, SERIAL_FLAGS.length + 4),
    ["--path-ignore-patterns", "tests/a.test.ts", "--path-ignore-patterns", "tests/b.test.ts"],
    "repeated flags union (comma-separated does not)",
  );
});

test("test-split: explicit paths drop the ignore patterns", () => {
  const { mode, bunArgs } = buildRunnerArgs(["tests/a.test.ts"], ["tests/a.test.ts"]);
  assert.equal(mode, "explicit");
  assert.ok(!bunArgs.some((a) => a.includes("ignore-patterns")), "naming a file means run that file");
  assert.ok(bunArgs.includes("tests/a.test.ts"));
});

test("test-split: slow mode names the files; all mode passes through", () => {
  const slow = buildRunnerArgs(["--slow"], ["tests/a.test.ts"]);
  assert.equal(slow.mode, "slow");
  assert.ok(slow.bunArgs.includes("tests/a.test.ts"));
  assert.ok(!slow.bunArgs.some((a) => a.includes("ignore-patterns")));
  const all = buildRunnerArgs(["--all", "-t", "foo"], ["tests/a.test.ts"]);
  assert.equal(all.mode, "all");
  assert.ok(!all.bunArgs.some((a) => a.includes("ignore-patterns")));
  assert.deepEqual(all.bunArgs.slice(-2), ["-t", "foo"], "filters pass through");
});
