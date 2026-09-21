#!/usr/bin/env node
// pi-goal-list-loop-audit — v0.38.82
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

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SLOW_TEST_FILES } from "../tests/slow-files.mjs";

export const SERIAL_FLAGS = ["--parallel=1", "--max-concurrency=1", "--timeout=60000"];

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

function main() {
  const { mode, bunArgs } = buildRunnerArgs(process.argv.slice(2), SLOW_TEST_FILES);
  if (process.env.GLLA_TEST_RUNNER_QUIET !== "1") {
    // eslint-disable-next-line no-console
    console.log(`[run-tests] mode=${mode} slow_files=${SLOW_TEST_FILES.length}`);
  }
  const child = spawnSync("bun", ["test", ...bunArgs], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}

const invokedAsScript = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) main();
