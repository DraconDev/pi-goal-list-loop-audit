import { randomUUID, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { state, replaceState } from "./goal-state.js";
import { appendLedger, nowIso, archiveDir } from "./goal-loop-core.js";
import { loadSettings } from "./goal-settings.js";
import type { LoopState } from "./goal-loop-forever.js";
import { dispatchAuditorAllowedExtensions } from "./auditor-extensions.js";
import { resolveAuditorThinkingLevel } from "./auditor-thinking.js";
import { runDetachedGoalCompletionAuditor, runAuditorFallbackWithPolicy, readCompletedCompletionAudit, newDetachedAuditJobAttemptId, writeAtomicJson, type AuditorProcessRuntime } from "./goal-loop-auditor-process.js";
import { setRespecAuditLive, getRespecAuditLive, respecCompletionSummary } from "./respec-builder-ui.js";
import { respecIncrementAuditGoal } from "./respec-builder-audit.js";
import { adoptRespecRequirements, beginRespecAudit, blockRespecRequirement, unblockRespecRequirement, refineRespecRequirements, claimRespecTask, planRespecIncrement, settleRespecAudit, type RespecBuilderState } from "./respec-builder.js";

interface Host {
  context: (ctx: ExtensionContext) => ExtensionContext | null;
  persist: (ctx: ExtensionContext) => boolean;
  wake: (ctx: ExtensionContext) => void;
  resolveModel: (ctx: ExtensionContext) => { model: any; error?: string; fallbackModels?: { model: any; via?: string }[] };
  wrapTool: (tool: any) => any;
  /** Bounded worker launcher overrides for embedding and hermetic tests. */
  auditRuntime?: AuditorProcessRuntime;
  finished?: (ctx: ExtensionContext) => void;
  confirm?: (ctx: ExtensionContext, title: string, body: string) => Promise<boolean>;
  auditSleep?: (ms: number) => Promise<void>;
  thinkingLevel?: () => string | undefined;
  refresh?: (ctx: ExtensionContext) => void;
  completed?: (ctx: ExtensionContext, id: string, summary: string) => boolean;
}
let host: Host;
const running = new Map<string, AbortController>();

/** Hermetic process tests retain the production ownership/commit/tool adapters. */
export function __testOnlyRespecAuditorRuntime(overrides: Pick<Host, "auditRuntime" | "auditSleep" | "resolveModel">): () => void {
  const previous = host;
  const configured = { ...host, ...overrides };
  host = configured;
  return () => { if (host === configured) host = previous; };
}

export function cancelRespecBuilderAudit(cwd: string, startedAt: string): void {
  for (const [key, controller] of running) if (key.startsWith(`${cwd}:${startedAt}:`)) controller.abort();
}

export function respecProjectArchivePath(cwd: string, startedAt: string, revision: number): string {
  const identity = createHash("sha256").update(`${startedAt}:${revision}`).digest("hex").slice(0, 24);
  return path.join(archiveDir(cwd), `respec-${identity}.json`);
}

function projectBoundReason(loop: LoopState): string | undefined {
  if (loop.timeLimitHours !== undefined && Date.now() - Date.parse(loop.startedAt) >= loop.timeLimitHours * 3600000) return `time bound reached (${loop.timeLimitHours}h); project requirements remain unfinished`;
  if (loop.tokenBudget !== undefined && (loop.tokensUsed ?? 0) >= loop.tokenBudget) return `token budget exhausted (${loop.tokenBudget}); project requirements remain unfinished`;
  if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) return `max iterations reached (${loop.maxIterations}); project requirements remain unfinished`;
  return undefined;
}

function parkProjectBound(ctx: ExtensionContext): boolean {
  const loop = state.loop;
  if (!loop?.active || !loop.builder || !host.context(ctx)) return false;
  const reason = projectBoundReason(loop);
  if (!reason) return false;
  const old = state;
  replaceState({ ...old, loop: { ...loop, active: false, stopReason: reason } });
  if (!host.persist(ctx)) { replaceState(old); return true; }
  appendLedger(ctx.cwd, "respec_project_bound", { reason, cycle: loop.builder.cycle });
  ctx.ui.notify(`Project held: ${reason}. /loop status shows remaining work.`, "warning");
  return true;
}

function commit(ctx: ExtensionContext, before: RespecBuilderState, next: RespecBuilderState, completionSummary?: string): boolean {
  if (!host.context(ctx)) return false;
  const loop = state.loop;
  if (!loop || loop.builder !== before) return false;
  const old = state;
  const blocked = next.requirements.some(r => r.status === "blocked") && !next.requirements.some(r => r.status === "open") && next.phase !== "auditing";
  replaceState({ ...old, loop: { ...loop, builder: next, ...(completionSummary ? { completionSummary } : {}), ...(next.phase === "complete" ? { active: false, stopReason: "completed: all intended project requirements independently verified" } : blocked ? { active: false, stopReason: "blocked project requirements: clear the recorded blockers, then /loop resume" } : {}) } });
  if (!host.persist(ctx)) { replaceState(old); return false; }
  appendLedger(ctx.cwd, "respec_builder_transition", { phase: next.phase, revision: next.revision, cycle: next.cycle,
    history: next.history?.at(-1), scopeChange: next.scopeChanges?.at(-1) });
  return true;
}

/** Resume the same durable claim; process-layer lookup fences the exact request. */
export async function runRespecBuilderAudit(ctx: ExtensionContext): Promise<void> {
  const loop = state.loop, initialBuilder = loop?.builder;
  if (!loop?.active || initialBuilder?.phase !== "auditing" || !initialBuilder.audit || !host.context(ctx)) return;
  if (parkProjectBound(ctx)) return;
  let builder = initialBuilder;
  const key = `${ctx.cwd}:${loop.startedAt}:${builder.audit!.attemptId}`;
  if (running.has(key)) return;
  const controller = new AbortController();
  running.set(key, controller);
  const auditStartedAt = Date.now();
  const publish = (patch: Partial<NonNullable<ReturnType<typeof getRespecAuditLive>>>) => {
    if (!state.loop?.active || state.loop.builder !== builder || !host.context(ctx)) return;
    setRespecAuditLive(builder, { phase: "waiting", startedAt: auditStartedAt, ...getRespecAuditLive(builder), ...patch });
    try { host.refresh?.(ctx); } catch { /* display failure cannot discard audit evidence */ }
  };
  publish({ phase: "waiting" });
  const remainingMs = loop.timeLimitHours !== undefined ? loop.timeLimitHours * 3600000 - (Date.now() - Date.parse(loop.startedAt)) : undefined;
  const boundTimer = remainingMs !== undefined && Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= 2147483647
    ? setTimeout(() => { if (state.loop?.startedAt === loop.startedAt && state.loop.builder === builder && parkProjectBound(ctx)) controller.abort(); }, remainingMs + 1) : undefined;
  try {
    const goal = respecIncrementAuditGoal(builder, builder.projectId ?? loop.startedAt, nowIso());
    const settings = loadSettings(ctx.cwd);
    const saved = readCompletedCompletionAudit(ctx.cwd, goal, settings.auditorStrictChallenge);
    const resolved = host.resolveModel(ctx);
    const candidateRef = (model: any): string | undefined => typeof model === "string" ? model : model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
    const saveCursor = (patch: Partial<NonNullable<RespecBuilderState["audit"]>>): boolean => {
      if (!builder.audit || !state.loop?.active || state.loop.builder !== builder) return false;
      const next = { ...builder, audit: { ...builder.audit, ...patch } };
      if (!commit(ctx, builder, next)) return false;
      builder = next;
      return true;
    };
    const result = saved?.result ?? (resolved.error || !resolved.model
      ? { approved: false, disapproved: false, error: resolved.error ?? "No auditor model available", output: "", model: "unset" }
      : (await runAuditorFallbackWithPolicy([{ model: resolved.model, ref: candidateRef(resolved.model), via: "primary" }, ...(resolved.fallbackModels ?? []).map(candidate => ({ ...candidate, ref: candidateRef(candidate.model), via: candidate.via ?? "fallback" }))], candidate => runDetachedGoalCompletionAuditor({ cwd: ctx.cwd, goal, completionSummary: builder.audit!.claim,
        model: candidate.model, strictChallenge: settings.auditorStrictChallenge, thinkingLevel: resolveAuditorThinkingLevel(candidate.model, settings.auditorThinkingLevel ?? host.thinkingLevel?.() ?? "max"),
        allowedExtensions: dispatchAuditorAllowedExtensions(settings.auditorAllowedExtensions, settings.auditorMirrorSessionExtensions, host.auditRuntime?.homeDir ?? homedir(), ctx.cwd),
        inspection: settings.auditorInspection === true,
        signal: controller.signal,
        onProgress: progress => {
          publish({ phase: progress.phase === "starting" ? "starting" : "running", ...(progress.lastActivityAt !== undefined ? { lastActivityAt: progress.lastActivityAt } : {}), activity: progress.currentTool ? `tool: ${progress.currentTool}` : progress.phase.replaceAll("_", " ") });
          if (parkProjectBound(ctx)) controller.abort();
          if (!state.loop?.active || state.loop.startedAt !== loop.startedAt || state.loop.builder !== builder || !host.context(ctx)) controller.abort();
        },
        runtime: { ...host.auditRuntime, logicalAttemptId: builder.audit!.attemptId,
          attemptId: () => newDetachedAuditJobAttemptId(builder.audit!.attemptId),
          toolTimeoutMs: host.auditRuntime?.toolTimeoutMs ?? settings.auditorToolTimeoutMs, heartbeatNoProgressMs: host.auditRuntime?.heartbeatNoProgressMs ?? settings.auditorStallMs },
      }), {
        signal: controller.signal, sleep: host.auditSleep,
        forbiddenRefs: settings.forbiddenModels,
        shouldRetry: () => !!state.loop?.active && state.loop.builder === builder && !!host.context(ctx),
        resumeCandidateRef: builder.audit!.candidateRef, attemptedRefs: builder.audit!.attemptedRefs,
        retryCandidateRef: builder.audit!.retryCandidateRef, retryAttemptStarted: builder.audit!.retryAttemptStarted,
        retryFailureClass: builder.audit!.retryFailureClass,
        onAttempt: (_candidate, info) => { publish({ phase: "starting", model: info.candidateRef, retryAt: undefined, lastActivityAt: undefined, activity: undefined }); return saveCursor({ candidateRef: info.candidateRef, attemptedRefs: info.attemptedRefs, retryAttemptStarted: info.attempt === 2 }); },
        onRetry: (_candidate, _error, delay, info) => { publish({ phase: "retrying", retryAt: Date.now() + delay, activity: `retry: ${info.failureClass}` }); return saveCursor({ candidateRef: info.candidateRef, attemptedRefs: info.attemptedRefs, retryCandidateRef: info.candidateRef, retryFailureClass: info.failureClass, retryAttemptStarted: false }); },
        onCandidateExhausted: (_candidate, _error, info) => { publish({ phase: "waiting", model: info.nextCandidateRef, retryAt: undefined, activity: "selecting fallback" }); return saveCursor({ candidateRef: info.nextCandidateRef ?? info.candidateRef, attemptedRefs: info.attemptedRefs, retryCandidateRef: undefined, retryAttemptStarted: false, retryFailureClass: info.failureClass }); },
      })).result);
    const liveCtx = host.context(ctx);
    const current = state.loop;
    if (!liveCtx || current?.startedAt !== loop.startedAt || !current.active || current.builder !== builder) return;
    const next = settleRespecAudit(builder, builder.audit!.attemptId, result);
    const archive = respecProjectArchivePath(liveCtx.cwd, loop.startedAt, next.revision);
    const summary = next.phase === "complete" ? respecCompletionSummary(next, archive) : undefined;
    if (next.phase === "complete") {
      await mkdir(archiveDir(liveCtx.cwd), { recursive: true });
      await writeAtomicJson(respecProjectArchivePath(liveCtx.cwd, loop.startedAt, next.revision), { kind: "respec-project", startedAt: loop.startedAt, completedAt: nowIso(), builder: next, completionSummary: summary });
      // Archival yields: a concurrent stop/refinement must still own state.
      if (!host.context(liveCtx) || state.loop?.builder !== builder || !state.loop.active) return;
    }
    if (!commit(liveCtx, builder, next, summary)) return;
    if (result.error) {
      // Keep the claim, but park automation rather than retrying an unavailable
      // provider in a hot loop. Explicit resume retries the same durable claim.
      const old = state;
      replaceState({ ...old, loop: { ...state.loop!, active: false, stopReason: `audit infrastructure: ${result.error}` } });
      if (!host.persist(liveCtx)) replaceState(old);
      liveCtx.ui.notify(`Project audit has no verdict: ${result.error}. /loop resume retries the saved claim.`, "warning");
    } else {
      const verified = next.history?.at(-1)?.outcome === "approved";
      liveCtx.ui.notify(next.phase === "complete" ? "Project complete — every intended requirement was independently verified." : verified ? "Increment verified — replanning the remaining project requirements." : "Increment needs work — audit findings carry into replanning.", next.phase === "replanning" && !verified ? "warning" : "info");
      if (next.phase !== "complete") host.wake(liveCtx);
      else { replayRespecCompletionSummary(liveCtx); host.finished?.(liveCtx); }
    }
  } catch (error) {
    const liveCtx = host.context(ctx);
    if (liveCtx && state.loop?.startedAt === loop.startedAt && state.loop.builder === builder && state.loop.active) {
      const old = state;
      replaceState({ ...old, loop: { ...state.loop, active: false, stopReason: `audit infrastructure: ${String(error)}` } });
      if (!host.persist(liveCtx)) replaceState(old);
      liveCtx.ui.notify("Project audit interrupted without a verdict; /loop resume retries its durable claim.", "warning");
    }
  } finally { if (boundTimer) clearTimeout(boundTimer); running.delete(key); setRespecAuditLive(initialBuilder); if (host.context(ctx)) { try { host.refresh?.(ctx); } catch { /* stale display */ } } }
}

/** The durable terminal summary is the outbox; replay uses the existing receipt check. */
export function replayRespecCompletionSummary(ctx: ExtensionContext): void {
  const loop = state.loop, builder = loop?.builder;
  if (!host?.completed || !host.context(ctx) || builder?.phase !== "complete" || builder.summaryDeliveredAt || !loop?.completionSummary) return;
  try {
    if (host.completed(ctx, `respec:${builder.projectId ?? loop.startedAt}:${builder.revision}`, loop.completionSummary)) {
      commit(ctx, builder, { ...builder, summaryDeliveredAt: nowIso() });
    }
  } catch { ctx.ui.notify("Project summary is saved; /loop status shows it. Delivery will retry on reload.", "warning"); }
}

export function registerRespecBuilderTools(pi: ExtensionAPI, deps: Host): void {
  host = deps;
  const confirm = (ctx: ExtensionContext, title: string, body: string) => host.confirm ? host.confirm(ctx, title, body) : ctx.ui.confirm(title, body);
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const execute = (action: (p: any, ctx: ExtensionContext, before: RespecBuilderState) => Promise<RespecBuilderState> | RespecBuilderState, allowStopped = false) =>
    async (_id: string, params: any, _signal: AbortSignal | undefined, _update: any, execCtx: ExtensionContext) => {
      const ctx = host.context(execCtx);
      if (!ctx) return reply("This session cannot mutate the active project.");
      const before = state.loop?.builder;
      if (!before || (!state.loop?.active && !allowStopped)) return reply("No active respec project builder.");
      try {
        const next = await action(params, ctx, before);
        if (!commit(ctx, before, next)) return reply("Project changed or persistence failed; no proposal was applied.");
        return reply(`Project ${next.phase}; increment ${next.cycle}. Requirements close only after independent audit.${state.loop?.active ? "" : " Work stays paused; clear blockers and use /loop resume when ready."}`);
      } catch (error) { return reply(String(error instanceof Error ? error.message : error)); }
    };
  pi.registerTool(host.wrapTool({ name: "propose_project_requirements", label: "Draft intended project", description: "Propose desired project capabilities and observable acceptance criteria. User confirmation adopts scope; no requirement starts verified.",
    parameters: Type.Object({ requirements: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), acceptance: Type.String() })) }),
    execute: execute(async (p, ctx, before) => {
      const next = adoptRespecRequirements(before, p.requirements);
      const ok = await confirm(ctx, "Confirm intended project", next.requirements.map(r => `**${r.id}: ${r.text}**\n\nDone when: ${r.acceptance}`).join("\n\n"));
      if (!ok) throw new Error("Project scope was not adopted; continue drafting from the operator's feedback.");
      return next;
    }),
  }));
  pi.registerTool(host.wrapTool({ name: "plan_project_increment", label: "Plan build increment", description: "Plan a coherent build batch mapped to open requirement ids. The adopted project scope remains intact.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), requirementIds: Type.Array(Type.String()) })) }),
    execute: execute((p, _ctx, before) => planRespecIncrement(before, p.tasks)),
  }));
  pi.registerTool(host.wrapTool({ name: "claim_project_task", label: "Claim project task", description: "Claim a task implemented. This does not verify any project requirement.",
    parameters: Type.Object({ id: Type.String() }), execute: execute((p, _ctx, before) => claimRespecTask(before, p.id)),
  }));
  pi.registerTool(host.wrapTool({ name: "audit_project_increment", label: "Audit build increment", description: "Submit a concrete implementation claim after all batch tasks are claimed. The host runs the isolated auditor after this turn.",
    parameters: Type.Object({ claim: Type.String() }), execute: execute((p, _ctx, before) => beginRespecAudit(before, randomUUID(), p.claim)),
  }));
  pi.registerTool(host.wrapTool({ name: "block_project_requirement", label: "Record project blocker", description: "Record a concrete blocker. The requirement stays unfinished and abandoned batch work is retained.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String() }), execute: execute((p, _ctx, before) => blockRespecRequirement(before, p.id, p.reason), true),
  }));
  pi.registerTool(host.wrapTool({ name: "unblock_project_requirement", label: "Clear project blocker", description: "Record evidence that a blocker cleared. Paused work stays paused until explicit resume.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String() }), execute: execute((p, _ctx, before) => unblockRespecRequirement(before, p.id, p.reason), true),
  }));
  pi.registerTool(host.wrapTool({ name: "propose_project_refinement", label: "Refine intended project", description: "Propose the full revised requirements with rationale. Scope removal or changed acceptance needs user confirmation; prior audit claims become stale.",
    parameters: Type.Object({ reason: Type.String(), requirements: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), acceptance: Type.String() })) }),
    execute: execute(async (p, ctx, before) => {
      const next = refineRespecRequirements(before, p.requirements, p.reason);
      const ok = await confirm(ctx, "Confirm project scope change", `Reason: ${p.reason}\n\n**CURRENT:**\n${before.requirements.map(r => `${r.id}: ${r.text}\nDone when: ${r.acceptance}`).join("\n\n")}\n\n**PROPOSED:**\n${next.requirements.map(r => `${r.id}: ${r.text}\nDone when: ${r.acceptance}`).join("\n\n")}\n\nRemoved: ${next.scopeChanges!.at(-1)!.removedIds.join(", ") || "none"}. Changed scope requires renewed verification.`);
      if (!ok) throw new Error("Scope change declined; existing requirements and audit claim remain intact.");
      return next;
    }, true),
  }));
}
