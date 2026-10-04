import type { RespecBuilderState } from "./respec-builder.js";
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
  return ["### Done", markdown(builder.vision), "", "### What Changed",
    ...builder.requirements.map(r => `- **${markdown(r.id)}:** ${markdown(r.text)}`), "", "### Verification",
    `${builder.requirements.length} passed requirement audits; every adopted acceptance criterion is independently verified.`,
    ...builder.requirements.map(r => `- **${markdown(r.id)}:** ${markdown(r.acceptance)} — audit ${markdown(r.evidence!.attemptId)}`),
    "", "### Evidence", ...[...audits.values()].map(e => `- **${markdown(e.attemptId)}** · ${markdown(e.model)}: ${markdown(e.report)}`),
    `- **Archive:** ${markdown(archive)}`, "", "### Remaining", "No unfinished adopted requirements.", "", "### Next", "Use /loop status to inspect the verified project; start a new project when its intended scope changes."].join("\n");
}
