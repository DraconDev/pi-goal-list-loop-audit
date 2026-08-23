/**
 * Detached completion-auditor transport.
 *
 * The parent never creates an agent session. It owns a small, temporary job
 * directory in `<cwd>/.pi-glla/audit-jobs/<attemptId>/`, starts the
 * extension-less worker, accepts only an identity-checked result, and removes
 * the attempt directory when the transport settles.
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  stripThinkBlocks,
  captureGoalRevision,
  isRetriableInfraError,
  isForbiddenModel,
  piGlaDir,
  type Goal,
  type GoalRevisionToken,
} from "./goal-loop-core.js";
import {
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  mainModelFailureDelayMs,
  modelRef,
  nextUntriedModelRef,
  normalizeMainModelFallbackRefs,
} from "./main-model-recovery.js";
import { ModelSelector, type ModelFallbackEvent } from "./model-selector.js";
import { buildGoalAuditorPrompt } from "./goal-loop-auditor.js";
import { checkRegressionShield, parseAuditorVerdict } from "./goal-loop-shield.js";
import { renameWithWindowsRetry } from "../scripts/goal-auditor-launch.mjs";
import { resolveAuditorAllowedExtensions } from "./auditor-extensions.js";

export interface GoalAuditorResult {
  approved: boolean;
  disapproved: boolean;
  impossible?: boolean;
  impossibleReason?: string;
  output: string;
  model: string;
  thinkingLevel?: string;
  error?: string;
  infrastructureClass?: AuditorInfrastructureClass;
  regressionShieldPassed?: boolean;
  regressionShieldMissing?: string[];
  /** v0.34.59: focus revision token echoed from request.json. The parent
   * compares this against the current state.goal.revision after the audit
   * finishes; mismatch → the verdict is treated as stale-refused, not a
   * silent overwrite. The caller decides what to do (typically: skip the
   * verdict, log stale_revision_refused, surface the refusal in the HUD). */
  goalRevision?: GoalRevisionToken;
}

export interface AuditorProgress {
  recentOutput: string[];
  phase: "starting" | "running" | "thinking" | "tool_executing" | "producing_report" | "complete";
  elapsedMs: number;
  /** v0.34.86: monotonic report-stream byte count (text_delta chars). */
  reportBytes?: number;
  /** Timestamp of the last real RPC/session event observed by the worker. */
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  /** v0.34.56: the toolCallId of the open start (undefined when the start
   * event carried none — the missing-toolCallId shape). */
  currentToolId?: string;
  toolCalls: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
  /** v0.34.56: explicitly unmatched tool starts/ends — see
   * applyToolExecutionEvent (goal-loop-auditor.ts) and the worker's mirror
   * in scripts/goal-auditor-worker.mjs. Never dropped, never falsely paired. */
  unmatchedToolStarts: Array<{ name: string; argsPrefix: string; startedAt: number; toolCallId?: string }>;
  unmatchedToolEnds: Array<{ toolCallId?: string; toolName?: string; at: number }>;
}

export type AuditorModel = string | { provider: string; id: string };

/** A resolved auditor candidate. `ref` is optional for compatibility with
 * older callers; the shared fallback walker derives it from `model` when it
 * can and otherwise treats the candidate as a unique, last-resort slot. */
export interface AuditorFallbackCandidate {
  ref?: string;
  model: any;
  via: string;
}

export interface AuditorFallbackPolicyOptions {
  /** The user-configured forbidden refs. The selector skips these silently. */
  forbiddenRefs?: readonly string[];
  /** Lifecycle fence checked before and after each delayed attempt. */
  shouldRetry?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  retryBaseMinutes?: number;
  onRetry?: (candidate: AuditorFallbackCandidate, error: string, delayMs: number) => void;
  onFallback?: (from: AuditorFallbackCandidate, to: AuditorFallbackCandidate, error: string, delayMs: number) => void;
  onSelection?: (event: ModelFallbackEvent) => void;
}

/**
 * Run detached auditor candidates through the same policy as main-model
 * recovery: normalize the ordered refs, gate forbidden/unregistered refs,
 * select only an untried ref, classify provider failures, retry the current
 * ref once, then use the bounded shared backoff before walking to the next
 * ref. The worker transport remains unchanged; this function only owns the
 * parent-side candidate cursor and timing.
 */
export async function runAuditorFallbackWithPolicy(
  candidates: AuditorFallbackCandidate[],
  run: (candidate: AuditorFallbackCandidate) => Promise<GoalAuditorResult>,
  opts: AuditorFallbackPolicyOptions = {},
): Promise<{ result: GoalAuditorResult; retriedOnce: boolean; fallbackUsed: boolean; via: string }> {
  const sequence = candidates.length > 0 ? candidates : [{ model: undefined, via: "unset" }];
  if (candidates.length === 0) {
    const result = await run(sequence[0]!);
    return { result, retriedOnce: false, fallbackUsed: false, via: "unset" };
  }

  const normalized = sequence.map((candidate, index) => ({
    candidate,
    ref: (candidate.ref?.trim() || modelRef(candidate.model) || `auditor/candidate-${index}`),
  }));
  const refs = normalizeMainModelFallbackRefs(normalized.map((entry) => entry.ref));
  const byRef = new Map<string, AuditorFallbackCandidate>();
  for (const entry of normalized) {
    const key = entry.ref.toLowerCase();
    if (!byRef.has(key)) byRef.set(key, entry.candidate);
  }
  const scope = { kind: "auditor" } as const;
  const selector = new ModelSelector({
    getChain: () => refs,
    resolve: (ref) => byRef.get(ref.toLowerCase())?.model,
    isForbidden: (ref) => isForbiddenModel(ref, opts.forbiddenRefs ?? []),
    record: opts.onSelection,
  });
  const attempted: string[] = [];
  const addAttempted = (ref: string): void => {
    if (!attempted.some((entry) => entry.toLowerCase() === ref.toLowerCase())) attempted.push(ref);
  };
  const isLive = (): boolean => {
    if (!opts.shouldRetry) return true;
    try { return opts.shouldRetry(); } catch { return false; }
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let currentRef: string | undefined;
  let retriedOnce = false;
  let fallbackUsed = false;
  let failureAttempt = 0;
  let fallbackFrom: AuditorFallbackCandidate | undefined;
  let fallbackError: string | undefined;
  let fallbackDelayMs = 0;
  let pendingResult: GoalAuditorResult | undefined;
  const noCandidateResult = (): GoalAuditorResult => ({
    approved: false,
    disapproved: false,
    output: "",
    model: modelRef(sequence[0]!.model) ?? "",
    error: ["no auditor", "model"].join(" "),
    infrastructureClass: "no-verdict",
  });

  for (;;) {
    // Keep the explicit pure cursor call here. ModelSelector.selectNextValid
    // composes the same helper while adding the forbidden/unregistered walk.
    if (nextUntriedModelRef(currentRef, refs, attempted) === undefined) {
      const last = pendingResult ?? noCandidateResult();
      return { result: last, retriedOnce, fallbackUsed, via: fallbackFrom?.via ?? sequence[0]!.via };
    }
    const selected = selector.selectNextValid(scope, currentRef, attempted);
    for (const visited of selector.lastVisitedRefs) addAttempted(visited);
    if (!("model" in selected) || typeof selected.ref !== "string") {
      const result = pendingResult ?? noCandidateResult();
      return { result, retriedOnce, fallbackUsed, via: fallbackFrom?.via ?? sequence[0]!.via };
    }
    const selectedRef = selected.ref;
    const candidate = byRef.get(selectedRef.toLowerCase());
    if (!candidate) {
      addAttempted(selectedRef);
      currentRef = selectedRef;
      continue;
    }
    addAttempted(selectedRef);
    if (fallbackFrom) {
      fallbackUsed = true;
      opts.onFallback?.(fallbackFrom, candidate, fallbackError ?? "auditor fallback", fallbackDelayMs);
      fallbackFrom = undefined;
      fallbackError = undefined;
      fallbackDelayMs = 0;
    }

    pendingResult = undefined;
    const first = await run(candidate);
    if (first.approved || first.disapproved || first.impossible || !first.error) {
      return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    }
    let failure = classifyMainModelFailure(first.error);
    if (!isRetriableInfraError(first.error) || !isMainModelFallbackFailure(failure)) {
      return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    }
    failureAttempt += 1;
    if (!isLive()) return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    const retryDelayMs = mainModelFailureDelayMs(failure, failureAttempt, opts.retryBaseMinutes ?? 15);
    opts.onRetry?.(candidate, first.error, retryDelayMs);
    await sleep(retryDelayMs);
    if (!isLive()) return { result: first, retriedOnce, fallbackUsed, via: candidate.via };

    const second = await run(candidate);
    pendingResult = second;
    retriedOnce = true;
    if (second.approved || second.disapproved || second.impossible || !second.error) {
      return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
    }
    failure = classifyMainModelFailure(second.error);
    if (!isRetriableInfraError(second.error) || !isMainModelFallbackFailure(failure)) {
      return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
    }
    currentRef = selectedRef;
    const nextRef = nextUntriedModelRef(currentRef, refs, attempted);
    if (nextRef === undefined) {
      return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
    }
    failureAttempt += 1;
    fallbackDelayMs = mainModelFailureDelayMs(failure, failureAttempt, opts.retryBaseMinutes ?? 15);
    if (!isLive()) return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
    await sleep(fallbackDelayMs);
    if (!isLive()) return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
    fallbackFrom = candidate;
    fallbackError = second.error;
  }
}

// The detached auditor intentionally exposes the full inspection/tooling
// surface, including bash, so it can run bounded tests and reproduce behavior.
// This is a power-oriented mode, not a read-only security boundary; callers
// still get the independent per-tool timeout below.
export const AUDITOR_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const PROTOCOL_VERSION = 1;
const DEFAULT_WALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** v0.34.57 (steal-list #7 / bug #1.4): heartbeat-without-progress watchdog.
 * A worker heartbeat (`lastActivityAt`) fresher than this is "activity";
 * older than this is "silence" (the worker's own GLLA_AUDITOR_STALL_MS
 * brake owns that case — the parent watchdog must not double-fire it). */
const DEFAULT_HEARTBEAT_FRESH_MS = 60_000;
/** v0.34.57: if the heartbeat stays fresh but no NEW tool call or report
 * output arrives for this long, the worker is alive but wedged (auto-retry
 * loop, empty stream, hung tool). Demote to quiet, emit `auditor_stalled`,
 * and auto-cancel the detached job. Mirrors the worker's 10m default brake
 * on the complementary axis: silence→worker cancels, activity-without-
 * progress→parent cancels. Both are far inside the 30m wall bound and the
 * observed 1h50m stuck case. */
const DEFAULT_HEARTBEAT_NO_PROGRESS_MS = 10 * 60_000;
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WORKER_SHUTDOWN_GRACE_MS = 1_000;
const WORKER_FORCE_SETTLE_MS = 250;
const activeChildren = new Map<string, ChildProcess>();
const workerTermination = new WeakMap<ChildProcess, Promise<void>>();

/**
 * Give each detached filesystem/child attempt a fresh identity while keeping
 * the logical completion claim visible as its prefix. A retried worker must
 * not collide with a stale job directory, and the parent still uses the
 * logical claim ID for stale-result rejection.
 */
export function newDetachedAuditJobAttemptId(logicalAttemptId: string): string {
  return `${logicalAttemptId}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function childKey(cwd: string, attemptId: string): string {
  return `${path.resolve(cwd)}\u0000${attemptId}`;
}

/** Wait for a detached worker to actually exit. `ChildProcess.killed` only
 * means a signal was sent; it is not proof that the worker or its descendants
 * stopped. */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
  });
}

function signalWorkerTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  try {
    if (process.platform !== "win32") {
      // detached:true gives the worker its own process group. Signal the group
      // so a worker-launched shell/test/browser descendant cannot survive its
      // parent after cancellation.
      process.kill(-child.pid, signal);
      return true;
    }
  } catch {
    // Fall through to the direct child signal below.
  }
  try {
    // Keep the explicit SIGTERM spelling visible in the teardown contract;
    // the SIGKILL branch remains parameterized for escalation.
    return signal === "SIGTERM" ? child.kill("SIGTERM") : child.kill(signal);
  } catch { return false; }
}

async function terminateWorker(child: ChildProcess): Promise<void> {
  const existing = workerTermination.get(child);
  if (existing) return existing;
  const termination = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      // The worker is itself a detached Node process; taskkill /T reaches its
      // nested cmd/npm/pi descendants as one tree.
      let killer: ChildProcess | undefined;
      try {
        killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        await waitForChildExit(killer, WORKER_SHUTDOWN_GRACE_MS);
      } catch {
        /* direct fallback below */
      }
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* best effort */ }
        await waitForChildExit(child, WORKER_FORCE_SETTLE_MS);
      }
      return;
    }
    signalWorkerTree(child, "SIGTERM");
    await waitForChildExit(child, WORKER_SHUTDOWN_GRACE_MS);
    if (child.exitCode === null && child.signalCode === null) {
      signalWorkerTree(child, "SIGKILL");
      await waitForChildExit(child, WORKER_FORCE_SETTLE_MS);
    }
  })();
  workerTermination.set(child, termination);
  return termination;
}

function workerProcessMatches(cwd: string, pid: number, dir: string): boolean {
  try {
    const workerDir = path.resolve(dir);
    const lock = JSON.parse(readFileSync(path.join(workerDir, "lock"), "utf8")) as Record<string, unknown>;
    const workerPath = typeof lock.workerPath === "string" && lock.workerPath.trim()
      ? path.resolve(lock.workerPath)
      : "goal-auditor-worker";
    let command: string;
    if (process.platform === "win32") {
      // Verify the command line before taskkill /T. A stale numeric PID can be
      // reused by an unrelated process between host sessions; PowerShell's
      // CIM query is available on supported Windows hosts and fails closed if
      // it is unavailable.
      const query = "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = "
        + String(pid)
        + "' -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.CommandLine }";
      const inspected = nodeSpawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
        encoding: "utf8",
        timeout: 1_000,
        windowsHide: true,
      });
      if (inspected.error || inspected.status !== 0) return false;
      command = String(inspected.stdout ?? "");
      const lower = command.toLowerCase();
      return (lower.includes(workerPath.toLowerCase()) || lower.includes(path.basename(workerPath).toLowerCase()))
        && lower.includes("--job-dir")
        && lower.includes(workerDir.toLowerCase());
    }
    command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    const cwdPath = readlinkSync(`/proc/${pid}/cwd`);
    const expectedCwd = realpathSync(cwd);
    return (command.includes(workerPath) || command.includes(path.basename(workerPath)))
      && command.includes("--job-dir")
      && command.includes(workerDir)
      && (cwdPath === expectedCwd || cwdPath.startsWith(`${expectedCwd}${path.sep}`));
  } catch {
    // A dead process or an unreadable process inspection is not safe to signal.
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function durableWorkerPids(cwd: string, logicalAttemptId: string): Array<{ pid: number; attemptId: string; dir: string }> {
  const root = path.join(piGlaDir(cwd), "audit-jobs");
  const names: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === logicalAttemptId || entry.name.startsWith(`${logicalAttemptId}-`)) names.push(entry.name);
    }
  } catch {
    return [];
  }
  const out: Array<{ pid: number; attemptId: string; dir: string }> = [];
  for (const attemptId of names) {
    try {
      const lock = JSON.parse(readFileSync(path.join(root, attemptId, "lock"), "utf8")) as Record<string, unknown>;
      const pid = typeof lock.pid === "number" ? lock.pid : Number(lock.pid);
      // Older locks contain the parent pid. Only the worker-owned marker is
      // safe to reap across a host restart; never guess at a reused parent.
      if (lock.role !== "worker" || !Number.isInteger(pid) || pid <= 1) continue;
      out.push({ pid, attemptId, dir: path.join(root, attemptId) });
    } catch {
      /* job is still being created or already cleaned */
    }
  }
  return out;
}

/** Reap workers left behind when their owning pi host died. This is the
 * cross-process companion to activeChildren, which intentionally cannot
 * survive a host restart. */
function reapDurableWorkers(cwd: string, logicalAttemptId: string): boolean {
  let killed = false;
  for (const { pid, dir } of durableWorkerPids(cwd, logicalAttemptId)) {
    // A stale numeric PID is not ownership proof. On POSIX require the live
    // process to still advertise this exact worker/job directory before
    // signalling its process group; otherwise a reused PID must be ignored.
    if (!workerProcessMatches(cwd, pid, dir)) {
      // An inspection failure is not proof that the PID is dead (notably when
      // PowerShell/CIM is unavailable). Keep the scratch directory until the
      // process is proven gone; deleting it here could strand a live worker.
      if (!processAlive(pid)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      continue;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, "SIGTERM");
        killed = true;
        const force = setTimeout(() => {
          if (!workerProcessMatches(cwd, pid, dir)) return;
          try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
        }, WORKER_SHUTDOWN_GRACE_MS);
        force.unref?.();
      } else {
        const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.unref?.();
        killed = true;
      }
      // A dead host cannot run the normal parent finally block. Once the
      // worker PID is gone, remove its orphaned scratch directory too; never
      // remove it while the process may still write protocol files.
      const cleanup = setTimeout(() => {
        if (workerProcessMatches(cwd, pid, dir) || processAlive(pid)) return;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }, WORKER_SHUTDOWN_GRACE_MS + WORKER_FORCE_SETTLE_MS + 500);
      cleanup.unref?.();
    } catch {
      if (workerProcessMatches(cwd, pid, dir)) {
        try { process.kill(pid, "SIGTERM"); killed = true; } catch { /* already gone */ }
      }
    }
  }
  return killed;
}

/** Best-effort cancellation used after the owning goal is archived/cancelled. */
export function cancelDetachedGoalCompletionAuditor(cwd: string, attemptId: string): boolean {
  const root = path.resolve(cwd);
  const exact = childKey(root, attemptId);
  const retryPrefix = `${exact}-`;
  let killed = reapDurableWorkers(root, attemptId);
  // Completion state keeps the logical claim attempt ID, while each detached
  // retry owns a unique filesystem/child identity (`<logical>-<nonce>`). Kill
  // both the exact legacy identity and every live retry for this claim.
  for (const [key, child] of activeChildren) {
    if (key !== exact && !key.startsWith(retryPrefix)) continue;
    if (!childAlive(child)) continue;
    killed = signalWorkerTree(child, "SIGTERM") || killed;
    void terminateWorker(child).catch(() => {});
  }
  return killed;
}

interface AuditorRequest {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  cwd: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  createdAt: string;
  wallDeadlineAt: number;
  /** v0.36.0: pi extension specs the detached auditor may load via
   * `pi --extension <spec>` (under the still-on `--no-extensions` discovery
   * switch). Absent/empty = the default extension-less auditor. Part of the
   * request hash like every other field. */
  allowedExtensions?: string[];
  /** v0.34.59: focus revision token captured at dispatch. Echoed in
   * result.json; the parent re-validates against current disk state
   * before applying the verdict. Mismatch → stale-refusal, not a silent
   * overwrite. */
  goalRevision?: GoalRevisionToken;
}

interface AuditorToolCall {
  name: string;
  argsPrefix: string;
  finishedAt: number;
}

interface AuditorResultFile {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  ok: boolean;
  output: string;
  model: string;
  thinkingLevel: string;
  toolCalls: AuditorToolCall[];
  error?: string;
  infrastructureClass?: AuditorInfrastructureClass;
  /** v0.34.59: focus revision token echoed from request.json. The parent
   * compares this against the current state.goal.revision; mismatch → the
   * verdict is treated as stale-refused, not a silent overwrite. */
  goalRevision?: GoalRevisionToken;
}

interface AuditorProgressFile {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  phase: AuditorProgress["phase"];
  elapsedMs: number;
  /** v0.34.86: monotonic report-stream byte count (text_delta chars). The
   * silent-mode byte counter — the "worker IS making progress" evidence
   * that never reveals prose. */
  reportBytes?: number;
  /** Worker-side activity, not merely a parent poll or UI refresh. */
  lastActivityAt?: number;
  recentOutput: string[];
  toolCalls: AuditorToolCall[];
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  /** v0.34.56: explicitly unmatched tool telemetry facts (see
   * applyToolExecutionEvent in goal-loop-auditor.ts). */
  unmatchedToolStarts?: AuditorProgress["unmatchedToolStarts"];
  unmatchedToolEnds?: AuditorProgress["unmatchedToolEnds"];
}

export type AuditorInfrastructureClass = "no-verdict" | "timeout" | "transport" | "provider";

export interface AuditorProcessRuntime {
  /** Override the worker launcher command (normally process.execPath). */
  command?: string;
  /** Override the worker module (normally scripts/goal-auditor-worker.mjs). */
  workerPath?: string;
  /** Override the pi binary without putting it in the request or argv. */
  piBinary?: string;
  /** Override process spawning in bounded tests. */
  spawn?: typeof nodeSpawn;
  pollIntervalMs?: number;
  wallTimeoutMs?: number;
  now?: () => number;
  attemptId?: () => string;
  /** v0.34.57: watchdog window — cancel the detached job when the worker's
   * heartbeat stays fresh but no new tool call or report output arrives for
   * this long (default 10m). Tests shrink this. */
  heartbeatNoProgressMs?: number;
  /** v0.35.49: budget for the worker's FIRST RPC event, armed from spawn
   * (default: heartbeatNoProgressMs — production boot is seconds, the window
   * is minutes). Separate knob so watchdog tests can arm one silence axis
   * without worker cold-start racing the other. */
  firstEventTimeoutMs?: number;
  /** v0.34.57: freshness horizon for `lastActivityAt` — only heartbeats
   * younger than this count as "activity" for the watchdog (default 60s). */
  heartbeatFreshMs?: number;
  /** v0.34.130: independent ceiling for one allowed auditor tool call.
   * This remains armed while the tool is open, unlike the inactivity brake. */
  toolTimeoutMs?: number;
  /** Environment is inherited by default; useful for a fake pi binary in tests. */
  env?: NodeJS.ProcessEnv;
  /** v0.36.0: override the home dir used to resolve allowlisted extension
   * specs to install paths (hermetic tests; os.homedir() ignores HOME env
   * changes mid-process on some platforms). */
  homeDir?: string;
  /** Logical completion claim id shared by unique retry attempt directories.
   * Used to reap a worker whose owning pi host died before cleanup. */
  logicalAttemptId?: string;
}

export type AuditorProgressCallback = (progress: AuditorProgress) => void;

/** v0.34.57: payload for the heartbeat-without-progress watchdog. The parent
 * persists this as the `auditor_stalled` ledger event. */
export interface AuditorStalledInfo {
  /** When the watchdog fired. */
  at: number;
  /** Which independent watchdog fired. */
  reason: "heartbeat-no-progress" | "tool-timeout" | "first-event-timeout" | "heartbeat-stale";
  /** Age of the last worker heartbeat at detection (`now - lastActivityAt`).
   * For heartbeat-no-progress this is fresh (≤ heartbeatFreshMs); a
   * tool-timeout may deliberately have a stale heartbeat. */
  heartbeatAgeMs: number;
  /** How long the no-progress/tool-open streak had been running. */
  noProgressMs: number;
  /** The worker phase in the last progress snapshot. */
  phase: AuditorProgress["phase"];
  /** Present when the tool-timeout watchdog fired. */
  toolName?: string;
  toolAgeMs?: number;
}

/** Return a stable JSON representation for request-hash validation. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function requestHash(requestWithoutHash: Omit<AuditorRequest, "requestHash">): string {
  return createHash("sha256").update(stableJson(requestWithoutHash), "utf8").digest("hex");
}

function modelLabel(model: AuditorModel | undefined): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return `${model.provider}/${model.id}`;
  return "(unset)";
}

function buildPrompt(goal: Goal, completionSummary?: string | null, verificationSummary?: string | null): string {
  return buildGoalAuditorPrompt(goal, completionSummary, verificationSummary);
}

function assertAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_RE.test(attemptId)) throw new Error("invalid auditor attempt id");
}

async function ensureRegularFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`auditor protocol path is not a regular file: ${file}`);
}

/** Each attempt directory is parent-owned scratch space, not an audit
 * archive. Remove it after the parent has consumed (or abandoned) the
 * attempt, while leaving the shared jobs root available for concurrent jobs. */
async function removeAuditJobDirectory(jobDir: string): Promise<void> {
  await fs.rm(jobDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).catch(() => {});
}

async function readJson<T>(file: string): Promise<T> {
  await ensureRegularFile(file);
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text) as T;
}

/** Write JSON so readers see either the old file or the complete new file. */
export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await renameWithWindowsRetry((from, to) => fs.rename(from, to), temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function acquireLock(lockPath: string, attemptId: string): Promise<void> {
  const handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, attemptId, pid: process.pid, role: "parent" })}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function defaultWorkerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/goal-auditor-worker.mjs");
}

function childAlive(child: ChildProcess): boolean {
  // ChildProcess.killed means a signal was sent, not that the process exited.
  return child.exitCode === null && child.signalCode === null;
}

function asProgress(file: AuditorProgressFile, startedAt: number): AuditorProgress {
  return {
    phase: file.phase,
    elapsedMs: Math.max(file.elapsedMs, Date.now() - startedAt),
    ...(file.reportBytes !== undefined ? { reportBytes: file.reportBytes } : {}),
    ...(file.lastActivityAt !== undefined ? { lastActivityAt: file.lastActivityAt } : {}),
    recentOutput: file.recentOutput,
    toolCalls: file.toolCalls,
    unmatchedToolStarts: file.unmatchedToolStarts ?? [],
    unmatchedToolEnds: file.unmatchedToolEnds ?? [],
    ...(file.currentTool ? { currentTool: file.currentTool } : {}),
    ...(file.currentToolArgs ? { currentToolArgs: file.currentToolArgs } : {}),
    ...(file.currentToolStartedAt ? { currentToolStartedAt: file.currentToolStartedAt } : {}),
    ...(file.unmatchedToolStarts ? { unmatchedToolStarts: file.unmatchedToolStarts } : {}),
    ...(file.unmatchedToolEnds ? { unmatchedToolEnds: file.unmatchedToolEnds } : {}),
  };
}

/** v0.34.57: the progress-bearing subset of a worker snapshot. Heartbeat
 * events refresh `lastActivityAt` and may oscillate `phase` (running ↔
 * thinking on message_start/agent_start) without delivering progress — this
 * signature deliberately excludes both, so only a NEW finished tool call,
 * new report output, or a NEW tool start counts as progress. */
function progressSignature(file: AuditorProgressFile): string {
  const calls = file.toolCalls;
  const lastToolFinishedAt = calls.length > 0 ? (calls[calls.length - 1]?.finishedAt ?? 0) : 0;
  return `${calls.length}|${lastToolFinishedAt}|${file.recentOutput.join("\u0000")}|${file.currentTool ?? ""}|${file.currentToolStartedAt ?? 0}`;
}

function infra(model: string, thinkingLevel: string, error: string, output = "", capturedToken?: GoalRevisionToken, infrastructureClass: AuditorInfrastructureClass = "transport"): GoalAuditorResult {
  return { approved: false, disapproved: false, output, model, thinkingLevel, error, infrastructureClass, ...(capturedToken ? { goalRevision: capturedToken } : {}) };
}

function failedResultClass(error: string | undefined): AuditorInfrastructureClass {
  if (/^Auditor (?:exceeded|stalled)\b/i.test(error ?? "")) return "timeout";
  // A provider can return an arbitrary HTTP status without any useful
  // wording. Keep status-bearing failures on the generic provider retry
  // path; status-free worker exits and missing verdicts stay no-verdict
  // infrastructure failures.
  return /(?:^|\b)(?:HTTP\s*)?(?:401|403|408|409|429|5\d\d)\b/i.test(error ?? "")
    ? "provider"
    : "no-verdict";
}

/** v0.34.59: stamp the captured focus revision onto a successful verdict
 * result so the parent can re-validate before applying. Mismatched tokens
 * cause the verdict to be refused (logged as stale_revision_refused in the
 * parent) rather than silently overwriting a goal that moved on. */
function stampToken<T extends GoalAuditorResult>(result: T, capturedToken: GoalRevisionToken | undefined): T {
  if (!capturedToken) return result;
  return { ...result, goalRevision: capturedToken };
}

/**
 * Run one completion audit in a detached, extension-less child process.
 * Infrastructure failures never become semantic disapprovals and never fall
 * back to an in-process session.
 */
export async function runDetachedGoalCompletionAuditor(args: {
  cwd: string;
  goal: Goal;
  completionSummary?: string | null;
  verificationSummary?: string | null;
  model?: AuditorModel;
  thinkingLevel?: string;
  /** v0.36.0: extension specs allow-listed for the detached auditor
   * (settings key auditorAllowedExtensions). Raw specs (npm:/git:/relative)
   * are resolved to concrete install paths HERE, inside the process layer,
   * so no call site can bypass resolution — the detached worker only ever
   * sees directly loadable absolute paths. */
  allowedExtensions?: string[];
  signal?: AbortSignal;
  onProgress?: AuditorProgressCallback;
  /** v0.34.57: fired once when the heartbeat-without-progress watchdog
   * detects a wedged worker and auto-cancels the detached job. The parent
   * persists this as the `auditor_stalled` ledger event. */
  onStalled?: (info: AuditorStalledInfo) => void;
  runtime?: AuditorProcessRuntime;
}): Promise<GoalAuditorResult> {
  const runtime = args.runtime ?? {};
  const model = modelLabel(args.model);
  const thinkingLevel = args.thinkingLevel ?? "medium";
  if (!args.model || !model.trim() || model === "(unset)") return infra(model, thinkingLevel, "no auditor model", "", undefined, "provider");

  const now = runtime.now ?? Date.now;
  const wallTimeoutMs = runtime.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const pollIntervalMs = Math.max(10, runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const heartbeatFreshMs = Math.max(10, runtime.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS);
  const heartbeatNoProgressMs = Math.max(50, runtime.heartbeatNoProgressMs ?? DEFAULT_HEARTBEAT_NO_PROGRESS_MS);
  const firstEventTimeoutMs = Math.max(50, runtime.firstEventTimeoutMs ?? heartbeatNoProgressMs);
  const configuredToolTimeoutMs = runtime.toolTimeoutMs;
  const toolTimeoutMs = configuredToolTimeoutMs === undefined || !Number.isFinite(configuredToolTimeoutMs)
    ? DEFAULT_TOOL_TIMEOUT_MS
    : Math.max(50, configuredToolTimeoutMs);
  const attemptId = runtime.attemptId?.() ?? `${Date.now().toString(36)}-${randomUUID()}`;
  const logicalAttemptId = runtime.logicalAttemptId ?? attemptId;
  // v0.34.59: capture the focus revision token at dispatch. Every result
  // shape returned to the parent carries this token so the parent can
  // re-validate before applying a verdict. Pre-revision goals pass through
  // unchanged (captured is null).
  const capturedRevisionToken: GoalRevisionToken | undefined = captureGoalRevision(args.goal) ?? undefined;
  try {
    assertAttemptId(attemptId);
  } catch (error) {
    return infra(model, thinkingLevel, error instanceof Error ? error.message : String(error), "", capturedRevisionToken, "transport");
  }

  const jobDir = path.join(piGlaDir(args.cwd), "audit-jobs", attemptId);
  const jobsRoot = path.dirname(jobDir);
  const requestPath = path.join(jobDir, "request.json");
  const resultPath = path.join(jobDir, "result.json");
  const progressPath = path.join(jobDir, "progress.json");
  const lockPath = path.join(jobDir, "lock");
  const startedAt = now();
  const wallDeadlineAt = startedAt + wallTimeoutMs;
  let lockHeld = false;
  let jobDirCreated = false;
  let child: ChildProcess | undefined;
  let childSpawnError: string | undefined;
  let lastProgressSerialized = "";
  // v0.34.57: heartbeat-without-progress watchdog state. `lastProgressAt` is
  // reset whenever the progress signature changes; the watchdog fires when
  // the worker heartbeat stays fresh but the signature has not changed for
  // `heartbeatNoProgressMs` — the worker is alive but wedged.
  let lastProgressAt = startedAt;
  let lastProgressSignature = "";
  let lastProgress: AuditorProgressFile | undefined;

  try {
    // A fresh host has no in-memory activeChildren map. Reap only durable
    // worker-owned locks for this claim before creating the next attempt.
    reapDurableWorkers(args.cwd, logicalAttemptId);
    await fs.mkdir(jobsRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(jobDir, { mode: 0o700 });
    jobDirCreated = true;
    await acquireLock(lockPath, attemptId);
    lockHeld = true;

    // v0.36.0: resolve allowlist entries to concrete install paths before
    // hashing — raw npm:/git:/relative specs are NOT directly loadable by
    // the detached worker (fresh temp npm install online, 0 models
    // offline, wrong base dir for relative paths). Doing this in the
    // process layer means every dispatch path is covered.
    const allowedExtensions = resolveAuditorAllowedExtensions(args.allowedExtensions, runtime.homeDir ?? os.homedir(), args.cwd);
    const requestWithoutHash: Omit<AuditorRequest, "requestHash"> = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      cwd: args.cwd,
      prompt: buildPrompt(args.goal, args.completionSummary, args.verificationSummary),
      model,
      thinkingLevel,
      createdAt: new Date(startedAt).toISOString(),
      wallDeadlineAt,
      // v0.34.59: capture the focus revision token at dispatch. The
      // worker echoes it in result.json; the parent re-validates before
      // applying the verdict. A stale-handle ghost can no longer silently
      // overwrite a goal that moved on.
      goalRevision: capturedRevisionToken,
      // v0.36.0: only present when non-empty so historical requests hash
      // byte-identically to pre-feature workers.
      ...(allowedExtensions.length ? { allowedExtensions } : {}),
    };
    const request: AuditorRequest = { ...requestWithoutHash, requestHash: requestHash(requestWithoutHash) };
    await writeAtomicJson(requestPath, request);
    const initialProgress: AuditorProgressFile = {
      protocolVersion: PROTOCOL_VERSION, attemptId, requestHash: request.requestHash,
      phase: "starting", elapsedMs: 0, recentOutput: [], toolCalls: [],
    };
    await writeAtomicJson(progressPath, initialProgress);
    args.onProgress?.(asProgress(initialProgress, startedAt));

    const workerPath = runtime.workerPath ?? defaultWorkerPath();
    const command = runtime.command ?? process.execPath;
    const spawn = runtime.spawn ?? nodeSpawn;
    const env = { ...process.env, ...(runtime.env ?? {}) };
    if (runtime.piBinary) env.GLLA_PI_BINARY = runtime.piBinary;
    child = spawn(command, [workerPath, "--job-dir", jobDir], {
      cwd: args.cwd,
      detached: true,
      stdio: "ignore",
      env,
    } satisfies SpawnOptions);
    // `spawn()` reports ENOENT/EACCES asynchronously instead of throwing.
    // Attach the listener immediately so a launcher failure becomes a bounded
    // transport result rather than an unhandled error followed by a wall
    // timeout that hides the actual cause.
    child.once("error", (error) => {
      childSpawnError = error instanceof Error ? error.message : String(error);
    });
    activeChildren.set(childKey(args.cwd, attemptId), child);
    // The worker rewrites this marker with its own pid immediately after
    // reading the request. The durable role prevents a later host from
    // mistaking an old parent pid for a worker it may safely reap.
    const workerPathIdentity = path.isAbsolute(workerPath) ? path.resolve(workerPath) : path.resolve(args.cwd, workerPath);
    await writeAtomicJson(lockPath, { protocolVersion: PROTOCOL_VERSION, attemptId, pid: child.pid, role: "worker", workerPath: workerPathIdentity });
    child.unref();

    let abortTermination: Promise<void> | null = null;
    const abort = () => {
      if (child && childAlive(child)) {
        abortTermination ??= terminateWorker(child).catch(() => {});
      }
    };
    args.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (args.signal?.aborted) {
          // Do not return the transport result until the detached worker's
          // TERM→KILL teardown has settled. Returning first races the caller's
          // cleanup with a TERM-ignoring worker and leaves its PID alive.
          if (child && childAlive(child)) await terminateWorker(child).catch(() => {});
          else if (abortTermination) await abortTermination;
          return infra(model, thinkingLevel, "Auditor aborted.", "", capturedRevisionToken, "transport");
        }
        if (childSpawnError) return infra(model, thinkingLevel, `auditor worker launch failed: ${childSpawnError}`, "", capturedRevisionToken, "transport");
        if (now() >= wallDeadlineAt) {
          if (childAlive(child)) await terminateWorker(child);
          return infra(model, thinkingLevel, `Auditor exceeded its ${Math.round(wallTimeoutMs / 60_000)}m wall-clock bound and was aborted.`, "", capturedRevisionToken, "timeout");
        }
        try {
          const progress = await readJson<AuditorProgressFile>(progressPath);
          if (progress.protocolVersion !== PROTOCOL_VERSION || progress.attemptId !== attemptId || progress.requestHash !== request.requestHash) {
            return infra(model, thinkingLevel, "auditor progress identity/request-hash mismatch", "", capturedRevisionToken, "no-verdict");
          }
          lastProgress = progress;
          const serialized = stableJson(progress);
          if (serialized !== lastProgressSerialized) {
            lastProgressSerialized = serialized;
            args.onProgress?.(asProgress(progress, startedAt));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return infra(model, thinkingLevel, `invalid auditor progress: ${error instanceof Error ? error.message : String(error)}`, "", capturedRevisionToken, "no-verdict");
        }
        try {
          const result = await readJson<AuditorResultFile>(resultPath);
          if (result.protocolVersion !== PROTOCOL_VERSION || result.attemptId !== attemptId || result.requestHash !== request.requestHash) {
            return infra(model, thinkingLevel, "auditor result identity/request-hash mismatch", "", capturedRevisionToken, "no-verdict");
          }
          const output = stripThinkBlocks(result.output);
          if (!result.ok) {
            const error = result.error || "detached auditor failed";
            return infra(model, thinkingLevel, error, output, capturedRevisionToken, failedResultClass(error));
          }
          if (!output.trim()) return infra(model, thinkingLevel, "auditor produced no output", output, capturedRevisionToken, "no-verdict");
          const parsed = parseAuditorVerdict(output);
          if (!parsed.approved && !parsed.disapproved && !parsed.impossible) return infra(model, thinkingLevel, "auditor produced no verdict marker", output, capturedRevisionToken, "no-verdict");
          const disallowedTool = result.toolCalls.find((call) => !(AUDITOR_TOOLS as readonly string[]).includes(call.name));
          if (disallowedTool) {
            return infra(model, thinkingLevel, `Auditor reported unsupported tool: ${disallowedTool.name}`, output, capturedRevisionToken, "no-verdict");
          }
          const usedAuditTool = result.toolCalls.some((call) => (AUDITOR_TOOLS as readonly string[]).includes(call.name));
          if (parsed.approved && !usedAuditTool) {
            return stampToken({ approved: false, disapproved: true, output, model, thinkingLevel, error: "Auditor approved without calling any audit tool; treated as disapproved." }, capturedRevisionToken);
          }
          if (parsed.approved && args.goal.verificationContract?.trim()) {
            const shield = checkRegressionShield(output, args.goal.verificationContract);
            if (!shield.passed) {
              // The auditor's semantic verdict was approval; the separate
              // regression shield blocked acceptance because the report did
              // not cite every contract item. Keep that outcome distinct from
              // both a work disapproval and infrastructure failure.
              return stampToken({
                approved: true, disapproved: false, output, model, thinkingLevel,
                regressionShieldPassed: false, regressionShieldMissing: shield.missingItems,
              }, capturedRevisionToken);
            }
            args.onProgress?.({ phase: "complete", elapsedMs: now() - startedAt, recentOutput: output.split("\n").filter(Boolean).slice(-8), toolCalls: result.toolCalls, unmatchedToolStarts: [], unmatchedToolEnds: [] });
            return stampToken({ approved: true, disapproved: false, output, model, thinkingLevel, regressionShieldPassed: true }, capturedRevisionToken);
          }
          args.onProgress?.({ phase: "complete", elapsedMs: now() - startedAt, recentOutput: output.split("\n").filter(Boolean).slice(-8), toolCalls: result.toolCalls, unmatchedToolStarts: [], unmatchedToolEnds: [] });
          return stampToken({ approved: parsed.approved, disapproved: parsed.disapproved, impossible: parsed.impossible, impossibleReason: parsed.impossibleReason, output, model, thinkingLevel }, capturedRevisionToken);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return infra(model, thinkingLevel, `invalid auditor result: ${error instanceof Error ? error.message : String(error)}`, "", capturedRevisionToken, "no-verdict");
        }
        // v0.34.130: a tool-open timeout is independent of both heartbeat
        // freshness and the worker's inactivity brake. A stuck read/grep/find/
        // ls call emits no further RPC event, so neither heartbeat axis can
        // safely own its termination. Keep the detached job bounded well
        // inside the 30m wall.
        if (lastProgress?.currentToolStartedAt !== undefined) {
          const toolAgeMs = Math.max(0, now() - lastProgress.currentToolStartedAt);
          if (toolAgeMs >= toolTimeoutMs) {
            args.onProgress?.({
              phase: "running",
              elapsedMs: now() - startedAt,
              recentOutput: lastProgress.recentOutput,
              toolCalls: lastProgress.toolCalls,
              unmatchedToolStarts: lastProgress.unmatchedToolStarts ?? [],
              unmatchedToolEnds: lastProgress.unmatchedToolEnds ?? [],
            });
            const toolLabel = toolTimeoutMs >= 60_000
              ? `${Math.max(1, Math.round(toolTimeoutMs / 60_000))}m`
              : `${Math.max(1, Math.round(toolTimeoutMs / 1_000))}s`;
            args.onStalled?.({
              at: now(),
              reason: "tool-timeout",
              heartbeatAgeMs: lastProgress.lastActivityAt === undefined ? toolAgeMs : Math.max(0, now() - lastProgress.lastActivityAt),
              noProgressMs: toolAgeMs,
              phase: lastProgress.phase,
              toolName: lastProgress.currentTool,
              toolAgeMs,
            });
            if (child && childAlive(child)) await terminateWorker(child);
            return infra(model, thinkingLevel, `Auditor stalled — tool ${lastProgress.currentTool ?? "unknown"} exceeded its ${toolLabel} timeout; the detached job was auto-cancelled.`, "", capturedRevisionToken, "timeout");
          }
        }
        // v0.34.57: heartbeat-without-progress watchdog (steal-list #7 /
        // bug #1.4). The worker's own stall brake only fires on TOTAL silence
        // (and skips it while an auditor tool is running); a worker that
        // keeps emitting RPC events — auto-retry loops, empty message
        // updates, a hung tool — refreshes `lastActivityAt` forever without
        // delivering any new tool call or report output. That is the 1h50m
        // "alive but wedged" class: fail fast instead.
        if (lastProgress && lastProgress.lastActivityAt !== undefined && now() - lastProgress.lastActivityAt <= heartbeatFreshMs) {
          const signature = progressSignature(lastProgress);
          if (signature !== lastProgressSignature) {
            lastProgressSignature = signature;
            lastProgressAt = now();
          }
          const noProgressMs = now() - lastProgressAt;
          if (noProgressMs >= heartbeatNoProgressMs) {
            // Demote to quiet first: a final progress snapshot WITHOUT the
            // live heartbeat, so the HUD cannot render LIVE + "worker activity
            // 0s ago" for the wedged worker.
            args.onProgress?.({
              phase: "running",
              elapsedMs: now() - startedAt,
              recentOutput: lastProgress.recentOutput,
              toolCalls: lastProgress.toolCalls,
              unmatchedToolStarts: lastProgress.unmatchedToolStarts ?? [],
              unmatchedToolEnds: lastProgress.unmatchedToolEnds ?? [],
            });
            const stallLabel = heartbeatNoProgressMs >= 60_000
              ? `${Math.max(1, Math.round(heartbeatNoProgressMs / 60_000))}m`
              : `${Math.max(1, Math.round(heartbeatNoProgressMs / 1_000))}s`;
            args.onStalled?.({
              at: now(),
              reason: "heartbeat-no-progress",
              heartbeatAgeMs: now() - lastProgress.lastActivityAt,
              noProgressMs,
              phase: lastProgress.phase,
            });
            if (child && childAlive(child)) await terminateWorker(child);
            return infra(model, thinkingLevel, `Auditor stalled — heartbeats without progress for ${stallLabel} (no new tool call or output); the detached job was auto-cancelled.`, "", capturedRevisionToken, "timeout");
          }
        }
        // v0.35.49: the two complementary silence axes. The fresh-heartbeat
        // branch above only arms while RPC events keep flowing; the field
        // (2026-08-23, football-forever/doomtap/junk-runner/vps-compare) showed
        // workers whose provider hangs emit ONE boot event (or none) and then
        // total silence — the heartbeat goes STALE, that gate disarms, and the
        // only remaining bound is the 30m wall, so every doomed attempt burned
        // its full wall while the goal sat "auditing" and the queue looked
        // dead. The worker's own inactivity brake (GLLA_AUDITOR_STALL_MS) is
        // the same window with the same running-tool exemption; mirror it
        // parent-side so a wedged or silently-dead worker is failed fast into
        // the (already eager first-retry) fallback ladder instead of the wall.
        // Two separate axes with separate budgets: a worker that HAS emitted
        // an event and gone silent gets heartbeatNoProgressMs; a worker that
        // never emitted anything gets firstEventTimeoutMs (default: the same
        // window — production boot is seconds, the window is minutes — but
        // overridable so watchdog tests can arm one axis without the other
        // racing worker cold-start). A running tool exempts both: the
        // independent per-tool timeout owns that axis.
        if (lastProgress?.currentToolStartedAt === undefined) {
          if (lastProgress?.lastActivityAt !== undefined) {
            const staleMs = Math.max(0, now() - lastProgress.lastActivityAt);
            if (staleMs >= heartbeatNoProgressMs) {
              const stallLabel = heartbeatNoProgressMs >= 60_000
                ? `${Math.max(1, Math.round(heartbeatNoProgressMs / 60_000))}m`
                : `${Math.max(1, Math.round(heartbeatNoProgressMs / 1_000))}s`;
              args.onProgress?.({
                phase: "running",
                elapsedMs: now() - startedAt,
                recentOutput: lastProgress.recentOutput,
                toolCalls: lastProgress.toolCalls,
                unmatchedToolStarts: lastProgress.unmatchedToolStarts ?? [],
                unmatchedToolEnds: lastProgress.unmatchedToolEnds ?? [],
              });
              args.onStalled?.({
                at: now(),
                reason: "heartbeat-stale",
                heartbeatAgeMs: staleMs,
                noProgressMs: staleMs,
                phase: lastProgress.phase,
              });
              if (child && childAlive(child)) await terminateWorker(child);
              return infra(
                model,
                thinkingLevel,
                `Auditor stalled — no session activity for ${stallLabel}; the detached job was auto-cancelled.`,
                "",
                capturedRevisionToken,
                "timeout",
              );
            }
          } else if (now() - startedAt >= firstEventTimeoutMs) {
            const stallLabel = firstEventTimeoutMs >= 60_000
              ? `${Math.max(1, Math.round(firstEventTimeoutMs / 60_000))}m`
              : `${Math.max(1, Math.round(firstEventTimeoutMs / 1_000))}s`;
            args.onStalled?.({
              at: now(),
              reason: "first-event-timeout",
              heartbeatAgeMs: now() - startedAt,
              noProgressMs: now() - startedAt,
              phase: lastProgress?.phase ?? "starting",
            });
            if (child && childAlive(child)) await terminateWorker(child);
            return infra(
              model,
              thinkingLevel,
              `Auditor stalled — no session activity since boot for ${stallLabel}; the detached job was auto-cancelled.`,
              "",
              capturedRevisionToken,
              "timeout",
            );
          }
        }
        if (child && !childAlive(child)) return infra(model, thinkingLevel, "auditor worker exited without an atomic result", "", capturedRevisionToken, "no-verdict");
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      args.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    return infra(model, thinkingLevel, error instanceof Error ? error.message : String(error), "", capturedRevisionToken, "transport");
  } finally {
    if (child && childAlive(child)) await terminateWorker(child).catch(() => {});
    activeChildren.delete(childKey(args.cwd, attemptId));
    if (lockHeld) await fs.unlink(lockPath).catch(() => {});
    // request/progress/result are transport scratch files. Do not retain one
    // directory per retry, and never remove a colliding directory we did not
    // successfully create and therefore do not own.
    if (jobDirCreated) await removeAuditJobDirectory(jobDir);
  }
}

export { buildPrompt as buildGoalAuditorPrompt };
