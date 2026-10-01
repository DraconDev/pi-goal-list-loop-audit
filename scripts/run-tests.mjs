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
// Observable progress and bounded suite-group cleanup. The field reported a
// suite that produced nothing for 37 minutes and a 26-hour-old `bun test`
// still burning a core: a runner you cannot see is a runner you cannot trust.
// So this wrapper now:
//   1. streams a periodic progress heartbeat (bytes of suite output seen),
//   2. fails LOUDLY instead of hanging when the suite goes silent past a
//      bounded stall window, and
//   3. always takes its child down with it (SIGINT/SIGTERM/exit), so an
//      interrupted run cleans its suite group before reporting failure.
// Separately detached workers require their own ownership cleanup (F3).
// The heartbeat goes to stderr so piping stdout still gives clean test output.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { terminateContainedChild } from "./contained-child.mjs";
import { createTestProcessRegistry, registerOwnedTestProcess, reapOwnedTestProcesses } from "./test-process-registry.mjs";
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

  // Give the suite a group we can terminate without signalling this wrapper.
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-test-processes-"));
  const testEnv = { ...process.env, ...createTestProcessRegistry(registryDir) };
  testEnv.GLLA_TEST_ROOT_PROCESS_REGISTRY ??= testEnv.GLLA_TEST_PROCESS_REGISTRY;
  testEnv.GLLA_TEST_ROOT_PROCESS_TOKEN ??= testEnv.GLLA_TEST_PROCESS_TOKEN;
  const child = spawn("bun", ["test", ...bunArgs], { stdio: ["inherit", "pipe", "pipe"], detached: true, env: testEnv });
  let bytes = 0;
  let lastOutputAt = Date.now();
  let settled = false;
  let stallFired = false;
  let interruptedExitCode;
  let cleanupPromise;
  let exitCleanupTimer;
  const cleanup = () => cleanupPromise ??= terminateContainedChild(child, { graceMs: 5000 });
  child.once("exit", () => {
    // A descendant retaining a pipe must not prevent close/status delivery.
    exitCleanupTimer = setTimeout(() => { void cleanup(); }, 100);
  });

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
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  // Probe the suite group; detached grandchildren do not belong to it.
  try {
    process.kill(-child.pid, 0);
    // Keep the exit-status obligation referenced. Pipe EOF can precede
    // ChildProcess.close; unref here let a failed suite become exit 0.
  } catch (error) {
    log(`WARNING: the suite child is not its own process group (${error?.code ?? error?.message}) — takeDown can only signal the direct child, so orphaned grandchildren may survive the run.`);
  }

  const onSignal = (signal) => {
    interruptedExitCode ??= signal === "SIGINT" ? 130 : 143;
    log(`received ${signal} — cleaning up the suite group`);
    void cleanup();
  };
  process.on("SIGINT", () => { onSignal("SIGINT"); });
  process.on("SIGTERM", () => { onSignal("SIGTERM"); });
  process.on("exit", () => takeDown("SIGTERM"));

  const watch = setInterval(() => {
    const silentMs = Date.now() - lastOutputAt;
    const elapsed = Date.now() - startedAt;
    if (!stallFired && isStalled({ silentMs, limitMs: stallLimit })) {
      stallFired = true;
      log(`STALLED: no suite output for ${Math.round(silentMs / 1000)}s (limit ${Math.round(stallLimit / 1000)}s) after ${Math.round(elapsed / 1000)}s — killing the run instead of hanging.`);
      log(`hint: a hung run is usually CPU starvation (host load) or a test awaiting a child that exited; rerun that file alone, or raise GLLA_TEST_STALL_TIMEOUT_MS if the host is simply slow.`);
      void cleanup();
      return;
    }
    log(`progress: ${Math.round(elapsed / 1000)}s elapsed · ${Math.round(silentMs / 1000)}s since last output · ${(bytes / 1024).toFixed(0)} KiB of suite output`);
  }, beat);
  watch.unref?.();

  const done = async (code, signal) => {
    if (settled) return;
    settled = true;
    clearInterval(watch);
    clearTimeout(exitCleanupTimer);
    await cleanup();
    const detached = await reapOwnedTestProcesses(testEnv);
    if (detached.reaped || detached.unverified) log(`detached cleanup: ${detached.reaped} owned groups; ${detached.unverified} unverified survivors/records`);
    if (detached.unverified) log(`cleanup evidence retained at ${registryDir}`);
    else {
      fs.rmSync(registryDir, { recursive: true, force: true });
      fs.rmSync(`${registryDir}.obligations`, { recursive: true, force: true });
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (stallFired) {
      log(`FAILED: suite stalled and was terminated after ${elapsed}s`);
      process.exit(1);
    }
    log(`finished in ${elapsed}s (exit ${code}${signal ? `, signal ${signal}` : ""})`);
    process.exit(interruptedExitCode ?? (detached.unverified ? 1 : code ?? 1));
  };
  child.on("error", (error) => {
    log(`could not start bun: ${error.message}`);
    void done(1);
  });
  child.on("close", done);
  // Registration can fail while the newly launched suite is already running.
  // Install containment and settlement handlers first, then retain/reap its
  // failed obligation through the same exit path as every other launch error.
  try { registerOwnedTestProcess(child, testEnv); }
  catch (error) {
    log(`could not register bun: ${error.message}`);
    void done(1);
  }
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
