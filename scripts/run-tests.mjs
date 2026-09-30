#!/usr/bin/env node
// pi-goal-list-loop-audit — v0.38.104
// scripts/run-tests.mjs
//
// Fast/slow suite split. The full serialized suite takes ~7 minutes —
// slow enough to discourage running it. Default `npm test` runs the
// fast set (everything minus tests/slow-files.mjs, excluded via bun's
// --path-ignore-patterns); `npm run test:slow` runs the slow files;
// `npm run test:all` still runs the whole suite plus the release gates.
//
// Usage: node scripts/run-tests.mjs [--slow|--all] [extra bun test args...]
// An explicit test path in the extras always wins: ignore patterns are
// dropped so `npm test -- tests/some-slow.test.ts` runs that file.
//
// v0.38.104 — observable, hang-proof, orphan-free. The field reported a
// suite that produced nothing for 37 minutes and a 26-hour-old `bun test`
// still burning a core: a runner you cannot see is a runner you cannot trust.
// So this wrapper now:
//   1. streams a periodic progress heartbeat (bytes of suite output seen),
//   2. fails LOUDLY instead of hanging when the suite goes silent past a
//      bounded stall window, and
//   3. always takes its child down with it (SIGINT/SIGTERM/exit), so an
//      aborted run can never leave a runaway behind.
// The heartbeat goes to stderr so piping stdout still gives clean test output.

import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SLOW_TEST_FILES } from "../tests/slow-files.mjs";

export const SERIAL_FLAGS = ["--parallel=1", "--max-concurrency=1", "--timeout=60000"];

/** v0.38.104: how long the suite may print NOTHING before we call it hung.
 * Generous on purpose — a serialized suite on a loaded host still emits
 * output every few seconds, and bun's own --timeout=60000 only bounds a
 * single test, not a runner that stops making progress. */
export const DEFAULT_STALL_TIMEOUT_MS = 180_000;
/** Heartbeat cadence: frequent enough that a watcher sees movement. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

export function stallTimeoutMs(env = process.env) {
  const raw = Number(env.GLLA_TEST_STALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? Math.floor(raw) : DEFAULT_STALL_TIMEOUT_MS;
}

export function heartbeatMs(env = process.env) {
  const raw = Number(env.GLLA_TEST_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_HEARTBEAT_MS;
}

/** Pure: has the suite gone silent for longer than the stall window? */
export function isStalled({ silentMs, limitMs }) {
  return Number.isFinite(silentMs) && Number.isFinite(limitMs) && silentMs >= limitMs;
}

/** Pure arg builder (unit-tested in tests/test-split.test.ts). */
export function buildRunnerArgs(argv, slowFiles) {
  let mode = "fast";
  const rest = [];
  for (const arg of argv) {
    if (arg === "--slow") mode = "slow";
    else if (arg === "--all") mode = "all";
    else rest.push(arg);
  }
  // Ignore patterns beat even explicit paths in bun, so explicit
  // selection drops them — naming a file means "run this file".
  // Value-taking flags (-t foo) consume the next token so filter
  // values are not mistaken for paths.
  const VALUE_FLAGS = new Set([
    "-t", "--test-name-pattern", "--timeout", "--parallel",
    "--max-concurrency", "--preload", "--path-ignore-patterns",
    "--changed", "--rerun-each", "--repeat-each",
  ]);
  let hasExplicitPaths = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) { i++; continue; }
    if (!arg.startsWith("-")) { hasExplicitPaths = true; break; }
  }
  if (mode === "slow") return { mode, bunArgs: [...SERIAL_FLAGS, ...slowFiles, ...rest] };
  if (mode === "all" || hasExplicitPaths) return { mode: hasExplicitPaths ? "explicit" : mode, bunArgs: [...SERIAL_FLAGS, ...rest] };
  return {
    mode,
    bunArgs: [...SERIAL_FLAGS, ...slowFiles.flatMap((f) => ["--path-ignore-patterns", f]), ...rest],
  };
}

const log = (line) => {
  if (process.env.GLLA_TEST_RUNNER_QUIET !== "1") process.stderr.write(`[run-tests] ${line}\n`);
};

function main() {
  const { mode, bunArgs } = buildRunnerArgs(process.argv.slice(2), SLOW_TEST_FILES);
  const stallLimit = stallTimeoutMs();
  const beat = heartbeatMs();
  const startedAt = Date.now();
  log(`mode=${mode} slow_files=${SLOW_TEST_FILES.length} stall_timeout=${Math.round(stallLimit / 1000)}s heartbeat=${Math.round(beat / 1000)}s`);

  // v0.38.104: `detached: true` is what makes the group-kill below real.
  // Without it the child stays in THIS process's group, so
  // process.kill(-child.pid) targets a pgid that does not exist, throws
  // ESRCH, and takeDown silently degrades to signalling the direct child —
  // leaving the detached auditor/worker grandchildren (the 26-hour orphan
  // this wrapper exists to prevent) running. The spawn option, not the
  // kill, was the missing half of the guarantee.
  const child = spawn("bun", ["test", ...bunArgs], { stdio: ["inherit", "pipe", "pipe"], detached: true });
  let bytes = 0;
  let lastOutputAt = Date.now();
  let settled = false;
  let stallFired = false;

  const forward = (stream, sink) => {
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      lastOutputAt = Date.now();
      sink.write(chunk);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  /** Take the child down, escalating, so nothing survives this wrapper. */
  const takeDown = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  // Own the child's process group so detached auditor workers spawned by the
  // suite die with it — the 26-hour orphan was exactly this failure mode.
  // v0.38.104: this probe used to swallow its own ESRCH, so when the group
  // did not exist (the pre-fix spawn) the wrapper claimed a guarantee it
  // never had and never even unref'd. A failed probe is now loud.
  try {
    process.kill(-child.pid, 0);
    child.unref?.();
  } catch (error) {
    log(`WARNING: the suite child is not its own process group (${error?.code ?? error?.message}) — takeDown can only signal the direct child, so orphaned grandchildren may survive the run.`);
  }

  const onSignal = (signal) => {
    log(`received ${signal} — taking the suite down with it (no orphan)`);
    takeDown("SIGTERM");
    setTimeout(() => takeDown("SIGKILL"), 5_000).unref?.();
  };
  process.on("SIGINT", () => { onSignal("SIGINT"); });
  process.on("SIGTERM", () => { onSignal("SIGTERM"); });
  process.on("exit", () => takeDown("SIGTERM"));

  const watch = setInterval(() => {
    const silentMs = Date.now() - lastOutputAt;
    const elapsed = Date.now() - startedAt;
    if (isStalled({ silentMs, limitMs: stallLimit })) {
      stallFired = true;
      log(`STALLED: no suite output for ${Math.round(silentMs / 1000)}s (limit ${Math.round(stallLimit / 1000)}s) after ${Math.round(elapsed / 1000)}s — killing the run instead of hanging.`);
      log(`hint: a hung run is usually CPU starvation (host load) or a test awaiting a child that exited; rerun that file alone, or raise GLLA_TEST_STALL_TIMEOUT_MS if the host is simply slow.`);
      takeDown("SIGTERM");
      setTimeout(() => takeDown("SIGKILL"), 5_000).unref?.();
      return;
    }
    log(`progress: ${Math.round(elapsed / 1000)}s elapsed · ${Math.round(silentMs / 1000)}s since last output · ${(bytes / 1024).toFixed(0)} KiB of suite output`);
  }, beat);
  watch.unref?.();

  const done = (code, signal) => {
    if (settled) return;
    settled = true;
    clearInterval(watch);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (stallFired) {
      log(`FAILED: suite stalled and was terminated after ${elapsed}s`);
      process.exit(1);
    }
    log(`finished in ${elapsed}s (exit ${code}${signal ? `, signal ${signal}` : ""})`);
    process.exit(code ?? 1);
  };
  child.on("error", (error) => {
    log(`could not start bun: ${error.message}`);
    process.exit(1);
  });
  child.on("close", done);
}

// Kept for a caller that explicitly wants a blocking run (tests).
export function runBlocking(args) {
  const child = spawnSync("bun", ["test", ...args], { stdio: "inherit" });
  return child.status ?? 1;
}

const invokedAsScript = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) main();
