import type { GoalAuditorResult } from "./goal-loop-auditor.js";

export type RespecBuilderPhase = "drafting" | "planning" | "building" | "auditing" | "replanning" | "complete";
export interface RespecRequirement {
  id: string;
  text: string;
  acceptance: string;
  status: "open" | "blocked" | "verified";
  blockedReason?: string;
  evidence?: { attemptId: string; report: string; model: string };
}
export interface RespecBuildTask {
  id: string;
  text: string;
  requirementIds: string[];
  status: "pending" | "claimed";
}
export interface RespecBuilderState {
  phase: RespecBuilderPhase;
  revision: number;
  cycle: number;
  vision: string;
  requirements: RespecRequirement[];
  tasks: RespecBuildTask[];
  feedback: string[];
  audit?: { attemptId: string; revision: number; requirementIds: string[]; claim: string; at: string };
}

/** Pure copy transitions; the host must journal the returned state before use. */
export function createRespecBuilder(vision: string): RespecBuilderState {
  return { phase: "drafting", revision: 0, cycle: 0, vision: vision.trim(), requirements: [], tasks: [], feedback: [] };
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
  if (!approved) return { ...state, phase: result.error ? "auditing" : "replanning", audit: result.error ? state.audit : undefined,
    feedback: [...state.feedback, result.error ?? result.impossibleReason ?? result.output].slice(-5) };
  const audited = new Set(state.audit.requirementIds);
  const requirements = state.requirements.map(r => audited.has(r.id) ? { ...r, status: "verified" as const, blockedReason: undefined,
    evidence: { attemptId, report: result.output, model: result.model } } : r);
  return { ...state, requirements, phase: requirements.every(r => r.status === "verified") ? "complete" : "replanning", audit: undefined };
}

export function blockRespecRequirement(state: RespecBuilderState, id: string, reason: string): RespecBuilderState {
  requirePhase(state, ["planning", "replanning"]);
  if (!reason.trim() || !state.requirements.some(r => r.id === id && r.status !== "verified")) throw new Error("Blocking needs an unfinished requirement and a concrete reason.");
  return { ...state, requirements: state.requirements.map(r => r.id === id ? { ...r, status: "blocked", blockedReason: reason.trim() } : r) };
}

export function respecCoverage(state: RespecBuilderState): { verified: number; remaining: number; blocked: number; total: number } {
  return { verified: state.requirements.filter(r => r.status === "verified").length,
    remaining: state.requirements.filter(r => r.status !== "verified").length,
    blocked: state.requirements.filter(r => r.status === "blocked").length, total: state.requirements.length };
}
