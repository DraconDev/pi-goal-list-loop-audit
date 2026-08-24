/**
 * Durable suspicious-objective recovery.
 *
 * This module only classifies persisted text and selects already-recorded
 * intent. Callers own state mutation, queueing, and UI side effects; no repair
 * path creates a model turn or asks a model to invent an objective.
 */

import type { Goal, ObjectiveRepairRecord } from "./goal-loop-core.js";

export type SuspiciousObjectiveReason =
  | "empty"
  | "archive-metadata"
  | "verification-fragment"
  | "reviewer-fragment"
  | "heading"
  | "numbered-audit-fragment"
  | "command-only"
  | "marker-only"
  | "dangling-fragment"
  | "lowercase-fragment";

export interface SuspiciousObjectiveAssessment {
  suspicious: boolean;
  reasons: SuspiciousObjectiveReason[];
  evidence: string;
}

export interface ObjectiveRepairProposal {
  objective: string;
  verificationContract?: string;
  source: string;
  reason: string;
  evidence: string;
  confidence: "best-effort";
}

// A verb that plausibly opens a real, actionable objective. The reviewer/
// verification momentum lives in the vocabulary and narrative regexes below;
// this list is the escape hatch that keeps genuine imperatives (including
// ones that mention the auditor/reviewer machinery legitimately, e.g.
// "Show the selected models … (main/auditor/drafter) on the goal card")
// from being misread as report text. Keep it broad: an objective that starts
// with any of these is actionable on its face.
const IMPERATIVE_START = /^(add|allow|audit|benchmark|build|cap|check|clarify|close|collapse|collect|compare|consolidate|create|describe|detect|diagnose|display|document|ensure|enforce|explain|expose|fix|harden|improve|implement|inspect|instrument|investigate|list|make|measure|migrate|monitor|open|optimize|overhaul|plan|preserve|prevent|print|profile|publish|read|recover|refactor|remove|render|repair|replace|research|resolve|restore|review|ship|show|simplify|strengthen|summarize|support|surface|test|trace|update|validate|verify|watch|wire|write)\b/i;
const COMMAND_ONLY = /^(?:bun|npm|pnpm|yarn|npx|node|deno|git)\s+(?:test|run|check|diff|status|show|log|exec)\b/i;
const REVIEWER_MARKER = /(?:^|[.!?;]\s+|[-*]\s+)(?:audit(?:\s+(?:report|result|findings?))?|review(?:er)?(?:\s+(?:report|result|feedback|findings?))?|verdict|evidence|output|item|required\s+fixes?|completion\s+claim)\s*:/i;
// Report vocabulary. "auditor"/"reviewer" count ONLY when tied to a verdict
// shape ("auditor approved", "reviewer finding") — a bare mention of the
// role ("(main/auditor/drafter)", "auditor workers") is legitimate task
// vocabulary and must not trip verification-fragment on its own.
const REVIEWER_VOCABULARY = /\b(?:passes\s+sequentially|zero\s+failures?|\d+\s+failures?|ran\s+\d+\s+tests?|verification\s+contract|regression\s+shield|auditor[- ]+(?:approved|report|disapproved)|reviewer[- ]+(?:approved|report|disapproved|feedback|finding)|completion\s+claim|<\/?(?:evidence|approved|disapproved|impossible)\b)\b/i;
// A report can look superficially task-like because it lists completed work
// with imperative-shaped nouns ("Added ...", "Focused tests ..."). Keep
// genuine phrases such as "Add focused tests for the audit path" valid, but
// reject report markers that start a later sentence/tail, including
// "Fix the gate. Evidence: ..." and "Review complete; Focused tests: ...".
const REVIEWER_NARRATIVE = /(?:^|[.!?;]\s+|[-*]\s+)(?:the\s+)?(?:auditor|reviewer|audit|review)(?:['’]s)?\s+(?:says?|reports?|found|finding|feedback|objection|verdict|assessment|result|is|was|has|have)\b/i;
const EVIDENCE_SUMMARY = /(?:^|[.!?;]\s+|[-*]\s+)(?:focused\s+tests?|full\s+suite|typecheck(?:\s+and\s+diff\s+checks?)?|diff\s+checks?|test\s+results?|resubmitted(?:\s+for)?)\s*:/i;
const SEMANTIC_REVIEW_FRAGMENT = /\b(?:now\s+)?i\s+(?:need|should|must)\s+(?:to\s+)?(?:verify|check|inspect|confirm)\b/i;
const DANGling_END = /\b(?:or|and|but|to|with|because|if|when|of|in|for|from)\s*$/i;

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Remove only explicit archive decoration. Never turn the valid objective
 * `Implement archive` into the incoherent objective `Implement`. */
function stripArchiveDecoration(text: string): string {
  return text
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s*\(\s*archive\s*\)\s*$/i, "")
    .replace(/\s*[_*`~]+archive[_*`~]+\s*$/i, "")
    .trim();
}

function archiveMetadata(text: string): boolean {
  return /^(?:archive|archived|\(?[_*`~]*archive[_*`~]*\)?)$/i.test(text)
    || /\b(?:archive[- ]derived|archive\s+metadata|archived\s+objective|objective\s+archive)\b/i.test(text)
    || /\(\s*archive\s*\)\s*$/i.test(text);
}

function isAuditLikeNumberedText(text: string): boolean {
  return /^\d+[.)]\s+/.test(text)
    && /\b(?:guard|evidence|revision|generation|stale|archive|repair|auditor|test|suite|required|fix|dispatch|provenance)\b/i.test(text);
}

export function assessSuspiciousObjective(objective: unknown, verificationContract?: unknown): SuspiciousObjectiveAssessment {
  const text = normalizedText(objective);
  const contract = normalizedText(verificationContract);
  const reasons: SuspiciousObjectiveReason[] = [];

  if (!text) reasons.push("empty");
  if (archiveMetadata(text)) reasons.push("archive-metadata");
  // A real imperative can legitimately mention the auditor, verification,
  // or regression machinery it is meant to repair. Treat evaluator
  // vocabulary and report-shaped labels as fragment signals only when the
  // text is not already an actionable imperative; explicit reviewer markers
  // and verdict tags remain suspicious regardless of their opening word.
  const explicitReviewerMarker = REVIEWER_MARKER.test(text) || /<\/?(?:evidence|approved|disapproved|impossible)\b/i.test(text);
  const reviewerReport = REVIEWER_NARRATIVE.test(text)
    || EVIDENCE_SUMMARY.test(text)
    || (!IMPERATIVE_START.test(text) && REVIEWER_VOCABULARY.test(text));
  if (explicitReviewerMarker || reviewerReport) reasons.push("verification-fragment");
  if (/^#{1,6}\s+\S/.test(text)) reasons.push("heading");
  if (isAuditLikeNumberedText(text)) reasons.push("numbered-audit-fragment");
  if (SEMANTIC_REVIEW_FRAGMENT.test(text)) reasons.push("reviewer-fragment");
  if (DANGling_END.test(text)) reasons.push("dangling-fragment");
  if (COMMAND_ONLY.test(text) && !contract) reasons.push("command-only");
  if (/^(?:done when|verify|objective|tasks?)\s*:??\s*$/i.test(text)) reasons.push("marker-only");
  // Lowercase prose is valid in some list items. It becomes suspicious only
  // when it also looks like evaluator prose, rather than merely because it is
  // lowercase.
  if (text && /^[a-z]/.test(text) && !IMPERATIVE_START.test(text) && /\b(?:passes|including|protections|auditor|verification)\b/i.test(text)) {
    reasons.push("lowercase-fragment");
  }

  const unique = [...new Set(reasons)];
  return {
    suspicious: unique.length > 0,
    reasons: unique,
    evidence: unique.length > 0 ? `${unique.join(", ")}: ${text.slice(0, 240)}` : "",
  };
}

function usableCandidate(text: unknown): string | null {
  const candidate = stripArchiveDecoration(normalizedText(text));
  if (!candidate || candidate.length < 8) return null;
  const assessment = assessSuspiciousObjective(candidate);
  if (assessment.suspicious) return null;
  return candidate;
}

function usableContract(text: unknown): string | undefined {
  const candidate = normalizedText(text);
  if (!candidate || candidate.length < 8) return undefined;
  // A completion report/evidence tail is durable context, not a replacement
  // contract. Do not promote it into the contract field.
  if (REVIEWER_MARKER.test(candidate) || REVIEWER_VOCABULARY.test(candidate) || /<\/?(?:evidence|approved|disapproved)\b/i.test(candidate)) return undefined;
  return candidate;
}

function seedObjective(seed: unknown): string | null {
  const raw = normalizedText(seed);
  if (!raw) return null;
  // A raw seed can carry an inline contract. Keep the intent before the
  // marker, never the contract/report tail.
  return usableCandidate(raw.split(/\b(?:done\s+when|verify)\s*:/i)[0]);
}

/**
 * v0.35.53 (note.md Now): heal legacy malformed queue items WITHOUT a repair
 * card. The v0.35.53 parser tightening stops NEW items from being written
 * with an empty objective, but items already persisted that way (field:
 * neonbreak — objective "", the entire intent inside the verification
 * contract, faulty_objective_list_activation_blocked ×42 over 22h) need a
 * deterministic heal at activation: when the objective is empty but the
 * contract carries a clean, actionable leading imperative, derive the
 * objective from the contract's first sentence. Returns null when the
 * contract is absent or itself suspicious — those stay on the true
 * broken-objective repair path.
 */
export function deriveObjectiveFromContract(contract: unknown): string | null {
  const text = normalizedText(contract);
  if (!text) return null;
  if (assessSuspiciousObjective(text).suspicious) return null;
  if (!IMPERATIVE_START.test(text)) return null;
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  // 400: long single-sentence intents are legitimate objectives (the field
  // sentence is ~253 chars); the cap only guards against pathological dumps.
  const bounded = firstSentence.slice(0, 400).trim();
  return bounded.length >= 8 ? bounded : null;
}

function repairContract(goal: Goal): { value?: string; source: string } {
  const candidates: Array<[string, unknown]> = [
    ["current contract", goal.verificationContract],
    ["original contract", goal.objectiveProvenance?.originalContract],
    ["pending verification summary", goal.pendingCompletion?.verificationSummary],
  ];
  for (const [source, value] of candidates) {
    const usable = usableContract(value);
    if (usable) return { value: usable, source };
  }
  return { source: "no coherent durable contract" };
}

function durableSources(goal: Goal): string[] {
  const sources: string[] = [];
  if (goal.objectiveProvenance?.originalObjective) sources.push("original record");
  if ((goal.objectiveProvenance?.userSeeds ?? []).length > 0) sources.push("user seed");
  if ((goal.pendingTasks ?? []).length > 0) sources.push("pending tasks");
  if ((goal.taskList?.tasks ?? []).length > 0) sources.push("task list");
  if (goal.pendingCompletion?.verificationSummary) sources.push("pending verification summary");
  if ((goal.auditHistory ?? []).length > 0) sources.push("audit history");
  if (goal.completionSummary) sources.push("completion context");
  return sources;
}

function proposalFrom(
  goal: Goal,
  assessment: SuspiciousObjectiveAssessment,
  objective: string,
  source: string,
  reason: string,
): ObjectiveRepairProposal {
  const contract = repairContract(goal);
  const sources = durableSources(goal);
  return {
    objective,
    verificationContract: contract.value,
    source,
    reason,
    evidence: `${assessment.evidence}; consulted ${sources.length > 0 ? sources.join(", ") : "no durable provenance"}${contract.source === "no coherent durable contract" ? "; no replacement contract applied" : `; contract from ${contract.source}`}`,
    confidence: "best-effort",
  };
}

function approvedCompletionContext(goal: Goal): string | null {
  const latest = goal.auditHistory?.at(-1);
  if (!latest?.approved || latest.disapproved || latest.regressionShieldPassed === false) return null;
  // A completion summary approved for an older contract is not saved intent
  // for the current objective. Legacy verdicts without a revision retain the
  // historical compatibility policy; revisioned verdicts must match exactly.
  if (latest.revision !== undefined && goal.revision !== undefined && latest.revision !== goal.revision) return null;
  return usableCandidate(goal.completionSummary);
}

function auditedRequiredFix(goal: Goal): string | null {
  for (const verdict of [...(goal.auditHistory ?? [])].reverse()) {
    if (!verdict.disapproved || !verdict.report) continue;
    const block = verdict.report.split(/##\s*required fixes\s*/i)[1];
    if (!block) continue;
    for (const line of block.split(/\r?\n/)) {
      const candidate = usableCandidate(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
      if (candidate) return candidate;
    }
  }
  return null;
}

/**
 * Choose only durable, already-recorded intent. This is intentionally not a
 * model call: event handlers must not create a turn or invent a task. The
 * original record and explicit user seed win over task/reviewer prose.
 */
export function deriveObjectiveRepair(goal: Goal, assessment: SuspiciousObjectiveAssessment): ObjectiveRepairProposal | null {
  if (!assessment.suspicious) return null;
  const current = normalizedText(goal.objective);
  const candidates: Array<[string, string | null, string]> = [];
  const provenance = goal.objectiveProvenance;
  candidates.push(["original-record", seedObjective(provenance?.originalObjective), "restored the durable original objective"]);
  for (const record of [...(goal.objectiveRepairHistory ?? [])].reverse()) {
    candidates.push(["repair-history", seedObjective(record.originalObjective), "restored the original objective from an earlier durable repair record"]);
  }
  for (const seed of provenance?.userSeeds ?? []) {
    candidates.push(["user-seed", seedObjective(seed), "restored an explicit user-supplied seed"]);
  }
  for (const task of goal.pendingTasks ?? []) {
    candidates.push(["pendingTasks", usableCandidate(task), "recovered the next durable pending task"]);
  }
  for (const task of goal.taskList?.tasks ?? []) {
    if (task.status === "complete") continue;
    candidates.push(["taskList", usableCandidate(task.title), "recovered the next incomplete durable task"]);
  }
  const normalized = stripArchiveDecoration(current);
  if (normalized !== current) {
    candidates.push(["objective-normalization", usableCandidate(normalized), "removed explicit archive decoration without inventing intent"]);
  }
  // completionSummary is not trusted merely because it is present. It is
  candidates.push(["auditHistory", auditedRequiredFix(goal), "recovered one actionable required fix from durable audit context"]);
  // eligible only when the durable audit history says that context passed.
  candidates.push(["verifiedCompletionContext", approvedCompletionContext(goal), "restored a completion context already approved by the auditor"]);

  for (const [source, candidate, reason] of candidates) {
    if (candidate && candidate !== current) return proposalFrom(goal, assessment, candidate, source, reason);
  }
  return null;
}

/** The repair item itself must be ordinary, actionable work. In particular it
 * must not echo the malformed/reviewer text or its reason codes, because that
 * would recursively trip the same gate when the repair item is activated. */
export function buildRepairTaskObjective(goal: Goal, _assessment: SuspiciousObjectiveAssessment): string {
  return `Repair the blocked ${goal.policy === "list" ? "list item" : "goal"} from saved intent`;
}

export function buildAutoRepairRecord(
  goal: Goal,
  proposal: ObjectiveRepairProposal,
  at: string,
  revisionBefore = goal.revision ?? 0,
): ObjectiveRepairRecord {
  return {
    at,
    action: "auto-applied",
    originalObjective: goal.objective,
    replacementObjective: proposal.objective,
    originalContract: goal.verificationContract,
    replacementContract: proposal.verificationContract ?? "",
    source: proposal.source,
    reason: proposal.reason,
    evidence: proposal.evidence,
    confidence: proposal.confidence,
    revisionBefore,
    revisionAfter: revisionBefore + 1,
  };
}

export function buildQueuedRepairRecord(goal: Goal, assessment: SuspiciousObjectiveAssessment, at: string): ObjectiveRepairRecord {
  const revision = goal.revision ?? 0;
  return {
    at,
    action: "queued",
    originalObjective: goal.objective,
    originalContract: goal.verificationContract,
    source: "repair-queue",
    reason: `no coherent repair from ${durableSources(goal).join(", ") || "durable provenance"}`,
    evidence: assessment.evidence,
    confidence: "fallback",
    revisionBefore: revision,
    revisionAfter: revision,
  };
}

export function appendObjectiveRepairRecord(goal: Goal, record: ObjectiveRepairRecord): void {
  goal.objectiveRepairHistory = [...(goal.objectiveRepairHistory ?? []), record].slice(-10);
}

export function hasQueuedObjectiveRepair(goal: Goal): boolean {
  return (goal.objectiveRepairHistory ?? []).some((record) =>
    record.action === "queued" && record.originalObjective === goal.objective,
  );
}

export function applyObjectiveRepair(goal: Goal, proposal: ObjectiveRepairProposal, at: string): ObjectiveRepairRecord {
  const before = goal.revision ?? 0;
  const record = buildAutoRepairRecord(goal, proposal, at, before);
  goal.objective = proposal.objective;
  // Never carry a reviewer/evidence fragment forward as a contract. A
  // coherent durable contract is applied; otherwise the repaired goal has an
  // explicitly empty contract rather than an unvalidated stale value.
  goal.verificationContract = proposal.verificationContract ?? "";
  goal.revision = before + 1;
  goal.updatedAt = at;
  appendObjectiveRepairRecord(goal, record);
  return record;
}
