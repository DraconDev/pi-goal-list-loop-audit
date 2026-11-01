// tests/glla-wipe-real-path.test.ts
//
// note.md item 3 — "/glla wipe is slow; after waiting it out everything was
// normal." This test drives the REAL `cmdGllaWipe` (via the `/glla` command that
// the user types), not a sub-operation, because the slowness was never in the
// operations that look expensive (readState, queue scan, archive render/write —
// all sub-millisecond).
//
// Root cause (measured, not assumed): the wipe archives the goal, the archive
// path fires the postaudit reviewer, and the reviewer streamed the ENTIRE
// multi-month ledger — 280 MB, ~750 ms — to answer two questions that are both
// bounded to today ("did a review fire in the last 5 minutes", "how many fired
// today"). At the real profile that one scan was ~80% of a 650-900 ms wipe.
//
// The pin is deterministic rather than a stopwatch: the wipe must not invoke the
// unbounded `scanLedgerRecords`. A wall-clock ceiling alone is too weak here — a
// loaded host can let a full rescan slip underneath it, which is exactly how an
// earlier version of this control silently passed.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import {
  __testOnlyLedgerScanRecordsCalls,
  __testOnlyResetLedgerScanRecordsCalls,
  ledgerFiles,
} from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal } from "./harness/mock-pi.js";
import { scaledBudgetMs } from "../scripts/host-contention.mjs";

const pi = new MockPi();
activate(pi.api);

const DAY = 24 * 60 * 60_000;

/** A ledger profile shaped like the real one: months of rotated history plus a
 * small live tail. Returns the total bytes stored so the test can state what a
 * full scan would have had to read. */
function seedHistoricalLedger(cwd: string, segments: number, rowsPerSegment: number): number {
  const dir = path.join(cwd, ".pi-glla", "ledger-segments");
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const oldAt = new Date(Date.now() - 200 * DAY).toISOString();
  // A fat payload so a full scan is genuinely expensive to parse, like the real
  // segments (28 MB, 8 MB, 8 MB …).
  const padding = "x".repeat(420);
  for (let s = 0; s < segments; s++) {
    const lines: string[] = [];
    for (let r = 0; r < rowsPerSegment; r++) {
      lines.push(JSON.stringify({ type: "state", at: oldAt, value: { goal: { id: `old-${s}-${r}` }, padding } }));
    }
    const body = lines.join("\n") + "\n";
    // Segment names carry a leading ms timestamp and must sort chronologically.
    const name = `segment-${1780000000000 + s * 1000}-1-old${s}.jsonl`;
    fs.writeFileSync(path.join(dir, name), body);
    bytes += Buffer.byteLength(body);
  }
  return bytes;
}

function gllaCtx(cwd: string) {
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "main-session-manager-wipe-real" } });
  Object.assign(ctx, { hasUI: true, modelRegistry: { find: () => undefined, getAvailable: () => [(ctx as any).model], getAll: () => [(ctx as any).model], hasConfiguredAuth: () => true } });
  Object.assign(ctx.ui, { confirmImpl: () => Promise.resolve(true) });
  return ctx;
}

test("/glla wipe does not read the whole ledger history to archive a goal", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const historyBytes = seedHistoricalLedger(cwd, 24, 2000);
  assert.ok(historyBytes > 20_000_000, `fixture should be a real history (got ${historyBytes} bytes)`);
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "wipe on a heavy ledger" }) });
  // The live ledger (`active.jsonl`) is the newest file, so today's rows belong
  // there — this is what makes the bounded newest-first read find them.
  fs.appendFileSync(path.join(cwd, ".pi-glla", "active.jsonl"),
    JSON.stringify({ type: "reviewer_fired", at: new Date().toISOString(), value: { goalId: "live" } }) + "\n");
  const ctx = gllaCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    __testOnlyResetLedgerScanRecordsCalls();
    const started = Date.now();
    await pi.command("glla", "wipe", ctx);
    const elapsed = Date.now() - started;

    // The wipe really ran: the goal was archived, not short-circuited.
    const notified = ctx.ui.notifies.map((n) => n.message).join("\n");
    assert.match(notified, /glla wipe done/);
    assert.match(notified, /archived as aborted/);

    // The pin: the unbounded full-history scan must not run during a wipe.
    assert.equal(__testOnlyLedgerScanRecordsCalls(), 0,
      "the wipe performed a full-ledger scan — the reviewer is reading all history again");

    // And it must stay perceptually instant even though a full scan of this
    // fixture alone takes far longer than the ceiling.
    const ceiling = scaledBudgetMs(400);
    assert.ok(elapsed < ceiling,
      `wipe over ${(historyBytes / 1e6).toFixed(0)}MB of history took ${elapsed}ms (ceiling ${Math.round(ceiling)}ms) — the full scan is back`);
  } finally {
    __testOnlyResetStaleFlag();
  }
});

test("the bounded scan still finds today's reviewer_fired rows in the live tail", async () => {
  const cwd = tmpCwd();
  seedHistoricalLedger(cwd, 6, 200);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"),
    JSON.stringify({ type: "state", at: new Date(Date.now() - 100 * DAY).toISOString(), value: { goal: null } }) + "\n" +
    JSON.stringify({ type: "reviewer_fired", at: new Date().toISOString(), value: { goalId: "live" } }) + "\n");
  const { scanLedgerRecordsSince } = await import("../extensions/goal-loop-core.js");
  const seen: string[] = [];
  const segments = scanLedgerRecordsSince(cwd, Date.now() - DAY, (e) => seen.push(e.type));
  assert.ok(seen.includes("reviewer_fired"), "today's reviewer row must not be skipped");
  assert.equal(seen.filter((t) => t === "state").length, 0,
    "rows older than the lookback must not be delivered");
  // The live tail, plus exactly one boundary segment that proves the rest is
  // older. Never the whole history.
  assert.ok(segments <= 2,
    `bounded read touched ${segments} of ${ledgerFiles(cwd).length} segments; only the tail is relevant`);
  assert.ok(ledgerFiles(cwd).length >= 7, "the historical segments are still present — the read was bounded, not the data");
});

test("a row with no timestamp is delivered rather than silently dropped", async () => {
  const cwd = tmpCwd();
  const dir = path.join(cwd, ".pi-glla", "ledger-segments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"),
    JSON.stringify({ type: "untimestamped" }) + "\n" + JSON.stringify({ type: "reviewer_fired", at: new Date().toISOString() }) + "\n");
  const { scanLedgerRecordsSince } = await import("../extensions/goal-loop-core.js");
  const seen: string[] = [];
  scanLedgerRecordsSince(cwd, Date.now() - DAY, (e) => seen.push(e.type));
  assert.ok(seen.includes("untimestamped"),
    "a record we cannot date must not be excluded — correctness outranks the speedup");
});
