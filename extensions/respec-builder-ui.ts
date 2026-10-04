import type { RespecBuilderState } from "./respec-builder.js";
import { MAX_RENDER_LINE_CHARS } from "./terminal-summary-limits.js";
import { sanitizeDisplayText } from "./goal-loop-core.js";

export interface RespecAuditLive {
  phase: "starting" | "running" | "retrying" | "waiting";
  model?: string;
  startedAt: number;
  lastActivityAt?: number;
  activity?: string;
  retryAt?: number;
}
const live = new Map<string, RespecAuditLive>();
function key(builder: RespecBuilderState): string | undefined {
  return builder.audit ? `${builder.projectId ?? "legacy"}:${builder.audit.attemptId}` : undefined;
}
export function setRespecAuditLive(builder: RespecBuilderState, value?: RespecAuditLive): void {
  const id = key(builder);
  if (!id) return;
  if (value) live.set(id, value); else live.delete(id);
}
export function getRespecAuditLive(builder: RespecBuilderState): RespecAuditLive | undefined {
  const id = key(builder);
  return id ? live.get(id) : undefined;
}
const seconds = (ms: number) => `${Math.max(0, Math.floor(ms / 1000))}s`;
export function respecAuditStatus(builder: RespecBuilderState, now: number): string {
  const progress = getRespecAuditLive(builder);
  if (!progress) return "auditor: waiting for dispatch · no live worker observed";
  return `auditor: ${progress.phase} · ${sanitizeDisplayText(progress.model ?? "model pending")} · elapsed ${seconds(now - progress.startedAt)}`
    + (progress.lastActivityAt !== undefined ? ` · last activity ${seconds(now - progress.lastActivityAt)} ago` : " · worker activity not observed")
    + (progress.activity ? ` · ${sanitizeDisplayText(progress.activity)}` : "")
    + (progress.retryAt !== undefined ? ` · retry in ${seconds(progress.retryAt - now)}` : "");
}
const markdown = (text: string) => sanitizeDisplayText(text).replace(/[\\`*_{}\[\]()#+.!>|~-]/g, "\\$&");
export function respecCompletionSummary(builder: RespecBuilderState, archive: string): string {
  if (builder.phase !== "complete" || !builder.requirements.length || builder.requirements.some(r => r.status !== "verified" || !r.evidence)) throw new Error("Project summary requires independently verified requirements.");
  const audits = new Map(builder.requirements.map(r => [r.evidence!.attemptId, r.evidence!]));
  // Preserve receipt/outbox parity for large projects; the archive and status
  // retain the full contract and reports. Display omissions are explicit.
  const requirements = builder.requirements.slice(0, 40);
  const evidence = [...audits.values()].slice(0, 20);
  const omittedRequirements = builder.requirements.length - requirements.length;
  const omittedAudits = audits.size - evidence.length;
  return ["### Done", markdown(builder.vision), "", "### What Changed",
    ...requirements.map(r => `- **${markdown(r.id)}:** ${markdown(r.text)}`), ...(omittedRequirements ? [`- ${omittedRequirements} more requirements: see /loop status and archive.`] : []), "", "### Verification",
    `PASS: All ${builder.requirements.length} adopted requirements are independently verified.`,
    ...requirements.map(r => `- **${markdown(r.id)}:** ${markdown(r.acceptance)} — audit ${markdown(r.evidence!.attemptId)}`),
    ...(omittedRequirements ? [`- Acceptance and proof for ${omittedRequirements} more requirements: see /loop status and archive.`] : []),
    "", "### Evidence", ...evidence.map(e => `- **${markdown(e.attemptId)}** · ${markdown(e.model)}: ${markdown(e.report)}`),
    ...(omittedAudits ? [`- ${omittedAudits} more audit reports: see archive.`] : []),
    `- **Archive:** ${markdown(archive)}`, "", "### Remaining", "No unfinished adopted requirements.", "", "### Next", "Use /loop status to inspect the verified project; start a new project when its intended scope changes."].map(line => {
      const points = [...line];
      return points.length <= MAX_RENDER_LINE_CHARS ? line : points.slice(0, MAX_RENDER_LINE_CHARS - 1).join("") + "…";
    }).join("\n");
}
