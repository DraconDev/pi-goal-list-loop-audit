import { randomUUID, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { state, replaceState } from "./goal-state.js";
import { appendLedger, nowIso, archiveDir } from "./goal-loop-core.js";
import { loadSettings } from "./goal-settings.js";
import { runDetachedGoalCompletionAuditor, readCompletedCompletionAudit, newDetachedAuditJobAttemptId, writeAtomicJson, type AuditorProcessRuntime } from "./goal-loop-auditor-process.js";
import { respecIncrementAuditGoal } from "./respec-builder-audit.js";
import { adoptRespecRequirements, beginRespecAudit, blockRespecRequirement, unblockRespecRequirement, refineRespecRequirements, claimRespecTask, planRespecIncrement, settleRespecAudit, type RespecBuilderState } from "./respec-builder.js";

interface Host {
  context: (ctx: ExtensionContext) => ExtensionContext | null;
  persist: (ctx: ExtensionContext) => boolean;
  wake: (ctx: ExtensionContext) => void;
  resolveModel: (ctx: ExtensionContext) => { model: any; error?: string };
  wrapTool: (tool: any) => any;
  /** Bounded worker launcher overrides for embedding and hermetic tests. */
  auditRuntime?: AuditorProcessRuntime;
  finished?: (ctx: ExtensionContext) => void;
}
let host: Host;
const running = new Set<string>();

export function respecProjectArchivePath(cwd: string, startedAt: string, revision: number): string {
  const identity = createHash("sha256").update(`${startedAt}:${revision}`).digest("hex").slice(0, 24);
  return path.join(archiveDir(cwd), `respec-${identity}.json`);
}

function commit(ctx: ExtensionContext, before: RespecBuilderState, next: RespecBuilderState): boolean {
  if (!host.context(ctx)) return false;
  const loop = state.loop;
  if (!loop || loop.builder !== before) return false;
  const old = state;
  const blocked = next.requirements.some(r => r.status === "blocked") && !next.requirements.some(r => r.status === "open") && next.phase !== "auditing";
  replaceState({ ...old, loop: { ...loop, builder: next, ...(next.phase === "complete" ? { active: false, stopReason: "completed: all intended project requirements independently verified" } : blocked ? { active: false, stopReason: "blocked project requirements: clear the recorded blockers, then /loop resume" } : {}) } });
  if (!host.persist(ctx)) { replaceState(old); return false; }
  appendLedger(ctx.cwd, "respec_builder_transition", { phase: next.phase, revision: next.revision, cycle: next.cycle,
    history: next.history?.at(-1), scopeChange: next.scopeChanges?.at(-1) });
  return true;
}

/** Resume the same durable claim; process-layer lookup fences the exact request. */
export async function runRespecBuilderAudit(ctx: ExtensionContext): Promise<void> {
  const loop = state.loop, builder = loop?.builder;
  if (!loop?.active || builder?.phase !== "auditing" || !builder.audit) return;
  const key = `${ctx.cwd}:${loop.startedAt}:${builder.audit.attemptId}`;
  if (running.has(key)) return;
  running.add(key);
  try {
    const goal = respecIncrementAuditGoal(builder, loop.startedAt, nowIso());
    const settings = loadSettings(ctx.cwd);
    const saved = readCompletedCompletionAudit(ctx.cwd, goal, settings.auditorStrictChallenge);
    const resolved = host.resolveModel(ctx);
    const controller = new AbortController();
    const result = saved?.result ?? (resolved.error || !resolved.model
      ? { approved: false, disapproved: false, error: resolved.error ?? "No auditor model available", output: "", model: "unset" }
      : await runDetachedGoalCompletionAuditor({ cwd: ctx.cwd, goal, completionSummary: builder.audit.claim,
        model: resolved.model, strictChallenge: settings.auditorStrictChallenge, thinkingLevel: settings.auditorThinkingLevel ?? "max",
        signal: controller.signal,
        onProgress: () => {
          if (!state.loop?.active || state.loop.startedAt !== loop.startedAt || state.loop.builder !== builder || !host.context(ctx)) controller.abort();
        },
        runtime: { ...host.auditRuntime, logicalAttemptId: builder.audit.attemptId,
          attemptId: () => newDetachedAuditJobAttemptId(builder.audit!.attemptId),
          toolTimeoutMs: host.auditRuntime?.toolTimeoutMs ?? settings.auditorToolTimeoutMs, heartbeatNoProgressMs: host.auditRuntime?.heartbeatNoProgressMs ?? settings.auditorStallMs },
      }));
    const liveCtx = host.context(ctx);
    const current = state.loop;
    if (!liveCtx || current?.startedAt !== loop.startedAt || !current.active || current.builder !== builder) return;
    const next = settleRespecAudit(builder, builder.audit.attemptId, result);
    if (next.phase === "complete") {
      await mkdir(archiveDir(liveCtx.cwd), { recursive: true });
      await writeAtomicJson(respecProjectArchivePath(liveCtx.cwd, loop.startedAt, next.revision), { kind: "respec-project", startedAt: loop.startedAt, completedAt: nowIso(), builder: next });
      // Archival yields: a concurrent stop/refinement must still own state.
      if (!host.context(liveCtx) || state.loop?.builder !== builder || !state.loop.active) return;
    }
    if (!commit(liveCtx, builder, next)) return;
    if (result.error) {
      // Keep the claim, but park automation rather than retrying an unavailable
      // provider in a hot loop. Explicit resume retries the same durable claim.
      const old = state;
      replaceState({ ...old, loop: { ...state.loop!, active: false, stopReason: `audit infrastructure: ${result.error}` } });
      if (!host.persist(liveCtx)) replaceState(old);
      liveCtx.ui.notify(`Project audit has no verdict: ${result.error}. /loop resume retries the saved claim.`, "warning");
    } else {
      liveCtx.ui.notify(next.phase === "complete" ? "Project complete — every intended requirement was independently verified." : result.approved ? "Increment verified — replanning the remaining project requirements." : "Increment needs work — audit findings carry into replanning.", next.phase === "replanning" && !result.approved ? "warning" : "info");
      if (next.phase !== "complete") host.wake(liveCtx);
      else host.finished?.(liveCtx);
    }
  } catch (error) {
    const liveCtx = host.context(ctx);
    if (liveCtx && state.loop?.startedAt === loop.startedAt && state.loop.builder === builder && state.loop.active) {
      const old = state;
      replaceState({ ...old, loop: { ...state.loop, active: false, stopReason: `audit infrastructure: ${String(error)}` } });
      if (!host.persist(liveCtx)) replaceState(old);
      liveCtx.ui.notify("Project audit interrupted without a verdict; /loop resume retries its durable claim.", "warning");
    }
  } finally { running.delete(key); }
}

export function registerRespecBuilderTools(pi: ExtensionAPI, deps: Host): void {
  host = deps;
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
      const ok = await ctx.ui.confirm("Confirm intended project", next.requirements.map(r => `${r.id}: ${r.text}\nDone when: ${r.acceptance}`).join("\n\n"));
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
  for (const [name, label, action] of [
    ["block_project_requirement", "Record project blocker", blockRespecRequirement],
    ["unblock_project_requirement", "Clear project blocker", unblockRespecRequirement],
  ] as const) {
    pi.registerTool(host.wrapTool({ name, label, description: "Record a concrete blocker or evidence it cleared. Blocked requirements remain unfinished; abandoning a batch retains its tasks and reason.",
      parameters: Type.Object({ id: Type.String(), reason: Type.String() }), execute: execute((p, _ctx, before) => action(before, p.id, p.reason), true),
    }));
  }
  pi.registerTool(host.wrapTool({ name: "propose_project_refinement", label: "Refine intended project", description: "Propose the full revised requirements with rationale. Scope removal or changed acceptance needs user confirmation; prior audit claims become stale.",
    parameters: Type.Object({ reason: Type.String(), requirements: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), acceptance: Type.String() })) }),
    execute: execute(async (p, ctx, before) => {
      const next = refineRespecRequirements(before, p.requirements, p.reason);
      const ok = await ctx.ui.confirm("Confirm project scope change", `Reason: ${p.reason}\n\nCURRENT:\n${before.requirements.map(r => `${r.id}: ${r.text}\nDone when: ${r.acceptance}`).join("\n\n")}\n\nPROPOSED:\n${next.requirements.map(r => `${r.id}: ${r.text}\nDone when: ${r.acceptance}`).join("\n\n")}\n\nRemoved: ${next.scopeChanges!.at(-1)!.removedIds.join(", ") || "none"}. Changed scope requires renewed verification.`);
      if (!ok) throw new Error("Scope change declined; existing requirements and audit claim remain intact.");
      return next;
    }, true),
  }));
}
