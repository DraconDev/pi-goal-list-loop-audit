import type { Goal, Status } from "./goal-loop-core.js";

/**
 * The durable, user-facing terminal recap contract. Keep this as a small
 * string contract rather than a second verdict object: the auditor's report
 * remains independent evidence.
 */
export const COMPLETION_SUMMARY_LABELS = [
  "Outcome:",
  "Changed:",
  "Evidence:",
  "Tests:",
  "Unresolved:",
  "Next:",
] as const;

export type CompletionSummaryLabel = typeof COMPLETION_SUMMARY_LABELS[number];

export interface CompletionSummaryResolution {
  summary: string;
  usedFallback: boolean;
  reason?: "missing" | "generic" | "incomplete";
  raw?: string;
}

export interface CompletionSummaryFacts {
  goal: Goal;
  status: Status;
  stopReason?: string;
  archivePath?: string;
}

function labelIndex(text: string, label: CompletionSummaryLabel): number {
  return text.toLowerCase().indexOf(label.toLowerCase());
}

/**
 * Validation/version annotations are metadata, not recap fields. Keep them
 * out of the parser so a generated NOTE containing examples such as
 * `Outcome:` cannot turn an incomplete claim into a useful recap.
 */
function completionSummaryBody(text: string): string {
  const annotation = /\s(?:—|–|-)\s*NOTE\s*:/i.exec(text);
  return annotation?.index === undefined ? text : text.slice(0, annotation.index);
}

/** Return labels that are absent or have no value after the label. */
export function missingCompletionSummaryLabels(text: string): CompletionSummaryLabel[] {
  const normalized = completionSummaryBody(text).trim();
  return COMPLETION_SUMMARY_LABELS.filter((label) => {
    const start = labelIndex(normalized, label);
    if (start < 0) return true;
    const valueStart = start + label.length;
    const next = COMPLETION_SUMMARY_LABELS
      .map((candidate) => labelIndex(normalized.slice(valueStart), candidate))
      .filter((index) => index >= 0)
      .map((index) => valueStart + index)
      .sort((a, b) => a - b)[0];
    return normalized.slice(valueStart, next ?? normalized.length).trim().length === 0;
  });
}

export function isGenericCompletionSummary(text: string): boolean {
  return /^\s*(?:done|complete|completed|shipped|fixed|finished|all\s+done)\s*[.!]?\s*$/i.test(completionSummaryBody(text).trim());
}

/** A recap is useful only when every label has a non-empty value. */
export function isUsefulCompletionSummary(text: string | undefined): boolean {
  if (!text?.trim() || isGenericCompletionSummary(text)) return false;
  return missingCompletionSummaryLabels(text).length === 0;
}

/**
 * Project a durable six-label recap into one bounded notification line.
 * Terminal state keeps the complete multi-line text; this projection is only
 * for chat/UI/external surfaces where six short facts must remain scannable.
 * Missing labels are retained as `not recorded` so a compact notification
 * cannot accidentally imply evidence that the durable recap did not contain.
 */
/** Cut a summary value at a word boundary, never mid-word (the
 * Screenshot_20260903_204003/204005 complaint: `0 o…`, `qu…`, `belo…`).
 * Falls back to a hard cut only when the head holds no space past the
 * halfway mark — a long token such as a commit hash must not eviscerate
 * the whole value. Short values pass through untouched (no `…`). */
export function clipSummaryValue(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const capped = Number.isFinite(limit) ? Math.max(8, Math.floor(limit)) : 72;
  if (clean.length <= capped) return clean;
  const head = clean.slice(0, capped - 1);
  const space = head.lastIndexOf(" ");
  const kept = (space > capped / 2 ? head.slice(0, space) : head).trimEnd();
  return `${kept}…`;
}

export function compactCompletionSummary(text: string | undefined, maxValueLength = 72): string {
  const source = completionSummaryBody(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "not recorded";
  const lower = source.toLowerCase();
  const limit = Number.isFinite(maxValueLength) ? Math.max(8, Math.floor(maxValueLength)) : 72;
  const positions = COMPLETION_SUMMARY_LABELS
    .map((label) => ({ label, start: lower.indexOf(label.toLowerCase()) }))
    .filter((entry) => entry.start >= 0);
  const parts = COMPLETION_SUMMARY_LABELS.map((label) => {
    const current = positions.find((entry) => entry.label === label);
    const name = label.slice(0, -1);
    if (!current) return `${name}: not recorded`;
    const valueStart = current.start + label.length;
    const nextStart = positions
      .filter((entry) => entry.start > current.start)
      .map((entry) => entry.start)
      .sort((a, b) => a - b)[0] ?? source.length;
    const rawValue = source.slice(valueStart, nextStart).trim();
    const value = rawValue || "not recorded";
    return `${name}: ${clipSummaryValue(value, limit)}`;
  });
  return parts.join(" · ");
}

/** A recap value informs the human only when it is not an empty / none /
 * not-recorded placeholder. `None — <real content>` (a common agent habit)
 * keeps just the content. Returns null for filler. */
export function briefValueContent(value: string): string | null {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  // System placeholder vocabulary: the `— explanation` is still a placeholder.
  if (/^not recorded\b/i.test(clean)) return null;
  // Agent habit: `none — <real content>` hides information behind filler.
  const prefixed = /^none\s*[—–:\-]\s*(.+)$/i.exec(clean);
  const body = (prefixed?.[1] ?? clean).trim();
  if (/^(none|n\/a|nil|nothing)(\s+for\s+this\s+\w+)?\.?$/i.test(body)) return null;
  return body;
}

export interface HumanCompletionBrief {
  outcome: string;
  details: string[];
}

/** The human briefing: outcome first in its own words, then only the
 * labels that carry real content (filler like `Unresolved: none` or
 * `Changed: not recorded` is dropped, never shown). The durable archive
 * keeps the full six-label record; this is the end-of-objective voice
 * that informs the user at a glance. */
export function humanCompletionBrief(
  text: string | undefined,
  outcomeBudget = 140,
  valueBudget = 120,
): HumanCompletionBrief {
  const lines = completionSummaryLines(text, Math.max(outcomeBudget, valueBudget));
  const rawOutcome = (lines[0] ?? "").replace(/^Outcome:\s*/, "");
  const outcome = clipSummaryValue(briefValueContent(rawOutcome) ?? "done", outcomeBudget);
  const details: string[] = [];
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const content = briefValueContent(line.slice(separator + 1));
    if (content) details.push(`${line.slice(0, separator)}: ${clipSummaryValue(content, valueBudget)}`);
  }
  return { outcome, details };
}

/** v0.38.20: the agent's `Next:` recap line goes stale the moment the
 * verdict lands — reprinting it next to the approval trailer reads as
 * complete-before-verify (field 2026-09-04: `Next: detached auditor
 * verdict decides.` printed above `— auditor … approved.`). Every approval
 * surface strips it; the full six-label record stays in the archive. */
export function withoutStaleNext(details: string[] | undefined): string[] {
  return (details ?? []).filter((d) => !/^\s*Next\s*:/i.test(d));
}

/** v0.38.20: the approval chat notify — outcome first, at most two
 * informing details (the full record lives in the archive and the
 * transcript notice), then the approval trailer and the record pointer.
 * Five 120-char label lines scan as soup, not a summary (field
 * 2026-09-04); the stale Next never reaches the chat. */
export function buildApprovalChatLines(notice: {
  outcome: string;
  details: string[] | undefined;
  approval: string;
  record: string;
}): string[] {
  return [
    `✓ done — ${notice.outcome}`,
    ...withoutStaleNext(notice.details).slice(0, 2),
    notice.approval,
    notice.record,
  ];
}

/** Multi-line projection: one `Label: value` line per label with generous
 * word-bounded values. This is the user-facing `✓ done` block — six short
 * facts that stay scannable in chat. The single-line projection remains
 * for width-bound surfaces (TUI widget card, external notifies). */
export function completionSummaryLines(text: string | undefined, maxValueLength = 240): string[] {
  const source = completionSummaryBody(text ?? "").replace(/\s+/g, " ").trim();
  const lower = source.toLowerCase();
  const positions = COMPLETION_SUMMARY_LABELS
    .map((label) => ({ label, start: lower.indexOf(label.toLowerCase()) }))
    .filter((entry) => entry.start >= 0);
  return COMPLETION_SUMMARY_LABELS.map((label) => {
    const name = label.slice(0, -1);
    const current = positions.find((entry) => entry.label === label);
    if (!source || !current) return `${name}: not recorded`;
    const valueStart = current.start + label.length;
    const nextStart = positions
      .filter((entry) => entry.start > current.start)
      .map((entry) => entry.start)
      .sort((a, b) => a - b)[0] ?? source.length;
    const rawValue = source.slice(valueStart, nextStart).trim();
    return `${name}: ${clipSummaryValue(rawValue || "not recorded", maxValueLength)}`;
  });
}

function safeFact(value: unknown, fallback = "not recorded"): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || fallback;
}

function objectiveExcerpt(objective: string): string {
  const clean = safeFact(objective);
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}

function stopReasonExcerpt(reason: string | undefined): string {
  const clean = safeFact(reason);
  return clean.length > 260 ? `${clean.slice(0, 257)}…` : clean;
}

function auditEvidence(goal: Goal): string {
  const history = goal.auditHistory;
  const latest = history && history.length > 0 ? history[history.length - 1] : undefined;
  if (!latest) return "no auditor verdict was recorded";
  const verdict = latest.approved ? "approved" : latest.impossible ? "impossible" : latest.disapproved ? "disapproved" : "no verdict";
  const model = safeFact(latest.model, "unknown model");
  return `latest auditor verdict=${verdict} by ${model} at ${safeFact(latest.at)}`;
}

function executionEvidence(goal: Goal): string {
  const telemetry = goal.telemetry;
  if (!telemetry) return "no execution telemetry was recorded";
  return `${telemetry.turns} turns, ${telemetry.fileWrites} file-write signals, and ${telemetry.bashCalls} bash calls were recorded`;
}

/**
 * Build a fallback from facts already present in durable GLLA state. This
 * intentionally does not inspect the working tree or infer that a command
 * passed: absent facts are named as absent instead of being invented.
 */
export function buildRecordedFactsCompletionSummary(facts: CompletionSummaryFacts): string {
  const { goal, status, stopReason, archivePath } = facts;
  const hasFileSignals = (goal.telemetry?.fileWrites ?? 0) > 0;
  const changed = hasFileSignals
    ? `${goal.telemetry!.fileWrites} file-write signal(s) were recorded; changed paths were not captured`
    : "not recorded — no file-write signal was captured";
  const tests = goal.verificationContract
    ? "not recorded — a verification contract was present, but no terminal test result was captured"
    : "not recorded — no terminal test result was captured";
  const unresolved = stopReason
    ? `terminal reason: ${stopReasonExcerpt(stopReason)}`
    : "not recorded";
  const next = archivePath
    ? `review the durable record at ${archivePath}`
    : "review the durable archived record";

  return [
    `Outcome: Objective "${objectiveExcerpt(goal.objective)}" archived with status=${status}.`,
    `Changed: ${changed}.`,
    `Evidence: goal ${safeFact(goal.id)}; ${executionEvidence(goal)}; ${auditEvidence(goal)}.`,
    `Tests: ${tests}.`,
    `Unresolved: ${unresolved}.`,
    `Next: ${next}.`,
  ].join("\n");
}

/** Resolve a caller claim into the exact durable recap written at terminalization. */
export function resolveCompletionSummary(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
): CompletionSummaryResolution {
  const raw = candidate?.trim();
  if (raw && isUsefulCompletionSummary(raw)) {
    return { summary: raw, usedFallback: false };
  }
  const reason: CompletionSummaryResolution["reason"] = !raw
    ? "missing"
    : isGenericCompletionSummary(raw)
      ? "generic"
      : "incomplete";
  return {
    summary: buildRecordedFactsCompletionSummary(facts),
    usedFallback: true,
    reason,
    ...(raw ? { raw } : {}),
  };
}

/**
 * Resolve and compact a goal recap before the archive fence runs. Terminal
 * callers use this for notifications because archiveCurrentGoal returns only
 * success/failure so it can preserve its existing persistence contract.
 */
export function compactTerminalCompletionSummary(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
  maxValueLength = 72,
): string {
  return compactCompletionSummary(resolveCompletionSummary(facts, candidate).summary, maxValueLength);
}

/** Brief twin of compactTerminalCompletionSummary for the `✓ done` chat
 * notifies: same resolved facts, outcome + informing labels only. */
export function terminalHumanBrief(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
): HumanCompletionBrief {
  return humanCompletionBrief(resolveCompletionSummary(facts, candidate).summary);
}

/** Multi-line twin of compactTerminalCompletionSummary for the `✓ done`
 * chat notifies: same resolved facts, one `Label: value` line each. */
export function terminalCompletionSummaryLines(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
  maxValueLength = 240,
): string[] {
  return completionSummaryLines(resolveCompletionSummary(facts, candidate).summary, maxValueLength);
}

/**
 * Loop terminal states use the same six-label user-facing contract. Loop
 * state is converted to the smaller Goal-shaped fact set by the caller, so
 * this module remains independent of the loop runtime.
 */
/** Lifecycle/recovery holds are not terminal outcomes even though the loop
 * is temporarily inactive. All other explicit stop reasons receive a recap. */
export function isTerminalLoopStopReason(stopReason: string | undefined): boolean {
  if (!stopReason?.trim()) return false;
  const transient = [
    "held: restored in a fresh session",
    "extension api stale",
    "stalled: continuation refires landed no turn",
    "stalled: continuation start acknowledgement timed out",
    "send-retry storm:",
    "main model recovery",
  ];
  return !transient.some((prefix) => stopReason === prefix || stopReason.startsWith(prefix));
}

export function buildLoopCompletionSummary(facts: {
  target: string;
  stopReason: string;
  iteration: number;
  bestValue: number | null;
  historyLength: number;
}): string {
  const reason = safeFact(facts.stopReason);
  const best = facts.bestValue === null ? "not recorded" : String(facts.bestValue);
  return [
    `Outcome: Loop "${objectiveExcerpt(facts.target)}" stopped with reason: ${reason}.`,
    "Changed: not recorded — the loop does not persist a changed-file manifest in its terminal state.",
    `Evidence: ${facts.iteration} iteration(s), ${facts.historyLength} measurement record(s), best=${best}.`,
    "Tests: not recorded — no terminal test result was captured by the loop supervisor.",
    `Unresolved: ${reason}.`,
    "Next: review the loop history and resume or start a new loop when the stop reason is understood.",
  ].join("\n");
}

/** Build or reuse the loop's durable recap for a terminal notification. */
export function compactLoopCompletionSummary(loop: {
  target: string;
  stopReason?: string;
  iteration: number;
  bestValue: number | null;
  historyLength?: number;
  completionSummary?: string;
}): string {
  const summary = loop.completionSummary ?? (loop.stopReason
    ? buildLoopCompletionSummary({
      target: loop.target,
      stopReason: loop.stopReason,
      iteration: loop.iteration,
      bestValue: loop.bestValue,
      historyLength: loop.historyLength ?? 0,
    })
    : undefined);
  return compactCompletionSummary(summary);
}
