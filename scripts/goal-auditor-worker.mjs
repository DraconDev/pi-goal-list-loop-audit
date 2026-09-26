#!/usr/bin/env node
/**
 * Detached auditor worker. This file intentionally has no extension or
 * project-runtime dependencies: the parent gives it one validated job
 * directory and it launches a clean pi RPC process with the auditor's full
 * inspection/tooling allowlist. The sibling launcher helper is Node-only and
 * contains no glla/session state.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildAuditorPiSpawnSpec, renameWithWindowsRetry } from "./goal-auditor-launch.mjs";

const PROTOCOL_VERSION = 1;
// Power-oriented auditor mode: bash is intentionally available so the model
// can run bounded verification commands and reproduce behavior. The timeout
// below still prevents one tool call from pinning the audit indefinitely.
const AUDITOR_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;
// Mirror of MAX_AUDITOR_TOOL_TIMEOUT_MS in
// extensions/goal-loop-auditor-process.ts: a granted tool timeout is honored,
// but never beyond the same ceiling the user-facing setting enforces.
const MAX_TOOL_TIMEOUT_MS = 6 * 3_600_000;
// A cancelled worker must not leave a wedged RPC child holding stdout/stderr
// pipes open. Give a cooperative SIGTERM a short grace period, then force
// kill and destroy the pipes so this worker can finish and exit too.
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 1_000;
const FORCE_KILL_SETTLE_MS = 250;
// A project command run through the auditor may be untrusted code. Keep a
// generous ceiling for parallel test runners, but stop a recursive helper
// before it can turn a single audit into a host-wide process storm. The
// parent-side mechanical shield has the same ceiling for its direct checks.
const DEFAULT_MAX_PROCESS_GROUP_SIZE = 256;
const PROCESS_GROUP_POLL_MS = 100;
// stdout EOF normally precedes ChildProcess `close`. Give the child a short
// window to report its real exit code/signal and drain stderr before publishing
// a no-verdict result. A child that closes stdout but remains alive is still
// bounded: the same worker-owned TERM→KILL cleanup runs when this grace ends.
const DEFAULT_RPC_CLOSE_GRACE_MS = 250;

function configuredDuration(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(50, value) : fallback;
}

function childRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function linuxProcessGroupId(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]); // stat field 5, after pid/comm/state/ppid
    return Number.isInteger(processGroup) && processGroup > 1 ? processGroup : undefined;
  } catch {
    return undefined;
  }
}

function linuxProcessGroupSize(group) {
  if (group === undefined || process.platform !== "linux") return undefined;
  let entries;
  try { entries = readdirSync("/proc"); } catch { return undefined; }
  let count = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || linuxProcessGroupId(pid) !== group) continue;
    count++;
  }
  return count;
}

function signalPosixProcessGroup(group, signal) {
  if (group === undefined || process.platform !== "linux") return false;
  const workerGroup = linuxProcessGroupId(process.pid);
  if (group !== workerGroup) {
    try { process.kill(-group, signal); return true; } catch { return false; }
  }
  // The worker itself is the group leader. Enumerate members instead of
  // signalling the whole group, otherwise this worker dies before it can
  // publish result.json.
  let entries;
  try { entries = readdirSync("/proc"); } catch { return false; }
  let signaled = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) continue;
    if (linuxProcessGroupId(pid) !== group) continue;
    try { process.kill(pid, signal); signaled = true; } catch {}
  }
  return signaled;
}

function signalPosixChildTree(child, signal) {
  if (!child.pid) return;
  // The worker itself is a detached process-group leader. Its RPC child and
  // normal shell descendants therefore share the worker's group. If a child
  // deliberately creates a separate group, signalling that group is safe and
  // catches its nested bash/test/browser processes.
  const childGroup = process.platform === "linux" ? linuxProcessGroupId(child.pid) : undefined;
  const workerGroup = process.platform === "linux" ? linuxProcessGroupId(process.pid) : undefined;
  if (childGroup !== undefined && childGroup !== workerGroup && signalPosixProcessGroup(childGroup, signal)) return;
  try { child.kill(signal === "SIGTERM" ? "SIGTERM" : signal); } catch {}
  signalPosixProcessGroup(childGroup, signal);
}

function destroyChildStreams(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch {}
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!childRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve();
    };
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

async function terminateWindowsProcessTree(child) {
  if (!child.pid) return;
  let killer;
  try {
    // The Windows launch is a cmd.exe shim boundary. taskkill /T is needed to
    // terminate the npm shim and the Node/pi descendants as one tree; killing
    // only cmd.exe can leave the RPC child alive with the worker's pipes gone.
    killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    return;
  }
  await waitForChildExit(killer, configuredDuration("GLLA_AUDITOR_CHILD_SHUTDOWN_MS", DEFAULT_CHILD_SHUTDOWN_GRACE_MS));
}

async function terminateChild(child) {
  if (!childRunning(child)) {
    destroyChildStreams(child);
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child);
    // If taskkill was unavailable or raced the process exit, retain the direct
    // finite fallback so worker shutdown remains bounded.
    if (childRunning(child)) {
      try { child.kill(); } catch {}
      await waitForChildExit(child, FORCE_KILL_SETTLE_MS);
    }
    destroyChildStreams(child);
    return;
  }
  const childGroup = process.platform === "linux" && child.pid !== undefined
    ? linuxProcessGroupId(child.pid)
    : undefined;
  signalPosixChildTree(child, "SIGTERM");
  await waitForChildExit(child, configuredDuration("GLLA_AUDITOR_CHILD_SHUTDOWN_MS", DEFAULT_CHILD_SHUTDOWN_GRACE_MS));
  if (childRunning(child)) {
    signalPosixChildTree(child, "SIGKILL");
  } else {
    // The direct RPC child may exit after TERM while a nested shell/browser
    // ignores it. Reuse the captured group identity so those descendants still
    // receive the finite KILL escalation.
    signalPosixProcessGroup(childGroup, "SIGKILL");
  }
  // SIGKILL should settle a direct child promptly; keep a second finite
  // bound so a broken pipe/close event can never hold the worker forever.
  await waitForChildExit(child, FORCE_KILL_SETTLE_MS);
  destroyChildStreams(child);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function hashRequest(request) {
  const { requestHash: ignored, ...withoutHash } = request;
  return createHash("sha256").update(stableJson(withoutHash), "utf8").digest("hex");
}

// Provider/RPC errors may carry HTTP status and message as non-enumerable
// Error properties or as nested JSON. Keep those facts in the bounded worker
// diagnostic so the parent can preserve rate-limit/account-wall classification
// instead of collapsing a structured 429 into generic infrastructure.
function normalizeErrorText(...values) {
  const statuses = [];
  const messages = [];
  const seen = new Set();
  const statusKeys = new Set(["status", "statusCode", "status_code", "httpStatus", "http_status", "code"]);
  const messageKeys = new Set(["errorMessage", "message", "detail", "reason", "description", "finalError"]);
  const nestedKeys = new Set(["error", "response", "cause", "body", "details", "data"]);
  const visit = (value, depth) => {
    if (value === undefined || value === null || depth > 4) return;
    if (typeof value === "string") {
      if (value.trim()) messages.push(value.trim());
      return;
    }
    if (typeof value === "number") {
      if (Number.isInteger(value) && value >= 100 && value <= 599) statuses.push(value);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const keys = new Set([
      ...Object.keys(value),
      ...Object.getOwnPropertyNames(value),
      ...statusKeys,
      ...messageKeys,
      ...nestedKeys,
    ]);
    for (const key of keys) {
      let child;
      try { child = value[key]; } catch { continue; }
      if (statusKeys.has(key)) {
        if (typeof child === "number" && Number.isInteger(child) && child >= 100 && child <= 599) statuses.push(child);
        else if (typeof child === "string" && /^\d{3}$/.test(child.trim())) statuses.push(Number(child));
      } else if (messageKeys.has(key) || nestedKeys.has(key)) {
        visit(child, depth + 1);
      }
    }
  };
  for (const value of values) visit(value, 0);
  return [...new Set([
    ...[...new Set(statuses)].map((status) => `HTTP ${status}`),
    ...messages,
  ])].join(" — ").slice(0, 500);
}

// v0.38.76: auditor challenge round (falsification pass). A round-1 approval
// earns one bounded second RPC round in a FRESH session (no anchoring on
// round-1 reasoning) with an adversarial brief. The final-line verdict rule
// makes composition safe: round-2 output is appended, so a challenge
// disapproval flips the verdict while a re-confirm preserves it — and the
// shield keeps reading round-1's evidence block (first match wins).
const CHALLENGE_SEPARATOR = "\n\n--- auditor challenge round (falsification pass) ---\n\n";

// Mirror of parseAuditorVerdict's final-line gate (goal-loop-shield.ts).
// The worker needs the round-1 verdict to decide whether to challenge;
// keep this in sync with the parser (final non-blank line only).
function finalLineOf(output) {
  const normalized = String(output).replaceAll("\\\\n", "\n").replaceAll("\\\\r", "\r");
  return normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function finalLineIsApproval(output) {
  return /^<approved\/>$/i.test(finalLineOf(output));
}

function finalLineVerdict(output) {
  const line = finalLineOf(output);
  if (/^<approved\/>$/i.test(line)) return "approved";
  if (/^<disapproved\/>$/i.test(line)) return "disapproved";
  if (/^<impossible>[\s\S]*?<\/impossible>$/i.test(line)) return "impossible";
  return "none";
}

function buildChallengePrompt(originalPrompt, round1Output) {
  return [
    "AUDITOR CHALLENGE ROUND (falsification pass).",
    "",
    "A first-pass auditor already APPROVED the completion below. Approvals can be wrong — your job is to try to prove this one wrong. Re-verify the load-bearing claims with your own tool calls; do not trust the first report's assertions without checking them.",
    "",
    "ORIGINAL AUDIT BRIEF (verbatim):",
    originalPrompt,
    "",
    "FIRST-PASS REPORT (verbatim):",
    round1Output,
    "",
    "RULES:",
    "- If you find ANY genuine gap between the completion claim and the evidence (missing artifact, failing check, untested contract item, hallucinated file, evidence that does not actually show what the report claims), list the concrete gaps, then end your report with a single final line exactly: <disapproved/>",
    "- If the completion genuinely holds up after your adversarial re-check, end with a single final line exactly: <approved/>",
    "- The final non-empty line is the ONLY authoritative verdict location. Do not emit verdict markers anywhere else.",
  ].join("\n");
}

async function regular(file) {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error(`not a regular protocol file: ${file}`);
}

async function readJson(file) {
  await regular(file);
  return JSON.parse(await readFile(file, "utf8"));
}

async function atomicJson(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    // Keep the old destination in place while Windows readers/AV release it;
    // unlinking first would make the supposedly atomic protocol observable as
    // a missing file and could lose the previous valid snapshot on a retry.
    await renameWithWindowsRetry(rename, temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function jobDirArg() {
  const index = process.argv.indexOf("--job-dir");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !path.isAbsolute(value)) throw new Error("worker requires an absolute --job-dir");
  return path.resolve(value);
}

function identity(request, attemptId) {
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error("unsupported auditor protocol version");
  if (request.attemptId !== attemptId) throw new Error("auditor request attempt identity mismatch");
  if (typeof request.requestHash !== "string" || request.requestHash !== hashRequest(request)) throw new Error("auditor request hash mismatch");
  if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd)) throw new Error("auditor request cwd is not absolute");
  if (typeof request.prompt !== "string" || !request.prompt) throw new Error("auditor request prompt is empty");
  if (typeof request.model !== "string" || !request.model) throw new Error("auditor request model is empty");
  if (typeof request.thinkingLevel !== "string" || !request.thinkingLevel) throw new Error("auditor request thinking level is empty");
  // v0.38.3: opt-in live inspection toggle. When true the worker spawns pi
  // with --session <jobDir>/session.jsonl instead of --no-session, so the
  // auditor's pi persists as a resumable session you can tail -f live or
  // resume after the audit. Part of the request hash like every field.
  if (request.inspection !== undefined && typeof request.inspection !== "boolean") {
    throw new Error("auditor request inspection must be a boolean");
  }
  // Older request files may carry wallDeadlineAt. It is intentionally not
  // validated or enforced: a guessed duration must not terminate a worker
  // that continues to emit real progress. Current requests omit the field.
  // v0.36.0: optional extension allowlist. Specs are passed verbatim to
  // `pi --extension <spec>`; the strict shape check keeps a corrupted job
  // dir from smuggling arbitrary extra CLI surface into the spawn.
  if (request.allowedExtensions !== undefined) {
    if (!Array.isArray(request.allowedExtensions)) throw new Error("auditor request allowedExtensions must be an array");
    if (request.allowedExtensions.length > 32) throw new Error("auditor request allowedExtensions is too large");
    for (const spec of request.allowedExtensions) {
      if (typeof spec !== "string" || !spec.trim()) throw new Error("auditor request allowedExtensions contains an invalid spec");
    }
  }
}

const MAX_TOOL_ARGS_CHARS = 120;
const MAX_TOOL_ARG_VALUE_CHARS = 80;
const MAX_RECENT_OUTPUT_ITEMS = 8;
const MAX_RECENT_OUTPUT_ITEM_CHARS = 240;
const MAX_TOOL_CALLS = 64;
/** v0.34.56: bounded explicit unmatched-tool-fact retention. */
const MAX_UNMATCHED_EVENTS = 20;

function clipTelemetryString(value, max) {
  if (value.length <= max) return value;
  // Preserve the basename/end of paths and the useful tail of commands while
  // keeping the JSON argument prefix valid for the parent's safe-target parser.
  return `…${value.slice(-(max - 1))}`;
}

function toolArgsPrefix(args) {
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      const serialized = JSON.stringify(args ?? {});
      return serialized.length <= MAX_TOOL_ARGS_CHARS
        ? serialized
        : JSON.stringify({ args: clipTelemetryString(String(args), MAX_TOOL_ARG_VALUE_CHARS) });
    }
    const preferred = ["path", "file_path", "command", "pattern", "query", "url", "title"];
    const source = args;
    const keys = Object.keys(source);
    const orderedKeys = [...preferred.filter((key) => key in source), ...keys.filter((key) => !preferred.includes(key))];
    const bounded = {};
    for (const key of orderedKeys.slice(0, 8)) {
      const value = source[key];
      bounded[key] = typeof value === "string"
        ? clipTelemetryString(value, MAX_TOOL_ARG_VALUE_CHARS)
        : (value === null || typeof value === "number" || typeof value === "boolean" ? value : "[omitted]");
      const serialized = JSON.stringify(bounded);
      if (serialized.length > MAX_TOOL_ARGS_CHARS) {
        delete bounded[key];
        break;
      }
    }
    const serialized = JSON.stringify(bounded);
    return serialized.length <= MAX_TOOL_ARGS_CHARS ? serialized : JSON.stringify({ args: "[omitted]" });
  } catch {
    return "";
  }
}

function appendRecentOutput(recentOutput, reportLine, text, flush = false) {
  // text_delta fragments are arbitrary provider chunks, not logical lines.
  // Assemble them exactly like MAIN's cumulative assistant renderer; treating
  // each fragment as a line made the HUD show one word or punctuation mark at
  // a time (for example, `Audit summary` followed by `:`). The exact audit
  // result remains in outputParts and is deliberately unaffected by this
  // bounded display telemetry.
  const combined = `${reportLine.value}${text}`;
  const parts = combined.split("\n");
  reportLine.value = parts.pop() ?? "";
  for (const raw of parts) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    recentOutput.push(line.length <= MAX_RECENT_OUTPUT_ITEM_CHARS
      ? line
      : `${line.slice(0, MAX_RECENT_OUTPUT_ITEM_CHARS - 1)}…`);
  }
  if (flush && reportLine.value) {
    const line = reportLine.value;
    recentOutput.push(line.length <= MAX_RECENT_OUTPUT_ITEM_CHARS
      ? line
      : `${line.slice(0, MAX_RECENT_OUTPUT_ITEM_CHARS - 1)}…`);
    reportLine.value = "";
  }
  while (recentOutput.length > MAX_RECENT_OUTPUT_ITEMS) recentOutput.shift();
}

async function main() {
  const jobDir = jobDirArg();
  const requestPath = path.join(jobDir, "request.json");
  const resultPath = path.join(jobDir, "result.json");
  const progressPath = path.join(jobDir, "progress.json");
  const lockPath = path.join(jobDir, "lock");
  const attemptId = path.basename(jobDir);
  await regular(lockPath);
  const request = await readJson(requestPath);
  identity(request, attemptId);
  // v0.38.3: deterministic session path — pinned inside the job dir so its
  // lifetime equals the job-dir retention window (no new cleanup path).
  const sessionPath = request.inspection === true ? path.join(jobDir, "session.jsonl") : undefined;
  // Mark the detached worker owner durably. A replacement pi host can reap
  // this PID after the original host dies; parent-owned/pending locks are
  // deliberately not safe to kill across a restart.
  await atomicJson(lockPath, { protocolVersion: PROTOCOL_VERSION, attemptId, pid: process.pid, role: "worker", workerPath: path.resolve(process.argv[1]) });

  const startedAt = Date.now();
  // 2026-09-26 slow-audit hardening: request JSON byte size, measured once
  // — the prompt-cost half of the per-attempt cost record.
  const promptBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  const toolCalls = [];
  // v0.34.56: tool starts/ends that provably never paired are recorded as
  // EXPLICIT unmatched facts — never dropped, never falsely paired with a
  // different tool (see applyToolExecutionEvent in goal-loop-auditor.ts for
  // the shared truth rules; the worker keeps a concurrency-capable Map).
  const unmatchedToolStarts = [];
  const unmatchedToolEnds = [];
  const recentOutput = [];
  const outputParts = [];
  const recentReportLine = { value: "" };
  // v0.34.86: monotonic report-stream byte counter (chars of text_delta).
  // The silent-mode HUD shows this instead of the hidden prose tail —
  // "the worker IS making progress" without revealing the report text.
  let reportBytes = 0;
  const activeTools = new Map();
  const toolTimers = new Map();
  const configuredToolTimeoutMs = Number(process.env.GLLA_AUDITOR_TOOL_TIMEOUT_MS ?? DEFAULT_TOOL_TIMEOUT_MS);
  const TOOL_TIMEOUT_MS = Number.isFinite(configuredToolTimeoutMs)
    ? Math.max(50, configuredToolTimeoutMs)
    : DEFAULT_TOOL_TIMEOUT_MS;
  /** Keys of active starts that arrived WITHOUT a toolCallId. An anonymous
   * end can only pair when exactly ONE anonymous start is open — with zero
   * or several it is an unmatched fact (any pairing would be a guess). */
  const anonymousStartKeys = new Set();
  let currentTool;
  let currentToolArgs;
  let currentToolStartedAt;
  let currentToolTimeoutMs;
  const setCurrentToolFromActive = () => {
    const active = [...activeTools.values()].at(-1);
    if (!active) {
      currentTool = undefined;
      currentToolArgs = undefined;
      currentToolStartedAt = undefined;
      currentToolTimeoutMs = undefined;
      return;
    }
    currentTool = active.name;
    currentToolArgs = active.argsPrefix;
    currentToolStartedAt = active.startedAt;
    currentToolTimeoutMs = active.timeoutMs;
  };
  let finalized = false;
  let streamError;
  let pi;
  let inactivityTimer;
  let processGroupTimer;
  let rpcCloseGraceTimer;
  // v0.38.76 challenge round: 1 = audit pass, 2 = falsification pass.
  // round1EndParts/round1ReportBytes pin the byte-exact round-1 output so a
  // failed challenge truncates back to it (fail-open to today's behavior,
  // recorded in result.challenge — never silent).
  let round = 1;
  let round1EndParts = 0;
  let round1ReportBytes = 0;
  let challengeState = "not-applicable";
  let abandoning = false;
  // Per-round RPC stream state, hoisted so startRound() resets it between
  // rounds (a stale settledSeen/exit flag from round 1 must never leak
  // into round 2's lifecycle).
  let stdoutBuffer = "";
  let settledSeen = false;
  let stdoutEnded = false;
  let piExited = false;
  let piClosed = false;
  let piExitCode;
  let piExitSignal;
  let rpcStreamDiagnostic;
  // `lastActivityAt` is user-visible and must remain unset until a real RPC
  // event arrives. The separate probe clock keeps the inactivity brake armed
  // while the provider is silent during startup/thinking.
  let lastActivityAt;
  let lastActivityProbeAt = Date.now();
  let progressWrite = Promise.resolve();
  const configuredStallMs = Number(process.env.GLLA_AUDITOR_STALL_MS ?? 10 * 60_000);
  const AUDITOR_STALL_MS = Number.isFinite(configuredStallMs) ? Math.max(50, configuredStallMs) : 10 * 60_000;
  const configuredProcessGroupSize = Number(process.env.GLLA_AUDITOR_MAX_PROCESS_GROUP_SIZE ?? DEFAULT_MAX_PROCESS_GROUP_SIZE);
  const MAX_PROCESS_GROUP_SIZE = Number.isInteger(configuredProcessGroupSize)
    ? Math.min(DEFAULT_MAX_PROCESS_GROUP_SIZE, Math.max(2, configuredProcessGroupSize))
    : DEFAULT_MAX_PROCESS_GROUP_SIZE;

  const progress = (phase = "running") => {
    const file = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      requestHash: request.requestHash,
      phase,
      elapsedMs: Date.now() - startedAt,
      promptBytes,
      ...(sessionPath ? { sessionPath } : {}),
      ...(reportBytes > 0 ? { reportBytes } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      recentOutput: [
        ...recentOutput.slice(-MAX_RECENT_OUTPUT_ITEMS),
        ...(recentReportLine.value ? [recentReportLine.value.length <= MAX_RECENT_OUTPUT_ITEM_CHARS
          ? recentReportLine.value
          : `${recentReportLine.value.slice(0, MAX_RECENT_OUTPUT_ITEM_CHARS - 1)}…`] : []),
      ].slice(-MAX_RECENT_OUTPUT_ITEMS),
      toolCalls: toolCalls.slice(-MAX_TOOL_CALLS),
      unmatchedToolStarts: unmatchedToolStarts.slice(-MAX_UNMATCHED_EVENTS),
      unmatchedToolEnds: unmatchedToolEnds.slice(-MAX_UNMATCHED_EVENTS),
      ...(currentTool ? { currentTool } : {}),
      ...(currentToolArgs ? { currentToolArgs } : {}),
      ...(currentToolStartedAt ? { currentToolStartedAt } : {}),
      ...(currentToolTimeoutMs !== undefined ? { currentToolTimeoutMs } : {}),
    };
    // Event handlers publish asynchronously. Serialize snapshots so a slow
    // older write can never overwrite a newer tool/report phase on disk.
    progressWrite = progressWrite.catch(() => {}).then(() => atomicJson(progressPath, file));
    return progressWrite;
  };

  // v0.34.56: tools still in flight when the session ends never received
  // their end — represent them as explicitly unmatched STARTS in the final
  // telemetry snapshot instead of a phantom in-flight "current tool".
  // Shared with the round-1→2 transition (v0.38.76), which drains without
  // finalizing.
  const drainActiveTools = () => {
    for (const active of activeTools.values()) {
      unmatchedToolStarts.push({ name: active.name, argsPrefix: active.argsPrefix, startedAt: active.startedAt, toolCallId: active.toolCallId });
      if (unmatchedToolStarts.length > MAX_UNMATCHED_EVENTS) unmatchedToolStarts.shift();
    }
    activeTools.clear();
    anonymousStartKeys.clear();
    setCurrentToolFromActive();
  };

  const finish = async (ok, error = "") => {
    if (finalized) return;
    finalized = true;
    drainActiveTools();
    // Preserve a final unterminated report line in the last progress snapshot
    // without changing the exact result output used for verdict parsing.
    appendRecentOutput(recentOutput, recentReportLine, "", true);
    if (inactivityTimer) clearInterval(inactivityTimer);
    if (processGroupTimer) clearInterval(processGroupTimer);
    if (rpcCloseGraceTimer) clearTimeout(rpcCloseGraceTimer);
    for (const timer of toolTimers.values()) clearTimeout(timer);
    toolTimers.clear();
    // Wait for the nested RPC child to settle before publishing the terminal
    // result. SIGTERM alone is insufficient when a provider stream wedges the
    // child and its stdout listener keeps this worker's event loop referenced.
    if (pi) await terminateChild(pi);
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      requestHash: request.requestHash,
      ok,
      // text_delta events are arbitrary stream fragments, not lines. Preserve
      // their exact order/content so verdict markers cannot be split by an
      // inserted newline (for example: "<approved" + "/>" ).
      output: outputParts.join(""),
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      toolCalls: toolCalls.slice(-MAX_TOOL_CALLS),
      // v0.34.59: echo the focus revision token captured at dispatch.
      // The parent re-validates against current disk state; a mismatch
      // refuses the verdict instead of silently overwriting a goal that
      // moved on during the audit. Ghost writes cannot survive.
      ...(request.goalRevision ? { goalRevision: request.goalRevision } : {}),
      // v0.38.76: challenge-round outcome. The parent ignores this field
      // (verdict comes from output's final line); it exists for forensics
      // and future surfacing.
      challenge: challengeState,
      ...(error ? { error: error.slice(0, 500) } : {}),
    };
    // Publish the terminal worker phase before the result. The parent polls
    // progress first, so it cannot return on result.json while the TUI still
    // shows an older tool/report phase.
    await progress("complete").catch(() => {});
    await atomicJson(resultPath, result);
  };

  const clearToolTimer = (key) => {
    const timer = toolTimers.get(key);
    if (timer) clearTimeout(timer);
    toolTimers.delete(key);
  };
  // The tool layer grants each call its own budget (pi bash `timeout` is
  // seconds). A brake that fires before the granted budget expires would
  // discard a healthy audit for running exactly the command it declared —
  // the 2026-09-25 field case: a 620s full-suite run aborted at the 5m base,
  // throwing away ~60m of completed audit work. Honor the granted budget,
  // floored at the configured base and capped at the shared ceiling.
  const grantedToolTimeoutMs = (args) => {
    const seconds = args && typeof args === "object" ? args.timeout : undefined;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(MAX_TOOL_TIMEOUT_MS, Math.floor(seconds * 1000));
  };
  const effectiveToolTimeoutMs = (args) => Math.min(
    MAX_TOOL_TIMEOUT_MS,
    Math.max(TOOL_TIMEOUT_MS, grantedToolTimeoutMs(args) ?? 0),
  );
  const toolTimeoutLabel = (budgetMs) => budgetMs >= 60_000
    ? `${Math.max(1, Math.round(budgetMs / 60_000))}m`
    : `${Math.max(1, Math.round(budgetMs / 1_000))}s`;
  const armToolTimer = (key, name, budgetMs) => {
    clearToolTimer(key);
    const budget = Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(50, budgetMs));
    const timer = setTimeout(() => {
      void finish(false, `Auditor stalled — tool ${name} exceeded its ${toolTimeoutLabel(budget)} timeout; the worker was aborted.`).catch(() => {});
    }, budget);
    timer.unref?.();
    toolTimers.set(key, timer);
  };

  // The parent may cancel the detached job after the goal is archived. Cleanly
  // terminate the nested RPC child too, rather than leaving it orphaned.
  // Cancellation wins over everything, including a round-1 approval awaiting
  // challenge (v0.38.76): finish(false) directly, never the round-1 fallback.
  process.once("SIGTERM", () => {
    void finish(false, "Auditor aborted.").catch(() => {});
  });

  // v0.38.76 challenge-round machinery. Round 1 is byte-identical to the
  // historical single-shot flow; round 2 replays it with the falsification
  // brief. All error paths route through failRound: round-1 errors finish
  // failed exactly as before, round-2 errors abandon back to the round-1
  // output (fail-open, recorded — never silent).
  const resetRoundStreamState = () => {
    stdoutBuffer = "";
    settledSeen = false;
    stdoutEnded = false;
    piExited = false;
    piClosed = false;
    piExitCode = undefined;
    piExitSignal = undefined;
    rpcStreamDiagnostic = undefined;
    lastActivityProbeAt = Date.now();
  };

  const clearRoundTimers = () => {
    if (inactivityTimer) clearInterval(inactivityTimer);
    if (processGroupTimer) clearInterval(processGroupTimer);
    if (rpcCloseGraceTimer) clearTimeout(rpcCloseGraceTimer);
    for (const timer of toolTimers.values()) clearTimeout(timer);
    toolTimers.clear();
    inactivityTimer = undefined;
    processGroupTimer = undefined;
    rpcCloseGraceTimer = undefined;
  };

  const detachRoundChild = async () => {
    const old = pi;
    pi = undefined;
    if (!old) return;
    // Remove listeners synchronously on entry: a stale round-1 exit/close/
    // data event dispatching after the round flips would corrupt round-2
    // lifecycle state. Termination itself is async and bounded.
    for (const stream of [old.stdin, old.stdout, old.stderr]) {
      try { stream?.removeAllListeners(); } catch {}
    }
    try { old.removeAllListeners(); } catch {}
    await terminateChild(old).catch(() => {});
  };

  const failRound = (error) => {
    if (round === 1) {
      void finish(false, error).catch(() => {});
    } else {
      void abandonChallenge(error).catch(() => {});
    }
  };

  const abandonChallenge = async (reason) => {
    if (finalized || abandoning) return;
    abandoning = true;
    try {
      // Byte-exact fallback: the published output is indistinguishable from
      // a run where the challenge never happened. recentOutput (bounded
      // display telemetry) is intentionally not rewound.
      outputParts.length = round1EndParts;
      reportBytes = round1ReportBytes;
      challengeState = `skipped: ${String(reason ?? "unknown").slice(0, 120)}`;
      await detachRoundChild();
      drainActiveTools();
      clearRoundTimers();
      // Round 1 settled ok with an approval (the only path here) — finish
      // true on the preserved output.
      await finish(true, "");
    } catch (error) {
      await finish(false, `challenge abandon failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  };

  const startChallengeRound = async (round1Output) => {
    // Synchronous prefix first: round flip, output pin, drain, timer clear —
    // no await may precede detach's listener removal (see detachRoundChild).
    round = 2;
    round1EndParts = outputParts.length;
    round1ReportBytes = reportBytes;
    drainActiveTools();
    clearRoundTimers();
    outputParts.push(CHALLENGE_SEPARATOR);
    challengeState = "challenging";
    streamError = undefined;
    await detachRoundChild();
    await progress("challenging").catch(() => {});
    await startRound(buildChallengePrompt(request.prompt, round1Output), "challenging");
  };

  const startRound = async (roundPrompt, initialPhase) => {
    resetRoundStreamState();
    const piBinary = process.env.GLLA_PI_BINARY || "pi";
    // v0.38.3: off = the original --no-session spawn, byte-identical args.
    // Round 2 reuses the identical spec (including inspection --session):
    // the falsification brief carries full context either way.
    const piArgs = [
      "--mode", "rpc",
      ...(sessionPath ? ["--session", sessionPath] : ["--no-session"]),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--tools", "read,grep,find,ls,bash",
      "--model", request.model,
      "--thinking", request.thinkingLevel,
    ];
    // v0.36.0: explicitly allow-listed extension specs still load under
    // --no-extensions (pi honors explicit -e paths). Extension tools stay
    // disabled: --tools above remains the auditor's only tool surface, so
    // allow-listed extensions effectively contribute model providers.
    for (const spec of request.allowedExtensions ?? []) piArgs.push("--extension", spec);
    const launch = buildAuditorPiSpawnSpec(piBinary, piArgs);
    // The parent already reduced process.env to execution necessities plus
    // selected-model credentials. Copy that exact set: inheriting a second
    // time here would restore unrelated host secrets despite the parent fence.
    pi = spawn(launch.file, launch.args, {
      cwd: request.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...launch.options,
    });

    // The worker is detached into its own group by the parent; normal RPC and
    // shell descendants inherit that group. Count both identities because a
    // runtime is allowed to create a separate group for its own child tree.
    // This is a containment fence, not a progress timeout: a legitimate audit
    // remains eligible while its group stays below the ceiling.
    const processGroups = [...new Set([
      linuxProcessGroupId(process.pid),
      pi.pid ? linuxProcessGroupId(pi.pid) : undefined,
    ].filter((group) => group !== undefined))];
    if (processGroups.length > 0) {
      processGroupTimer = setInterval(() => {
        if (finalized || !pi || !childRunning(pi)) return;
        for (const group of processGroups) {
          const size = linuxProcessGroupSize(group);
          if (size !== undefined && size > MAX_PROCESS_GROUP_SIZE) {
            failRound(`Auditor stalled — process group exceeded its ${MAX_PROCESS_GROUP_SIZE}-process safety limit; the worker process tree was aborted.`);
            break;
          }
        }
      }, PROCESS_GROUP_POLL_MS);
      processGroupTimer.unref?.();
    }

    const stallLabel = AUDITOR_STALL_MS >= 60_000
      ? `${Math.max(1, Math.round(AUDITOR_STALL_MS / 60_000))}m`
      : `${Math.max(1, Math.round(AUDITOR_STALL_MS / 1_000))}s`;
    inactivityTimer = setInterval(() => {
      if (finalized || activeTools.size > 0) return;
      if (Date.now() - lastActivityProbeAt >= AUDITOR_STALL_MS) {
        failRound(`Auditor stalled — no session activity for ${stallLabel} while no auditor tool was running, so it was aborted.`);
      }
    }, Math.min(15_000, Math.max(10, Math.floor(AUDITOR_STALL_MS / 4))));
    inactivityTimer.unref?.();

    // RPC is a strict LF-delimited JSON stream. Do not use readline here:
    // its CRLF normalization accepts transport corruption that the worker
    // protocol deliberately rejects, and it can obscure an unterminated final
    // record. Buffer arbitrary chunks, reject raw CR, and process only complete
    // LF-terminated records. agent_end is intentionally not terminal: Pi may
    // retry/compact/follow up after it. agent_settled is the completion event.
    const RPC_CLOSE_GRACE_MS = configuredDuration("GLLA_AUDITOR_EOF_EXIT_GRACE_MS", DEFAULT_RPC_CLOSE_GRACE_MS);
    const missingSettledError = (closeGraceExpired = false) => {
      const processFacts = `pi exited before agent_settled (code=${piExitCode ?? "?"}, signal=${piExitSignal ?? "none"})`;
      const closeGraceDetail = closeGraceExpired && !piClosed
        ? `; RPC streams did not close within ${RPC_CLOSE_GRACE_MS}ms`
        : "";
      const headline = closeGraceExpired && stdoutEnded && !piExited
        ? `RPC stdout ended before agent_settled and the child did not close within ${RPC_CLOSE_GRACE_MS}ms`
        : `${processFacts}${closeGraceDetail}`;
      return [...new Set([headline, rpcStreamDiagnostic, streamError].filter(Boolean))].join(": ");
    };

    const coordinatePiEnd = () => {
      if (finalized || settledSeen) return;
      if (piClosed) {
        failRound(missingSettledError());
        return;
      }
      if ((!stdoutEnded && !piExited) || rpcCloseGraceTimer) return;
      rpcCloseGraceTimer = setTimeout(() => {
        rpcCloseGraceTimer = undefined;
        if (finalized || settledSeen || piClosed) return;
        failRound(missingSettledError(true));
      }, RPC_CLOSE_GRACE_MS);
      rpcCloseGraceTimer.unref?.();
    };

    const handleRpcLine = (line) => {
      if (finalized || !line) return;
      // The RPC contract is LF-delimited but permits a trailing CR for
      // conventional CRLF producers. Any other raw CR is transport damage.
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.includes("\r")) {
        failRound("RPC stream contained a raw CR; expected LF-delimited JSONL");
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch {
        failRound("RPC stream contained invalid JSON");
        return;
      }
      const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
      const phase = event.type === "message_update" && update?.type === "text_delta"
        ? "producing_report"
        : event.type === "tool_execution_start" && AUDITOR_TOOLS.has(event.toolName)
          ? "tool_executing"
          : event.type === "tool_execution_end" || event.type === "agent_start" || event.type === "message_start" || event.type === "message_end" || event.type === "response" || event.type === "agent_end"
            ? "thinking"
            : "running";
      const observedAt = Date.now();
      // Only a parsed RPC event counts as worker activity. Startup writes use
      // the separate probe clock and must not render `last activity 0s ago`.
      lastActivityAt = observedAt;
      lastActivityProbeAt = observedAt;
      if (event.type === "error" || event.type === "extension_error" || event.type === "auto_retry_start" || event.type === "auto_retry_end") {
        const message = normalizeErrorText(event);
        if (message) streamError = message;
      }
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
        const message = normalizeErrorText(event.message);
        if (message) streamError = message;
      }
      if (event.type === "response" && event.command === "prompt" && event.success === false) {
        const message = normalizeErrorText(event) || "RPC prompt was rejected before acceptance";
        streamError = message;
        failRound(`RPC prompt rejected: ${streamError}`);
        return;
      }
      if (event.type === "tool_execution_start" && !AUDITOR_TOOLS.has(event.toolName)) {
        failRound(`Auditor attempted unsupported tool: ${String(event.toolName ?? "(unknown)")}`);
        return;
      }
      if (event.type === "message_update") {
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          outputParts.push(update.delta);
          reportBytes += update.delta.length;
          appendRecentOutput(recentOutput, recentReportLine, update.delta);
          void progress(phase).catch(() => {});
        } else {
          void progress("thinking").catch(() => {});
        }
        return;
      }
      if (event.type === "tool_execution_start" && AUDITOR_TOOLS.has(event.toolName)) {
        const id = event.toolCallId === undefined || event.toolCallId === null ? undefined : String(event.toolCallId);
        const key = id !== undefined ? id : `${event.toolName}:${activeTools.size}:${Date.now()}`;
        const timeoutMs = effectiveToolTimeoutMs(event.args);
        activeTools.set(key, { name: event.toolName, argsPrefix: toolArgsPrefix(event.args), startedAt: Date.now(), toolCallId: id, timeoutMs });
        if (id === undefined) anonymousStartKeys.add(key);
        armToolTimer(key, event.toolName, timeoutMs);
        setCurrentToolFromActive();
        void progress(phase).catch(() => {});
        return;
      }
      if (event.type === "tool_execution_end") {
        const id = event.toolCallId === undefined || event.toolCallId === null ? undefined : String(event.toolCallId);
        let key;
        if (id !== undefined) {
          key = id;
        } else if (anonymousStartKeys.size === 1) {
          key = [...anonymousStartKeys][0];
        }
        const active = key !== undefined ? activeTools.get(key) : undefined;
        if (active) {
          clearToolTimer(key);
          const { startedAt: _startedAt, toolCallId: _toolCallId, timeoutMs: _timeoutMs, ...toolCall } = active;
          toolCalls.push({ ...toolCall, finishedAt: Date.now() });
          while (toolCalls.length > MAX_TOOL_CALLS) toolCalls.shift();
          activeTools.delete(key);
          if (id === undefined) anonymousStartKeys.delete(key);
          setCurrentToolFromActive();
        } else {
          // v0.34.56: an end that provably closes nothing is an EXPLICIT
          // unmatched fact — never silently dropped. Only telemetry-relevant
          // auditor tools are tracked, so only their stray ends are
          // surfaced; ends of untracked tools are outside the telemetry
          // scope by design.
          if (!event.toolName || AUDITOR_TOOLS.has(event.toolName)) {
            unmatchedToolEnds.push({ toolCallId: id, toolName: event.toolName, at: Date.now() });
            if (unmatchedToolEnds.length > MAX_UNMATCHED_EVENTS) unmatchedToolEnds.shift();
          }
        }
        void progress(activeTools.size > 0 ? "tool_executing" : "thinking").catch(() => {});
        return;
      }
      if (event.type === "agent_settled") {
        settledSeen = true;
        const output = outputParts.join("");
        const hasVerdict = /<(?:approved\/|disapproved\/|impossible>)/i.test(output);
        // v0.38.76: round-1 approvals earn the falsification pass; every
        // other round-1 outcome finishes exactly as the historical
        // single-shot flow. Round-2 verdicts compose by final line.
        if (round === 1 && (!streamError || hasVerdict) && finalLineIsApproval(output)) {
          // v0.38.81: light-tier dispatches skip the falsification pass —
          // recorded as skipped (round 2 never ran), never silent. Falls
          // through to the historical single-shot finish below.
          if (request.challenge === false) {
            challengeState = "skipped: light-tier audit";
          } else {
            void startChallengeRound(output).catch((error) => abandonChallenge(error instanceof Error ? error.message : String(error)));
            return;
          }
        }
        if (round === 2) {
          const verdict = finalLineVerdict(output);
          if (verdict === "approved") {
            challengeState = "confirmed";
            void finish(true, "").catch(() => {});
          } else if (verdict === "disapproved" || verdict === "impossible") {
            challengeState = "flipped";
            void finish(true, "").catch(() => {});
          } else {
            void abandonChallenge("challenge round settled without a verdict").catch(() => {});
          }
          return;
        }
        void finish(!streamError || hasVerdict, hasVerdict ? "" : streamError || "auditor session settled without a verdict").catch(() => {});
        return;
      }
      // agent_end is progress only; never finalize on it. Its `thinking`
      // phase is still published, so a moving worker is visible without
      // pretending that hidden model reasoning is available.
      void progress(phase).catch(() => {});
    };
    pi.stdout.on("data", (chunk) => {
      if (finalized) return;
      stdoutBuffer += String(chunk);
      let newline;
      while (!finalized && (newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleRpcLine(line);
      }
    });
    pi.stdout.on("end", () => {
      if (finalized) return;
      stdoutEnded = true;
      if (stdoutBuffer.length > 0) {
        rpcStreamDiagnostic = "RPC stream ended with an unterminated LF record";
      }
      coordinatePiEnd();
    });

    pi.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) streamError = text.slice(-500);
    });
    const handlePiStreamError = (stream, error) => {
      if (finalized) return;
      const message = error instanceof Error ? error.message : String(error);
      streamError = message.slice(-500);
      failRound(`RPC ${stream} stream failed: ${streamError}`);
    };
    // A provider/auth failure can make pi close RPC stdin before the prompt
    // write completes. Without an error listener, Node treats EPIPE as an
    // uncaught stream error and kills this worker before it can publish the
    // atomic infrastructure result the parent is waiting for.
    pi.stdin.on("error", (error) => handlePiStreamError("stdin", error));
    pi.stdout.on("error", (error) => handlePiStreamError("stdout", error));
    pi.stderr.on("error", (error) => handlePiStreamError("stderr", error));
    pi.on("error", (error) => { failRound(`pi launch failed: ${error.message}`); });
    pi.on("exit", (code, signal) => {
      piExited = true;
      piExitCode = code;
      piExitSignal = signal;
      coordinatePiEnd();
    });
    pi.on("close", (code, signal) => {
      piClosed = true;
      piExited = true;
      piExitCode = code;
      piExitSignal = signal;
      coordinatePiEnd();
    });

    // Exactly one LF-terminated JSONL prompt. JSON.stringify escapes embedded
    // newlines and carriage returns, so this remains one strict LF-only line.
    const promptLine = JSON.stringify({ type: "prompt", message: roundPrompt });
    if (promptLine.includes("\r") || promptLine.includes("\n")) throw new Error("prompt JSONL encoding is not strict LF-only");
    pi.stdin.write(`${promptLine}\n`, "utf8");
    // Keep RPC stdin open. Pi's RPC mode treats stdin EOF as an explicit
    // shutdown request; closing it immediately after the prompt can terminate
    // the session before the asynchronous prompt reaches the model or emits
    // agent_settled. finish() terminates the child after settlement instead.
    await progress(initialPhase);
  };

  try {
    // There is deliberately no wall-clock lifetime timer here. The worker
    // remains eligible while it emits real RPC/tool/report progress; the
    // confirmed-silence and per-tool watchdogs below are the safety bounds.
    await progress("starting");
    await startRound(request.prompt, "running");
  } catch (error) {
    await finish(false, error instanceof Error ? error.message : String(error));
  }
}

main().catch(async (error) => {
  // A malformed request cannot safely be associated with a result identity.
  // There is deliberately no fallback or in-process execution here.
  process.stderr.write(`goal-auditor-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
