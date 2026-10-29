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
import { scaledBudgetMs } from "../scripts/host-contention.mjs";
const VERDICT_HELPER = path.join(path.dirname(new URL(import.meta.url).pathname), "harness", "fake-auditor-verdict.mjs");

/** The scenario budgets below are the PRODUCT's own timing knobs, and the
 * detached child has to boot, be observed and do its work inside them. The
 * parent polls the child's progress file; on a loaded host that poll loop is
 * starved, so it can miss a heartbeat the scenario expected it to see, and
 * a fixed scenario number then measures the HOST instead of the product.
 *
 * Scaling the scenario keeps the RELATIONSHIP each test asserts — the stall
 * fires before the wall, an open in-budget tool is spared, a stale heartbeat
 * is caught — while letting the absolute numbers fit the machine. On an idle
 * host the factor is 1.0 and every number is exactly what it was.
 */

/** Wait for an observable side effect. A signal is delivered to a process
 * that then runs its handler; the observer sees the EFFECT a moment after
 * the signal was sent, and on a loaded host that moment is not
 * instantaneous. */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + scaledBudgetMs(timeoutMs);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Assert the detached worker was torn down, accepting EITHER observable
 * consequence of the cancellation.
 *
 * `terminateWorker` signals the child's process group (SIGTERM, then SIGKILL
 * after the grace window) and the parent then removes the job scratch. The
 * worker's own SIGTERM handler writes a marker — but the handler only exists
 * once the child has BOOTED far enough to install it. On a saturated host the
 * watchdog fires before that, so the signal hits the default disposition and
 * the child dies with no marker: the cancellation is correct, the marker never
 * appears, and a marker-only assertion reports a healthy watchdog as broken
 * (observed as a contended full-gate failure at load 35 on 16 cores).
 *
 * So the assertion is the cancellation itself, not one host-dependent
 * symptom of it: the handler ran, OR the process is gone and its job scratch
 * was reaped. A worker that survives the cancellation still fails.
 */
async function assertWorkerTornDown(childMarker: string, jobDir: string): Promise<void> {
  await waitFor(
    () => existsSync(childMarker) || (jobDir !== undefined && !existsSync(jobDir)),
    "the detached silent worker was cancelled (handler ran, or the job was reaped)",
  );
}

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

test("stall: worker that never emits a first event is failed fast, not left for the wall", { timeout: scaledBudgetMs(80_000) }, async () => {
  const wall = scaledBudgetMs(10_000), firstEvent = scaledBudgetMs(5_000);
  const noProgress = scaledBudgetMs(20_000), fresh = scaledBudgetMs(500);
  const silenceFloor = scaledBudgetMs(1_200);

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
      wallTimeoutMs: wall,
      // Give the detached Node child enough startup budget to install its
      // SIGTERM handler on the busy full-suite rig. The first-event watchdog
      // still fires well before the 10s wall; the delayed launcher already
      // consumes 1.5s before the child can install its handler.
      firstEventTimeoutMs: firstEvent,
      heartbeatNoProgressMs: noProgress,
      heartbeatFreshMs: fresh,
    },
  });
  assert.equal(result.approved, false, "a stalled worker is never a verdict");
  assert.equal(result.disapproved, false, "a stalled worker is never a verdict");
  assert.match(result.error ?? "", /Auditor stalled — no session activity since boot/);
  assert.match(result.error ?? "", /auto-cancelled/);
  assert.equal(result.infrastructureClass, "timeout", "the stall classifies as retryable infra, feeding the eager ladder");
  assert.equal(stalled.length, 1, "the watchdog emits auditor_stalled exactly once");
  assert.equal(stalled[0]!.reason, "first-event-timeout");
  assert.ok(stalled[0]!.noProgressMs >= silenceFloor, `silence reached the window: ${stalled[0]!.noProgressMs}ms`);
  assert.ok(
    Date.now() - started < wall - 1_000,
    "the stall fired well before the 10s wall — the doomed attempt must not burn its full wall",
  );
  // The child installs its SIGTERM handler as its first statement, but the
  // handler RUNS a moment after the signal is delivered: the parent returns
  // as soon as it has sent it. Wait for the cancellation's observable effect
  // instead of racing it — and accept either effect, because on a starved
  // host the watchdog may fire before the child has installed the handler.
  await assertWorkerTornDown(sigtermMarker, path.join(dir, ".pi-glla", "audit-jobs", "attempt-first-event-stall"));
  assert.equal(
    existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-first-event-stall")),
    false,
    "cancelled auditor job scratch is removed",
  );
  await cleanup();
});

test("stall: first-event budget starts after successful spawn, not pre-spawn setup", { timeout: scaledBudgetMs(80_000) }, async () => {
  const wall = scaledBudgetMs(10_000), firstEvent = scaledBudgetMs(5_000);
  const noProgress = scaledBudgetMs(20_000), fresh = scaledBudgetMs(500);

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
      wallTimeoutMs: wall,
      firstEventTimeoutMs: firstEvent,
      heartbeatNoProgressMs: noProgress,
      heartbeatFreshMs: fresh,
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
  // The gap is the first-event budget plus however long the parent's timer
  // callback took to run — the latter is the HOST's business, not the
  // product's. The durable claim is the classification asserted above: a
  // "first-event-timeout" stall means the watchdog beat the wall, not the
  // other way round. The bound below is generous enough not to measure host
  // starvation, and still fails if the stall never arrives.
  assert.ok(stalled[0]!.at - spawnReturnedAt < wall + firstEvent, "the watchdog still beats the wall bound");
  await assertWorkerTornDown(sigtermMarker, path.join(dir, ".pi-glla", "audit-jobs", "attempt-first-event-clock"));
  await cleanup();
});

test("stall: worker whose single boot heartbeat goes stale is failed fast, not left for the wall", { timeout: scaledBudgetMs(20_000) }, async () => {
  const wall = scaledBudgetMs(10_000), firstEvent = scaledBudgetMs(20_000);
  const noProgress = scaledBudgetMs(1_200), fresh = scaledBudgetMs(500);

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
      wallTimeoutMs: wall,
      heartbeatNoProgressMs: noProgress,
      firstEventTimeoutMs: firstEvent,
      heartbeatFreshMs: fresh,
    },
  });
  assert.equal(result.approved, false, "a stalled worker is never a verdict");
  assert.equal(result.disapproved, false, "a stalled worker is never a verdict");
  assert.match(result.error ?? "", /Auditor stalled — no session activity for/);
  assert.equal(result.infrastructureClass, "timeout", "the stall classifies as retryable infra, feeding the eager ladder");
  assert.equal(stalled.length, 1, "the watchdog emits auditor_stalled exactly once");
  assert.equal(stalled[0]!.reason, "heartbeat-stale");
  assert.ok(stalled[0]!.heartbeatAgeMs >= noProgress, `heartbeat was stale at detection: ${stalled[0]!.heartbeatAgeMs}ms`);
  assert.ok(
    Date.now() - started < wall - 1_000,
    "the stall fired well before the 10s wall — the doomed attempt must not burn its full wall",
  );
  assert.ok(existsSync(sigtermMarker), "the wedged worker was SIGTERMed — the detached job was cancelled");
  await cleanup();
});

test("progress: a live auditor outlives the legacy wall metadata and settles on its result", { timeout: scaledBudgetMs(60_000) }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-live-progress-") );
  dirs.push(dir);
  const worker = path.join(dir, "progress-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const verdictKey = await readVerdictKey();
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
    await writeFile(resultPath, JSON.stringify(signVerdict({
      protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
      ok: true, output: "<evidence>live progress</evidence>\\n<approved/>",
      model: request.model, thinkingLevel: request.thinkingLevel,
      toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }],
    }, verdictKey)));
  }
};
const timer = setInterval(() => { void publish(); }, 20);
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
`);
  const reports: AuditorProgress[] = [];
  const started = Date.now();
  let eventClock = started;
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal: { ...goal, verificationContract: undefined },
    model: "test/provider-model",
    thinkingLevel: "high",
    onProgress: (progress) => {
      reports.push(progress);
      if (progress.phase === "running" && typeof progress.lastActivityAt === "number") eventClock = Math.max(eventClock, progress.lastActivityAt);
    },
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-live-progress",
      pollIntervalMs: 10,
      // This test owns the progress/wall axis, not subprocess cold-start.
      // Advance the clock on received child events; a missing worker still
      // fails at the bounded outer test deadline. Separate tests own boot silence.
      now: () => eventClock,
      // This deliberately expires before the worker's first result. It is
      // legacy metadata only; real progress and the result must win.
      wallTimeoutMs: 100,
      firstEventTimeoutMs: scaledBudgetMs(5_000),
      heartbeatNoProgressMs: scaledBudgetMs(2_000),
      heartbeatFreshMs: scaledBudgetMs(1_000),
    },
  });
  assert.equal(result.approved, true, result.error ?? "live worker did not settle");
  assert.equal(result.error, undefined);
  assert.ok(Date.now() - started >= 180, "the worker remained alive beyond the ignored legacy wall metadata");
  assert.ok(reports.some((progress) => (progress.recentOutput.at(-1) ?? "").startsWith("live-progress-")), "real child progress reached the parent");
  assert.ok(eventClock - started > 100, "accepted progress crossed the legacy wall deadline");
  await cleanup();
});

test("stall: a running auditor tool is exempt — the per-tool timeout owns that axis", { timeout: scaledBudgetMs(20_000) }, async () => {
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
      wallTimeoutMs: scaledBudgetMs(250),
      toolTimeoutMs: 800,
      // v0.38.99: the parent now grants the worker a bounded window to cancel
      // the over-budget tool and resume before it falls back to the hard kill.
      // A zero grace keeps this test on the pre-grace semantics: the kill is
      // the only way the run can end.
      toolCancelGraceMs: 0,
      heartbeatNoProgressMs: scaledBudgetMs(1_200),
      firstEventTimeoutMs: scaledBudgetMs(20_000),
      heartbeatFreshMs: scaledBudgetMs(500),
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

test("stall: a silent-past-bound attempt fails fast WITH its cost record (controlled clock)", { timeout: scaledBudgetMs(20_000) }, async () => {
  const wall = scaledBudgetMs(20_000), firstEvent = scaledBudgetMs(20_000);
  const noProgress = scaledBudgetMs(1_200), fresh = scaledBudgetMs(500);

  const dir = await mkdtemp(path.join(tmpdir(), "glla-stall-evidence-"));
  dirs.push(dir);
  // One heartbeat + two finished tool calls (one of them an image read, i.e.
  // vision work), then total silence — the field shape. The parent never
  // burns the real wall: the injected clock jumps past the silence bound as
  // soon as the snapshot is observed, so the watchdog's DECISION is pinned
  // while the test pays milliseconds.
  const worker = path.join(dir, "costed-then-silent-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const verdictKey = await readVerdictKey();
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
      // bound on the first observed snapshot. Everything else (the worker, the
      // poll loop, the cancellation and scratch cleanup) still runs for real.
      if (progress.lastActivityAt) clock = Math.max(clock, progress.lastActivityAt) + scaledBudgetMs(4_000);
    },
    onStalled: (info) => stalled.push(info),
    runtime: {
      now: () => clock,
      workerPath: worker,
      attemptId: () => "attempt-stall-evidence",
      pollIntervalMs: 10,
      wallTimeoutMs: wall,
      heartbeatNoProgressMs: noProgress,
      firstEventTimeoutMs: firstEvent,
      heartbeatFreshMs: fresh,
    },
  });
  assert.equal(result.infrastructureClass, "timeout", "silence past the bound is still retryable infra");
  assert.match(result.error ?? "", /Auditor stalled — no session activity for/);
  assert.equal(stalled.length, 1, "one stall event per attempt");
  const stall = stalled[0]!;
  assert.equal(stall.reason, "heartbeat-stale");
  assert.ok(stall.heartbeatAgeMs >= noProgress, `silence reached the window: ${stall.heartbeatAgeMs}ms`);
  assert.ok(
    Date.now() - started < wall / 2,
    "the controlled clock tripped the watchdog — the doomed attempt burns no real wall",
  );
  // The evidence: a slow audit must be able to name its driver.
  assert.equal(stall.cost?.promptBytes, 123_456, "prompt bytes are the worker's own measurement");
  assert.equal(stall.cost?.toolCallsTotal, 2);
  assert.deepEqual(stall.cost?.toolCallsByName, { read: 2 });
  assert.equal(stall.cost?.visionInputs, 1, "the image read is recorded as vision work");
  assert.equal(stall.cost?.reportBytes, 789);
  assert.equal(stall.cost?.elapsedMs, 42_000, "worker-measured elapsed survives into the evidence");
  assert.equal(
    existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-stall-evidence")),
    false,
    "the stalled job was cancelled and its scratch removed",
  );
  await cleanup();
});

test("stall: a worker-reported brake is reclassified with the same evidence", { timeout: scaledBudgetMs(20_000) }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-brake-"));
  dirs.push(dir);
  // The worker wins the shared silence window: it publishes its own atomic
  // stall result (exactly what scripts/goal-auditor-worker.mjs writes when
  // GLLA_AUDITOR_STALL_MS elapses with no tool running) instead of leaving a
  // parent watchdog to fire.
  const worker = path.join(dir, "self-braked-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const verdictKey = await readVerdictKey();
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const stamp = Date.now();
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 600_000, promptBytes: 98_765, lastActivityAt: stamp,
  recentOutput: [], toolCalls: [{ name: "bash", argsPrefix: "{\\"command\\":\\"bun test\\"}", finishedAt: stamp }],
}));
await writeFile(dir + "/result.json", JSON.stringify(signVerdict({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  ok: false, output: "", model: request.model, thinkingLevel: request.thinkingLevel,
  error: "Auditor stalled — no session activity for 10m while no auditor tool was running, so it was aborted.",
  toolCalls: [],
}, verdictKey)));
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
      wallTimeoutMs: scaledBudgetMs(250),
      // The parent watchdogs are deliberately DISARMED here: this test pins
      // the result path (the worker winning the shared window), so the
      // result must be the first thing the parent sees. Both files are
      // published back-to-back, so the parent consumes them in one poll.
      heartbeatNoProgressMs: scaledBudgetMs(1_200),
      firstEventTimeoutMs: scaledBudgetMs(20_000),
      heartbeatFreshMs: scaledBudgetMs(500),
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

test("stall: an open in-budget tool is not silence — the no-progress bound spares it", { timeout: scaledBudgetMs(20_000) }, async () => {
  const wall = scaledBudgetMs(30_000), firstEvent = scaledBudgetMs(30_000);
  const noProgress = scaledBudgetMs(300), fresh = scaledBudgetMs(5_000);

  const dir = await mkdtemp(path.join(tmpdir(), "glla-tool-silence-"));
  dirs.push(dir);
  // Fresh heartbeats, no progress signature change, an OPEN tool well inside
  // its own budget. That is a long test suite, not a wedged worker: the
  // per-tool watchdog owns this axis, so the audit must survive the
  // no-progress window elapsing again and again and still settle on its
  // verdict.
  const worker = path.join(dir, "long-tool-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile, rename } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const verdictKey = await readVerdictKey();
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
  if (tick >= 6) {
    await writeFile(dir + "/result.json", JSON.stringify(signVerdict({
      protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
      ok: true, output: "<evidence>long suite finished</evidence>\\n<approved/>",
      model: request.model, thinkingLevel: request.thinkingLevel,
      toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }],
    }, verdictKey)));
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
  // Controlled clock: every observed snapshot advances the parent's view of
  // time by a full second, so the 300ms no-progress window is crossed again
  // and again in fake time while the fixture only needs six beats. The audit
  // must survive all of it: an open, in-budget tool is work, not silence.
  // (Without the exemption the watchdog fires on the very first jump.)
  let clock = Date.now();
  const started = Date.now();
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal: { ...goal, verificationContract: undefined },
    model: "test/provider-model",
    thinkingLevel: "high",
    onProgress: (progress) => {
      if (progress.lastActivityAt) clock = Math.max(clock, progress.lastActivityAt) + 1_000;
    },
    onStalled: (info) => stalled.push(info),
    runtime: {
      now: () => clock,
      workerPath: worker,
      attemptId: () => "attempt-tool-silence",
      pollIntervalMs: 10,
      wallTimeoutMs: wall,
      // Far smaller than the tool's own 60s grant: without the open-tool
      // exemption the no-progress watchdog cut a healthy audit in half.
      heartbeatNoProgressMs: noProgress,
      firstEventTimeoutMs: firstEvent,
      heartbeatFreshMs: fresh,
      toolTimeoutMs: scaledBudgetMs(60_000),
    },
  });
  assert.deepEqual(stalled, [], "an in-budget open tool is exempt from the no-progress bound");
  assert.equal(result.approved, true, result.error ?? "the long-tool audit did not settle");
  assert.ok(Date.now() - started < wall / 3, "the audit outlived several no-progress windows without burning the wall");
  await cleanup();
});

// ---------------------------------------------------------------------------
// v0.38.99 — non-destructive tool timeout.
//
// Field evidence: on a host at load 48-95 across 16 cores, the auditor's
// verification step (`npm test` / `tsc`) blew the 5m per-tool budget, and the
// watchdog killed the WHOLE attempt — discarding up to 64 completed tool
// calls. The goal then re-audited from zero, hit the same slow step, and
// blew the budget again. That is what "audits not landing" looked like from
// the outside. The worker now cancels the offending tool and resumes, and the
// parent holds its hard kill for a bounded grace window so it cannot race
// that resume.
//
// Audit integrity: a cancelled tool produced NO result, so an approval from
// such an attempt rests on evidence the auditor never saw. The approval is
// refused and the attempt fails as retryable infrastructure — never a
// disapproval (the goal did not regress) and never an approval.
// ---------------------------------------------------------------------------

test("v0.38.99: an over-budget tool is NOT fatal — the worker cancels it, resumes, and its result still lands", { timeout: scaledBudgetMs(25_000) }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-tool-cancel-continue-"));
  dirs.push(dir);
  // The worker opens a tool whose budget is already blown, then — instead of
  // dying — publishes a verdict. Under the old semantics the parent killed it
  // at the budget and this result never arrived.
  const worker = path.join(dir, "cancel-continue-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile, rename } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const verdictKey = await readVerdictKey();
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const openedAt = Date.now() - 5_000; // already past the 800ms budget
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 5_000, lastActivityAt: openedAt,
  currentTool: "bash", currentToolArgs: "{\\"command\\":\\"bun test\\"}",
  currentToolStartedAt: openedAt, currentToolTimeoutMs: 800,
  recentOutput: [], toolCalls: [],
}));
process.on("SIGTERM", () => process.exit(7));
// Survive well past the budget, then land a DISAPPROVED verdict: the
// cancelled verification is not evidence for an approval, so the auditor
// rejects instead of certifying what it never saw.
setTimeout(async () => {
  await writeFile(dir + "/progress.tmp", JSON.stringify({
    protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
    phase: "continuing", elapsedMs: 9_000, lastActivityAt: Date.now(),
    currentTool: undefined, recentOutput: ["resumed"], toolCalls: [],
    verificationIncomplete: true,
  }));
  await rename(dir + "/progress.tmp", dir + "/progress.json");
  await writeFile(dir + "/result.json", JSON.stringify(signVerdict({
    protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
    ok: true, output: "<evidence>suite result unknown; re-ran one targeted test</evidence>\\n<disapproved/>",
    model: request.model, thinkingLevel: request.thinkingLevel,
    toolCalls: [{ name: "bash", argsPrefix: "{\\"command\\":\\"bun test src/x\\"}", finishedAt: Date.now() }],
    verificationIncomplete: true,
    cancelledToolCalls: [{ name: "bash", argsPrefix: "{\\"command\\":\\"bun test\\"}", budgetMs: 800 }],
  }, verdictKey)));
  process.exit(0);
}, 2_500);
setInterval(() => {}, 1_000);
`);
  const stalled: AuditorStalledInfo[] = [];
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal: { ...goal, verificationContract: "" },
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-cancel-continue",
      pollIntervalMs: 10,
      toolTimeoutMs: 800,
      toolCancelGraceMs: 10_000, // wide enough that only the worker can end this
      heartbeatNoProgressMs: scaledBudgetMs(1_200),
      firstEventTimeoutMs: scaledBudgetMs(20_000),
      heartbeatFreshMs: scaledBudgetMs(500),
    },
  });
  assert.equal(stalled.length, 1, "the over-budget tool is recorded as one stall");
  assert.equal(stalled[0]?.reason, "tool-timeout");
  assert.equal(stalled[0]?.toolName, "bash");
  assert.equal(result.approved, false, "a cancelled verification must never approve");
  assert.equal(result.disapproved, true, "the auditor's own disapproval still lands");
  assert.equal(result.error, undefined, "the attempt was not killed mid-flight");
  assert.equal(result.verificationIncomplete, true, "the attempt is flagged for the audit trail");
  await cleanup();
});

test("v0.38.99 approval guard: an approving verdict from a verification-incomplete attempt is refused, not applied", { timeout: scaledBudgetMs(25_000) }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-approval-guard-"));
  dirs.push(dir);
  // The auditor says <approved/> even though one tool call was cancelled and
  // produced no result. That approval rests on evidence the auditor never
  // saw, so it must be refused as retryable infrastructure — NOT applied, and
  // NOT laundered into a disapproval (which would send the agent into
  // pointless rework for a load problem).
  const worker = path.join(dir, "approve-with-cancelled-tool.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const verdictKey = await readVerdictKey();
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const openedAt = Date.now() - 5_000;
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 5_000, lastActivityAt: Date.now(),
  currentTool: "bash", currentToolArgs: "{\\"command\\":\\"bun test\\"}",
  currentToolStartedAt: openedAt, currentToolTimeoutMs: 800,
  recentOutput: [], toolCalls: [],
}));
setTimeout(async () => {
  await writeFile(dir + "/result.json", JSON.stringify(signVerdict({
    protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
    ok: true, output: "<evidence>looks fine to me</evidence>\\n<approved/>",
    model: request.model, thinkingLevel: request.thinkingLevel,
    toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }],
    verificationIncomplete: true,
    cancelledToolCalls: [{ name: "bash", argsPrefix: "{\\"command\\":\\"bun test\\"}", budgetMs: 800 }],
  }, verdictKey)));
  process.exit(0);
}, 1_500);
setInterval(() => {}, 1_000);
`);
  const stalled: AuditorStalledInfo[] = [];
  const result = await runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal: { ...goal, verificationContract: "" },
    model: "test/provider-model",
    thinkingLevel: "high",
    onStalled: (info) => stalled.push(info),
    runtime: {
      workerPath: worker,
      attemptId: () => "attempt-approval-guard",
      pollIntervalMs: 10,
      toolTimeoutMs: 800,
      toolCancelGraceMs: 10_000,
      heartbeatNoProgressMs: scaledBudgetMs(1_200),
      firstEventTimeoutMs: scaledBudgetMs(20_000),
      heartbeatFreshMs: scaledBudgetMs(500),
    },
  });
  assert.equal(result.approved, false, "the approval is refused");
  assert.equal(result.disapproved, false, "and is not laundered into a disapproval");
  assert.equal(result.infrastructureClass, "timeout", "it fails as retryable so the ladder re-audits");
  assert.match(result.error ?? "", /verification is incomplete/);
  assert.match(result.error ?? "", /must be retried/);
  assert.ok(
    stalled.some((info) => info.reason === "tool-timeout"),
    "the refusal carries the tool-timeout evidence",
  );
  await cleanup();
});

test("v0.38.99: a genuinely wedged tool still fails fast once the grace expires", { timeout: scaledBudgetMs(25_000) }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-grace-expiry-"));
  dirs.push(dir);
  // A tool that never returns and a worker that never recovers: the grace
  // window must not become an unbounded lease. The hard kill still lands.
  const worker = path.join(dir, "wedged-tool-worker.mjs");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const verdictKey = await readVerdictKey();
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const openedAt = Date.now() - 5_000;
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 5_000, lastActivityAt: openedAt,
  currentTool: "bash", currentToolArgs: "{\\"command\\":\\"sleep 9999\\"}",
  currentToolStartedAt: openedAt, currentToolTimeoutMs: 800,
  recentOutput: [], toolCalls: [],
}));
process.on("SIGTERM", () => process.exit(0));
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
      attemptId: () => "attempt-grace-expiry",
      pollIntervalMs: 10,
      toolTimeoutMs: 800,
      toolCancelGraceMs: 400,
      heartbeatNoProgressMs: scaledBudgetMs(1_200),
      firstEventTimeoutMs: scaledBudgetMs(20_000),
      heartbeatFreshMs: scaledBudgetMs(500),
    },
  });
  assert.equal(stalled.length, 1, "one stall event, recorded at first expiry");
  assert.equal(result.approved, false);
  assert.equal(result.disapproved, false);
  assert.equal(result.infrastructureClass, "timeout");
  assert.ok(Date.now() > 0);
  await cleanup();
});
