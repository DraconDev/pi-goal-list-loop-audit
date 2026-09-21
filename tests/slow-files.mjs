// pi-goal-list-loop-audit — v0.38.82
// tests/slow-files.mjs
//
// Files too slow for the default fast loop (each over ~8s standalone;
// the full serialized suite is ~7 minutes). `npm test` (fast) excludes
// these via bun --path-ignore-patterns; `npm run test:slow` runs them;
// `npm run test:all` / release:check still run everything, so nothing
// escapes the gate. Timings below are standalone per-file runs on the
// maintainer rig (2026-09-21) — re-time when the suite shape changes.
//
// NOTE: this file is not *.test.* by design — bun never runs it.

// [placeholder — filled from the timing sweep]
export const SLOW_TEST_FILES = [];
