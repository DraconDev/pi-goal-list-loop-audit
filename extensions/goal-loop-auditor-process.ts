/**
 * Detached completion-auditor transport.
 *
 * The parent never creates an agent session. It owns a small, temporary job
 * directory in `<cwd>/.pi-glla/audit-jobs/<attemptId>/`, starts the
 * extension-less worker, accepts only an identity-checked result, and removes
 * the attempt directory when the transport settles.
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  piGlaDir,
  stripThinkBlocks,
  captureGoalRevision,
  isRetriableInfraError,
  isForbiddenModel,
  type Goal,
  type GoalRevisionToken,
} from "./goal-loop-core.js";
import {
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  mainModelFailureDelayMs,
  modelRef,
  nextUntriedModelRef,
  normalizeBoundedModelRefs,
  MAX_AUDITOR_CANDIDATE_REFS,
} from "./main-model-recovery.js";
import { ModelSelector, type ModelFallbackEvent } from "./model-selector.js";
import { buildGoalAuditorPrompt } from "./goal-loop-auditor.js";
import { checkRegressionShield, parseAuditorVerdict } from "./goal-loop-shield.js";
import { renameWithWindowsRetry } from "../scripts/goal-auditor-launch.mjs";
import { resolveAuditorAllowedExtensions } from "./auditor-extensions.js";

export type AuditorInfrastructureClass = "no-verdict" | "timeout" | "transport" | "provider";
export type AuditorRecoveryFailureClass = AuditorInfrastructureClass;
const AUDITOR_INFRASTRUCTURE_CLASSES = new Set<AuditorInfrastructureClass>(["no-verdict", "timeout", "transport", "provider"]);
export const AUDITOR_CURSOR_PERSISTENCE_FAILURE = "auditor recovery cursor persistence failed";

export function isAuditorCursorPersistenceFailure(error: unknown): boolean {
  return typeof error === "string" && error.trim() === AUDITOR_CURSOR_PERSISTENCE_FAILURE;
}

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
  /** True when the ordered candidate chain was exhausted after the last
   * candidate's allowed retry. This is orthogonal to infrastructureClass:
   * the final failure still retains its concrete transport/provider/timeout
   * class while the parent can record that no candidate remained. */
  fallbackExhausted?: boolean;
  regressionShieldPassed?: boolean;
  regressionShieldMissing?: string[];
  /** v0.34.59: focus revision token echoed from request.json. The parent
   * compares this against the current state.goal.revision after the audit
   * finishes; mismatch → the verdict is treated as stale-refused, not a
   * silent overwrite. The caller decides what to do (typically: skip the
   * verdict, log stale_revision_refused, surface the refusal in the HUD). */
  goalRevision?: GoalRevisionToken;
}

/** Infrastructure errors are never semantic verdicts, even if a parser or
 * partial worker payload also set verdict-like flags. Normalize at the parent
 * boundary before history, shield, archive, or continuation policy sees the
 * result. */
export function normalizeAuditorInfrastructureResult(result: GoalAuditorResult): GoalAuditorResult {
  const infrastructureClass = result.infrastructureClass && AUDITOR_INFRASTRUCTURE_CLASSES.has(result.infrastructureClass)
    ? result.infrastructureClass
    : undefined;
  if (!result.error && !infrastructureClass) return result;
  const error = result.error ?? (infrastructureClass === "timeout"
    ? "Auditor timed out"
    : infrastructureClass === "no-verdict"
      ? "worker produced no verdict"
      : infrastructureClass === "transport"
        ? "auditor transport failed"
        : "auditor provider failed");
  return {
    ...result,
    error,
    approved: false,
    disapproved: false,
    impossible: false,
    impossibleReason: undefined,
    regressionShieldPassed: undefined,
    regressionShieldMissing: undefined,
  };
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
  /** v0.37.0: dispatch fact (not worker telemetry) — the effective per-tool
   * budget this attempt was launched with, after adaptive escalation. The
   * display layer renders "tool: X · 4m / 20m budget" and exempts an
   * in-budget long tool from the 3m quiet warning. */
  toolTimeoutMs?: number;
  /** v0.38.3: worker telemetry — the deterministic session file the
   * auditor's pi persists when the request enabled live inspection
   * (<jobDir>/session.jsonl). Absent = the original --no-session spawn. */
  sessionPath?: string;
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

export interface AuditorFallbackAttemptInfo {
  /** The normalized ref selected for this attempt. */
  candidateRef: string;
  /** The bounded ordered chain visible to this fallback run. */
  candidateRefs: string[];
  /** Candidates fully exhausted before candidateRef. */
  attemptedRefs: string[];
  /** 1 for the first attempt, 2 for the one allowed same-ref retry. */
  attempt: 1 | 2;
  /** Failures already observed for candidateRef before this run call. */
  failureCount: 0 | 1;
  failureClass?: AuditorInfrastructureClass;
}

export interface AuditorFallbackExhaustionInfo {
  candidateRef: string;
  candidateRefs: string[];
  /** Includes candidateRef when the current candidate is being advanced. */
  attemptedRefs: string[];
  nextCandidateRef?: string;
  failureClass: AuditorInfrastructureClass;
  delayMs: number;
}

export interface AuditorFallbackPolicyOptions {
  /** The user-configured forbidden refs. The selector skips these silently. */
  forbiddenRefs?: readonly string[];
  /** Lifecycle fence checked before and after each delayed attempt. */
  shouldRetry?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  retryBaseMinutes?: number;
  /** Resume an in-flight candidate after a host restart. */
  resumeCandidateRef?: string;
  /** Candidates exhausted before resumeCandidateRef. */
  attemptedRefs?: readonly string[];
  /** When set with resumeCandidateRef, the first post-restart call is the
   * candidate's already-authorized second attempt, not a third call. */
  retryCandidateRef?: string;
  /** Durable marker that the authorized second attempt was already launched
   * before a host restart. Such a candidate is advanced without a third
   * worker call because its result is no longer safely observable. */
  retryAttemptStarted?: boolean;
  /** Failure class retained for a retry that was launched before a restart
   * but never produced an adoptable result. */
  retryFailureClass?: AuditorInfrastructureClass;
  /** Called before every detached worker launch. Returning false stops before
   * launch when the durable cursor could not be persisted. */
  onAttempt?: (candidate: AuditorFallbackCandidate, info: AuditorFallbackAttemptInfo) => boolean | void;
  onRetry?: (candidate: AuditorFallbackCandidate, error: string, delayMs: number, info: AuditorFallbackAttemptInfo) => boolean | void;
  /** Called before the fallback delay, so a crash during that delay resumes
   * from the next candidate rather than repeating an exhausted one. */
  onCandidateExhausted?: (candidate: AuditorFallbackCandidate, error: string, info: AuditorFallbackExhaustionInfo) => boolean | void;
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
    const result = normalizeAuditorInfrastructureResult(await run(sequence[0]!));
    return { result, retriedOnce: false, fallbackUsed: false, via: "unset" };
  }

  const normalized = sequence.map((candidate, index) => ({
    candidate,
    ref: (candidate.ref?.trim() || modelRef(candidate.model) || `auditor/candidate-${index}`),
  }));
  const refs = normalizeBoundedModelRefs(normalized.map((entry) => entry.ref), MAX_AUDITOR_CANDIDATE_REFS);
  const byRef = new Map<string, AuditorFallbackCandidate>();
  for (const entry of normalized) {
    const key = entry.ref.toLowerCase();
    if (!byRef.has(key)) byRef.set(key, entry.candidate);
  }
  const scope = { kind: "auditor" } as const;
  // The selector reads this indirection so a persisted in-flight candidate
  // can be placed first without changing the configured ordering for normal
  // runs. This is the only special case needed for restart recovery.
  let selectionChain = refs;
  const selector = new ModelSelector({
    getChain: () => selectionChain,
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
  const sameRef = (left: string | undefined, right: string | undefined): boolean =>
    !!left && !!right && left.toLowerCase() === right.toLowerCase();
  const candidateRefs = refs.slice();
  const resumeRef = opts.retryCandidateRef?.trim() || opts.resumeCandidateRef?.trim();
  const resumeRetry = !!opts.retryCandidateRef
    && !!resumeRef
    && refs.some((ref) => sameRef(ref, opts.retryCandidateRef));
  const retryAttemptStarted = resumeRetry && opts.retryAttemptStarted === true;
  // A persisted cursor is deliberately bounded at the state boundary. Keep
  // only refs that still belong to the current chain and let resumeRef win if
  // a defensive caller supplied it in both lists.
  for (const ref of opts.attemptedRefs ?? []) {
    if (typeof ref !== "string" || !refs.some((candidateRef) => sameRef(candidateRef, ref))) continue;
    if (!sameRef(ref, resumeRef)) addAttempted(ref);
  }
  let resumePending = !!resumeRef && refs.some((ref) => sameRef(ref, resumeRef));
  let currentRef: string | undefined;
  let retriedOnce = false;
  let fallbackUsed = false;
  let failureAttempt = resumeRetry ? 1 : 0;
  let fallbackFrom: AuditorFallbackCandidate | undefined;
  let fallbackError: string | undefined;
  let fallbackDelayMs = 0;
  let pendingResult: GoalAuditorResult | undefined;

  const failureClass = (result: GoalAuditorResult): AuditorInfrastructureClass => {
    if (result.infrastructureClass && AUDITOR_INFRASTRUCTURE_CLASSES.has(result.infrastructureClass)) return result.infrastructureClass;
    const error = result.error ?? "";
    if (/^Auditor (?:exceeded|stalled)\b|\b(?:timed? ?out|timeout|inactivity)\b/i.test(error)) return "timeout";
    if (/worker exited|produced no (?:output|verdict)|identity\/request-hash mismatch|invalid auditor|unsupported tool/i.test(error)) return "no-verdict";
    if (/spawn|launch failed|transport|aborted/i.test(error)) return "transport";
    return "provider";
  };
  const markExhausted = (result: GoalAuditorResult, inferredClass?: AuditorInfrastructureClass): GoalAuditorResult => ({
    ...result,
    ...(result.infrastructureClass || !inferredClass ? {} : { infrastructureClass: inferredClass }),
    fallbackExhausted: true,
  });
  const cursorPersistenceFailure = (candidate: AuditorFallbackCandidate): GoalAuditorResult => ({
    approved: false,
    disapproved: false,
    output: "",
    model: modelRef(candidate.model) ?? "",
    error: AUDITOR_CURSOR_PERSISTENCE_FAILURE,
    infrastructureClass: "transport",
  });
  const callbackAccepted = (accepted: boolean | void): boolean => accepted !== false;
  const noCandidateResult = (): GoalAuditorResult => ({
    approved: false,
    disapproved: false,
    output: "",
    model: modelRef(sequence[0]!.model) ?? "",
    error: ["no", "auditor", "model"].join(" "),
    infrastructureClass: "no-verdict",
    fallbackExhausted: true,
  });

  for (;;) {
    // Keep the explicit pure cursor call here. ModelSelector.selectNextValid
    // composes the same helper while adding the forbidden/unregistered walk.
    if (nextUntriedModelRef(currentRef, refs, attempted) === undefined) {
      const last = pendingResult ?? noCandidateResult();
      return { result: markExhausted(last, last.error ? failureClass(last) : undefined), retriedOnce, fallbackUsed, via: fallbackFrom?.via ?? sequence[0]!.via };
    }

    // Prefer the persisted candidate once. If it was removed, forbidden, or
    // unregistered, the selector records that fact and resumes normal order.
    selectionChain = resumePending ? [resumeRef!, ...refs.filter((ref) => !sameRef(ref, resumeRef))] : refs;
    const selected = selector.selectNextValid(scope, currentRef, attempted);
    selectionChain = refs;
    resumePending = false;
    for (const visited of selector.lastVisitedRefs) addAttempted(visited);
    if (!("model" in selected) || typeof selected.ref !== "string") {
      const result = pendingResult ?? noCandidateResult();
      return { result: markExhausted(result, result.error ? failureClass(result) : undefined), retriedOnce, fallbackUsed, via: fallbackFrom?.via ?? sequence[0]!.via };
    }
    const selectedRef = selected.ref;
    const candidate = byRef.get(selectedRef.toLowerCase());
    if (!candidate) {
      addAttempted(selectedRef);
      currentRef = selectedRef;
      continue;
    }
    const isRetryAttempt = resumeRetry && sameRef(selectedRef, opts.retryCandidateRef);
    const attemptedBefore = attempted.filter((ref) => !sameRef(ref, selectedRef));
    addAttempted(selectedRef);
    if (retryAttemptStarted && isRetryAttempt) {
      // The parent persisted this marker immediately before launching the
      // second call, but the host restarted before a result could be adopted.
      // Treat the unknown outcome as exhausted and move on; re-launching this
      // ref would be a third provider call in disguise.
      const failureClass = opts.retryFailureClass ?? "transport";
      retriedOnce = true;
      const syntheticError = "auditor retry attempt was already started before host restart";
      const nextRef = nextUntriedModelRef(selectedRef, refs, attempted);
      const retryInfo: AuditorFallbackExhaustionInfo = {
        candidateRef: selectedRef,
        candidateRefs: candidateRefs.slice(),
        attemptedRefs: attempted.slice(),
        ...(nextRef ? { nextCandidateRef: nextRef } : {}),
        failureClass,
        delayMs: nextRef ? mainModelFailureDelayMs({ kind: "transient", raw: syntheticError }, ++failureAttempt, opts.retryBaseMinutes ?? 15) : 0,
      };
      if (!callbackAccepted(opts.onCandidateExhausted?.(candidate, syntheticError, retryInfo))) {
        return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
      }
      const unknownResult: GoalAuditorResult = {
        approved: false,
        disapproved: false,
        output: "",
        model: modelRef(candidate.model) ?? "",
        error: syntheticError,
        infrastructureClass: failureClass,
      };
      if (nextRef === undefined) {
        return { result: markExhausted(unknownResult, failureClass), retriedOnce, fallbackUsed, via: candidate.via };
      }
      if (!isLive()) return { result: unknownResult, retriedOnce, fallbackUsed, via: candidate.via };
      fallbackDelayMs = retryInfo.delayMs;
      await sleep(fallbackDelayMs);
      if (!isLive()) return { result: unknownResult, retriedOnce, fallbackUsed, via: candidate.via };
      fallbackFrom = candidate;
      fallbackError = syntheticError;
      pendingResult = unknownResult;
      continue;
    }
    if (fallbackFrom) {
      fallbackUsed = true;
      opts.onFallback?.(fallbackFrom, candidate, fallbackError ?? "auditor fallback", fallbackDelayMs);
      fallbackFrom = undefined;
      fallbackError = undefined;
      fallbackDelayMs = 0;
    }

    const firstInfo: AuditorFallbackAttemptInfo = {
      candidateRef: selectedRef,
      candidateRefs: candidateRefs.slice(),
      attemptedRefs: attemptedBefore.slice(),
      attempt: isRetryAttempt ? 2 : 1,
      failureCount: isRetryAttempt ? 1 : 0,
    };
    if (!callbackAccepted(opts.onAttempt?.(candidate, firstInfo))) {
      return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
    }
    if (isRetryAttempt && !isLive()) {
      return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
    }

    pendingResult = undefined;
    if (isRetryAttempt) retriedOnce = true;
    const first = normalizeAuditorInfrastructureResult(await run(candidate));
    if (first.approved || first.disapproved || first.impossible || !first.error) {
      return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    }
    let failure = classifyMainModelFailure(first.error);
    if (!isRetriableInfraError(first.error) || !isMainModelFallbackFailure(failure)) {
      return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    }

    if (!isRetryAttempt) {
      failureAttempt += 1;
      if (!isLive()) return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
      const retryDelayMs = mainModelFailureDelayMs(failure, failureAttempt, opts.retryBaseMinutes ?? 15);
      const retryInfo: AuditorFallbackAttemptInfo = {
        ...firstInfo,
        failureCount: 1,
        failureClass: failureClass(first),
      };
      if (!callbackAccepted(opts.onRetry?.(candidate, first.error, retryDelayMs, retryInfo))) {
        return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
      }
      await sleep(retryDelayMs);
      if (!isLive()) return { result: first, retriedOnce, fallbackUsed, via: candidate.via };

      const secondInfo: AuditorFallbackAttemptInfo = {
        ...firstInfo,
        attempt: 2,
        failureCount: 1,
        failureClass: failureClass(first),
      };
      if (!callbackAccepted(opts.onAttempt?.(candidate, secondInfo))) {
        return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
      }
      const second = normalizeAuditorInfrastructureResult(await run(candidate));
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
      failureAttempt += 1;
      fallbackDelayMs = mainModelFailureDelayMs(failure, failureAttempt, opts.retryBaseMinutes ?? 15);
      const exhaustedInfo: AuditorFallbackExhaustionInfo = {
        candidateRef: selectedRef,
        candidateRefs: candidateRefs.slice(),
        attemptedRefs: attempted.slice(),
        ...(nextRef ? { nextCandidateRef: nextRef } : {}),
        failureClass: failureClass(second),
        delayMs: nextRef ? fallbackDelayMs : 0,
      };
      if (!callbackAccepted(opts.onCandidateExhausted?.(candidate, second.error, exhaustedInfo))) {
        return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
      }
      if (nextRef === undefined) {
        return { result: markExhausted(second, failureClass(second)), retriedOnce, fallbackUsed, via: candidate.via };
      }
      if (!isLive()) return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
      await sleep(fallbackDelayMs);
      if (!isLive()) return { result: second, retriedOnce, fallbackUsed, via: candidate.via };
      fallbackFrom = candidate;
      fallbackError = second.error;
      continue;
    }

    // A restart resumed the already-authorized second attempt. Do not grant a
    // third call to the same candidate: advance through the chain now.
    currentRef = selectedRef;
    const nextRef = nextUntriedModelRef(currentRef, refs, attempted);
    failureAttempt += 1;
    const exhaustedInfo: AuditorFallbackExhaustionInfo = {
      candidateRef: selectedRef,
      candidateRefs: candidateRefs.slice(),
      attemptedRefs: attempted.slice(),
      ...(nextRef ? { nextCandidateRef: nextRef } : {}),
      failureClass: failureClass(first),
      delayMs: nextRef ? mainModelFailureDelayMs(failure, failureAttempt, opts.retryBaseMinutes ?? 15) : 0,
    };
    if (!callbackAccepted(opts.onCandidateExhausted?.(candidate, first.error, exhaustedInfo))) {
      return { result: cursorPersistenceFailure(candidate), retriedOnce, fallbackUsed, via: candidate.via };
    }
    if (nextRef === undefined) {
      return { result: markExhausted(first, failureClass(first)), retriedOnce, fallbackUsed, via: candidate.via };
    }
    if (!isLive()) return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    fallbackDelayMs = exhaustedInfo.delayMs;
    await sleep(fallbackDelayMs);
    if (!isLive()) return { result: first, retriedOnce, fallbackUsed, via: candidate.via };
    fallbackFrom = candidate;
    fallbackError = first.error;
  }
}

/** Return the same bounded, de-duplicated refs that the runtime fallback
 * walker will use. Persisting refs rather than model objects keeps recovery
 * portable across host restarts and avoids serializing provider credentials. */
export function auditorCandidateRefs(candidates: AuditorFallbackCandidate[]): string[] {
  return normalizeBoundedModelRefs(candidates.map((candidate, index) =>
    candidate.ref?.trim() || modelRef(candidate.model) || `auditor/candidate-${index}`,
  ), MAX_AUDITOR_CANDIDATE_REFS);
}

/** Classify the final failure without trusting provider prose when the worker
 * already supplied a concrete transport class. `fallbackExhausted` is kept
 * separate so callers can distinguish a provider timeout from an exhausted
 * candidate chain. */
export function auditorResultFailureClass(result: GoalAuditorResult): AuditorRecoveryFailureClass {
  if (result.infrastructureClass && AUDITOR_INFRASTRUCTURE_CLASSES.has(result.infrastructureClass)) return result.infrastructureClass;
  const error = result.error ?? "";
  if (/^Auditor (?:exceeded|stalled)\b|\b(?:timed? ?out|timeout|inactivity)\b/i.test(error)) return "timeout";
  if (/worker exited|produced no (?:output|verdict)|identity\/request-hash mismatch|invalid auditor|unsupported tool/i.test(error)) return "no-verdict";
  if (/spawn|launch failed|transport|aborted/i.test(error)) return "transport";
  return "provider";
}

// The detached auditor intentionally exposes the full inspection/tooling
// surface, including bash, so it can run bounded tests and reproduce behavior.
// This is a power-oriented mode, not a read-only security boundary; callers
// still get the independent per-tool timeout below.
export const AUDITOR_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const PROTOCOL_VERSION = 1;
/** v0.37.0: base budget for ONE allowed auditor tool call. Exported so the
 * settings layer defaults/clamps the user-facing `auditorToolTimeoutMs` key
 * against the exact value the watchdogs use — one source of truth. */
export const DEFAULT_AUDITOR_TOOL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = DEFAULT_AUDITOR_TOOL_TIMEOUT_MS;
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
 * progress→parent cancels. Both are event-derived safety mechanisms; neither
 * is a wall-clock horizon for a worker that continues making real progress.
 * v0.37.0: exported as the `auditorStallMs` setting's base budget — the
 * user-facing knob and this watchdog share one source of truth. */
export const DEFAULT_AUDITOR_STALL_MS = 10 * 60_000;
/** v0.37.0: bounds for the user-facing timeout settings. The floors keep a
 * genuinely dead worker failing fast; the ceilings still bound a single
 * attempt (a 6h per-tool / 24h silence budget is "let the slow local model
 * finish", not "no bound at all"). */
export const MIN_AUDITOR_TOOL_TIMEOUT_MS = 30_000;
export const MAX_AUDITOR_TOOL_TIMEOUT_MS = 6 * 3_600_000;
export const MIN_AUDITOR_STALL_MS = 60_000;
export const MAX_AUDITOR_STALL_MS = 24 * 3_600_000;
/** v0.37.0: adaptive timeout escalation. Each failed detached attempt that
 * gets retried doubles BOTH base budgets (per-tool and silence), saturating
 * after AUDITOR_TIMEOUT_ESCALATION_MAX_STEPS doublings (4× base). The
 * durable index lives on the claim (PendingCompletion.timeoutEscalation) so
 * the schedule survives host restarts instead of resetting into the same
 * identical budget that timed out before — the infinite identical loop.
 * Pure function so tests can pin the schedule. */
export const AUDITOR_TIMEOUT_ESCALATION_MAX_STEPS = 2;
export function escalatedAuditorTimeout(
  baseMs: number,
  attemptIndex: number,
): number {
  const base = Number.isFinite(baseMs)
    ? Math.max(50, Math.floor(baseMs))
    : DEFAULT_AUDITOR_TOOL_TIMEOUT_MS;
  const steps = Number.isFinite(attemptIndex)
    ? Math.min(
        Math.max(0, Math.floor(attemptIndex)),
        AUDITOR_TIMEOUT_ESCALATION_MAX_STEPS,
      )
    : 0;
  return base * 2 ** steps;
}
const DEFAULT_HEARTBEAT_NO_PROGRESS_MS = DEFAULT_AUDITOR_STALL_MS;
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WORKER_SHUTDOWN_GRACE_MS = 1_000;
const WORKER_FORCE_SETTLE_MS = 250;
// A child can finish its final atomic rename just as the parent observes the
// exit event. Give the filesystem one short poll window before classifying the
// worker as result-less; otherwise a valid identity-checked result becomes a
// load-sensitive infrastructure failure.
const CHILD_EXIT_RESULT_GRACE_MS = 250;
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
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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

/** v0.38.3: a finished audit leaves a readable transcript behind — a job dir
 * holding result.json belongs to the retention policy (/glla audits health
 * cleanup + auditJobRetentionMs), not to any kill/reap path. */
function auditDirHasResult(dir: string): boolean {
  try {
    statSync(path.join(dir, "result.json"));
    return true;
  } catch {
    return false;
  }
}

export type AuditJobHealthStatus = "live" | "dead" | "ambiguous";

export interface AuditJobHealthEntry {
  attemptId: string;
  dir: string;
  ageMs: number;
  bytes: number;
  status: AuditJobHealthStatus;
  pid?: number;
  reason?: string;
}

export interface AuditJobHealthReport {
  root: string;
  scannedAt: string;
  total: number;
  live: number;
  dead: number;
  ambiguous: number;
  bytes: number;
  cleanupCandidates: number;
  entries: AuditJobHealthEntry[];
}

/** A deliberately conservative threshold: an auditor that is merely slow is
 * not a stale directory. Explicit cleanup only considers older directories
 * whose worker PID is proven dead and whose lock advertises role=worker.
 * v0.38.3: this constant is the DEFAULT retention; the effective value is
 * the `auditJobRetentionMs` setting (goal-settings.ts), threaded into
 * inspectAuditJobHealth / cleanupDeadAuditJobs at the call site. */
export const AUDIT_JOB_CLEANUP_MIN_AGE_MS = 15 * 60_000;
/** v0.38.3: upper bound for the `auditJobRetentionMs` setting — 7 days.
 * Retention is a review window for finished audit logs, not storage:
 * anything older than a week is noise the reaper should take. */
export const MAX_AUDIT_JOB_RETENTION_MS = 7 * 86_400_000;

function auditJobDirectoryBytes(dir: string): number {
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try { bytes += statSync(path.join(dir, entry.name)).size; } catch { /* health is best effort per file */ }
    }
  } catch {
    /* unreadable contents remain represented by the ambiguous lock status */
  }
  return bytes;
}

/** Read-only project-wide audit-job inventory. It never signals a process and
 * never removes an ambiguous or unreadable directory. */
export function inspectAuditJobHealth(
  cwd: string,
  nowMs = Date.now(),
  maxAgeMs = AUDIT_JOB_CLEANUP_MIN_AGE_MS,
): AuditJobHealthReport {
  const root = path.join(piGlaDir(cwd), "audit-jobs");
  const entries: AuditJobHealthEntry[] = [];
  let dirs: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { root, scannedAt: new Date(nowMs).toISOString(), total: 0, live: 0, dead: 0, ambiguous: 0, bytes: 0, cleanupCandidates: 0, entries };
    }
    return { root, scannedAt: new Date(nowMs).toISOString(), total: 0, live: 0, dead: 0, ambiguous: 1, bytes: 0, cleanupCandidates: 0, entries: [{ attemptId: "<audit-jobs-root>", dir: root, ageMs: 0, bytes: 0, status: "ambiguous", reason: "root unreadable" }] };
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let ageMs = 0;
    try { ageMs = Math.max(0, nowMs - statSync(dir).mtimeMs); } catch { ageMs = 0; }
    const bytes = auditJobDirectoryBytes(dir);
    let status: AuditJobHealthStatus = "ambiguous";
    let pid: number | undefined;
    let reason: string | undefined = "missing or unreadable worker lock";
    try {
      const lock = JSON.parse(readFileSync(path.join(dir, "lock"), "utf8")) as Record<string, unknown>;
      pid = typeof lock.pid === "number" ? lock.pid : Number(lock.pid);
      if (lock.role === "worker" && Number.isInteger(pid) && pid > 1) {
        if (workerProcessMatches(cwd, pid, dir)) {
          status = "live";
          reason = undefined;
        } else if (!processAlive(pid)) {
          status = "dead";
          reason = "worker PID is not alive";
        } else {
          reason = "PID is alive but worker identity does not match this job";
        }
      } else {
        reason = "lock is not a worker-owned identity";
      }
    } catch {
      /* preserve ambiguous */
    }
    entries.push({ attemptId: entry.name, dir, ageMs, bytes, status, ...(pid !== undefined ? { pid } : {}), ...(reason ? { reason } : {}) });
  }
  const live = entries.filter((entry) => entry.status === "live").length;
  const dead = entries.filter((entry) => entry.status === "dead").length;
  const ambiguous = entries.filter((entry) => entry.status === "ambiguous").length;
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const cleanupCandidates = entries.filter((entry) => entry.status === "dead" && entry.ageMs >= maxAgeMs).length;
  return { root, scannedAt: new Date(nowMs).toISOString(), total: entries.length, live, dead, ambiguous, bytes, cleanupCandidates, entries };
}

/** Explicit, age-bounded cleanup for only proven-dead worker identities.
 * Ambiguous locks are intentionally left for operator inspection. */
export function cleanupDeadAuditJobs(cwd: string, maxAgeMs = AUDIT_JOB_CLEANUP_MIN_AGE_MS, nowMs = Date.now()): AuditJobHealthReport {
  const report = inspectAuditJobHealth(cwd, nowMs, maxAgeMs);
  for (const entry of report.entries) {
    if (entry.status !== "dead" || entry.ageMs < maxAgeMs || entry.pid === undefined) continue;
    if (processAlive(entry.pid) || workerProcessMatches(cwd, entry.pid, entry.dir)) continue;
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* preserve the next health report */ }
  }
  return inspectAuditJobHealth(cwd, nowMs, maxAgeMs);
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
        // A finished audit's dir holds the post-completion transcript —
        // retention owns its lifetime, never an immediate reap.
        if (!auditDirHasResult(dir)) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
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
        if (auditDirHasResult(dir)) return; // finished transcript → retention
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
  /** Legacy request metadata accepted by older workers; current workers do
   * not use it as a lifetime bound. Liveness is owned by event-derived
   * watchdogs and lifecycle cancellation. */
  wallDeadlineAt?: number;
  /** v0.36.0: pi extension specs the detached auditor may load via
   * `pi --extension <spec>` (under the still-on `--no-extensions` discovery
   * switch). Absent/empty = the default extension-less auditor. Part of the
   * request hash like every other field. */
  allowedExtensions?: string[];
  /** v0.38.3: opt-in live inspection. When true the worker spawns pi with
   * --session <jobDir>/session.jsonl instead of --no-session, persisting the
   * auditor's pi as a resumable session (tail -f live, resume after).
   * Part of the request hash; absent/false = the original spawn. */
  inspection?: boolean;
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
  /** v0.38.3: set when the request enabled live inspection — the session
   * file the auditor's pi writes inside the job dir. */
  sessionPath?: string;
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

export interface AuditorProcessRuntime {
  /** Override the worker launcher command (normally resolved from process.execPath, with a JS-runtime fallback for compiled hosts). */
  command?: string;
  /** Override the worker module (normally scripts/goal-auditor-worker.mjs). */
  workerPath?: string;
  /** Override the pi binary without putting it in the request or argv. */
  piBinary?: string;
  /** Override process spawning in bounded tests. */
  spawn?: typeof nodeSpawn;
  pollIntervalMs?: number;
  /**
   * @deprecated Accepted for compatibility with older callers, but never
   * used as a lifetime bound. Confirmed-silence, per-tool, and lifecycle
   * cancellation are the only termination paths for an otherwise live audit.
   */
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
    ...(file.sessionPath ? { sessionPath: file.sessionPath } : {}),
    ...(file.unmatchedToolStarts ? { unmatchedToolStarts: file.unmatchedToolStarts } : {}),
    ...(file.unmatchedToolEnds ? { unmatchedToolEnds: file.unmatchedToolEnds } : {}),
  };
}

/** v0.34.57: the progress-bearing subset of a worker snapshot. Heartbeat
 * events refresh `lastActivityAt` and may oscillate `phase` (running ↔
 * thinking on message_start/agent_start) without delivering progress — this
 * signature deliberately excludes both, so only a NEW finished tool call,
 * new report output, or a NEW tool start counts as progress. */
export function progressSignature(file: AuditorProgressFile): string {
  const calls = file.toolCalls;
  const lastToolFinishedAt = calls.length > 0 ? (calls[calls.length - 1]?.finishedAt ?? 0) : 0;
  // v0.37.0: reportBytes (the monotonic text_delta counter) is part of the
  // signature — an actively generating model resets the no-progress clock
  // even when the bounded recentOutput tail renders identically.
  return `${calls.length}|${lastToolFinishedAt}|${file.recentOutput.join("\u0000")}|${file.currentTool ?? ""}|${file.currentToolStartedAt ?? 0}|${file.reportBytes ?? 0}`;
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

const JAVASCRIPT_RUNTIME_BASENAMES = new Set(["node", "nodejs", "bun", "deno"]);

/** Resolve the runtime that can execute the extension-less worker module.
 * In a normal Node/Bun/Deno host, process.execPath is already a JavaScript
 * runtime. In a compiled Pi host it is the Pi executable, which would parse
 * worker flags such as --job-dir itself and exit before the worker starts. */
export function resolveWorkerCommand(execPath: string): string {
  const base = path.basename(execPath.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
  return JAVASCRIPT_RUNTIME_BASENAMES.has(base) ? execPath : "node";
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
  /** v0.38.3: opt-in live inspection (settings key auditorInspection) — the
   * worker persists the auditor's pi as a resumable session pinned inside
   * the job dir. Off/absent = the original --no-session spawn. */
  inspection?: boolean;
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
  // `wallTimeoutMs` remains accepted on AuditorProcessRuntime for older
  // embedded callers, but a guessed duration must never terminate a live
  // auditor. Confirmed-silence, per-tool, result, and lifecycle cancellation
  // are the bounded termination paths.
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
  let lockHeld = false;
  let jobDirCreated = false;
  let child: ChildProcess | undefined;
  let workerSpawnedAt: number | undefined;
  let childSpawnError: string | undefined;
  let childExitObservedAt: number | undefined;
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
      // v0.34.59: capture the focus revision token at dispatch. The
      // worker echoes it in result.json; the parent re-validates before
      // applying the verdict. A stale-handle ghost can no longer silently
      // overwrite a goal that moved on.
      goalRevision: capturedRevisionToken,
      // v0.36.0: only present when non-empty so historical requests hash
      // byte-identically to pre-feature workers.
      ...(allowedExtensions.length ? { allowedExtensions } : {}),
      // v0.38.3: only present when enabled so default dispatches hash
      // byte-identically to pre-feature workers.
      ...(args.inspection ? { inspection: true } : {}),
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
    const command = runtime.command ?? resolveWorkerCommand(process.execPath);
    const spawn = runtime.spawn ?? nodeSpawn;
    const env = { ...process.env, ...(runtime.env ?? {}) };
    if (runtime.piBinary) env.GLLA_PI_BINARY = runtime.piBinary;
    child = spawn(command, [workerPath, "--job-dir", jobDir], {
      cwd: args.cwd,
      detached: true,
      stdio: "ignore",
      env,
    } satisfies SpawnOptions);
    // The first-event watchdog is a worker-silence budget, not a dispatch
    // setup budget. Anchor it to Node's successful spawn event so filesystem
    // setup, extension resolution, and scheduler delay cannot consume the
    // child's startup window before the worker can install its handlers.
    // Set the lower bound at return as well as on the event: Bun's
    // child_process shim may deliver the spawn event before a listener added
    // after spawn() can observe it. A launch error still wins via
    // childSpawnError on the next loop iteration.
    workerSpawnedAt = now();
    child.once("spawn", () => {
      workerSpawnedAt ??= now();
    });
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
          // A fast worker can publish progress.json and result.json between
          // two parent polls. Read the final progress snapshot once more
          // before consuming the result so the callback cannot miss the
          // worker's last live tool/report telemetry (the result protocol
          // is ordered after progress publication). A missing snapshot is
          // tolerated for legacy/result-only test workers.
          try {
            const finalProgress = await readJson<AuditorProgressFile>(progressPath);
            if (finalProgress.protocolVersion !== PROTOCOL_VERSION || finalProgress.attemptId !== attemptId || finalProgress.requestHash !== request.requestHash) {
              return infra(model, thinkingLevel, "auditor progress identity/request-hash mismatch", "", capturedRevisionToken, "no-verdict");
            }
            lastProgress = finalProgress;
            const serializedFinalProgress = stableJson(finalProgress);
            if (serializedFinalProgress !== lastProgressSerialized) {
              lastProgressSerialized = serializedFinalProgress;
              args.onProgress?.(asProgress(finalProgress, startedAt));
            }
          } catch (progressError) {
            if ((progressError as NodeJS.ErrnoException).code !== "ENOENT") {
              return infra(model, thinkingLevel, `invalid auditor progress: ${progressError instanceof Error ? progressError.message : String(progressError)}`, "", capturedRevisionToken, "no-verdict");
            }
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
        // independently of the event-driven lifetime policy.
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
        // remaining safety mechanisms are event-derived, so a worker with
        // real progress is never cut off merely because elapsed time crossed
        // a guessed task duration. The worker's own inactivity brake
        // (GLLA_AUDITOR_STALL_MS) is
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
          } else if (workerSpawnedAt !== undefined && now() - workerSpawnedAt >= firstEventTimeoutMs) {
            const silenceMs = Math.max(0, now() - workerSpawnedAt);
            const stallLabel = firstEventTimeoutMs >= 60_000
              ? `${Math.max(1, Math.round(firstEventTimeoutMs / 60_000))}m`
              : `${Math.max(1, Math.round(firstEventTimeoutMs / 1_000))}s`;
            args.onStalled?.({
              at: now(),
              reason: "first-event-timeout",
              heartbeatAgeMs: silenceMs,
              noProgressMs: silenceMs,
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
        if (child && !childAlive(child)) {
          // The worker's result is atomic, but the child exit notification and
          // the parent's next filesystem read are separate observations. One
          // bounded grace window lets a final rename become visible without
          // delaying a genuinely result-less worker by the full wall timeout.
          childExitObservedAt ??= Date.now();
          if (Date.now() - childExitObservedAt < CHILD_EXIT_RESULT_GRACE_MS) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, 25)));
            continue;
          }
          return infra(model, thinkingLevel, "auditor worker exited without an atomic result", "", capturedRevisionToken, "no-verdict");
        }
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
    if (jobDirCreated) {
      if (auditDirHasResult(jobDir)) {
        // v0.38.3: a finished audit's dir is the post-completion transcript.
        // Keep the worker lock so health classifies the dir 'dead' (reaped
        // once aged past auditJobRetentionMs by /glla audits health cleanup)
        // instead of 'ambiguous' (which cleanup never touches).
      } else {
        // No verdict: incomplete transport scratch — remove it so kill-and-
        // restart loops do not accumulate empty dirs. Never remove a colliding
        // directory we did not successfully create and therefore do not own.
        if (lockHeld) await fs.unlink(lockPath).catch(() => {});
        await removeAuditJobDirectory(jobDir);
      }
    }
  }
}

export { buildPrompt as buildGoalAuditorPrompt };
