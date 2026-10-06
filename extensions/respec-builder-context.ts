import type { RespecBuilderState } from "./respec-builder.js";

export const MAX_RESPEC_CONTEXT_CHARS = 48_000;
const authority = ".pi-glla/active.jsonl (last state record, loop.builder)";
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.floor(max / 2))}\n[Excerpt: omitted text remains in ${authority}; read the relevant full fields before acting.]\n${text.slice(-Math.floor(max / 2))}`;
}

/** Dispatch projection only. Contracts and complete reports remain durable. */
export function respecBuilderContext(builder: RespecBuilderState): string {
  const latest = builder.history?.at(-1);
  const projected = {
    ...builder,
    contextProjection: { authority, historyEntriesOmitted: Math.max(0, (builder.history?.length ?? 0) - 1),
      feedbackEntriesOmitted: Math.max(0, builder.feedback.length - 1),
      scopeChangesOmitted: Math.max(0, (builder.scopeChanges?.length ?? 0) - 1),
      instruction: "This is a dispatch projection, not a replacement contract. Read omitted report/feedback fields using scoped inspection when needed; all adopted requirements and audit evidence remain binding." },
    requirements: builder.requirements.map(r => ({ ...r, evidence: r.evidence
      ? { attemptId: r.evidence.attemptId, model: r.evidence.model, reportReference: `${authority}: requirements evidence.report for ${r.id}` } : undefined })),
    feedback: builder.feedback.slice(-1).map(text => excerpt(text, 4_000)),
    history: latest ? [{ cycle: latest.cycle, outcome: latest.outcome, attemptId: latest.attemptId, report: excerpt(latest.report, 12_000) }] : [],
    scopeChanges: builder.scopeChanges?.slice(-1),
    audit: builder.audit ? { ...builder.audit, claim: excerpt(builder.audit.claim, 6_000) } : undefined,
  };
  const result = JSON.stringify(projected, null, 2);
  if (result.length <= MAX_RESPEC_CONTEXT_CHARS) return result;
  // Never silently clip acceptance criteria or serialize invalid JSON.
  // Oversized contracts require a scoped durable read before operational work.
  const fallback = JSON.stringify({ projectId: excerpt(builder.projectId ?? "", 256), phase: builder.phase,
    revision: builder.revision, cycle: builder.cycle, vision: excerpt(builder.vision, 2_000),
    requirementCount: builder.requirements.length, taskCount: builder.tasks.length,
    contextProjection: { authority, contractOmitted: true,
      instruction: "STOP before implementing, verifying or refining: read the full adopted requirements, acceptance criteria and current tasks from the last durable builder state using scoped inspection. This short record cannot define or weaken the contract." },
    latestAudit: latest ? { cycle: latest.cycle, outcome: latest.outcome, report: excerpt(latest.report, 12_000) } : undefined,
    latestFeedback: builder.feedback.length ? excerpt(builder.feedback.at(-1)!, 4_000) : undefined,
  }, null, 2);
  if (fallback.length <= MAX_RESPEC_CONTEXT_CHARS) return fallback;
  return JSON.stringify({ projectId: excerpt(builder.projectId ?? "", 128), phase: builder.phase,
    revision: builder.revision, cycle: builder.cycle, requirementCount: builder.requirements.length,
    taskCount: builder.tasks.length, contextProjection: { authority, contractOmitted: true, reportsOmitted: true,
      instruction: "STOP before operational work: read the full adopted contract, current tasks and latest feedback through scoped durable inspection. This projection cannot define or weaken scope." } }, null, 2);
}
