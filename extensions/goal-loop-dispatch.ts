/**
 * Generation-bound continuation dispatch state.
 *
 * A pi `sendMessage({ triggerTurn: true })` call is only a dispatch
 * acknowledgement. It is not proof that an agent turn started. This module
 * keeps that distinction explicit and persists the one in-flight dispatch so
 * a replacement session can recover without treating an old send as a live
 * turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { piGlaDir, runPersistStep, stateRootPending } from "./goal-loop-core.js";

export const DISPATCH_RECORD_VERSION = 1;
export const DISPATCH_RECORD_FILE = "continuation-dispatch.json";

export type DispatchKind = "goal" | "loop" | "stall" | "length";
export type DispatchPhase = "prepared" | "accepted" | "started" | "failed" | "unacknowledged";

/** Optional lifecycle timestamps are persisted on the sidecar when a send
 * crosses each boundary. The phase alone is not enough to explain whether a
 * provider accepted the enqueue, whether pi proved a turn start, or why the
 * attempt settled. */
export interface DispatchLifecycleTimestamps {
  acceptedAt?: number;
  startedAt?: number;
  timedOutAt?: number;
  settledAt?: number;
  startProofSource?: string;
  timeoutMs?: number;
}

export interface ContinuationDispatch extends DispatchLifecycleTimestamps {
  version: typeof DISPATCH_RECORD_VERSION;
  id: string;
  generation: number;
  ownerSessionId: string;
  kind: DispatchKind;
  goalId?: string;
  iteration?: number;
  marker: string;
  sentAt: number;
  phase: DispatchPhase;
  resync: boolean;
  /** v0.34.88: one automatic retry after the first no-turn-start timeout.
   * retryCount is 1 after the single retry send; retrySentAt is the retry
   * send time. Both persist so a reload mid-backoff keeps the record
   * consistent (optional fields — no record-version bump). */
  retryCount?: number;
  retrySentAt?: number;
}

export function dispatchRecordPath(cwd: string): string {
  return path.join(piGlaDir(cwd), DISPATCH_RECORD_FILE);
}

export function createContinuationDispatch(input: {
  id: string;
  generation: number;
  ownerSessionId: string;
  kind: DispatchKind;
  goalId?: string;
  iteration?: number;
  marker: string;
  resync: boolean;
  sentAt?: number;
}): ContinuationDispatch {
  return {
    version: DISPATCH_RECORD_VERSION,
    id: input.id,
    generation: input.generation,
    ownerSessionId: input.ownerSessionId,
    kind: input.kind,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
    marker: input.marker,
    sentAt: input.sentAt ?? Date.now(),
    phase: "prepared",
    resync: input.resync,
  };
}

export function transitionDispatch(record: ContinuationDispatch, phase: DispatchPhase): ContinuationDispatch {
  return { ...record, phase };
}

export function dispatchMatchesOwner(
  record: ContinuationDispatch,
  generation: number,
  ownerSessionId: string,
): boolean {
  return record.generation === generation && record.ownerSessionId === ownerSessionId;
}

export function dispatchPromptMatches(record: ContinuationDispatch, prompt: unknown): boolean {
  return typeof prompt === "string" && prompt.includes(record.marker);
}

export function dispatchTimedOut(record: ContinuationDispatch, now: number, timeoutMs: number): boolean {
  return record.phase === "accepted" && now - record.sentAt >= timeoutMs;
}

/**
 * Write-before-send is deliberate: an accepted dispatch must have a durable
 * identity before it can be allowed to trigger a turn. The temp+rename keeps
 * a killed process from leaving half a JSON document behind.
 */
export function persistDispatchRecord(cwd: string, record: ContinuationDispatch): boolean {
  return runPersistStep("writeContinuationDispatch", () => {
    if (stateRootPending()) return false;
    const dir = path.dirname(dispatchRecordPath(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const target = dispatchRecordPath(cwd);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(record) + "\n");
    fs.renameSync(temp, target);
    return true;
  }) === true;
}

export function readDispatchRecord(cwd: string): ContinuationDispatch | null {
  const raw = runPersistStep("readContinuationDispatch", () => {
    const file = dispatchRecordPath(cwd);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ContinuationDispatch>;
    const optionalFinite = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value));
    if (
      parsed.version !== DISPATCH_RECORD_VERSION ||
      typeof parsed.id !== "string" ||
      typeof parsed.generation !== "number" ||
      !Number.isFinite(parsed.generation) ||
      typeof parsed.ownerSessionId !== "string" ||
      !["goal", "loop", "stall", "length"].includes(String(parsed.kind)) ||
      typeof parsed.marker !== "string" ||
      typeof parsed.sentAt !== "number" ||
      !Number.isFinite(parsed.sentAt) ||
      typeof parsed.resync !== "boolean" ||
      !["prepared", "accepted", "started", "failed", "unacknowledged"].includes(String(parsed.phase)) ||
      !optionalFinite(parsed.acceptedAt) ||
      !optionalFinite(parsed.startedAt) ||
      !optionalFinite(parsed.timedOutAt) ||
      !optionalFinite(parsed.settledAt) ||
      !optionalFinite(parsed.timeoutMs) ||
      (parsed.startProofSource !== undefined && typeof parsed.startProofSource !== "string")
    ) return null;
    return parsed as ContinuationDispatch;
  } catch {
    return null;
  }
}

export function dispatchRecordExists(cwd: string): boolean {
  try {
    const target = dispatchRecordPath(cwd);
    if (fs.existsSync(target)) return true;
    const dir = path.dirname(target);
    const prefix = `${DISPATCH_RECORD_FILE}.tmp-`;
    return fs.readdirSync(dir).some((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
}

export function clearDispatchRecord(cwd: string): boolean {
  return runPersistStep("clearContinuationDispatch", () => {
    const target = dispatchRecordPath(cwd);
    fs.rmSync(target, { force: true });
    const dir = path.dirname(target);
    const prefix = `${DISPATCH_RECORD_FILE}.tmp-`;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      // The target may have been the only file; missing cleanup is harmless.
    }
    return true;
  }) === true;
}
