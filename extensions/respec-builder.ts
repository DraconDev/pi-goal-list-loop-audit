import type { GoalAuditorResult } from "./goal-loop-auditor.js";
import { randomUUID } from "node:crypto";

export type RespecBuilderPhase = "drafting" | "planning" | "building" | "auditing" | "replanning" | "complete";
export interface RespecRequirement {
  id: string;
  text: string;
  acceptance: string;
  status: "open" | "blocked" | "verified";
  blockedReason?: string;
  blockerAction?: { owner?: string; nextAction?: string; expectedResult?: string };
  evidence?: { attemptId: string; report: string; model: string };
}
export interface RespecBuildTask {
  id: string;
  text: string;
  requirementIds: string[];
  status: "pending" | "claimed";
}
export interface RespecBuilderState {
  summaryDeliveredAt?: string;
  projectId?: string;
  phase: RespecBuilderPhase;
  revision: number;
  cycle: number;
  vision: string;
  requirements: RespecRequirement[];
  tasks: RespecBuildTask[];
  feedback: string[];
  history?: { cycle: number; tasks: RespecBuildTask[]; outcome: "approved" | "needs-work" | "replanned"; report: string; attemptId?: string }[];
  scopeChanges?: { revision: number; reason: string; removedIds: string[] }[];
  audit?: { attemptId: string; revision: number; requirementIds: string[]; claim: string; at: string;
    candidateRef?: string; attemptedRefs?: string[]; retryCandidateRef?: string;
    retryAttemptStarted?: boolean; retryFailureClass?: "no-verdict" | "timeout" | "transport" | "provider" };
}

/** Pure copy transitions; the host must journal the returned state before use. */
export function createRespecBuilder(vision: string): RespecBuilderState {
  return { projectId: randomUUID(), phase: "drafting", revision: 0, cycle: 0, vision: vision.trim(), requirements: [], tasks: [], feedback: [] };
}

function requirePhase(state: RespecBuilderState, phases: RespecBuilderPhase[]): void {
  if (!phases.includes(state.phase)) throw new Error(`Respec is ${state.phase}; expected ${phases.join(" or ")}.`);
}
function uniqueIds(items: { id: string }[]): void {
  if (items.some(item => !item.id.trim()) || new Set(items.map(item => item.id)).size !== items.length) throw new Error("Ids must be nonempty and unique.");
}

/** Called only after the host's scope confirmation. Never adopt agent status. */
export function adoptRespecRequirements(state: RespecBuilderState, requirements: { id: string; text: string; acceptance: string }[]): RespecBuilderState {
  requirePhase(state, ["drafting"]);
  uniqueIds(requirements);
  if (!requirements.length || requirements.some(r => !r.text.trim() || !r.acceptance.trim())) throw new Error("Each requirement needs a capability and observable acceptance criteria.");
  return { ...state, revision: state.revision + 1, phase: "planning", requirements: requirements.map(r => ({ id: r.id, text: r.text.trim(), acceptance: r.acceptance.trim(), status: "open" })), tasks: [] };
}

export function planRespecIncrement(state: RespecBuilderState, tasks: { id: string; text: string; requirementIds: string[] }[]): RespecBuilderState {
  requirePhase(state, ["planning", "replanning"]);
  uniqueIds(tasks);
  if (!tasks.length || tasks.some(t => !t.text.trim() || !t.requirementIds.length || new Set(t.requirementIds).size !== t.requirementIds.length
    || t.requirementIds.some(id => !state.requirements.some(r => r.id === id && r.status === "open")))) throw new Error("An increment needs concrete tasks addressing open requirements.");
  return { ...state, phase: "building", cycle: state.cycle + 1, tasks: tasks.map(t => ({ id: t.id, text: t.text.trim(), requirementIds: [...t.requirementIds], status: "pending" })), audit: undefined };
}

export function claimRespecTask(state: RespecBuilderState, id: string): RespecBuilderState {
  requirePhase(state, ["building"]);
  if (!state.tasks.some(t => t.id === id)) throw new Error(`Unknown task ${id}.`);
  return { ...state, tasks: state.tasks.map(t => t.id === id ? { ...t, status: "claimed" } : t) };
}

export function beginRespecAudit(state: RespecBuilderState, attemptId: string, claim: string): RespecBuilderState {
  requirePhase(state, ["building"]);
  if (!attemptId.trim() || !claim.trim() || !state.tasks.length || state.tasks.some(t => t.status !== "claimed")) throw new Error("Audit requires a concrete claim and every task in the increment claimed.");
  return { ...state, phase: "auditing", audit: { attemptId, revision: state.revision, requirementIds: [...new Set(state.tasks.flatMap(t => t.requirementIds))], claim, at: new Date().toISOString() } };
}

/** Only the detached auditor adapter supplies results. Stale attempts do nothing. */
export function settleRespecAudit(state: RespecBuilderState, attemptId: string, result: GoalAuditorResult): RespecBuilderState {
  if (state.phase !== "auditing" || state.audit?.attemptId !== attemptId || state.audit.revision !== state.revision) return state;
  const approved = result.approved && !result.disapproved && !result.impossible && !result.error && result.regressionShieldPassed !== false;
  const report = result.regressionShieldPassed === false
    ? `${result.output}\n\nIndependent verification incomplete: missing contract evidence${result.regressionShieldMissing?.length ? ` for ${result.regressionShieldMissing.join("; ")}` : ""}. The approving claim was not accepted.`
    : result.output;
  const history = result.error ? state.history : [...(state.history ?? []), { cycle: state.cycle, tasks: state.tasks, outcome: approved ? "approved" as const : "needs-work" as const, report, attemptId }].slice(-20);
  if (!approved) return { ...state, phase: result.error ? "auditing" : "replanning", audit: result.error ? state.audit : undefined,
    // The audit covers earlier capabilities as regressions too. A negative
    // verdict cannot retain them as currently verified without itemized proof.
    requirements: result.error ? state.requirements : state.requirements.map(r => r.status === "verified" ? { ...r, status: "open", evidence: undefined } : r),
    history,
    feedback: [...state.feedback, result.error ?? result.impossibleReason ?? report].slice(-5) };
  const audited = new Set(state.audit.requirementIds);
  const requirements = state.requirements.map(r => audited.has(r.id) ? { ...r, status: "verified" as const, blockedReason: undefined, blockerAction: undefined,
    evidence: { attemptId, report: result.output, model: result.model } } : r);
  return { ...state, requirements, history, phase: requirements.every(r => r.status === "verified") ? "complete" : "replanning", audit: undefined };
}

export function blockRespecRequirement(state: RespecBuilderState, id: string, reason: string, action?: RespecRequirement["blockerAction"]): RespecBuilderState {
  requirePhase(state, ["planning", "replanning", "building"]);
  if (!reason.trim() || !state.requirements.some(r => r.id === id && r.status !== "verified")) throw new Error("Blocking needs an unfinished requirement and a concrete reason.");
  return { ...state, phase: "replanning", tasks: [], history: state.tasks.length ? [...(state.history ?? []), { cycle: state.cycle, tasks: state.tasks, outcome: "replanned" as const, report: `Blocked ${id}: ${reason.trim()}` }].slice(-20) : state.history,
    requirements: state.requirements.map(r => r.id === id ? { ...r, status: "blocked", blockedReason: reason.trim(), blockerAction: action ? { owner: action.owner?.trim() || undefined, nextAction: action.nextAction?.trim() || undefined, expectedResult: action.expectedResult?.trim() || undefined } : undefined } : r) };
}

export function unblockRespecRequirement(state: RespecBuilderState, id: string, reason: string): RespecBuilderState {
  requirePhase(state, ["planning", "replanning", "building"]);
  if (!reason.trim() || !state.requirements.some(r => r.id === id && r.status === "blocked")) throw new Error("Unblocking needs a blocked requirement and evidence that its blocker cleared.");
  return { ...state, feedback: [...state.feedback, `Unblocked ${id}: ${reason.trim()}`].slice(-5), requirements: state.requirements.map(r => r.id === id ? { ...r, status: "open", blockedReason: undefined, blockerAction: undefined } : r) };
}

/** Explicit confirmed scope change; changing criteria invalidates their proof. */
export function refineRespecRequirements(state: RespecBuilderState, requirements: { id: string; text: string; acceptance: string }[], reason: string): RespecBuilderState {
  requirePhase(state, ["planning", "replanning", "building", "auditing"]);
  if (!reason.trim()) throw new Error("Scope refinement needs a reason.");
  const adopted = adoptRespecRequirements({ ...state, phase: "drafting" }, requirements);
  const next = adopted.requirements.map(r => {
    const old = state.requirements.find(prior => prior.id === r.id && prior.text === r.text && prior.acceptance === r.acceptance);
    return old ? { ...old } : r;
  });
  // All-verified scope still requires an independent whole-project audit.
  return { ...state, revision: state.revision + 1, phase: "replanning", requirements: next.map(r => r.status === "verified" ? { ...r, status: "open", evidence: undefined } : r), tasks: [], audit: undefined,
    history: state.tasks.length ? [...(state.history ?? []), { cycle: state.cycle, tasks: state.tasks, outcome: "replanned" as const, report: reason }].slice(-20) : state.history,
    scopeChanges: [...(state.scopeChanges ?? []), { revision: state.revision + 1, reason: reason.trim(), removedIds: state.requirements.filter(r => !next.some(n => n.id === r.id)).map(r => r.id) }].slice(-20) };
}

export function respecCoverage(state: RespecBuilderState): { verified: number; remaining: number; blocked: number; total: number } {
  return { verified: state.requirements.filter(r => r.status === "verified").length,
    remaining: state.requirements.filter(r => r.status !== "verified").length,
    blocked: state.requirements.filter(r => r.status === "blocked").length, total: state.requirements.length };
}
