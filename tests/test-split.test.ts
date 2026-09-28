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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { readFile } from "node:fs/promises";

import { SLOW_TEST_FILES } from "./slow-files.mjs";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  SERIAL_FLAGS,
  buildRunnerArgs,
  heartbeatMs,
  isStalled,
  stallTimeoutMs,
} from "../scripts/run-tests.mjs";

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
  const filtered = buildRunnerArgs(["-t", "foo"], ["tests/a.test.ts"]);
  assert.equal(filtered.mode, "fast", "a -t value is not an explicit path");
  assert.ok(filtered.bunArgs.some((a) => a.includes("ignore-patterns")), "filtered fast keeps the exclusion");
});

// ---------------------------------------------------------------------------
// v0.38.107: the runner must be observable and hang-proof. Field evidence: a
// suite that printed nothing for 37 minutes, and a 26-hour-old `bun test`
// still burning a core — a runner you cannot see is a runner you cannot trust.
// ---------------------------------------------------------------------------

test("runner: the stall window is bounded and overridable", () => {
  assert.ok(DEFAULT_STALL_TIMEOUT_MS >= 60_000, "the default stall window is generous enough for a slow host");
  assert.equal(stallTimeoutMs({}), DEFAULT_STALL_TIMEOUT_MS, "unset env uses the default");
  assert.equal(stallTimeoutMs({ GLLA_TEST_STALL_TIMEOUT_MS: "5000" }), DEFAULT_STALL_TIMEOUT_MS, "an absurdly small window is refused");
  assert.equal(stallTimeoutMs({ GLLA_TEST_STALL_TIMEOUT_MS: "nonsense" }), DEFAULT_STALL_TIMEOUT_MS, "junk env is refused");
  assert.equal(stallTimeoutMs({ GLLA_TEST_STALL_TIMEOUT_MS: "45000" }), 45_000, "a sane override is honoured");
  assert.equal(heartbeatMs({}), DEFAULT_HEARTBEAT_MS);
  assert.equal(heartbeatMs({ GLLA_TEST_HEARTBEAT_MS: "2000" }), 2_000);
});

test("runner: silence past the window stalls, progress resets the clock", () => {
  assert.equal(isStalled({ silentMs: 10_000, limitMs: 30_000 }), false, "a working suite is never stalled");
  assert.equal(isStalled({ silentMs: 30_000, limitMs: 30_000 }), true, "exactly at the limit is a stall");
  assert.equal(isStalled({ silentMs: 31_000, limitMs: 30_000 }), true);
  // The regression that matters: a hung run is TERMINATED, never left to sit
  // there consuming a core (the 26-hour orphan).
  assert.equal(isStalled({ silentMs: 3_600_000, limitMs: DEFAULT_STALL_TIMEOUT_MS }), true, "an hour of silence stalls");
  assert.equal(isStalled({ silentMs: Number.NaN, limitMs: 30_000 }), false, "an unknown clock never stalls on a guess");
});

test("runner: the wrapper owns its child (no orphan on abort)", () => {
  const src = readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
  assert.match(src, /process\.on\("SIGINT"/, "SIGINT takes the child down");
  assert.match(src, /process\.on\("SIGTERM"/, "SIGTERM takes the child down");
  assert.match(src, /process\.on\("exit"/, "an exiting wrapper takes the child down");
  assert.match(src, /process\.kill\(-child\.pid, signal\)/, "the whole child process group is signalled, not just the runner");
  assert.match(src, /STALLED: no suite output for/, "a stall is reported, not silent");
  assert.match(src, /progress: .*since last output/, "progress is observable while it runs");
});

test("runner: the hand-written .d.mts declares every runtime export (drift guard)", () => {
  // scripts/run-tests.d.mts is hand-maintained: TypeScript sees the .mjs
  // through it, so a new export that is not declared there fails the typecheck
  // with a confusing "has no exported member" instead of "you forgot the .d.mts".
  const runtime = readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
  const declared = readFileSync(new URL("../scripts/run-tests.d.mts", import.meta.url), "utf8");
  const names = [
    ...runtime.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm),
  ].map((m) => m[1]);
  assert.ok(names.length >= 7, `the runtime export surface is discovered, found ${names.length}`);
  for (const name of names) {
    assert.match(declared, new RegExp(`\\b${name}\\b`), `scripts/run-tests.d.mts must declare ${name}`);
  }
});

test("v0.38.108: the suite child is detached so the documented group-kill is real", async () => {
  const src = await readFile(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
  const spawnLine = src.slice(src.indexOf("const child = spawn(\"bun\""), src.indexOf("const child = spawn(\"bun\"") + 200);
  assert.match(spawnLine, /detached: true/, "without detached the negative-pid kill is a silent no-op");
  // The probe must not swallow its own failure again.
  assert.doesNotMatch(src, /catch \{ \/\* no group \*\/ \}/, "a missing process group is reported, not swallowed");
  assert.match(src, /is not its own process group/, "the wrapper names the degraded guarantee");
});

test("v0.38.108: the release gate runs the hardened runner, and CI bounds both jobs", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:all"], /^node scripts\/run-tests\.mjs --all/, "test:all goes through the stall-proof, orphan-free wrapper");
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const jobs = workflow.split(/\n  (?=quality:|publish:)/).slice(1);
  assert.equal(jobs.length, 2, "both workflow jobs are inspected");
  for (const job of jobs) {
    assert.match(job, /timeout-minutes: \d+/, `${job.split("\n")[0]} bounds its own runtime`);
  }
});

test("v0.38.108: no test gates itself on the removed @tintinweb fork", () => {
  assert.equal(
    existsSync(path.join("tests", "subagent-stop-rpc.integration.test.mjs")),
    false,
    "the permanently-skipped real-host fixture is gone, not left to report 'skipped' forever",
  );
  for (const file of readdirSync("tests")) {
    if (!/\.test\.(ts|mjs)$/.test(file)) continue;
    const text = readFileSync(path.join("tests", file), "utf-8");
    // A bare mention is fine (the no-provider smoke blocks the import);
    // a node_modules PATH is a hard dependency on an installed layout.
    assert.doesNotMatch(text, /node_modules\/@tintinweb/, `${file} gates on a fork no dependency installs`);
  }
});

test("v0.38.108: tests/README.md does not claim npm test runs the whole suite", () => {
  const readme = readFileSync(path.join("tests", "README.md"), "utf-8");
  assert.doesNotMatch(readme, /npm test\s+# runs: bun test/, "the old line claimed bare bun test");
  assert.match(readme, /slow-files\.mjs/, "the fast/slow split is documented");
  assert.match(readme, /npm run test:slow/, "the slow run is documented");
  assert.match(readme, /not the whole suite/, "a green fast run is explicitly not full coverage");
});
