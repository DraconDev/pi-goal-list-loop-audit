import type { RespecBuilderState } from "./respec-builder.js";
import { MAX_RENDER_LINE_CHARS } from "./terminal-summary-limits.js";
import { sanitizeDisplayText } from "./goal-loop-core.js";

export interface RespecAuditLive {
  phase: "starting" | "running" | "retrying" | "waiting";
  model?: string;
  startedAt: number;
  attemptStartedAt?: number;
  workerPhase?: string;
  round?: 1 | 2;
  currentTool?: string;
  currentToolStartedAt?: number;
  toolTimeoutMs?: number;
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
function wrapBlockerText(text: string): string[] {
  let remaining = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  while (remaining.length > 96) {
    const space = remaining.lastIndexOf(" ", 96);
    const end = space > 0 ? space : 96;
    lines.push(remaining.slice(0, end)); remaining = remaining.slice(end).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}
/** Action first: diagnostics stay in the explicit full-details view. */
export function respecBlockerActions(builder: RespecBuilderState): string {
  const blocked = builder.requirements.filter(r => r.status === "blocked");
  if (!blocked.length) return "No recorded project blockers. /loop status shows remaining work.";
  return ["Project blockers — recorded by the agent; recheck before treating them as current facts.",
    ...blocked.flatMap(r => {
      const action = r.blockerAction;
      const legacy = !action?.summary || !action?.whyAgentCannotProceed;
      return ["", ...wrapBlockerText(`${r.id}: ${action?.summary || "The agent did not record a short explanation of the hangup."}`),
        ...wrapBlockerText(`Who can act: ${action?.owner || "Not recorded; operator involvement is unconfirmed."}`),
        ...wrapBlockerText(`Why the agent cannot continue: ${action?.whyAgentCannotProceed || "Not recorded. A failed test or unfinished implementation alone is not an external blocker."}`),
        ...wrapBlockerText(`Action to take: ${action?.nextAction || 'Ask the agent: "Recheck these blockers. Continue fixing ordinary implementation or test failures. For a real external dependency, name who must act and the exact step needed."'}`),
        ...wrapBlockerText(`Resolved when: ${action?.expectedResult || "The agent demonstrates that the blocking condition cleared."}`),
        ...(legacy ? ["This older report needs clarification; it does not establish that you must intervene."] : [])];
    }), "", "Evidence and full recorded reports: /loop blockers",
    ...wrapBlockerText("When evidence shows a blocker is resolved, the agent records it with unblock_project_requirement. Then /loop resume continues the saved project. Clearing a blocker does not verify or complete the requirement.")].join("\n");
}
export function respecBlockerDetails(builder: RespecBuilderState): string {
  const blocked = builder.requirements.filter(r => r.status === "blocked");
  if (!blocked.length) return respecBlockerActions(builder);
  return [respecBlockerActions(builder), "", "Full recorded evidence:",
    ...blocked.flatMap(r => ["", ...wrapBlockerText(`${r.id}: ${r.text}`), "Recorded reason:", ...wrapBlockerText(r.blockedReason || "No concrete reason recorded.")])].join("\n");
}
export function respecAuditToolWait(progress: RespecAuditLive | undefined, now: number): string | undefined {
  if (!progress || progress.phase !== "running" || !progress.currentTool
    || !["running", "tool_executing"].includes(progress.workerPhase ?? "")
    || !Number.isFinite(progress.currentToolStartedAt) || progress.currentToolStartedAt! > now
    || (progress.lastActivityAt !== undefined && (!Number.isFinite(progress.lastActivityAt) || progress.lastActivityAt > now))
    || !Number.isFinite(progress.toolTimeoutMs) || progress.toolTimeoutMs! <= 0
    || now - progress.currentToolStartedAt! >= progress.toolTimeoutMs!) return undefined;
  return `waiting on ${sanitizeDisplayText(progress.currentTool)} · ${seconds(now - progress.currentToolStartedAt!)} / ${seconds(progress.toolTimeoutMs!)} timeout`;
}
export function respecAuditStatus(builder: RespecBuilderState, now: number): string {
  const progress = getRespecAuditLive(builder);
  if (!progress) return "auditor: waiting for dispatch · no live worker observed";
  return `auditor: ${respecAuditToolWait(progress, now) ?? progress.phase}${progress.round === 2 ? " · second pass" : ""} · ${sanitizeDisplayText(progress.model ?? "model pending")}`
    + (progress.attemptStartedAt !== undefined ? ` · attempt ${seconds(now - progress.attemptStartedAt)}` : "")
    + ` · total ${seconds(now - progress.startedAt)}`
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
