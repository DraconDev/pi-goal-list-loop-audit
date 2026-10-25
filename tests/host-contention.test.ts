// pi-goal-list-loop-audit — v0.39.41
// tests/host-contention.test.ts
//
// The gate's hang bounds must be sized for the CPU the host is actually
// giving the suite, and they must be sized in ONE place.
//
// This file pins three things:
//   1. the contention measurement is bounded and never shrinks a budget,
//   2. an idle host is a no-op — the budget is exactly what was asked for,
//      so CI and a normal workstation see no behaviour change at all,
//   3. no test file hand-rolls a wait deadline any more: the wait budget
//      comes from the shared helper, so the rule cannot drift back.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CONTENTION_FACTOR,
  MAX_LOAD_SCALE_FACTOR,
  MIN_CONTENTION_FACTOR,
  contentionFactor,
  hangFactor,
  hostLoadFactor,
  measureContentionFactor,
  resetContentionFactor,
  scaledBudgetMs,
} from "../scripts/host-contention.mjs";
import { hangDeadlineMs, untilMs, waitFor } from "./harness/host-budget.js";
import {
  DEFAULT_TEST_TIMEOUT_MS,
  MAX_TEST_TIMEOUT_MS,
  buildRunnerArgs,
  serialFlags,
} from "../scripts/run-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the contention measurement is bounded and never reports a speedup", () => {
  const measured = measureContentionFactor();
  assert.equal(measured.measurable, true, "the host can be measured");
  assert.ok(Number.isFinite(measured.factor), "the factor is a finite number");
  assert.ok(measured.factor >= MIN_CONTENTION_FACTOR, `factor ${measured.factor} is at least ${MIN_CONTENTION_FACTOR}`);
  assert.ok(measured.factor <= MAX_CONTENTION_FACTOR, `factor ${measured.factor} is at most ${MAX_CONTENTION_FACTOR}`);
  assert.ok(measured.cpuMs > 0, "the probe actually consumed CPU");
  // The probe's CPU time is the PROCESS's, so background threads (GC, libuv)
  // can make it exceed the wall time it took. The ratio is then below 1 and
  // the factor is clamped UP to 1 — a budget is never shrunk. Either way the
  // factor stays inside the bounds.
  if (measured.wallMs < measured.cpuMs) {
    assert.equal(measured.factor, MIN_CONTENTION_FACTOR, "a ratio below 1 is clamped, never allowed to shrink a budget");
  }
});

test("a budget is never smaller than the one the test asked for", () => {
  for (const base of [1, 1_000, 10_000, 30_000, 300_000]) {
    assert.ok(hangDeadlineMs(base) >= base, `budget ${base} is not shrunk (got ${hangDeadlineMs(base)})`);
    assert.ok(scaledBudgetMs(base) >= base, `scaled budget ${base} is not shrunk`);
  }
});

test("the budget scales with the slowdown the host is actually experiencing", () => {
  assert.equal(hangDeadlineMs(10_000, { factor: 1 }), 10_000, "an idle host asks for exactly what it asked for");
  assert.equal(hangDeadlineMs(10_000, { factor: 3 }), 30_000, "a 3x slower host gets 3x the wall time");
  assert.equal(hangDeadlineMs(10_000, { factor: 2.5 }), 25_000, "the factor is applied, not rounded down to a bucket");
});

test("an idle host is a no-op: the deadline is exactly the requested budget", () => {
  const before = Date.now();
  const deadline = untilMs(10_000, { factor: 1 });
  const after = Date.now();
  assert.ok(deadline >= before + 10_000, "the deadline is at least the requested budget");
  assert.ok(deadline <= after + 10_000, "the deadline is at most the requested budget plus the call's own cost");
});

test("the measured factor is cached for its window and can be forced fresh", () => {
  resetContentionFactor();
  const first = contentionFactor();
  const second = contentionFactor();
  assert.equal(first, second, "a fresh factor is reused inside the window");
  const forced = contentionFactor({ force: true });
  assert.ok(forced >= MIN_CONTENTION_FACTOR && forced <= MAX_CONTENTION_FACTOR, "a forced measurement is still bounded");
  resetContentionFactor();
});

test("the machine's load pressure is bounded and never shrinks a budget", () => {
  const load = hostLoadFactor();
  assert.ok(Number.isFinite(load), "the load factor is a finite number");
  assert.ok(load >= 1, `the load factor ${load} never goes below 1`);
  assert.ok(load <= MAX_LOAD_SCALE_FACTOR, `the load factor ${load} is at most ${MAX_LOAD_SCALE_FACTOR}`);
  // The product scales its own timeouts by load/cpus with the same ceiling;
  // the gate and the product must size their budgets the same way.
  assert.equal(MAX_LOAD_SCALE_FACTOR, 2, "the load ceiling matches the product's MECHANICAL_LOAD_SCALE_MAX");
});

test("a hang bound takes the worse of the CPU probe and the machine's load", () => {
  // The CPU probe cannot see machine-wide pressure: a saturated host still
  // burns the probe at full speed and reports 1.0. The load term is what
  // lets a busy host's budget grow for the pressure that is actually slowing
  // an I/O-bound wait down.
  const cpu = contentionFactor();
  const load = hostLoadFactor();
  assert.equal(hangFactor(), Math.max(cpu, load), "the hang factor is the worse of the two readings");
  assert.ok(hangFactor() >= cpu, "the hang factor is never below the CPU probe");
});

test("a budget scaled for a busy host is never smaller than the one asked for", () => {
  for (const base of [1, 1_000, 10_000, 30_000, 300_000, 600_000]) {
    assert.ok(scaledBudgetMs(base) >= base, `scaled budget ${base} is not shrunk (got ${scaledBudgetMs(base)})`);
    assert.ok(hangDeadlineMs(base) >= base, `hang deadline ${base} is not shrunk (got ${hangDeadlineMs(base)})`);
  }
});

test("the load factor is cached for its window and can be forced fresh", () => {
  resetContentionFactor();
  const first = hostLoadFactor();
  const second = hostLoadFactor();
  assert.equal(first, second, "a fresh load factor is reused inside the window");
  const forced = hostLoadFactor({ force: true });
  assert.ok(forced >= 1 && forced <= MAX_LOAD_SCALE_FACTOR, "a forced load reading is still bounded");
  resetContentionFactor();
});

test("waitFor waits for the condition instead of guessing a wall time", async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 120);
  await waitFor(() => ready, { timeoutMs: 5_000, message: "the condition never became true" });
  assert.equal(ready, true, "waitFor returns once the condition holds");
});

test("waitFor still fails when the condition never becomes true", async () => {
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 150, message: "the condition never became true" }),
    /the condition never became true/,
    "a condition that never holds still fails the test, with the caller's own message",
  );
});

test("the per-test timeout default leaves real headroom over the slowest legitimate test", () => {
  // The slowest test that relies on the DEFAULT budget took 22.8s
  // (tests/goal-timeline.test.ts). The old 60s default left only ~2.6x
  // headroom, and that test was killed by bun's own timeout on a contended
  // host — a healthy test reported as a hang.
  assert.ok(
    DEFAULT_TEST_TIMEOUT_MS >= 5 * 22_800,
    `the default per-test budget leaves at least 5x headroom over the slowest legitimate test (got ${DEFAULT_TEST_TIMEOUT_MS}ms)`,
  );
  assert.ok(MAX_TEST_TIMEOUT_MS >= DEFAULT_TEST_TIMEOUT_MS, "the ceiling is above the default");
  assert.ok(MAX_TEST_TIMEOUT_MS <= 900_000, "the ceiling keeps a hung test bounded to minutes, not hours");
});

test("the runner passes a serial, load-sized timeout to bun", () => {
  assert.deepEqual(
    serialFlags(DEFAULT_TEST_TIMEOUT_MS),
    ["--parallel=1", "--max-concurrency=1", `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`],
    "the serial flags keep their shape and carry the per-test budget",
  );
  const { bunArgs } = buildRunnerArgs([], []);
  assert.ok(bunArgs.includes(`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`), "the default budget reaches bun");
  const scaled = buildRunnerArgs([], [], undefined, { timeoutMs: 240_000 });
  assert.ok(scaled.bunArgs.includes("--timeout=240000"), "an explicit budget reaches bun");
  assert.ok(!scaled.bunArgs.includes(`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`), "the explicit budget replaces the default");
});

test("no test file hand-rolls a wait deadline any more", () => {
  // A wait deadline is a `Date.now() + N` that is later compared against
  // `Date.now()`. The budget must come from the shared measurement, so it is
  // sized for the host and the rule cannot drift back into 40 files.
  // A deadline is compliant when its value goes through the shared helper
  // (untilMs / hangDeadlineMs), through the shared module an embedded child
  // script imports (scaledBudgetMs), or through the budget the parent hands
  // that child (GLLA_TEST_WAIT_BUDGET_MS).
  const DEADLINE = /\b(?:const|let)\s+(\w+)\s*=\s*Date\.now\(\)\s*\+\s*([^;]+);/;
  const CHECK = /Date\.now\(\)\s*[<>]=?\s*(\w+)/;
  const SHARED = /untilMs\(|hangDeadlineMs\(|scaledBudgetMs\(|GLLA_TEST_WAIT_BUDGET_MS/;
  const offenders: string[] = [];
  for (const file of walk(path.join(ROOT, "tests"))) {
    if (!file.endsWith(".test.ts")) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const made = lines[i]?.match(DEADLINE);
      if (!made) continue;
      const name = made[1];
      const value = made[2];
      if (name === undefined || value === undefined) continue;
      if (SHARED.test(value)) continue;
      const window = lines.slice(i + 1, i + 8).join("\n");
      const checked = window.match(CHECK);
      if (!checked || checked[1] !== name) continue;
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${lines[i]?.trim() ?? ""}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these files size a wait deadline by hand; use untilMs() from ./harness/host-budget.js so the budget follows the host's CPU",
  );
});

test("no test's frame expires before the waits inside it", () => {
  // A test that declares a FRAMEWORK timeout shorter than the waits inside
  // it is killed by the framework before the wait can report what never
  // happened. Bun's message is a bare "timed out after 51285ms" with no
  // diagnosis, so the failure reads as a hang instead of as the missing
  // condition it actually is.
  //
  // The rule is the SUM of the waits, not the largest one: the waits run in
  // sequence, so the frame has to cover all of them.
  //
  // And the sum is multiplied by the contention cap, because a wait's budget
  // is scaled by the host factor and that factor can reach the cap. A frame
  // of `scaledBudgetMs(base)` is at least `base` — the sampled factor can
  // only make it larger — so a base of cap x sum guarantees the frame covers
  // every wait it contains, however busy the host gets while the test runs.
  //
  // This matters because the frame's factor and the waits' factors are NOT
  // the same number. The frame samples the host when the test FILE loads,
  // which for an early file can be a quiet moment on an otherwise saturated
  // machine, while a wait re-measures the host when that wait runs. The
  // heartbeat-recovery test is exactly that shape: it loads early, it runs
  // through four sequential detached-auditor cycles, and it was killed at
  // 241s by a frame that had been sized at 1x on a host running at load 50.
  const FRAME = /test\(.*\{ timeout: (?:scaledBudgetMs|hangDeadlineMs)\((\d[\d_]*)\)/;
  const EXPLICIT_WAIT = /waitUntil\([^)]*?,\s*(\d[\d_]*)\s*\)|waitFor\([^)]*?timeoutMs:\s*(\d[\d_]*)/g;
  const ANY_WAIT = /\bwaitUntil\(|\bwaitFor\(|\bwaitForAuditDispatch\(|\bwaitForRecoveryDispatch\(/g;
  // A file may define its OWN wait helper with its own default budget, so
  // the default is read from the definition rather than assumed — otherwise
  // a local `waitFor(check, timeout = 30000)` would be measured against the
  // shared helper's default and reported as a violation it is not.
  const LOCAL_DEFAULT = /function (?:waitUntil|waitFor)\b.*?timeoutMs\s*=\s*(\d[\d_]*)/;
  const SHARED_DEFAULT_WAIT_MS = 30_000;
  const FRAME_MARGIN = MAX_CONTENTION_FACTOR;
  const offenders: string[] = [];
  for (const file of walk(path.join(ROOT, "tests"))) {
    if (!file.endsWith(".test.ts")) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const source = lines.join("\n");
    const local = source.match(LOCAL_DEFAULT);
    const localDefault = local ? Number((local[1] ?? "").replaceAll("_", "")) : undefined;
    for (let i = 0; i < lines.length; i++) {
      const frame = lines[i]?.match(FRAME);
      if (!frame) continue;
      const base = Number((frame[1] ?? "").replaceAll("_", ""));
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !/^test\(/.test(lines[j] ?? ""); j++) body.push(lines[j] ?? "");
      const text = body.join("\n");
      const calls = [...text.matchAll(ANY_WAIT)].length;
      if (!calls) continue;
      const explicit = [...text.matchAll(EXPLICIT_WAIT)]
        .map((m) => Number((m[1] ?? m[2] ?? "").replaceAll("_", "")))
        .filter((n) => Number.isFinite(n) && n > 0);
      const fallback = localDefault ?? SHARED_DEFAULT_WAIT_MS;
      const total = explicit.reduce((sum, n) => sum + n, 0) + (calls - explicit.length) * fallback;
      if (base < FRAME_MARGIN * total) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  frame ${base}ms < ${FRAME_MARGIN}x waits ${total}ms`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these tests declare a frame shorter than the waits inside them; the frame must cover its waits so the wait's own message is what a failure reports",
  );
});

/**
 * The argument text of a call, with strings and comments skipped so a
 * parenthesis inside a message cannot end the scan early.
 */
function callArgument(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return "";
}

test("no test waits for the transient goal status the product can legitimately leave", () => {
  // The goal's "auditing" status is TRANSIENT: the detached auditor can
  // finish, apply its verdict and return the goal to "active" before the
  // test observes it. On a starved host the observation lands after the
  // verdict, so a wait that asks for "auditing" burns its whole budget on a
  // state that is never coming back — and the gate reports a healthy
  // machine as broken.
  //
  // It did. The 0.39.52 release gate failed its own heartbeat-recovery
  // test after 240s: the probe dump showed status "active", one audit
  // history entry, one automatic claim and one recovery dispatch — the
  // heartbeat had recovered the claim, the auditor had produced its
  // verdict, and the wait was still asking for a status the product had
  // already left.
  //
  // The durable evidence is the LEDGER: `audit_started` records every
  // dispatched attempt, `audit_recovery_started` records the automatic
  // session-recovery origin, `audit_recovery_auto_retry_claimed` records
  // the one-shot automatic claim. A test may still READ the status and
  // assert it while the audit is in flight — but it must not WAIT for it.
  const WAIT = /\b(?:waitUntil|waitFor|waitForAuditDispatch|waitForRecoveryDispatch)\s*\(/g;
  const offenders: string[] = [];
  for (const file of walk(path.join(ROOT, "tests"))) {
    if (!file.endsWith(".test.ts")) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(WAIT)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      if (!callArgument(source, open).includes('"auditing"')) continue;
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      offenders.push(`${path.relative(ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these waits ask for the transient "auditing" status; wait for the durable ledger evidence instead (audit_started / audit_recovery_started)',
  );
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
