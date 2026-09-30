#!/usr/bin/env node
/**
 * Emergency compactor worker (v0.38.10). Deliberately tiny next to the
 * auditor worker: prompt-in / text-out over `pi -p`, no tools, no RPC
 * protocol, no verdict machinery. The parent supplies the full state
 * packet in request.json — this process never reads the repo itself.
 *
 * Protocol: node goal-compactor-worker.mjs --job-dir <dir>
 *   <dir>/request.json  { model, thinking?, systemPrompt, prompt, timeoutMs }
 *   <dir>/result.json   { ok: true, brief } | { ok: false, error }
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildAuditorPiSpawnSpec } from "./goal-auditor-launch.mjs";
import { terminateContainedChild } from "./contained-child.mjs";

function fail(resultPath, error) {
  try {
    writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error).slice(0, 500) }));
  } catch {}
  process.exit(1);
}

const index = process.argv.indexOf("--job-dir");
const jobDir = index >= 0 ? process.argv[index + 1] : undefined;
if (!jobDir) {
  console.error("goal-compactor-worker: missing --job-dir");
  process.exit(2);
}
const requestPath = path.join(jobDir, "request.json");
const resultPath = path.join(jobDir, "result.json");

let request;
try {
  request = JSON.parse(readFileSync(requestPath, "utf-8"));
} catch (error) {
  fail(resultPath, `unreadable request.json: ${error}`);
}
if (!request || typeof request.model !== "string" || !request.model || typeof request.prompt !== "string") {
  fail(resultPath, "request.json must carry { model, prompt }");
}

const piBinary = process.env.GLLA_PI_BINARY || "pi";
const piArgs = [
  "-p",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
  "--model", request.model,
  "--thinking", typeof request.thinking === "string" && request.thinking ? request.thinking : "minimal",
  "--system-prompt", typeof request.systemPrompt === "string" && request.systemPrompt ? request.systemPrompt : "Compress the provided state packet into a short handoff brief.",
  "--",
  request.prompt,
];
let launch;
try {
  launch = buildAuditorPiSpawnSpec(piBinary, piArgs);
} catch (error) {
  fail(resultPath, error);
}

const child = spawn(launch.file, launch.args, {
  cwd: request.cwd || process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  ...launch.options,
});

let stdout = "";
let stderr = "";
const CAP = 16_384; // brief output is capped by the parent; this is transport overflow only
child.stdout?.on("data", (chunk) => {
  if (stdout.length < CAP) stdout += chunk.toString("utf-8").slice(0, CAP - stdout.length);
});
child.stderr?.on("data", (chunk) => {
  if (stderr.length < 2_048) stderr += chunk.toString("utf-8").slice(0, 2_048 - stderr.length);
});

const timeoutMs = typeof request.timeoutMs === "number" && request.timeoutMs > 0 ? request.timeoutMs : 180_000;
let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await terminateContainedChild(child, { graceMs: 2000 });
  fail(resultPath, reason);
}
const timer = setTimeout(() => {
  void stop("compactor Pi timed out");
}, timeoutMs);
process.once("SIGTERM", () => { void stop("compactor worker interrupted by SIGTERM"); });
process.once("SIGINT", () => { void stop("compactor worker interrupted by SIGINT"); });

child.on("error", (error) => fail(resultPath, `pi spawn failed: ${error}`));
child.on("close", async (code) => {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await terminateContainedChild(child, { graceMs: 2000 });
  const brief = stdout.trim();
  if (code !== 0 || !brief) {
    fail(resultPath, `pi exited ${code ?? "?"} with no brief${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`);
    return;
  }
  try {
    writeFileSync(resultPath, JSON.stringify({ ok: true, brief }));
  } catch (error) {
    fail(resultPath, `result write failed: ${error}`);
    return;
  }
  process.exit(0);
});
