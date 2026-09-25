/**
 * v0.35.49 — parent-side silence watchdogs for the detached auditor.
 *
 * Field evidence (2026-08-23, football-forever / doomtap / junk-runner /
 * email-api-compare / vps-compare): a worker whose provider hangs emits ONE
 * boot RPC event (or none) and then total silence. The fresh-heartbeat
 * no-progress watchdog (v0.34.57) only arms while heartbeats stay fresh, so
 * a stale heartbeat DISARMS it and every doomed attempt burned its full 30m
 * wall while the goal sat "auditing" and the queue looked dead. These tests
 * pin the two complementary axes: no first event ever, and a heartbeat that
 * went stale. Both must fail fast into the eager retry ladder instead of the
 * wall.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn as realSpawn, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  runDetachedGoalCompletionAuditor,
  type AuditorProgress,
  type AuditorStalledInfo,
} from "../extensions/goal-loop-auditor-process.ts";

const goal = {
  id: "test-stall-watchdog",
  objective: "prove the silence watchdogs fire",
  status: "active" as const,
  policy: "goal" as const,
  verificationContract: "Done when:\n- the verdict lands",
  autoContinue: false,
  usage: { tokensUsed: 0, tokensLimit: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const dirs: string[] = [];

async function cleanup(): Promise<void> {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
}

test("stall: worker that never emits a first event is failed fast, not left for the wall", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-first-event-stall-"));
  dirs.push(dir);
  const sigtermMarker = path.join(dir, "sigterm-marker");
  // Silent worker: writes NOTHING (not even a heartbeat), never exits, and
  // honors SIGTERM so the parent's teardown stays observable.
  const worker = path.join(dir, "silent-worker.mjs");
  await writeFile(worker, `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(sigtermMarker)}, "killed"); process.exit(0); });
setInterval(() => {}, 1_000);
`);
  const stalled: AuditorStalledInfo[] = [];
  const reports: AuditorProgress[] = [];
  const started = Date.now();
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model",
    thinkingLevel: "high",
    onProgress: (progress) => reports.push(progress),
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-first-event-stall",
      pollIntervalMs: 10,
      // Wall deliberately exceeds the silence window: the STALL must fire
      // first — that is the entire point of the watchdog.
      wallTimeoutMs: 10_000,
      // Give the detached Node child enough startup budget to install its
      // SIGTERM handler on the busy full-suite rig. The first-event watchdog
      // still fires well before the 10s wall; the delayed launcher already
      // consumes 1.5s before the child can install its handler.
      firstEventTimeoutMs: 5_000,
      heartbeatNoProgressMs: 20_000,
      heartbeatFreshMs: 500,
    },
  });
  assert.equal(result.approved, false, "a stalled worker is never a verdict");
  assert.equal(result.disapproved, false, "a stalled worker is never a verdict");
  assert.match(result.error ?? "", /Auditor stalled — no session activity since boot/);
  assert.match(result.error ?? "", /auto-cancelled/);
  assert.equal(result.infrastructureClass, "timeout", "the stall classifies as retryable infra, feeding the eager ladder");
  assert.equal(stalled.length, 1, "the watchdog emits auditor_stalled exactly once");
  assert.equal(stalled[0]!.reason, "first-event-timeout");
  assert.ok(stalled[0]!.noProgressMs >= 1_200, `silence reached the window: ${stalled[0]!.noProgressMs}ms`);
  assert.ok(
    Date.now() - started < 9_000,
    "the stall fired well before the 10s wall — the doomed attempt must not burn its full wall",
  );
  assert.ok(existsSync(sigtermMarker), "the silent worker was SIGTERMed — the detached job was cancelled");
  assert.equal(
    existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-first-event-stall")),
    false,
    "cancelled auditor job scratch is removed",
  );
  await cleanup();
});

test("stall: first-event budget starts after successful spawn, not pre-spawn setup", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-first-event-clock-"));
  dirs.push(dir);
  const sigtermMarker = path.join(dir, "sigterm-marker");
  const worker = path.join(dir, "silent-worker.mjs");
  await writeFile(worker, `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(sigtermMarker)}, "killed"); process.exit(0); });
setInterval(() => {}, 1_000);
`);
  let spawnReturnedAt = 0;
  const delayedSpawn = ((command: string, args: string[], options: SpawnOptions) => {
    // Simulate a busy parent completing dispatch setup immediately before
    // spawn. The watchdog must not charge this delay to worker startup.
    const blocker = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(blocker, 0, 0, 1_500);
    const spawned = realSpawn(command, args, options);
    spawnReturnedAt = Date.now();
    return spawned;
  }) as typeof realSpawn;
  const stalled: AuditorStalledInfo[] = [];
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      spawn: delayedSpawn,
      attemptId: () => "attempt-first-event-clock",
      pollIntervalMs: 10,
      wallTimeoutMs: 10_000,
      firstEventTimeoutMs: 5_000,
      heartbeatNoProgressMs: 20_000,
      heartbeatFreshMs: 500,
    },
  });
  assert.equal(result.infrastructureClass, "timeout", result.error ?? "no error");
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0]!.reason, "first-event-timeout");
  assert.ok(spawnReturnedAt > 0, "the injected launcher returned a child");
  assert.ok(
    stalled[0]!.at - spawnReturnedAt >= 700,
    `first-event budget was measured after spawn: ${stalled[0]!.at - spawnReturnedAt}ms`,
  );
  assert.ok(stalled[0]!.at - spawnReturnedAt < 9_000, "the watchdog still beats the wall bound");
  assert.ok(existsSync(sigtermMarker), "the delayed-start worker was SIGTERMed");
  await cleanup();
});

test("stall: worker whose single boot heartbeat goes stale is failed fast, not left for the wall", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-stale-heartbeat-stall-"));
  dirs.push(dir);
  const sigtermMarker = path.join(dir, "sigterm-marker");
  // Boot-event worker: ONE heartbeat at boot, then total silence (the
  // provider-hang shape from the field), never a result, honors SIGTERM.
  const worker = path.join(dir, "boot-then-silent-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 1,
  lastActivityAt: Date.now(),
  recentOutput: [], toolCalls: [],
}));
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(sigtermMarker)}, "killed"); process.exit(0); });
setInterval(() => {}, 1_000);
`);
  const stalled: AuditorStalledInfo[] = [];
  const started = Date.now();
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-stale-heartbeat-stall",
      pollIntervalMs: 10,
      wallTimeoutMs: 10_000,
      heartbeatNoProgressMs: 1_200,
      firstEventTimeoutMs: 20_000,
      heartbeatFreshMs: 500,
    },
  });
  assert.equal(result.approved, false, "a stalled worker is never a verdict");
  assert.equal(result.disapproved, false, "a stalled worker is never a verdict");
  assert.match(result.error ?? "", /Auditor stalled — no session activity for/);
  assert.equal(result.infrastructureClass, "timeout", "the stall classifies as retryable infra, feeding the eager ladder");
  assert.equal(stalled.length, 1, "the watchdog emits auditor_stalled exactly once");
  assert.equal(stalled[0]!.reason, "heartbeat-stale");
  assert.ok(stalled[0]!.heartbeatAgeMs >= 1_200, `heartbeat was stale at detection: ${stalled[0]!.heartbeatAgeMs}ms`);
  assert.ok(
    Date.now() - started < 9_000,
    "the stall fired well before the 10s wall — the doomed attempt must not burn its full wall",
  );
  assert.ok(existsSync(sigtermMarker), "the wedged worker was SIGTERMed — the detached job was cancelled");
  await cleanup();
});

test("progress: a live auditor outlives the legacy wall metadata and settles on its result", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-live-progress-") );
  dirs.push(dir);
  const worker = path.join(dir, "progress-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const progressPath = dir + "/progress.json";
const resultPath = dir + "/result.json";
let tick = 0;
const publish = async () => {
  tick++;
  await writeFile(progressPath, JSON.stringify({
    protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
    phase: "running", elapsedMs: tick * 20, lastActivityAt: Date.now(),
    recentOutput: ["live-progress-" + tick], toolCalls: [],
  }));
  if (tick >= 12) {
    clearInterval(timer);
    await writeFile(resultPath, JSON.stringify({
      protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
      ok: true, output: "<evidence>live progress</evidence>\\n<approved/>",
      model: request.model, thinkingLevel: request.thinkingLevel,
      toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }],
    }));
  }
};
const timer = setInterval(() => { void publish(); }, 20);
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
`);
  const reports: AuditorProgress[] = [];
  const started = Date.now();
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal: { ...goal, verificationContract: undefined },
    model: "test/provider-model",
    thinkingLevel: "high",
    onProgress: (progress) => reports.push(progress),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-live-progress",
      pollIntervalMs: 10,
      // This deliberately expires before the worker's first result. It is
      // legacy metadata only; real progress and the result must win.
      wallTimeoutMs: 100,
      firstEventTimeoutMs: 5_000,
      heartbeatNoProgressMs: 2_000,
      heartbeatFreshMs: 1_000,
    },
  });
  assert.equal(result.approved, true, result.error ?? "live worker did not settle");
  assert.equal(result.error, undefined);
  assert.ok(Date.now() - started >= 180, "the worker remained alive beyond the ignored legacy wall metadata");
  assert.ok(reports.some((progress) => (progress.recentOutput.at(-1) ?? "").startsWith("live-progress-")), "real child progress reached the parent");
  await cleanup();
});

test("stall: a running auditor tool is exempt — the per-tool timeout owns that axis", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-tool-exempt-"));
  dirs.push(dir);
  // Worker opens a tool (currentToolStartedAt set) and then emits nothing:
  // the silence watchdogs must NOT fire — the independent per-tool timeout
  // owns termination while a tool is open.
  const worker = path.join(dir, "tool-open-silent-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const boot = JSON.parse(await readFile(dir + "/progress.json", "utf8"));
await writeFile(dir + "/progress.json", JSON.stringify({
  ...boot,
  phase: "running",
  lastActivityAt: Date.now(),
  currentTool: "bash",
  currentToolArgs: "{\\"command\\":\\"sleep 30\\"}",
  currentToolStartedAt: Date.now(),
}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`);
  const stalled: AuditorStalledInfo[] = [];
  let toolTimedOut = false;
  const pending = runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-tool-exempt",
      pollIntervalMs: 10,
      // A legacy wall shorter than the open tool must be ignored; the
      // independent per-tool watchdog owns this axis.
      wallTimeoutMs: 250,
      toolTimeoutMs: 800,
      heartbeatNoProgressMs: 1_200,
      firstEventTimeoutMs: 20_000,
      heartbeatFreshMs: 500,
    },
  }).then((result) => {
    toolTimedOut = /tool bash exceeded its 1s timeout/.test(result.error ?? "");
    return result;
  });
  const result = await pending;
  assert.equal(stalled.length, 1, "the per-tool watchdog owns the open-tool timeout");
  assert.equal(stalled[0]?.reason, "tool-timeout");
  assert.ok(toolTimedOut, "the run ended on the per-tool safety bound, not the legacy wall");
  assert.equal(result.infrastructureClass, "timeout");
  await cleanup();
});
