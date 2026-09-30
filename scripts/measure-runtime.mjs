#!/usr/bin/env node
/** Reproducible local measurements. No provider calls or live sessions.
 * Usage: node scripts/measure-runtime.mjs [--output path.json] */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "glla-runtime-measure-"));
const outputIndex = process.argv.indexOf("--output");
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputFile) throw new Error("--output needs a filename");
process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(scratch, "settings.json");
fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH, '{"aggressiveMode":false}');

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted.at(-1), meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}
function measure(n, action) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const before = performance.now(); action(i); samples.push(performance.now() - before);
  }
  return distribution(samples);
}
async function coldLoad() {
  const source = `import {performance} from 'node:perf_hooks'; import {createJiti} from 'jiti';
    const before=performance.now(); await createJiti(import.meta.url,{fsCache:false}).import(${JSON.stringify(path.join(root, "extensions/loops/goal.ts"))});
    console.log(JSON.stringify({ms:performance.now()-before,rssBytes:process.memoryUsage().rss}));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("cold load exceeded 60s")); }, 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr || `cold load exited ${code}`)); });
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

try {
  const cold = [];
  for (let i = 0; i < 3; i++) cold.push(await coldLoad());
  const jiti = createJiti(import.meta.url);
  const core = await jiti.import(path.join(root, "extensions/goal-loop-core.ts"));
  await jiti.import(path.join(root, "extensions/loops/goal.ts"));
  const runtimeState = await jiti.import(path.join(root, "extensions/goal-state.ts"));
  const heartbeat = await jiti.import(path.join(root, "extensions/goal-heartbeat.ts"));
  const outbox = await jiti.import(path.join(root, "extensions/approval-render-store.ts"));
  const limits = await jiti.import(path.join(root, "extensions/terminal-summary-limits.ts"));
  const auditor = await jiti.import(path.join(root, "extensions/goal-loop-auditor-process.ts"));
  const ownership = await jiti.import(path.join(root, "extensions/owner-file-protocol.ts"));
  const goal = { id: "benchmark", objective: "Local performance fixture", status: "active", policy: "goal", autoContinue: false,
    verificationContract: "Fixture only", usage: { tokensUsed: 0, tokensLimit: 0 }, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
    taskList: { tasks: Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}`, status: "pending" })) }, auditHistory: [] };
  const list = Array.from({ length: 500 }, (_, i) => ({ id: `queued-${i}`, objective: `Queued work ${i}`, verificationContract: "Fixture only" }));
  runtimeState.replaceState({ goal: null, list: [] });
  const idleHeartbeat = measure(1000, () => heartbeat.__testOnlyHeartbeatTickRaw());
  runtimeState.replaceState({ goal, list });
  const unboundHeartbeat = measure(1000, () => heartbeat.__testOnlyHeartbeatTickRaw());
  const prompt = measure(200, () => auditor.buildGoalAuditorPrompt(goal, "Outcome: fixture only", "synthetic verification"));
  const ownerFile = path.join(scratch, "owner.json");
  const ownerMutation = measure(100, i => {
    if (ownership.withOwnerMutation(ownerFile, () => { ownership.publishOwnerRecord(ownerFile, { pid: process.pid, i }); return true; }) !== true) throw new Error("owner benchmark refused");
  });

  const rotationSamples = [];
  const line = JSON.stringify({ type: "benchmark_event", value: { text: "x".repeat(1000) } }) + "\n";
  const rotationBytes = core.LEDGER_ROTATION_BYTES + 1024;
  for (let i = 0; i < 3; i++) {
    const cwd = path.join(scratch, `rotation-${i}`);
    core.appendStateSnapshot(cwd, { goal, list: [] });
    const latestStateLine = fs.readFileSync(core.ledgerPath(cwd), "utf8").trim().split("\n").at(-1);
    fs.appendFileSync(core.ledgerPath(cwd), line.repeat(Math.ceil(rotationBytes / line.length)));
    const start = performance.now();
    if (core.rotateLedgerIfNeeded(cwd, latestStateLine) !== true) throw new Error("rotation benchmark did not rotate");
    rotationSamples.push(performance.now() - start);
  }
  const outboxCwd = path.join(scratch, "outbox");
  const chatLines = Array.from({ length: limits.MAX_RENDER_CHAT_LINES }, () => "x".repeat(limits.MAX_RENDER_LINE_CHARS));
  for (let i = 0; i < 10; i++) if (!outbox.persistApprovalRender(outboxCwd, { goalId: `render-${i}`, objective: "fixture", chatLines })) throw new Error("outbox fixture failed");
  const outboxBytes = fs.statSync(outbox.approvalRenderStorePath(outboxCwd)).size;
  const outboxReadDedup = measure(20, () => outbox.persistApprovalRender(outboxCwd, { goalId: "render-0", objective: "fixture", chatLines }));
  const outboxReplayRotation = measure(10, () => outbox.replayUndeliveredApprovalRenders({ cwd: outboxCwd }, () => false));
  const sourceFiles = execFileSync("rg", ["--files", "extensions", "scripts"], { cwd: root, encoding: "utf8" }).trim().split("\n").sort();
  const digest = createHash("sha256");
  for (const name of sourceFiles) digest.update(name).update("\0").update(fs.readFileSync(path.join(root, name)));
  const result = {
    recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), sourceDigest: digest.digest("hex"), loadAverage: os.loadavg(),
    fixtures: { queuedItems: 500, goalTasks: 100, rotationBytes, pendingOutboxEntries: 10, outboxBytes, linesPerRender: chatLines.length, codePointsPerLine: chatLines[0].length },
    coldProcessLoadWithoutJitiDiskCache: { ...distribution(cold.map(sample => sample.ms)), rssBytes: cold.map(sample => sample.rssBytes) },
    idleHeartbeat, unboundActiveHeartbeat: unboundHeartbeat, auditPromptConstruction: prompt, ownerMutation,
    ledgerRotation: distribution(rotationSamples), outboxReadDedup, outboxUnconfirmedReplayRotation: outboxReplayRotation,
    scope: "Local synthetic fixtures; unbound heartbeat has no host. No paid-provider token/cost measurements or real host correctness claims. Context-growth and ledger-derived audit cost/flip/skip measurements are separate tools.",
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  if (outputFile) fs.writeFileSync(outputFile, json);
  process.stdout.write(json);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
