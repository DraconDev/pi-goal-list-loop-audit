import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state, replaceState } from "./goal-state.js";
import { appendLedger, supervisorPaused, type Goal } from "./goal-loop-core.js";
import { backgroundWaitReady, sanitizeBackgroundWait, settleBackgroundDependency,
  type BackgroundWait, type DependencyOutcome } from "./work-lifecycle.js";

interface Hooks {
  valid(ctx: ExtensionContext): boolean;
  persist(ctx: ExtensionContext): boolean;
  updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): boolean;
  clearTimers(): void;
  refresh(ctx: ExtensionContext): void;
  schedule(ctx: ExtensionContext): void;
  assessment(ctx: ExtensionContext, wait: BackgroundWait): void;
}
let hooks: Hooks | undefined;
interface Observation { runId: string; targetId: string; sessionId: string; asyncDir?: string; outcome: DependencyOutcome; }
const observations = new Map<string, Observation>();
const yieldedSessions = new Set<string>();
export function consumeBackgroundYield(ctx: ExtensionContext): boolean {
  const id = sessionId(ctx);
  const yielded = yieldedSessions.has(id);
  yieldedSessions.delete(id);
  return yielded;
}

export function bindBackgroundWaitRuntime(next: Hooks): void {
  hooks = next;
  observations.clear();
  yieldedSessions.clear();
}
export function __testOnlyResetBackgroundWaitRuntime(): void { hooks = undefined; observations.clear(); yieldedSessions.clear(); }

export function workTargetId(): string | undefined {
  if (state.goal && (state.goal.status === "active" || state.goal.status === "paused")) return state.goal.id;
  if (state.loop) return `loop:${state.loop.startedAt}:${state.loop.builder?.projectId ?? "metric"}`;
  return undefined;
}
function sessionId(ctx: ExtensionContext): string {
  try { return ctx.sessionManager.getSessionId?.() ?? ""; } catch { return ""; }
}
function eventId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const e = data as Record<string, unknown>;
  const id = e.runId ?? e.id;
  return typeof id === "string" && id.trim() && id.length <= 200 ? id.trim() : undefined;
}
function targetWait(): BackgroundWait | undefined {
  return workTargetId() === state.goal?.id ? state.goal?.backgroundWait : state.loop?.backgroundWait;
}

/** Only the currently admitted parent may associate a public start with work.
 * A supplied parent session must match; children from other tabs cannot attach. */
export function observeBackgroundStart(data: unknown, ctx: ExtensionContext): void {
  if (!hooks?.valid(ctx) || !sessionId(ctx)) return;
  const runId = eventId(data), targetId = workTargetId();
  if (!runId || !targetId || !data || typeof data !== "object") return;
  const e = data as Record<string, unknown>;
  const parent = e.sessionId;
  if (typeof parent === "string" && parent !== sessionId(ctx) && parent !== ctx.sessionManager.getSessionFile?.()) return;
  const prior = observations.get(runId);
  if (prior) return; // a duplicate start must not erase terminal/owner evidence
  const asyncDir = typeof e.asyncDir === "string" && path.isAbsolute(e.asyncDir) ? e.asyncDir : undefined;
  observations.set(runId, { runId, targetId, sessionId: sessionId(ctx), asyncDir, outcome: "pending" });
}

function storeWait(ctx: ExtensionContext, wait: BackgroundWait | undefined, legacy = false): boolean {
  if (!hooks) return false;
  if (state.goal && workTargetId() === state.goal.id) {
    const before = state.goal;
    const patch: Partial<Goal> = { backgroundWait: wait,
      ...(legacy ? { status: "active", pauseKind: undefined, pauseReason: undefined, pauseSuggestedAction: undefined } : {}) };
    if (hooks.updateGoal(patch, ctx)) return true;
    replaceState({ ...state, goal: before });
    return false;
  }
  if (!state.loop) return false;
  const before = state.loop;
  state.loop = { ...before, backgroundWait: wait };
  if (hooks.persist(ctx)) return true;
  state.loop = before;
  return false;
}

export function admitBackgroundWait(ctx: ExtensionContext, runIds: string[], reason: string): { ok: boolean; message: string } {
  if (!hooks?.valid(ctx) || !sessionId(ctx) || supervisorPaused(state)) return { ok: false, message: "Not waiting: supervision is frozen or this session no longer owns the work." };
  const targetId = workTargetId();
  const goalOwned = targetId === state.goal?.id;
  if (!targetId || (goalOwned ? state.goal?.pendingCompletion || state.goal?.status !== "active" : !state.loop?.active || state.loop.builder?.phase === "auditing")) return { ok: false, message: "Not waiting: no eligible running target." };
  if (targetWait()) return { ok: false, message: "An owned background wait already exists; inspect its dependency results before replacing it." };
  if (!runIds.length || runIds.length > 32 || new Set(runIds).size !== runIds.length) return { ok: false, message: "Supply 1–32 distinct exact background run ids; a prose reason cannot establish ownership." };
  const admitted: Observation[] = [];
  for (const runId of runIds) {
    const observation = observations.get(runId);
    if (!observation || observation.targetId !== targetId || observation.sessionId !== sessionId(ctx)) return { ok: false, message: `Run ${runId} was not observed as owned by this target and session. Inspect the run; do not guess its ownership.` };
    admitted.push(observation);
  }
  const wait: BackgroundWait = { version: 1, id: randomUUID(), targetId, sessionId: sessionId(ctx),
    createdAt: new Date().toISOString(), reason: reason.slice(0, 2000),
    dependencies: admitted.map(({ runId, asyncDir, outcome }) => ({ runId, asyncDir, outcome })) };
  if (wait.dependencies.every((dependency) => dependency.outcome !== "pending")) wait.settledAt = new Date().toISOString();
  if (!storeWait(ctx, wait)) return { ok: false, message: "Background wait could not persist. No durable waiting state was admitted; repair storage before yielding." };
  yieldedSessions.add(sessionId(ctx));
  hooks.clearTimers();
  appendLedger(ctx.cwd, "background_wait_admitted", { targetId, waitId: wait.id, runIds });
  hooks.refresh(ctx);
  return { ok: true, message: "Waiting on the named background dependencies; supervision remains active. Yield this turn. Matching completion or reconciliation settles the wait; explicit pauses still freeze continuation." };
}

/** Observe completion even before wait admission, but never adopt unknown ids. */
export function observeBackgroundTerminal(data: unknown, ctx: ExtensionContext, outcome: Exclude<DependencyOutcome, "pending">): void {
  if (!hooks?.valid(ctx)) return;
  const runId = eventId(data);
  if (!runId) return;
  const parent = data && typeof data === "object" ? (data as Record<string, unknown>).sessionId : undefined;
  if (typeof parent === "string" && parent !== sessionId(ctx) && parent !== ctx.sessionManager.getSessionFile?.()) return;
  const observation = observations.get(runId);
  if (observation && observation.sessionId === sessionId(ctx)) {
    if (observation.outcome === "pending") observation.outcome = outcome;
  }
  const wait = targetWait();
  if (!wait || wait.targetId !== workTargetId() || wait.sessionId !== sessionId(ctx)) return;
  // Terminal event authority requires observed ownership, not only an id.
  if (!observation || observation.targetId !== wait.targetId || observation.sessionId !== wait.sessionId) return;
  const next = settleBackgroundDependency(wait, { targetId: wait.targetId, sessionId: wait.sessionId, runId, outcome, at: new Date().toISOString() });
  if (next && storeWait(ctx, next)) reconcileBackgroundWait(ctx);
}

function artifactOutcome(wait: BackgroundWait, dependency: BackgroundWait["dependencies"][number], now: number): DependencyOutcome {
  const observed = observations.get(dependency.runId);
  if (observed?.targetId === wait.targetId && observed.sessionId === wait.sessionId && observed.outcome !== "pending") return observed.outcome;
  if (dependency.asyncDir) {
    try {
      const file = path.join(dependency.asyncDir, "status.json");
      if (fs.statSync(file).size > 1024 * 1024) return "missing";
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (raw.runId !== dependency.runId) return "missing";
      switch (raw.state ?? raw.status) {
        case "complete": case "completed": return "completed";
        case "failed": case "partial": return "failed";
        case "stopped": case "rejected": return "stopped";
        case "running": case "queued": case "pending": case "paused": {
          const deadline = typeof raw.deadlineAt === "number" ? raw.deadlineAt : undefined;
          if (deadline !== undefined && now > deadline) return "missing";
          if (deadline === undefined && now - Date.parse(wait.createdAt) > 30 * 60_000) return "missing";
          // A durable file cannot keep a dead local worker alive forever.
          if (typeof raw.pid === "number" && Number.isSafeInteger(raw.pid) && raw.pid > 0) {
            try { process.kill(raw.pid, 0); return "pending"; } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return "missing";
            }
          }
          const activity = typeof raw.lastActivityAt === "number" ? raw.lastActivityAt : Date.parse(wait.createdAt);
          return now - activity < 5 * 60_000 ? "pending" : "missing";
        }
        default: return "missing";
      }
    } catch { /* Missing publication is briefly tolerated only in the live owner. */ }
  }
  return observed && observed.targetId === wait.targetId && observed.sessionId === wait.sessionId
    && now - Date.parse(wait.createdAt) < 30_000 ? "pending" : "missing";
}

/** Runs at admitted contact/heartbeat boundaries. No timers or polling loop.
 * Explicit holds prevent settlement dispatch; evidence remains saved for resume. */
export function reconcileBackgroundWait(ctx: ExtensionContext, now = Date.now()): boolean {
  if (!hooks?.valid(ctx)) return false;
  const targetId = workTargetId();
  if (!targetId) return false;
  if (state.goal?.status === "paused" && state.goal.pauseKind === "standby" && !state.goal.backgroundWait) {
    if (supervisorPaused(state) || !sessionId(ctx)) return true;
    const wait: BackgroundWait = { version: 1, id: `legacy:${targetId}`, targetId, sessionId: sessionId(ctx),
      createdAt: new Date(now).toISOString(), reason: state.goal.pauseReason ?? "Legacy background wait requires assessment", legacy: true, dependencies: [], settledAt: new Date(now).toISOString() };
    if (!storeWait(ctx, wait, true)) return true;
  }
  const saved = targetWait();
  if (!saved) return false;
  const goalOwned = targetId === state.goal?.id;
  if (supervisorPaused(state) || (goalOwned ? state.goal?.status === "paused" : !state.loop?.active)) return true;
  if (goalOwned ? state.goal?.pendingCompletion : state.loop?.builder?.phase === "auditing") return true;
  const wait = sanitizeBackgroundWait(saved, targetId);
  if (!wait) {
    // Invalid records remain held rather than manufacturing owner authority.
    ctx.ui.notify("Background wait ownership is invalid; inspect saved work and resume explicitly after repair.", "warning");
    return true;
  }
  let next = wait;
  for (const dependency of wait.dependencies) {
    if (dependency.outcome !== "pending") continue;
    const outcome = artifactOutcome(wait, dependency, now);
    if (outcome !== "pending") next = settleBackgroundDependency(next, { targetId, sessionId: wait.sessionId,
      runId: dependency.runId, outcome, at: new Date(now).toISOString() }) ?? next;
  }
  if (!backgroundWaitReady(next)) {
    if (next !== wait) storeWait(ctx, next);
    return true;
  }
  // Keep owned settlement evidence before removing the dispatch gate. Both
  // are in one state write, so a crash cannot lose the assessment obligation.
  const before = { ...state, goal: state.goal, loop: state.loop };
  const result = { ...next, settledAt: next.settledAt ?? new Date(now).toISOString() };
  if (goalOwned && state.goal) state.goal = { ...state.goal, lastBackgroundWait: result, backgroundWait: undefined };
  else if (state.loop) state.loop = { ...state.loop, lastBackgroundWait: result, backgroundWait: undefined };
  if (!hooks.persist(ctx)) { replaceState(before); return true; }
  appendLedger(ctx.cwd, "background_wait_settled", { targetId, waitId: next.id, dependencies: next.dependencies, legacy: next.legacy === true });
  hooks.refresh(ctx);
  hooks.assessment(ctx, result);
  if (ctx.isIdle() && !ctx.hasPendingMessages()) hooks.schedule(ctx);
  return false;
}
