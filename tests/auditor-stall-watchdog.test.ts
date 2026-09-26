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
 *
 * 2026-09-26 (slow-audit hardening): failing fast is only half of it — the
 * fail-fast must carry EVIDENCE, and every silence shape must reach it. The
 * worker's own brake shares the parent's silence window, so it often wins the
 * race and returns an atomic "Auditor stalled" RESULT: classified `timeout`,
 * but with no `auditor_stalled` event and no cost record. These tests pin
 * (a) the evidence every stall event carries, under a controlled clock, so a
 * slow audit names its driver; (b) the worker-brake path reporting the same
 * way; and (c) that "silence" still means silence — an open, in-budget tool is
 * exempt from the no-progress bound, exactly as it is from the silence axes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn as realSpawn, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  isWorkerStallError,
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

test("stall: a silent-past-bound attempt fails fast WITH its cost record (controlled clock)", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-stall-evidence-"));
  dirs.push(dir);
  const sigtermMarker = path.join(dir, "sigterm-marker");
  // One heartbeat + two finished tool calls (one of them an image read, i.e.
  // vision work), then total silence — the field shape. The parent never
  // burns the real wall: the injected clock jumps past the silence bound as
  // soon as the snapshot is observed, so the watchdog's DECISION is pinned
  // while the test pays milliseconds.
  const worker = path.join(dir, "costed-then-silent-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const finished = Date.now();
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 42_000, promptBytes: 123_456, reportBytes: 789,
  lastActivityAt: finished, recentOutput: ["partial report"],
  toolCalls: [
    { name: "read", argsPrefix: "{\\"path\\":\\"src/a.ts\\"}", finishedAt: finished },
    { name: "read", argsPrefix: "{\\"path\\":\\"shots/01-home.png\\"}", finishedAt: finished },
  ],
}));
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(sigtermMarker)}, "killed"); process.exit(0); });
setInterval(() => {}, 1_000);
`);
  let clock = Date.now();
  const stalled: AuditorStalledInfo[] = [];
  const started = Date.now();
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model",
    thinkingLevel: "high",
    onProgress: (progress) => {
      // Controlled clock: jump the parent's view of time past the silence
      // bound on the first observed snapshot. Everything else (worker, poll
      // loop, SIGTERM teardown) still runs for real.
      if (progress.lastActivityAt) clock = Math.max(clock, progress.lastActivityAt) + 4_000;
    },
    onStalled: (info) => stalled.push(info),
    runtime: {
      now: () => clock,
      workerPath: worker,
      attemptId: () => "attempt-stall-evidence",
      pollIntervalMs: 10,
      wallTimeoutMs: 20_000,
      heartbeatNoProgressMs: 1_200,
      firstEventTimeoutMs: 20_000,
      heartbeatFreshMs: 500,
    },
  });
  assert.equal(result.infrastructureClass, "timeout", "silence past the bound is still retryable infra");
  assert.match(result.error ?? "", /Auditor stalled — no session activity for/);
  assert.equal(stalled.length, 1, "one stall event per attempt");
  const stall = stalled[0]!;
  assert.equal(stall.reason, "heartbeat-stale");
  assert.ok(stall.heartbeatAgeMs >= 1_200, `silence reached the window: ${stall.heartbeatAgeMs}ms`);
  assert.ok(
    Date.now() - started < 10_000,
    "the controlled clock tripped the watchdog — the doomed attempt burns no real wall",
  );
  // The evidence: a slow audit must be able to name its driver.
  assert.equal(stall.cost?.promptBytes, 123_456, "prompt bytes are the worker's own measurement");
  assert.equal(stall.cost?.toolCallsTotal, 2);
  assert.deepEqual(stall.cost?.toolCallsByName, { read: 2 });
  assert.equal(stall.cost?.visionInputs, 1, "the image read is recorded as vision work");
  assert.equal(stall.cost?.reportBytes, 789);
  assert.equal(stall.cost?.elapsedMs, 42_000, "worker-measured elapsed survives into the evidence");
  assert.ok(existsSync(sigtermMarker), "the silent worker was SIGTERMed");
  await cleanup();
});

test("stall: a worker-reported brake is reclassified with the same evidence", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-brake-"));
  dirs.push(dir);
  // The worker wins the shared silence window: it publishes its own atomic
  // stall result (exactly what scripts/goal-auditor-worker.mjs writes when
  // GLLA_AUDITOR_STALL_MS elapses with no tool running) instead of leaving a
  // parent watchdog to fire.
  const worker = path.join(dir, "self-braked-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const stamp = Date.now();
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 600_000, promptBytes: 98_765, lastActivityAt: stamp,
  recentOutput: [], toolCalls: [{ name: "bash", argsPrefix: "{\\"command\\":\\"bun test\\"}", finishedAt: stamp }],
}));
await writeFile(dir + "/result.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  ok: false, output: "", model: request.model, thinkingLevel: request.thinkingLevel,
  error: "Auditor stalled — no session activity for 10m while no auditor tool was running, so it was aborted.",
  toolCalls: [],
}));
setInterval(() => {}, 1_000);
`);
  const stalled: AuditorStalledInfo[] = [];
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-worker-brake",
      pollIntervalMs: 10,
      wallTimeoutMs: 20_000,
      heartbeatNoProgressMs: 1_200,
      firstEventTimeoutMs: 1_200,
      heartbeatFreshMs: 500,
    },
  });
  assert.equal(result.infrastructureClass, "timeout", "the worker's own brake stays retryable infra");
  assert.equal(stalled.length, 1, "a worker-reported stall produces the same evidence event");
  const stall = stalled[0]!;
  assert.equal(stall.reason, "worker-brake", "the event says the WORKER braked, not a parent watchdog");
  assert.match(stall.workerError ?? "", /no session activity for 10m/, "the worker's own headline is preserved");
  assert.equal(stall.cost?.promptBytes, 98_765);
  assert.equal(stall.cost?.toolCallsTotal, 1);
  assert.equal(stall.cost?.visionInputs, 0);
  assert.equal(stall.cost?.elapsedMs, 600_000, "a 10-minute stall carries its own elapsed evidence");
  assert.equal(isWorkerStallError(stall.workerError), true);
  assert.equal(isWorkerStallError("worker produced no verdict"), false);
  await cleanup();
});

test("stall: an open in-budget tool is not silence — the no-progress bound spares it", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-tool-silence-"));
  dirs.push(dir);
  // Fresh heartbeats, no progress signature change, an OPEN tool well inside
  // its own budget. That is a long test suite, not a wedged worker: the
  // per-tool watchdog owns this axis, so the audit must survive the
  // no-progress window elapsing (10x) and settle on its verdict.
  const worker = path.join(dir, "long-tool-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile, rename } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const openedAt = Date.now();
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 10, lastActivityAt: openedAt,
  currentTool: "bash", currentToolArgs: "{\\"command\\":\\"bun test\\"}",
  currentToolStartedAt: openedAt, currentToolTimeoutMs: 60_000,
  recentOutput: [], toolCalls: [],
}));
let tick = 0;
let next = setTimeout(() => { void beat(); }, 20);
async function beat() {
  tick++;
  await writeFile(dir + "/progress.tmp", JSON.stringify({
    protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
    phase: "running", elapsedMs: 10 + tick * 20, lastActivityAt: Date.now(),
    currentTool: "bash", currentToolArgs: "{\\"command\\":\\"bun test\\"}",
    currentToolStartedAt: openedAt, currentToolTimeoutMs: 60_000,
    recentOutput: [], toolCalls: [],
  }));
  await rename(dir + "/progress.tmp", dir + "/progress.json");
  if (tick >= 60) {
    await writeFile(dir + "/result.json", JSON.stringify({
      protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
      ok: true, output: "<evidence>long suite finished</evidence>\\n<approved/>",
      model: request.model, thinkingLevel: request.thinkingLevel,
      toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }],
    }));
    return;
  }
  // Serialized recursion: overlapping ticks would race on progress.tmp and
  // kill the worker with an ENOENT rename, which is a fixture bug, not a
  // product signal.
  next = setTimeout(() => { void beat(); }, 20);
}
process.on("SIGTERM", () => { clearTimeout(next); process.exit(0); });
`);
  const stalled: AuditorStalledInfo[] = [];
  const started = Date.now();
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal: { ...goal, verificationContract: undefined },
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-tool-silence",
      pollIntervalMs: 10,
      wallTimeoutMs: 30_000,
      // Ten times smaller than the tool's own 60s grant: without the open-tool
      // exemption the no-progress watchdog cut a healthy audit in half.
      heartbeatNoProgressMs: 300,
      firstEventTimeoutMs: 30_000,
      heartbeatFreshMs: 5_000,
      toolTimeoutMs: 60_000,
    },
  });
  assert.deepEqual(stalled, [], "an in-budget open tool is exempt from the no-progress bound");
  assert.equal(result.approved, true, result.error ?? "the long-tool audit did not settle");
  assert.ok(Date.now() - started >= 1_000, "the audit outlived the no-progress window many times over");
  await cleanup();
});
