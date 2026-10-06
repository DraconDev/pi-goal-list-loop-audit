import { randomUUID, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { state, replaceState } from "./goal-state.js";
import { appendLedger, nowIso, archiveDir, supervisorPaused } from "./goal-loop-core.js";
import { persistApprovalRender, replayUndeliveredApprovalRenders } from "./approval-render-store.js";
import { loadSettings } from "./goal-settings.js";
import type { LoopState } from "./goal-loop-forever.js";
import { dispatchAuditorAllowedExtensions } from "./auditor-extensions.js";
import { resolveAuditorThinkingLevel } from "./auditor-thinking.js";
import { runDetachedGoalCompletionAuditor, runAuditorFallbackWithPolicy, readCompletedCompletionAudit, newDetachedAuditJobAttemptId, writeAtomicJson, effectiveToolTimeoutMs, DEFAULT_AUDITOR_TOOL_TIMEOUT_MS, type AuditorProcessRuntime } from "./goal-loop-auditor-process.js";
import { setRespecAuditLive, getRespecAuditLive, respecCompletionSummary, respecBlockerActions } from "./respec-builder-ui.js";
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
let extensionApi: ExtensionAPI;
const running = new Map<string, AbortController>();

/** A durable claim alone is not proof of a live dispatch. The detached
 * auditor owns its watchdog while this exact, uncancelled dispatch runs. */
export function respecBuilderAuditInFlight(cwd: string): boolean {
  const loop = state.loop;
  if (!loop?.active || loop.builder?.phase !== "auditing" || !loop.builder.audit) return false;
  const controller = running.get(`${cwd}:${loop.startedAt}:${loop.builder.audit.attemptId}`);
  return !!controller && !controller.signal.aborted;
}

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
  const old = { ...state };
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
  const old = { ...state };
  const blocked = next.requirements.some(r => r.status === "blocked") && !next.requirements.some(r => r.status === "open") && next.phase !== "auditing";
  replaceState({ ...old, loop: { ...loop, builder: next, ...(completionSummary ? { completionSummary } : {}), ...(next.phase === "complete" ? { active: false, stopReason: "completed: all intended project requirements independently verified" } : blocked ? { active: false, stopReason: "blocked project requirements: clear the recorded blockers, then /loop resume" } : {}) } });
  if (!host.persist(ctx)) { replaceState(old); return false; }
  appendLedger(ctx.cwd, "respec_builder_transition", { phase: next.phase, revision: next.revision, cycle: next.cycle,
    history: next.history?.at(-1), scopeChange: next.scopeChanges?.at(-1) });
  const newBlockers = next.requirements.filter(r => r.status === "blocked" && !before.requirements.some(old =>
    old.id === r.id && old.status === "blocked" && old.blockedReason === r.blockedReason
    && JSON.stringify(old.blockerAction) === JSON.stringify(r.blockerAction)));
  if (newBlockers.length) {
    // Public transcript hook: display actions without starting a turn or
    // treating an operator acknowledgement as evidence of resolution.
    const content = respecBlockerActions({ ...next, requirements: newBlockers });
    try { extensionApi.sendMessage({ customType: "glla-project-blockers", content, display: true,
      details: { projectId: next.projectId, requirementIds: newBlockers.map(r => r.id) } }, { triggerTurn: false }); }
    catch { /* A UI failure must not roll back a durably recorded blocker. */ }
    try { ctx.ui.notify(content, "warning"); } catch { /* headless host */ }
  }
  return true;
}

/** Resume the same durable claim; process-layer lookup fences the exact request. */
export async function runRespecBuilderAudit(ctx: ExtensionContext): Promise<void> {
  const loop = state.loop, initialBuilder = loop?.builder;
  if (supervisorPaused(state) || !loop?.active || initialBuilder?.phase !== "auditing" || !initialBuilder.audit || !host.context(ctx)) return;
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
          publish({ phase: progress.phase === "starting" ? "starting" : "running", ...(progress.phase !== "starting" && progress.lastActivityAt !== undefined ? { lastActivityAt: progress.lastActivityAt } : {}),
            workerPhase: progress.phase, round: progress.round, currentTool: progress.currentTool, currentToolStartedAt: progress.currentToolStartedAt,
            toolTimeoutMs: effectiveToolTimeoutMs(host.auditRuntime?.toolTimeoutMs ?? settings.auditorToolTimeoutMs ?? DEFAULT_AUDITOR_TOOL_TIMEOUT_MS, progress.currentToolTimeoutMs),
            activity: progress.currentTool ? `tool: ${progress.currentTool}` : progress.phase.replaceAll("_", " ") });
          if (parkProjectBound(ctx)) controller.abort();
          if (!state.loop?.active || state.loop.startedAt !== loop.startedAt || state.loop.builder !== builder || !host.context(ctx)) controller.abort();
        },
        runtime: { ...host.auditRuntime, logicalAttemptId: builder.audit!.attemptId,
          attemptId: () => newDetachedAuditJobAttemptId(builder.audit!.attemptId),
          toolTimeoutMs: host.auditRuntime?.toolTimeoutMs ?? settings.auditorToolTimeoutMs, heartbeatNoProgressMs: host.auditRuntime?.heartbeatNoProgressMs ?? settings.auditorStallMs },
      }), {
        signal: controller.signal, sleep: host.auditSleep,
        forbiddenRefs: settings.forbiddenModels,
        shouldRetry: () => !supervisorPaused(state) && !!state.loop?.active && state.loop.builder === builder && !!host.context(ctx),
        resumeCandidateRef: builder.audit!.candidateRef, attemptedRefs: builder.audit!.attemptedRefs,
        retryCandidateRef: builder.audit!.retryCandidateRef, retryAttemptStarted: builder.audit!.retryAttemptStarted,
        retryFailureClass: builder.audit!.retryFailureClass,
        onAttempt: (_candidate, info) => { publish({ phase: "starting", model: info.candidateRef, attemptStartedAt: Date.now(), retryAt: undefined, lastActivityAt: undefined, activity: undefined, workerPhase: undefined, round: undefined, currentTool: undefined, currentToolStartedAt: undefined, toolTimeoutMs: undefined }); return saveCursor({ candidateRef: info.candidateRef, attemptedRefs: info.attemptedRefs, retryAttemptStarted: info.attempt === 2 }); },
        onRetry: (_candidate, _error, delay, info) => { publish({ phase: "retrying", retryAt: Date.now() + delay, activity: `retry: ${info.failureClass}` }); return saveCursor({ candidateRef: info.candidateRef, attemptedRefs: info.attemptedRefs, retryCandidateRef: info.candidateRef, retryFailureClass: info.failureClass, retryAttemptStarted: false }); },
        onCandidateExhausted: (_candidate, _error, info) => { publish({ phase: "waiting", model: info.nextCandidateRef, retryAt: undefined, activity: "selecting fallback" }); return saveCursor({ candidateRef: info.nextCandidateRef ?? info.candidateRef, attemptedRefs: info.attemptedRefs, retryCandidateRef: undefined, retryAttemptStarted: false, retryFailureClass: info.failureClass }); },
      })).result);
    const liveCtx = host.context(ctx);
    const current = state.loop;
    if (controller.signal.aborted || !liveCtx || current?.startedAt !== loop.startedAt || !current.active || current.builder !== builder) return;
    const next = settleRespecAudit(builder, builder.audit!.attemptId, result);
    const archive = respecProjectArchivePath(liveCtx.cwd, loop.startedAt, next.revision);
    const summary = next.phase === "complete" ? respecCompletionSummary(next, archive) : undefined;
    if (next.phase === "complete") {
      await mkdir(archiveDir(liveCtx.cwd), { recursive: true });
      await writeAtomicJson(respecProjectArchivePath(liveCtx.cwd, loop.startedAt, next.revision), { kind: "respec-project", startedAt: loop.startedAt, completedAt: nowIso(), builder: next, completionSummary: summary });
      // Archival yields: a concurrent stop/refinement must still own state.
      if (!host.context(liveCtx) || state.loop?.builder !== builder || !state.loop.active) return;
    }
    if (summary && !persistApprovalRender(liveCtx.cwd, {
      goalId: `respec:${next.projectId ?? loop.startedAt}:${next.revision}`,
      objective: next.vision, chatLines: summary.split("\n"),
    })) throw new Error("Project summary outbox could not be persisted");
    if (!commit(liveCtx, builder, next, summary)) return;
    if (result.error) {
      // Keep the claim, but park automation rather than retrying an unavailable
      // provider in a hot loop. Explicit resume retries the same durable claim.
      const old = { ...state };
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
    if (!controller.signal.aborted && liveCtx && state.loop?.startedAt === loop.startedAt && state.loop.builder === builder && state.loop.active) {
      const old = { ...state };
      replaceState({ ...old, loop: { ...state.loop, active: false, stopReason: `audit infrastructure: ${String(error)}` } });
      if (!host.persist(liveCtx)) replaceState(old);
      liveCtx.ui.notify("Project audit interrupted without a verdict; /loop resume retries its durable claim.", "warning");
    }
  } finally {
    if (boundTimer) clearTimeout(boundTimer);
    running.delete(key);
    setRespecAuditLive(initialBuilder);
    const current = state.loop;
    // An explicit resume may arrive before cancelled-job cleanup completes.
    // Re-arm only the same live claim, after releasing its dispatch latch.
    if (controller.signal.aborted && current?.active && current.startedAt === loop.startedAt && current.builder?.projectId === initialBuilder.projectId && current.builder?.audit?.attemptId === initialBuilder.audit?.attemptId && host.context(ctx) && !supervisorPaused(state)) host.wake(ctx);
    if (host.context(ctx)) { try { host.refresh?.(ctx); } catch { /* stale display */ } }
  }
}

/** The shared durable outbox survives replacement of the current project. */
export function replayRespecCompletionSummary(ctx: ExtensionContext): void {
  if (!host?.completed || !host.context(ctx)) return;
  const loop = state.loop, builder = loop?.builder;
  // Migrate completed projects written before the shared outbox was used.
  if (builder?.phase === "complete" && !builder.summaryDeliveredAt && loop?.completionSummary) {
    if (!persistApprovalRender(ctx.cwd, { goalId: `respec:${builder.projectId ?? loop.startedAt}:${builder.revision}`, objective: builder.vision, chatLines: loop.completionSummary.split("\n") })) return;
  }
  replayUndeliveredApprovalRenders(ctx, entry => {
    if (!entry.goalId.startsWith("respec:") || !host.context(ctx)) return false;
    if (!host.completed!(ctx, entry.goalId, entry.chatLines.join("\n"))) return false;
    const current = state.loop, completed = current?.builder;
    if (completed?.phase === "complete" && entry.goalId === `respec:${completed.projectId ?? current!.startedAt}:${completed.revision}`) {
      commit(ctx, completed, { ...completed, summaryDeliveredAt: nowIso() });
    }
    return true;
  });
}

export function registerRespecBuilderTools(pi: ExtensionAPI, deps: Host): void {
  host = deps;
  extensionApi = pi;
  pi.registerMessageRenderer("glla-project-blockers", (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("warning", theme.bold("GLLA · Action needed")), 0, 0));
    const content = typeof message.content === "string" ? message.content : "";
    for (const line of content.split("\n")) {
      const action = /^(Who can act:|Why the agent cannot continue:|Action to take:|Resolved when:|Next action:)/.test(line);
      box.addChild(new Text(action ? theme.fg("accent", theme.bold(line)) : line, 0, 0));
    }
    return box;
  });
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
  pi.registerTool(host.wrapTool({ name: "block_project_requirement", label: "Record project blocker", description: "Record any concrete blocker (access, dependency, decision, environment or other). Only park on a dependency you cannot resolve within the authorized project work. Failed tests, missing evidence, unrun checks and unfinished implementation are work to continue, not blockers. Supply a short summary, owner, nextAction (exact command or location when relevant), expectedResult and whyAgentCannotProceed. Put long measurements in reason. Actions are shown automatically. The requirement stays unfinished and abandoned batch work is retained.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String(), summary: Type.String({ description: "One short sentence naming the actual obstacle, not a test report", maxLength: 240 }), owner: Type.String({ description: "Person or external service that can remove this obstacle" }), nextAction: Type.String({ description: "Concrete action, with exact command or location when applicable", maxLength: 600 }), expectedResult: Type.String({ description: "Observable evidence that the obstacle cleared", maxLength: 400 }), whyAgentCannotProceed: Type.String({ description: "Why this cannot be resolved as ordinary authorized project work", maxLength: 400 }) }),
    execute: execute((p, _ctx, before) => {
      for (const [key, limit] of [["summary", 240], ["owner", 160], ["nextAction", 600], ["expectedResult", 400], ["whyAgentCannotProceed", 400]] as const) {
        if (typeof p[key] !== "string" || !p[key].trim() || p[key].trim().length > limit)
          throw new Error(`Blocker not recorded: supply a concrete ${key} (1–${limit} characters). Continue investigating and fixing ordinary test or implementation failures; do not park work merely because acceptance is unmet.`);
      }
      return blockRespecRequirement(before, p.id, p.reason, { summary: p.summary, owner: p.owner, nextAction: p.nextAction, expectedResult: p.expectedResult, whyAgentCannotProceed: p.whyAgentCannotProceed });
    }, true),
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
