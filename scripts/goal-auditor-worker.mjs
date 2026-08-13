#!/usr/bin/env node
/**
 * Detached auditor worker. This file intentionally has no project imports:
 * the parent gives it one validated job directory and it launches a clean pi
 * RPC process with the auditor's full inspection/tooling allowlist.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PROTOCOL_VERSION = 1;
// Power-oriented auditor mode: bash is intentionally available so the model
// can run bounded verification commands and reproduce behavior. The timeout
// below still prevents one tool call from pinning the audit indefinitely.
const AUDITOR_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;
// A cancelled worker must not leave a wedged RPC child holding stdout/stderr
// pipes open. Give a cooperative SIGTERM a short grace period, then force
// kill and destroy the pipes so this worker can finish and exit too.
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 1_000;
const FORCE_KILL_SETTLE_MS = 250;

function configuredDuration(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(50, value) : fallback;
}

function childRunning(child) {
  return child.exitCode === null && child.signalCode === null;
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

async function terminateChild(child) {
  if (!childRunning(child)) {
    destroyChildStreams(child);
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
  await waitForChildExit(child, configuredDuration("GLLA_AUDITOR_CHILD_SHUTDOWN_MS", DEFAULT_CHILD_SHUTDOWN_GRACE_MS));
  if (childRunning(child)) {
    try { child.kill("SIGKILL"); } catch {}
    // SIGKILL should settle a direct child promptly; keep a second finite
    // bound so a broken pipe/close event can never hold the worker forever.
    await waitForChildExit(child, FORCE_KILL_SETTLE_MS);
  }
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
    await rename(temp, file);
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
  if (!Number.isFinite(request.wallDeadlineAt)) throw new Error("auditor request deadline is invalid");
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

  const startedAt = Date.now();
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
  const setCurrentToolFromActive = () => {
    const active = [...activeTools.values()].at(-1);
    if (!active) {
      currentTool = undefined;
      currentToolArgs = undefined;
      currentToolStartedAt = undefined;
      return;
    }
    currentTool = active.name;
    currentToolArgs = active.argsPrefix;
    currentToolStartedAt = active.startedAt;
  };
  let finalized = false;
  let streamError;
  let pi;
  let deadlineTimer;
  let inactivityTimer;
  // `lastActivityAt` is user-visible and must remain unset until a real RPC
  // event arrives. The separate probe clock keeps the inactivity brake armed
  // while the provider is silent during startup/thinking.
  let lastActivityAt;
  let lastActivityProbeAt = Date.now();
  let progressWrite = Promise.resolve();
  const configuredStallMs = Number(process.env.GLLA_AUDITOR_STALL_MS ?? 10 * 60_000);
  const AUDITOR_STALL_MS = Number.isFinite(configuredStallMs) ? Math.max(50, configuredStallMs) : 10 * 60_000;

  const progress = (phase = "running") => {
    const file = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      requestHash: request.requestHash,
      phase,
      elapsedMs: Date.now() - startedAt,
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
    };
    // Event handlers publish asynchronously. Serialize snapshots so a slow
    // older write can never overwrite a newer tool/report phase on disk.
    progressWrite = progressWrite.catch(() => {}).then(() => atomicJson(progressPath, file));
    return progressWrite;
  };

  const finish = async (ok, error = "") => {
    if (finalized) return;
    finalized = true;
    // v0.34.56: tools still in flight when the session ends never received
    // their end — represent them as explicitly unmatched STARTS in the final
    // telemetry snapshot instead of a phantom in-flight "current tool".
    for (const active of activeTools.values()) {
      unmatchedToolStarts.push({ name: active.name, argsPrefix: active.argsPrefix, startedAt: active.startedAt, toolCallId: active.toolCallId });
      if (unmatchedToolStarts.length > MAX_UNMATCHED_EVENTS) unmatchedToolStarts.shift();
    }
    activeTools.clear();
    anonymousStartKeys.clear();
    setCurrentToolFromActive();
    // Preserve a final unterminated report line in the last progress snapshot
    // without changing the exact result output used for verdict parsing.
    appendRecentOutput(recentOutput, recentReportLine, "", true);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (inactivityTimer) clearInterval(inactivityTimer);
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
  const toolTimeoutLabel = TOOL_TIMEOUT_MS >= 60_000
    ? `${Math.max(1, Math.round(TOOL_TIMEOUT_MS / 60_000))}m`
    : `${Math.max(1, Math.round(TOOL_TIMEOUT_MS / 1_000))}s`;
  const armToolTimer = (key, name) => {
    clearToolTimer(key);
    const timer = setTimeout(() => {
      void finish(false, `Auditor stalled — tool ${name} exceeded its ${toolTimeoutLabel} timeout; the worker was aborted.`).catch(() => {});
    }, TOOL_TIMEOUT_MS);
    timer.unref?.();
    toolTimers.set(key, timer);
  };

  // The parent may cancel the detached job after the goal is archived. Cleanly
  // terminate the nested RPC child too, rather than leaving it orphaned.
  process.once("SIGTERM", () => {
    void finish(false, "Auditor aborted.").catch(() => {});
  });

  try {
    if (Date.now() >= request.wallDeadlineAt) {
      await finish(false, "Auditor exceeded its wall-clock bound and was aborted before launch.");
      return;
    }
    await progress("starting");

    const piBinary = process.env.GLLA_PI_BINARY || "pi";
    const piArgs = [
      "--mode", "rpc",
      "--no-session",
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
    // On Windows the npm-installed `pi` entrypoint is a .cmd shim (there is no
    // pi.exe), and Node's child_process cannot exec .cmd/.bat files without a
    // shell — spawn("pi") → ENOENT, spawn("pi.cmd") → EINVAL. shell: true routes
    // the launch through cmd.exe, which resolves the shim via PATH/PATHEXT.
    // The RPC child's own stdin/stdout/stderr pipes are unaffected. Unix keeps
    // the direct, shell-less spawn.
    pi = spawn(piBinary, piArgs, {
      cwd: request.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? { shell: true } : {}),
    });

    const remaining = Math.max(1, request.wallDeadlineAt - Date.now());
    const wallMinutes = Math.max(1, Math.round((request.wallDeadlineAt - startedAt) / 60_000));
    deadlineTimer = setTimeout(() => {
      void finish(false, `Auditor exceeded its ${wallMinutes}m wall-clock bound and was aborted.`).catch(() => {});
    }, remaining);
    deadlineTimer.unref?.();
    const stallLabel = AUDITOR_STALL_MS >= 60_000
      ? `${Math.max(1, Math.round(AUDITOR_STALL_MS / 60_000))}m`
      : `${Math.max(1, Math.round(AUDITOR_STALL_MS / 1_000))}s`;
    inactivityTimer = setInterval(() => {
      if (finalized || activeTools.size > 0) return;
      if (Date.now() - lastActivityProbeAt >= AUDITOR_STALL_MS) {
        void finish(false, `Auditor stalled — no session activity for ${stallLabel} while no auditor tool was running, so it was aborted.`).catch(() => {});
      }
    }, Math.min(15_000, Math.max(10, Math.floor(AUDITOR_STALL_MS / 4))));
    inactivityTimer.unref?.();

    // RPC is a strict LF-delimited JSON stream. Do not use readline here:
    // its CRLF normalization accepts transport corruption that the worker
    // protocol deliberately rejects, and it can obscure an unterminated final
    // record. Buffer arbitrary chunks, reject raw CR, and process only complete
    // LF-terminated records. agent_end is intentionally not terminal: Pi may
    // retry/compact/follow up after it. agent_settled is the completion event.
    let stdoutBuffer = "";
    let settledSeen = false;
    const handleRpcLine = (line) => {
      if (finalized || !line) return;
      // The RPC contract is LF-delimited but permits a trailing CR for
      // conventional CRLF producers. Any other raw CR is transport damage.
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.includes("\r")) {
        void finish(false, "RPC stream contained a raw CR; expected LF-delimited JSONL").catch(() => {});
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch {
        void finish(false, "RPC stream contained invalid JSON").catch(() => {});
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
        void finish(false, `RPC prompt rejected: ${streamError}`).catch(() => {});
        return;
      }
      if (event.type === "tool_execution_start" && !AUDITOR_TOOLS.has(event.toolName)) {
        void finish(false, `Auditor attempted unsupported tool: ${String(event.toolName ?? "(unknown)")}`).catch(() => {});
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
        activeTools.set(key, { name: event.toolName, argsPrefix: toolArgsPrefix(event.args), startedAt: Date.now(), toolCallId: id });
        if (id === undefined) anonymousStartKeys.add(key);
        armToolTimer(key, event.toolName);
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
          const { startedAt: _startedAt, toolCallId: _toolCallId, ...toolCall } = active;
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
      if (stdoutBuffer.length > 0) {
        void finish(false, "RPC stream ended with an unterminated LF record").catch(() => {});
      } else if (!settledSeen) {
        void finish(false, "pi exited without an agent_settled RPC event").catch(() => {});
      }
    });

    pi.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) streamError = text.slice(-500);
    });
    const handlePiStreamError = (stream, error) => {
      if (finalized) return;
      const message = error instanceof Error ? error.message : String(error);
      streamError = message.slice(-500);
      void finish(false, `RPC ${stream} stream failed: ${streamError}`).catch(() => {});
    };
    // A provider/auth failure can make pi close RPC stdin before the prompt
    // write completes. Without an error listener, Node treats EPIPE as an
    // uncaught stream error and kills this worker before it can publish the
    // atomic infrastructure result the parent is waiting for.
    pi.stdin.on("error", (error) => handlePiStreamError("stdin", error));
    pi.stdout.on("error", (error) => handlePiStreamError("stdout", error));
    pi.stderr.on("error", (error) => handlePiStreamError("stderr", error));
    pi.on("error", (error) => { void finish(false, `pi launch failed: ${error.message}`).catch(() => {}); });
    pi.on("exit", (code, signal) => {
      if (!finalized) {
        const detail = streamError ? `: ${streamError}` : "";
        void finish(false, `pi exited before audit completion (code=${code ?? "?"}, signal=${signal ?? "?"})${detail}`).catch(() => {});
      }
    });

    // Exactly one LF-terminated JSONL prompt. JSON.stringify escapes embedded
    // newlines and carriage returns, so this remains one strict LF-only line.
    const promptLine = JSON.stringify({ type: "prompt", message: request.prompt });
    if (promptLine.includes("\r") || promptLine.includes("\n")) throw new Error("prompt JSONL encoding is not strict LF-only");
    pi.stdin.write(`${promptLine}\n`, "utf8");
    // Keep RPC stdin open. Pi's RPC mode treats stdin EOF as an explicit
    // shutdown request; closing it immediately after the prompt can terminate
    // the session before the asynchronous prompt reaches the model or emits
    // agent_settled. finish() terminates the child after settlement instead.
    await progress("running");
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
