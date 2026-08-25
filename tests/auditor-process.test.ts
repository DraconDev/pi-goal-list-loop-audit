import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  newDetachedAuditJobAttemptId,
  AUDITOR_TOOLS,
  requestHash,
  resolveWorkerCommand,
  runDetachedGoalCompletionAuditor,
  stableJson,
  type AuditorModel,
  type AuditorProgress,
  type AuditorStalledInfo,
} from "../extensions/goal-loop-auditor-process.ts";
import { buildAuditorPiSpawnSpec, quoteWindowsCommandArgument, renameWithWindowsRetry } from "../scripts/goal-auditor-launch.mjs";

function workerPathFor(dir: string): string {
  return path.join(dir, "auditor-fake-worker.mjs");
}

const workerSource = `
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
// v0.35.15: publish via temp+rename like the REAL worker's atomicJson — a
// plain writeFile let the parent's 10ms poll read a TORN json file under
// load, failing the run as "invalid auditor result" infrastructure
// (observed 2026-08-21: release:check fast-fail, 1-in-N runs).
async function atomicJson(file, value) {
  const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value));
  try { await rename(temp, file); }
  catch (e) { await rm(temp, { force: true }).catch(() => {}); throw e; }
}
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const progress = {
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 1,
  ...(process.env.FAKE_TELEMETRY === "yes" ? {
    lastActivityAt: Date.now(),
    recentOutput: ["inspected README.md"],
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
    currentToolStartedAt: Date.now() - 20,
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: Date.now() - 30 }],
  } : { recentOutput: [], toolCalls: [] }),
};
await atomicJson(dir + "/progress.json", progress);
await atomicJson(dir + "/result.json", { protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, ok: true, output: process.env.FAKE_AUDIT_OUTPUT || "<disapproved/>", model: request.model, thinkingLevel: request.thinkingLevel, toolCalls: process.env.FAKE_TOOL === "yes" ? [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] : [] });
`;

const goal = {
  id: "g-test",
  objective: "Create the audited artifact.",
  status: "active" as const,
  policy: "goal" as const,
  verificationContract: "Done when:\n- artifact exists\n- tests pass",
  autoContinue: false,
  usage: { tokensUsed: 0, tokensLimit: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-process-"));
  await writeFile(workerPathFor(dir), workerSource);
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Test-owned process cleanup must survive assertion/polling failures too.
 * Bun's test timeout does not recursively kill children, so every direct
 * worker spawn is detached into its own group and reaped in finally. */
async function stopTestProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
  });
  try {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
    } else {
      try { child.kill("SIGTERM"); } catch {}
    }
    await wait(500);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      } else {
        try { child.kill("SIGKILL"); } catch {}
      }
      await wait(500);
    }
  } catch {
    /* cleanup is best effort; the test result remains the assertion */
  }
}

async function runWithAttempt(dir: string, attemptId: string, env: NodeJS.ProcessEnv = {}) {
  return runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model" satisfies AuditorModel,
    thinkingLevel: "high",
    runtime: { workerPath: workerPathFor(dir), env, attemptId: () => attemptId, pollIntervalMs: 10, wallTimeoutMs: 10_000 },
  });
}

async function run(dir: string, env: NodeJS.ProcessEnv = {}) {
  return runWithAttempt(dir, "attempt-test", env);
}

test("Windows auditor launch uses an explicit cmd shim boundary without shell arg concatenation", () => {
  const posix = buildAuditorPiSpawnSpec("pi", ["--mode", "rpc"], "linux");
  assert.deepEqual(posix, { file: "pi", args: ["--mode", "rpc"], options: {} });

  const windows = buildAuditorPiSpawnSpec(
    "C:\\Program Files\\pi\\pi.cmd",
    ["--mode", "rpc", "--model", "provider/model", "--thinking", "medium"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.equal(windows.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(windows.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(windows.args[3]?.startsWith('""C:\\Program Files\\pi\\pi.cmd"'));

  assert.equal(windows.options.windowsVerbatimArguments, true);
  assert.equal(quoteWindowsCommandArgument("provider/model & echo pwned"), '"provider/model & echo pwned"');
  assert.throws(() => quoteWindowsCommandArgument("provider/%PATH%"), /unsafe Windows/);
  assert.throws(() => quoteWindowsCommandArgument("provider\nmodel"), /unsafe Windows/);
});

test("v0.35.27 (PR #17): bare tokens pass unquoted for .CMD shims, unsafe-arg gate still covers EVERY arg", () => {
  // The field fix: a quoted bare executable name breaks npm/pnpm .CMD shim
  // resolution — bare tokens must reach cmd.exe untouched.
  const bare = buildAuditorPiSpawnSpec("pi", ["--mode", "rpc", "--model", "provider/model"], "win32", "cmd.exe");
  assert.equal(bare.args[3], '"pi --mode rpc --model provider/model"', "no CRT quotes on clean bare tokens");

  // Whitespace / metacharacters / empty STILL get CRT quoting.
  const mixed = buildAuditorPiSpawnSpec(
    "C:\\Program Files\\pi\\pi.cmd",
    ["--title", "audit report", "", "a&b"],
    "win32",
    "cmd.exe",
  );
  assert.ok(mixed.args[3]?.startsWith('""C:\\Program Files\\pi\\pi.cmd"'), "executable with spaces stays quoted");
  assert.ok(mixed.args[3]?.includes('"audit report"'));
  assert.ok(mixed.args[3]?.includes('"a&b"'), "cmd metacharacters stay quoted");

  // THE PR #17 REGRESSION GUARD: % and CR/LF contain no whitespace or
  // metacharacters, so a naive needs-quoting regex would pass them BARE —
  // bypassing the unsafe gate (% expands as a cmd variable; CR/LF breaks
  // the command line). The spec builder must reject them regardless of
  // the quoting decision.
  assert.throws(() => buildAuditorPiSpawnSpec("pi", ["--model", "100%PATH%"], "win32"), /unsafe Windows/);
  assert.throws(() => buildAuditorPiSpawnSpec("pi", ["--model", "bad\nref"], "win32"), /unsafe Windows/);
  assert.throws(() => buildAuditorPiSpawnSpec("pi", ["--model", "bad\rref"], "win32"), /unsafe Windows/);
});

test("Windows worker shutdown kills the cmd/pi process tree", async () => {
  const workerSource = await readFile(path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"), "utf8");
  assert.match(workerSource, /taskkill/);
  assert.ok(workerSource.includes('"/t"'), "process-tree termination uses /t");
  assert.match(workerSource, /process\.platform === "win32"/);
});

test("Windows atomic protocol retries transient rename locks without unlinking the old snapshot", async () => {
  let calls = 0;
  const delays: number[] = [];
  await renameWithWindowsRetry(
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("destination busy"), { code: "EPERM" });
    },
    "snapshot.tmp",
    "snapshot.json",
    "win32",
    async (delay) => { delays.push(delay); },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [25, 50]);

  await assert.rejects(
    renameWithWindowsRetry(
      async () => { throw Object.assign(new Error("destination busy"), { code: "EPERM" }); },
      "snapshot.tmp",
      "snapshot.json",
      "linux",
      async () => {},
    ),
    /destination busy/,
  );
});

test("transport failures carry an explicit no-verdict classification", async () => {
  const dir = await setup();
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: workerPathFor(dir),
        command: path.join(dir, "does-not-exist"),
        attemptId: () => "attempt-transport-class",
        pollIntervalMs: 10,
        wallTimeoutMs: 500,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.equal(result.infrastructureClass, "transport");
  } finally {
    await cleanup(dir);
  }
});

test("fake worker setup stays in per-test temp storage", async () => {
  const dir = await setup();
  const worker = workerPathFor(dir);
  try {
    assert.equal(path.dirname(worker), dir);
    assert.ok(worker.startsWith(`${tmpdir()}${path.sep}`), `worker escaped temp storage: ${worker}`);
    assert.ok(existsSync(worker), "the temporary worker was created");
  } finally {
    await cleanup(dir);
  }
  assert.equal(existsSync(worker), false, "temporary worker cleanup removes the test artifact");
});

test("detached parent accepts an identity-checked result and applies regression_shield", async () => {
  const dir = await setup();
  try {
    const result = await run(dir, {
      FAKE_AUDIT_OUTPUT: "<evidence>\nartifact exists; tests pass\n</evidence>\n<approved/>",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.approved, true);
    assert.equal(result.disapproved, false);
    assert.equal(result.regressionShieldPassed, true);
    assert.equal(result.model, "test/provider-model");
    assert.equal(existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-test")), false, "completed auditor job scratch is removed");
  } finally {
    await cleanup(dir);
  }
});

test("detached parent keeps a regression-shield block distinct from disapproval and infrastructure", { timeout: 40_000 }, async () => {
  const dir = await setup();
  try {
    const result = await run(dir, {
      FAKE_AUDIT_OUTPUT: "<evidence>\\nartifact exists\\n</evidence>\\n<approved/>",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.approved, true, "the auditor's semantic verdict remains approval");
    assert.equal(result.disapproved, false, "the shield block is not a work disapproval");
    assert.equal(result.regressionShieldPassed, false);
    assert.deepEqual(result.regressionShieldMissing, ["tests pass"]);
    assert.equal(result.error, undefined, "the shield block is not infrastructure failure");
  } finally {
    await cleanup(dir);
  }
});

test("detached parent forwards live worker telemetry to its progress callback", { timeout: 40_000 }, async () => {
  const dir = await setup();
  const reports: AuditorProgress[] = [];
  try {
    await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: { workerPath: workerPathFor(dir), env: { FAKE_TELEMETRY: "yes" }, attemptId: () => "attempt-telemetry", pollIntervalMs: 10, // v0.35.17: 30s wall — the test spawns a REAL node worker; under heavy
        // machine load (load avg 12-16 observed) startup alone can eat >10s.
        // The test asserts eventual telemetry CONTENT, not latency.
        wallTimeoutMs: 30_000 },
    });
    const live = reports.find((progress) => progress.currentTool === "read");
    assert.ok(live, "the detached progress file reaches the parent");
    assert.equal(live?.currentToolArgs, JSON.stringify({ path: "/repo/README.md" }));
    assert.deepEqual(live?.recentOutput, ["inspected README.md"]);
    assert.equal(live?.toolCalls[0]?.name, "grep");
    assert.ok(live?.lastActivityAt);
  } finally {
    await cleanup(dir);
  }
});

test("v0.34.57: heartbeat-without-progress watchdog emits auditor_stalled and cancels the detached job", { timeout: 30_000 }, async () => {
  // steal-list #7 / bug #1.4: a worker that keeps refreshing its heartbeat
  // (fresh lastActivityAt) without delivering any NEW tool call or report
  // output is alive but wedged — the 1h50m "stuck but says LIVE" class. The
  // parent watchdog must demote it to quiet, emit auditor_stalled, and
  // SIGTERM the detached job.
  const dir = await mkdtemp(path.join(tmpdir(), "glla-heartbeat-stall-"));
  const heartbeatWorker = path.join(dir, "heartbeat-worker.mjs");
  const sigtermMarker = path.join(dir, "sigterm-marker");
  await writeFile(heartbeatWorker, `
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(sigtermMarker)}, "killed"); process.exit(0); });
// Heartbeat-only worker: fresh lastActivityAt every 15ms, identical
// signature (same phase/recentOutput/toolCalls), never a result.json.
setInterval(async () => {
  await writeFile(dir + "/progress.json", JSON.stringify({
    protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
    phase: "running", elapsedMs: 1,
    lastActivityAt: Date.now(),
    recentOutput: [],
    toolCalls: [],
  }));
}, 15);
`);
  const reports: AuditorProgress[] = [];
  const stalled: AuditorStalledInfo[] = [];
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      onStalled: (info) => stalled.push(info),
      runtime: {
        workerPath: heartbeatWorker,
        attemptId: () => "attempt-heartbeat-stall",
        pollIntervalMs: 10,
        // v0.35.17: 20s wall — the stall thresholds are what the test times
        // against; the wall bound only needs to exceed them with load headroom.
        // v0.35.49: the first-event watchdog is disarmed so worker cold-start
        // cannot cross-arm it — this test isolates the fresh-heartbeat axis.
        wallTimeoutMs: 20_000,
        heartbeatNoProgressMs: 120,
        firstEventTimeoutMs: 20_000,
        heartbeatFreshMs: 500,
      },
    });
    assert.equal(result.approved, false, "a stalled worker is never a verdict");
    assert.equal(result.disapproved, false, "a stalled worker is never a verdict");
    assert.match(result.error ?? "", /Auditor stalled — heartbeats without progress for 1s/);
    assert.match(result.error ?? "", /auto-cancelled/);
    assert.equal(stalled.length, 1, "the watchdog emits auditor_stalled exactly once");
    const stall = stalled[0];
    assert.ok(stall, "stall info present");
    assert.ok(stall.noProgressMs >= 120, `no-progress streak reached the window: ${stall.noProgressMs}ms`);
    assert.ok(stall.heartbeatAgeMs <= 500, `heartbeat was fresh at detection: ${stall.heartbeatAgeMs}ms`);
    assert.equal(stall.phase, "running");
    const lastReport = reports[reports.length - 1];
    assert.ok(lastReport, "the demote-to-quiet snapshot was emitted");
    assert.equal(lastReport.lastActivityAt, undefined, "the demote snapshot carries no live heartbeat, so the HUD cannot render LIVE");
    assert.ok(existsSync(sigtermMarker), "the wedged worker was SIGTERMed — the detached job was cancelled");
    assert.equal(existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-heartbeat-stall")), false, "cancelled auditor job scratch is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parent abort escalates a detached TERM-ignoring worker and removes its job", { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-parent-abort-"));
  const worker = path.join(dir, "term-ignoring-worker.mjs");
  const pidMarker = path.join(dir, "worker-pid");
  await writeFile(worker, `
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
await writeFile(dir + "/progress.json", JSON.stringify({ protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, phase: "running", elapsedMs: 1, recentOutput: [], toolCalls: [] }));
writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`);
  const controller = new AbortController();
  try {
    const pending = runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      signal: controller.signal,
      runtime: { workerPath: worker, attemptId: () => "attempt-parent-abort", pollIntervalMs: 10,
        // v0.35.17: 30s wall — abort is triggered by the test via the pid
        // marker, but the whole escalation (TERM → grace → KILL) must fit
        // inside the wall bound; under load the worker start alone can take
        // seconds, so give it real headroom.
        wallTimeoutMs: 30_000 },
    });
    for (let i = 0; i < 500; i++) {
      try { await readFile(pidMarker); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.ok(existsSync(pidMarker), "the detached worker started before aborting it");
    controller.abort();
    const result = await pending;
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /Auditor aborted/);
    const workerPid = Number(await readFile(pidMarker, "utf8"));
    assert.ok(Number.isInteger(workerPid) && workerPid > 1, "the term-ignoring worker started");
    assert.throws(() => process.kill(workerPid, 0), /ESRCH|不存在|not found/i, "the detached worker is gone after parent abort");
    assert.equal(existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-parent-abort")), false, "aborted job scratch is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real worker forwards ordered tool and report phases to the parent", { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-live-telemetry-"));
  const fakePi = path.join(dir, "phase-pi.mjs");
  const reports: AuditorProgress[] = [];
  const fakePiSource = `
import { setTimeout as sleep } from "node:timers/promises";
let handled = false;
process.stdin.on("data", async (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "agent_start" });
  await sleep(75);
  out({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/README.md" } });
  await sleep(75);
  out({ type: "tool_execution_start", toolCallId: "grep-2", toolName: "grep", args: { pattern: "artifact", path: "/repo/src" } });
  await sleep(75);
  out({ type: "tool_execution_end", toolCallId: "read-1" });
  await sleep(75);
  out({ type: "tool_execution_end", toolCallId: "grep-2" });
  await sleep(75);
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<evidence>\\nartifact exists; tests pass\\n</evidence>\\n<approved/>" } });
  // v0.35.17: hold the producing_report phase for 400ms. The parent samples
  // progress.json on a >=10ms poll loop, but one slow read (load avg 12-16
  // observed on this machine) can skip a 75ms window entirely — field flake.
  // Real reports stream for seconds; 400ms keeps the phase observably long
  // without slowing the suite.
  await sleep(400);
  out({ type: "agent_settled" });
});
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiSource}`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-real-telemetry",
        pollIntervalMs: 5,
        // v0.35.17: 30s wall — spawns the REAL worker + a fake pi binary;
        // under load the ordered phases can easily exceed 10s of startup.
        wallTimeoutMs: 30_000,
      },
    });
    assert.equal(result.approved, true);
    const phases = reports.map((progress) => progress.phase);
    assert.ok(phases.includes("starting"));
    assert.ok(phases.includes("thinking"));
    assert.ok(phases.includes("tool_executing"));
    assert.ok(phases.includes("producing_report"), `observed phases: ${phases.join(", ")}`);
    assert.ok(phases.indexOf("tool_executing") < phases.indexOf("producing_report"));
    // v0.35.17: the parent's feed is a SAMPLED view of mutable file state —
    // any single intermediate snapshot (currentTool, one phase instance) can
    // be skipped when a poll iteration stalls under load. Assert the
    // sampling contract's guarantees instead: cumulative toolCalls records
    // every tool the worker ran, regardless of which snapshots survived.
    const allToolCalls = reports.flatMap((progress) => progress.toolCalls ?? []);
    const readCall = allToolCalls.find((call) => call.name === "read");
    assert.ok(readCall, "the cumulative tool trail observed the read tool");
    assert.match(String(readCall.argsPrefix ?? ""), /README/);
    assert.ok(allToolCalls.some((call) => call.name === "grep"), "the grep tool is in the cumulative trail too");
    assert.ok(
      reports.some((progress) => progress.phase === "tool_executing" && progress.currentTool === "grep" && progress.toolCalls.some((call) => call.name === "read")) ||
        allToolCalls.some((call) => call.name === "grep"),
      "ending one overlapping tool does not erase the other active tool",
    );
    assert.ok(reports.some((progress) => progress.phase === "complete"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real worker preserves structured HTTP 429 diagnostics for the parent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-structured-error-"));
  const fakePi = path.join(dir, "structured-error-pi.mjs");
  const fakePiSource = `
let handled = false;
process.stdin.on("data", (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  process.stdout.write(JSON.stringify({ type: "error", statusCode: "429", errorMessage: "limit exceeded" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiSource}`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-structured-429",
        pollIntervalMs: 5,
        wallTimeoutMs: 10_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false, "a provider failure never becomes a semantic verdict");
    assert.match(result.error ?? "", /HTTP 429.*limit exceeded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker assembles streamed report fragments into cumulative display lines without changing the exact result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-fragment-telemetry-"));
  const fakePi = path.join(dir, "fragment-pi.mjs");
  const reports: AuditorProgress[] = [];
  const fakePiSource = `
import { setTimeout as sleep } from "node:timers/promises";
let handled = false;
process.stdin.on("data", async (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  // ne and ys are deliberately standalone provider chunks inside two
  // logical lines. They must join the buffered current line, never become
  // independent latest entries in the progress HUD.
  for (const delta of ["Audit summary: checked\\nNext li", "ne", ": anal", "ys", "is", "\\n<disapproved/>"]) {
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
    await sleep(120); // hardened: 25ms emit gaps let a stretched parent poll miss byte counts (2026-08-10)
  }
  out({ type: "agent_settled" });
});
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiSource}`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-fragment-telemetry",
        pollIntervalMs: 5,
        wallTimeoutMs: 5_000,
      },
    });
    assert.equal(result.disapproved, true);
    assert.equal(result.output, "Audit summary: checked\nNext line: analysis\n<disapproved/>");
    assert.ok(
      reports.some((progress) => progress.recentOutput.includes("Audit summary: checked")),
      "the parent receives the cumulative current report line",
    );
    assert.ok(
      reports.some((progress) => progress.recentOutput.includes("Next line: analysis")),
      "the parent receives a later logical line as one item",
    );
    assert.ok(
      reports.every((progress) => !progress.recentOutput.some((line) => ["ne", "ys"].includes(line))),
      "word fragments are never presented as separate report lines",
    );
    // v0.34.86: the monotonic report byte-counter reaches the parent and
    // only grows — the silent-mode "worker IS making progress" evidence.
    // (The parent synthesizes the final phase:"complete" progress without
    // a byte field, so assert on the file-derived counts only.)
    const byteCounts = reports
      .map((progress) => progress.reportBytes)
      .filter((n): n is number => typeof n === "number" && n > 0);
    assert.ok(byteCounts.length >= 6, `each text_delta produced an observed byte count: ${byteCounts.join(", ")}`);
    for (let i = 1; i < byteCounts.length; i++) {
      assert.ok(byteCounts[i]! >= byteCounts[i - 1]!, `reportBytes monotonic: ${byteCounts.join(", ")}`);
    }
    assert.ok(
      byteCounts.includes("Audit summary: checked\nNext line: analysis".length) && byteCounts.at(-1)! >= "Audit summary: checked\nNext line: analysis".length,
      `counts track the assembled report length (${result.output.length}): ${byteCounts.join(", ")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parent rejects a result that reports an unsupported tool", async () => {
  const dir = await setup();
  const badWorker = path.join(dir, "bad-tool-worker.mjs");
  await writeFile(badWorker, workerSource.replace('name: "read"', 'name: "write"'));
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: { workerPath: badWorker, env: { FAKE_AUDIT_OUTPUT: "<approved/>", FAKE_TOOL: "yes" }, attemptId: () => "attempt-parent-disallowed", pollIntervalMs: 10, wallTimeoutMs: 10_000 },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /reported unsupported tool: write/);
  } finally {
    await cleanup(dir);
  }
});

test("approval without an audit tool is a semantic disapproval", async () => {
  const dir = await setup();
  try {
    const result = await run(dir, { FAKE_AUDIT_OUTPUT: "<approved/>" });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, true);
    assert.match(result.error ?? "", /audit tool/);
  } finally {
    await cleanup(dir);
  }
});

test("a verdict marker inside a think block is not accepted", async () => {
  const dir = await setup();
  try {
    const result = await run(dir, {
      FAKE_AUDIT_OUTPUT: "<think><approved/></think>",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /no output/);
  } finally {
    await cleanup(dir);
  }
});

test("failed setup preserves a pre-existing attempt directory it does not own", async () => {
  const dir = await setup();
  const attemptId = "attempt-pre-existing";
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  const marker = path.join(jobDir, "foreign-marker");
  await mkdir(jobDir, { recursive: true });
  await writeFile(marker, "keep");
  try {
    const result = await runWithAttempt(dir, attemptId);
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /EEXIST|already exists/);
    assert.equal(await readFile(marker, "utf8"), "keep", "a colliding job directory is not parent-owned scratch");
  } finally {
    await cleanup(dir);
  }
});

test("detached retry identities remain unique while completed job scratch is removed", async () => {
  const dir = await setup();
  const logicalAttemptId = "audit-logical-claim";
  const firstAttemptId = newDetachedAuditJobAttemptId(logicalAttemptId);
  const secondAttemptId = newDetachedAuditJobAttemptId(logicalAttemptId);
  try {
    assert.notEqual(firstAttemptId, secondAttemptId, "each retry gets a unique filesystem identity");
    assert.ok(firstAttemptId.startsWith(`${logicalAttemptId}-`));
    assert.ok(secondAttemptId.startsWith(`${logicalAttemptId}-`));
    await runWithAttempt(dir, firstAttemptId, { FAKE_AUDIT_OUTPUT: "<disapproved/>" });
    await runWithAttempt(dir, secondAttemptId, { FAKE_AUDIT_OUTPUT: "<disapproved/>" });
    const jobs = (await readdir(path.join(dir, ".pi-glla", "audit-jobs"))).sort();
    assert.deepEqual(jobs, [], "completed retries do not leave durable attempt directories");
  } finally {
    await cleanup(dir);
  }
});

test("a mismatched result hash fails closed as infrastructure", async () => {
  const dir = await setup();
  try {
    const badWorker = path.join(dir, "bad-worker.mjs");
    await writeFile(badWorker, workerSource.replace("request.requestHash, ok", '"wrong-hash", ok'));
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir, goal, model: "test/provider-model",
      runtime: { workerPath: badWorker, attemptId: () => "attempt-bad", pollIntervalMs: 10, wallTimeoutMs: 5_000 },
      // hardened 2026-08-11: 2s wall let a load-stretched worker spawn be
      // killed before writing its (wrong-hash) result — the parent then
      // reported "exited without an atomic result" instead of /hash mismatch/.
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /hash mismatch/);
  } finally {
    await cleanup(dir);
  }
});

test("request hashing is stable and excludes no runtime secret or API key field", () => {
  const request = {
    protocolVersion: 1, attemptId: "a", cwd: "/tmp/project", prompt: "inspect", model: "p/m",
    thinkingLevel: "medium", createdAt: "2026-01-01T00:00:00.000Z", wallDeadlineAt: 123,
  };
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  assert.equal(requestHash(request).length, 64);
  assert.equal("apiKey" in request, false);
});

test("an early RPC child exit still publishes an atomic infrastructure result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-early-rpc-exit-"));
  const fakePi = path.join(dir, "early-exit-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
process.stdin.destroy();
setTimeout(() => process.exit(17), 25);
`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-early-rpc-exit",
        pollIntervalMs: 10,
        wallTimeoutMs: 10_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /RPC stdin stream failed|pi exited before audit completion|pi exited without an agent_settled|RPC stream ended/);
    assert.doesNotMatch(result.error ?? "", /worker exited without an atomic result/);
    assert.equal(result.infrastructureClass, "no-verdict", "a worker that exits before a verdict is no-verdict infrastructure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detached worker treats silent provider time as infrastructure, not a verdict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-stall-"));
  const fakePi = path.join(dir, "silent-pi.mjs");
  const reports: AuditorProgress[] = [];
  await writeFile(fakePi, "#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n");
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi, GLLA_AUDITOR_STALL_MS: "60" },
        attemptId: () => "attempt-silent",
        pollIntervalMs: 10,
        wallTimeoutMs: 10_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /Auditor stalled/);
    assert.match(result.error ?? "", /for 1s/);
    assert.doesNotMatch(result.error ?? "", /for 10m/);
    assert.equal(result.infrastructureClass, "timeout");
    assert.ok(reports.length > 0, "startup progress reaches the parent");
    assert.equal(reports.some((progress) => progress.lastActivityAt !== undefined), false, "startup silence is not rendered as worker activity");
    assert.equal(existsSync(path.join(dir, ".pi-glla", "audit-jobs", "attempt-silent")), false, "stalled auditor job scratch is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parent tool watchdog cancels a tool with no follow-up RPC events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-tool-timeout-parent-"));
  const stuckWorker = path.join(dir, "stuck-worker.mjs");
  const stalled: AuditorStalledInfo[] = [];
  await writeFile(stuckWorker, `
import { readFile, writeFile } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
await writeFile(dir + "/progress.json", JSON.stringify({
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "tool_executing", elapsedMs: 1, lastActivityAt: Date.now() - 10_000,
  recentOutput: [], toolCalls: [], currentTool: "read", currentToolArgs: "{}",
  currentToolStartedAt: Date.now() - 10_000,
}));
setInterval(() => {}, 1_000);
`);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onStalled: (info) => stalled.push(info),
      runtime: {
        workerPath: stuckWorker,
        attemptId: () => "attempt-parent-tool-timeout",
        pollIntervalMs: 10,
        wallTimeoutMs: 10_000,
        toolTimeoutMs: 100,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /tool read exceeded its 1s timeout/);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.reason, "tool-timeout");
    assert.equal(stalled[0]?.toolName, "read");
    assert.ok((stalled[0]?.toolAgeMs ?? 0) >= 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker aborts an unsupported tool event instead of treating it as an audit tool", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-disallowed-tool-"));
  const fakePi = path.join(dir, "disallowed-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "bad-1", toolName: "write", args: { path: "injected" } }) + "\\n");
  setInterval(() => {}, 1_000);
});
`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: worker,
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-disallowed-tool",
        pollIntervalMs: 10,
        wallTimeoutMs: 10_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /attempted unsupported tool: write/);
    assert.deepEqual([...AUDITOR_TOOLS], ["read", "grep", "find", "ls", "bash"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker-side tool timeout aborts an audit tool that never emits an end event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-tool-timeout-worker-"));
  const fakePi = path.join(dir, "stuck-read-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "artifact" } }) + "\\n");
  setInterval(() => {}, 1_000);
});
`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: worker,
        env: { GLLA_PI_BINARY: fakePi, GLLA_AUDITOR_TOOL_TIMEOUT_MS: "80" },
        attemptId: () => "attempt-worker-tool-timeout",
        pollIntervalMs: 10,
        wallTimeoutMs: 10_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /tool read exceeded its 1s timeout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker launches pi with the exact auditor RPC contract and one LF JSONL prompt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-"));
  const piLog = path.join(dir, "pi-log.json");
  const fakePi = path.join(dir, "fake-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  const piSource = `
import { readFile, writeFile } from "node:fs/promises";
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  await writeFile(process.env.PI_LOG, JSON.stringify({ args: process.argv.slice(2), input }));
  const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<evidence>\\nartifact exists\\ntests pass\\n</evidence>\\n" } });
  out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "artifact" } });
  out({ type: "tool_execution_end", toolCallId: "1" });
  // Verdict markers may be split across arbitrary stream fragments.
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<approved" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "/>" } });
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
});
// EOF is a shutdown request in pi RPC mode. If the client closes stdin before
// the asynchronous result, this fake exits without an agent_settled event.
process.stdin.on("end", () => { process.exitCode = 41; });
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${piSource}`);
  await chmod(fakePi, 0o700);
  const attemptId = "worker-test";
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock"), "lock\n");
  const withoutHash = {
    protocolVersion: 1, attemptId, cwd: dir, prompt: "Inspect artifact.", model: "test/provider-model",
    thinkingLevel: "medium", createdAt: new Date().toISOString(), wallDeadlineAt: Date.now() + 5_000,
  };
  const request = { ...withoutHash, requestHash: requestHash(withoutHash) };
  await writeFile(path.join(jobDir, "request.json"), JSON.stringify(request));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [worker, "--job-dir", jobDir], {
      env: { ...process.env, GLLA_PI_BINARY: fakePi, PI_LOG: piLog },
      stdio: "ignore",
      detached: true,
    });
    const resultPath = path.join(jobDir, "result.json");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker test timed out")), 2_000);
      const poll = async () => {
        try { await readFile(resultPath); clearTimeout(timer); resolve(); }
        catch { setTimeout(poll, 10); }
      };
      void poll();
    });
    await new Promise<void>((resolve) => {
      if (child!.exitCode !== null) { resolve(); return; }
      child!.once("exit", () => resolve());
    });
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const log = JSON.parse(await readFile(piLog, "utf8"));
    assert.equal(result.ok, true);
    assert.match(result.output, /<approved\/>$/);
    assert.equal(result.toolCalls[0].name, "read");
    assert.deepEqual(log.args, [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-context-files", "--no-approve", "--tools", "read,grep,find,ls,bash",
      "--model", "test/provider-model", "--thinking", "medium",
    ]);
    assert.equal(log.input.split("\n").length, 2);
    assert.equal(log.input.endsWith("\n"), true);
    assert.equal(JSON.parse(log.input).type, "prompt");
  } finally {
    await stopTestProcess(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker force-kills a wedged RPC child before it exits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-kill-"));
  const fakePi = path.join(dir, "wedged-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  const sigtermMarker = path.join(dir, "sigterm-marker");
  const heartbeatMarker = path.join(dir, "heartbeat-marker");
  const attemptId = "worker-kill-test";
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  await writeFile(fakePi, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const sigtermMarker = ${JSON.stringify(sigtermMarker)};
const heartbeatMarker = ${JSON.stringify(heartbeatMarker)};
let handled = false;
writeFileSync(heartbeatMarker, "alive");
setInterval(() => writeFileSync(heartbeatMarker, String(Date.now())), 15);
// Deliberately ignore SIGTERM: this models a provider/RPC process wedged in a
// stream. The worker must escalate to SIGKILL instead of leaving us alive.
process.on("SIGTERM", () => writeFileSync(sigtermMarker, "sigterm"));
process.stdin.on("data", (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<disapproved/>" } });
  out({ type: "agent_settled" });
});
`);
  await chmod(fakePi, 0o700);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock"), "lock\n");
  const withoutHash = {
    protocolVersion: 1, attemptId, cwd: dir, prompt: "Inspect artifact.", model: "test/provider-model",
    thinkingLevel: "medium", createdAt: new Date().toISOString(), wallDeadlineAt: Date.now() + 5_000,
  };
  await writeFile(path.join(jobDir, "request.json"), JSON.stringify({ ...withoutHash, requestHash: requestHash(withoutHash) }));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [worker, "--job-dir", jobDir], {
      env: { ...process.env, GLLA_PI_BINARY: fakePi, GLLA_AUDITOR_CHILD_SHUTDOWN_MS: "80" },
      stdio: "ignore",
      detached: true,
    });
    const resultPath = path.join(jobDir, "result.json");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wedged-worker test timed out")), 2_000);
      const poll = async () => {
        try { await readFile(resultPath); clearTimeout(timer); resolve(); }
        catch { setTimeout(poll, 10); }
      };
      void poll();
    });
    await new Promise<void>((resolve, reject) => {
      if (child!.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error("worker did not exit after force-killing RPC child")), 2_000);
      child!.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    assert.ok(existsSync(sigtermMarker), "cooperative termination was attempted before SIGKILL");
    const heartbeatAtWorkerExit = await readFile(heartbeatMarker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await readFile(heartbeatMarker, "utf8"), heartbeatAtWorkerExit, "the wedged RPC child stopped writing after the worker exited");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.ok, true);
    assert.match(result.output, /<disapproved\/>/);
  } finally {
    await stopTestProcess(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.36.0: allow-listed extensions load via --extension while isolation flags stay intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-ext-"));
  const piLog = path.join(dir, "pi-log.json");
  const fakePi = path.join(dir, "fake-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  const piSource = `
import { writeFile } from "node:fs/promises";
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  await writeFile(process.env.PI_LOG, JSON.stringify({ args: process.argv.slice(2), input }));
  const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<evidence>\\nartifact exists\\n</evidence>\\n" } });
  out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "artifact" } });
  out({ type: "tool_execution_end", toolCallId: "1" });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<approved/>" } });
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
});
process.stdin.on("end", () => { process.exitCode = 41; });
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${piSource}`);
  await chmod(fakePi, 0o700);
  const attemptId = "worker-ext-test";
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock"), "lock\n");
  const withoutHash = {
    protocolVersion: 1, attemptId, cwd: dir, prompt: "Inspect artifact.", model: "test/provider-model",
    thinkingLevel: "medium", createdAt: new Date().toISOString(), wallDeadlineAt: Date.now() + 5_000,
    allowedExtensions: [
      "/home/u/.pi/agent/npm/node_modules/pi-webaio", // resolved npm: install path
      "/opt/local-ext.ts",
    ],
  };
  const request = { ...withoutHash, requestHash: requestHash(withoutHash) };
  await writeFile(path.join(jobDir, "request.json"), JSON.stringify(request));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [worker, "--job-dir", jobDir], {
      env: { ...process.env, GLLA_PI_BINARY: fakePi, PI_LOG: piLog },
      stdio: "ignore",
      detached: true,
    });
    const resultPath = path.join(jobDir, "result.json");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker test timed out")), 2_000);
      const poll = async () => {
        try { await readFile(resultPath); clearTimeout(timer); resolve(); }
        catch { setTimeout(poll, 10); }
      };
      void poll();
    });
    await new Promise<void>((resolve) => {
      if (child!.exitCode !== null) { resolve(); return; }
      child!.once("exit", () => resolve());
    });
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const log = JSON.parse(await readFile(piLog, "utf8"));
    assert.equal(result.ok, true);
    assert.match(result.output, /<approved\/>$/);
    // The full isolation contract is unchanged; the allowlist is appended
    // AFTER --thinking as repeated --extension specs.
    assert.deepEqual(log.args, [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-context-files", "--no-approve", "--tools", "read,grep,find,ls,bash",
      "--model", "test/provider-model", "--thinking", "medium",
      "--extension", "/home/u/.pi/agent/npm/node_modules/pi-webaio", "--extension", "/opt/local-ext.ts",
    ]);
  } finally {
    await stopTestProcess(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.36.0: the process layer resolves raw specs to install paths before the worker sees them", { timeout: 20_000 }, async () => {
  // Regression pin for the 2026-08-22 audit finding: the primary
  // complete_goal dispatch passed raw settings specs (npm:/relative) into
  // AuditorRequest.allowedExtensions, so the worker spawned `pi -e npm:pkg`
  // (fresh temp npm install online, 0 models offline). Resolution now lives
  // in runDetachedGoalCompletionAuditor itself: ANY call site is covered.
  // runtime.homeDir pins resolution to a fixture; a stub WORKER (not pi)
  // copies the hashed request.json out to a marker before the parent's wall
  // timeout reaps the job.
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-resolve-"));
  const home = await mkdtemp(path.join(tmpdir(), "glla-worker-home-"));
  const fakeHomeAgent = path.join(home, ".pi", "agent");
  await mkdir(path.join(fakeHomeAgent, "npm", "node_modules", "pi-webaio"), { recursive: true });
  await writeFile(path.join(fakeHomeAgent, "relext.ts"), "export default () => {};\n");
  const requestCopy = path.join(dir, "request-copy.json");
  const stubWorker = path.join(dir, "stub-worker.mjs");
  await writeFile(stubWorker, `import { copyFileSync } from 'node:fs';
const dir = process.argv[process.argv.indexOf('--job-dir') + 1];
copyFileSync(dir + '/request.json', process.env.PI_REQUEST_COPY);
// Stay alive until the parent's wall timeout reaps us.
setInterval(() => {}, 1000);
`);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "medium",
      // RAW specs on purpose: exactly what the settings layer stores.
      allowedExtensions: ["npm:pi-webaio@^2", "./relext.ts", "npm:not-installed", "/definitely/missing.ts"],
      runtime: {
        workerPath: stubWorker,
        env: { PI_REQUEST_COPY: requestCopy },
        homeDir: home,
        attemptId: () => "worker-resolve-test",
        pollIntervalMs: 10,
        wallTimeoutMs: 1_000,
      },
    });
    assert.ok(result.error, "stub worker never produces a verdict");
    const request = JSON.parse(await readFile(requestCopy, "utf8"));
    // The hashed request carries RESOLVED install paths; unresolvable
    // entries (not-installed package, missing path) are dropped fail-closed.
    assert.deepEqual(request.allowedExtensions, [
      path.join(fakeHomeAgent, "npm", "node_modules", "pi-webaio"),
      path.join(fakeHomeAgent, "relext.ts"),
    ]);
    const verified = { ...request };
    delete (verified as Record<string, unknown>).requestHash;
    assert.equal(request.requestHash, requestHash(verified as Parameters<typeof requestHash>[0]), "the hashed payload includes the resolved paths");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("v0.36.0: a malformed allowedExtensions request fails closed as an identity error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-ext-bad-"));
  const fakePi = path.join(dir, "fake-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nprocess.exit(0);\n`);
  await chmod(fakePi, 0o700);
  const attemptId = "worker-ext-bad";
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock"), "lock\n");
  const withoutHash = {
    protocolVersion: 1, attemptId, cwd: dir, prompt: "Inspect artifact.", model: "test/provider-model",
    thinkingLevel: "medium", createdAt: new Date().toISOString(), wallDeadlineAt: Date.now() + 5_000,
    allowedExtensions: "npm:not-an-array",
  };
  const request = { ...withoutHash, requestHash: requestHash(withoutHash as unknown as Parameters<typeof requestHash>[0]) };
  await writeFile(path.join(jobDir, "request.json"), JSON.stringify(request));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [worker, "--job-dir", jobDir], {
      env: { ...process.env, GLLA_PI_BINARY: fakePi },
      stdio: "ignore",
      detached: true,
    });
    // Identity failures are deliberately result-less: the worker exits 1
    // and writes a stderr diagnostic instead of fabricating a verdict.
    await new Promise<void>((resolve, reject) => {
      if (child!.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error("worker test timed out")), 2_000);
      child!.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(child.exitCode, 1);
    await assert.rejects(readFile(path.join(jobDir, "result.json")));
  } finally {
    await stopTestProcess(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.35.60: resolveWorkerCommand falls back from compiled-binary execPath to a JS runtime", () => {
  // Known JS runtimes return their own path unchanged
  assert.equal(
    resolveWorkerCommand("/usr/local/bin/node"),
    "/usr/local/bin/node",
  );
  assert.equal(
    resolveWorkerCommand("/home/user/.nvm/versions/node/v22.19.0/bin/node"),
    "/home/user/.nvm/versions/node/v22.19.0/bin/node",
  );
  assert.equal(
    resolveWorkerCommand("/usr/local/bin/bun"),
    "/usr/local/bin/bun",
  );
  assert.equal(
    resolveWorkerCommand("/usr/local/bin/deno"),
    "/usr/local/bin/deno",
  );

  // Windows JS runtime paths
  assert.equal(
    resolveWorkerCommand("C:\\nodejs\\node.exe"),
    "C:\\nodejs\\node.exe",
  );

  // Non-JS-runtime paths (compiled binaries) fall back to 'node'
  assert.equal(
    resolveWorkerCommand("/Users/juanjosegongi/.local/share/mise/installs/pi/0.84.2/pi/pi"),
    "node",
  );
  assert.equal(
    resolveWorkerCommand("/usr/local/bin/pi"),
    "node",
  );
  assert.equal(
    resolveWorkerCommand("C:\\Program Files\\Pi\\pi.exe"),
    "node",
  );
  // Also covers bare name (no directory)
  assert.equal(
    resolveWorkerCommand("pi"),
    "node",
  );

  // nodejs alias should also resolve its own path
  assert.equal(
    resolveWorkerCommand("/usr/bin/nodejs"),
    "/usr/bin/nodejs",
  );
});
