import type { FindingGroup, Goal, Status } from "./goal-loop-core.js";
import { fmtElapsed, truncateCells } from "./goal-loop-display.js";

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

/**
 * Validation/version annotations are metadata, not recap fields. Keep them
 * out of the parser so a generated NOTE containing examples such as
 * `Outcome:` cannot turn an incomplete claim into a useful recap.
 */
function completionSummaryBody(text: string): string {
  const annotation = /\s(?:—|–|-)\s*NOTE\s*:/i.exec(text);
  return annotation?.index === undefined ? text : text.slice(0, annotation.index);
}

/** Return labels that are absent or have no value after the label. Segments on
 * the same last-occurrence positions as every projector (compact, multi-line,
 * rich): a label named inside an earlier value must not shift the gate away
 * from what the user will actually read. */
export function missingCompletionSummaryLabels(text: string): CompletionSummaryLabel[] {
  const normalized = completionSummaryBody(text).trim();
  const positions = labelPositions(normalized.toLowerCase());
  return COMPLETION_SUMMARY_LABELS.filter((label) => {
    const current = positions.find((entry) => entry.label === label);
    if (!current) return true;
    const valueStart = current.start + label.length;
    const next = positions
      .filter((entry) => entry.start > current.start)
      .map((entry) => entry.start)
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
/** Cut a summary value at a clause boundary, never mid-word (field
 * complaints 2026-09-03 `0 o…` and 2026-09-08 `playlist auto-add,…`:
 * a word-boundary cut that strands dangling punctuation still reads as
 * clipping, not summarizing). Prefer the last clause boundary
 * (`, ; : · — – ( [`) past a floor so the cut reads intentional; fall
 * back to the word break, then to a hard cut only when the head holds
 * no space past the halfway mark — a long token such as a commit hash
 * must not eviscerate the whole value. Trailing punctuation is stripped
 * `npm version…+ latest` cut inside a `+`-joined list). */
export function clipSummaryValue(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const capped = Number.isFinite(limit) ? Math.max(8, Math.floor(limit)) : 72;
  // v0.38.45 audit: code-point-safe — UTF-16 slice split surrogate pairs.
  const units = [...clean];
  if (units.length <= capped) return clean;
  const headUnits = units.slice(0, capped - 1);
  const head = headUnits.join("");
  const floor = Math.max(16, Math.floor((capped - 1) * 0.4));
  let boundary = -1;
  headUnits.forEach((unit, i) => {
    if (/[,;:·—–(+[\[]/u.test(unit)) boundary = i;
  });
  if (boundary >= floor) {
    const cut = headUnits.slice(0, boundary).join("").replace(/[,;:·—–(+[\[\s]+$/u, "");
    if ([...cut].length >= Math.min(floor, 16)) return `${cut}…`;
  }
  let space = -1;
  headUnits.forEach((unit, i) => {
    if (unit === " ") space = i;
  });
  const kept = (space > capped / 2 ? headUnits.slice(0, space).join("") : head)
    .trimEnd()
    .replace(/[,;:·—–(+\[]$/u, "");
  return `${kept}…`;
}

/** v0.38.45 audit: LAST-occurrence label search — first-occurrence
 * indexOf let a label named inside an earlier label's VALUE steal the
 * segmentation of every later label ("Outcome: see Tests: x. Tests: y"
 * read Outcome as "see"). The last restatement wins, which also favors
 * the final wording when an agent echoes the skeleton twice. Residual
 * ambiguity (a single skeleton whose value names a later label once)
 * is accepted: values keep their text, only the boundary moves. */
function labelPositions(lower: string): Array<{ label: string; start: number }> {
  const positions: Array<{ label: string; start: number }> = [];
  for (const label of COMPLETION_SUMMARY_LABELS) {
    const start = lower.lastIndexOf(label.toLowerCase());
    if (start < 0) continue;
    positions.push({ label, start });
  }
  return positions;
}

export function compactCompletionSummary(text: string | undefined, maxValueLength = 72): string {
  const source = completionSummaryBody(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "not recorded";
  const lower = source.toLowerCase();
  const limit = Number.isFinite(maxValueLength) ? Math.max(8, Math.floor(maxValueLength)) : 72;
  const positions = labelPositions(lower);
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

/** v0.38.39 (field 20260909_013733): absolute machine paths read as a
 * machine receipt in user chat (`Tests: … (/var/tmp/glla-….log…`). The
 * chat brief strips `/tmp/…`, `/var/tmp/…`, and `*.tgz` tokens so bullets
 * carry human-readable proof (counts, versions, repo-relative paths);
 * the durable archive keeps the full text. Falls back to the original
 * when stripping would empty the value. */
export function chatSafeDetailValue(value: string): string {
  // v0.38.45 audit: loop the innermost-group strip to a fixpoint
  // (bounded) — a single pass left nested husks like "(log )" behind.
  let withoutGroups = value;
  for (let pass = 0; pass < 5; pass++) {
    const next = withoutGroups.replace(/\([^()]*\)/g, (group) => {
    // A parenthesized group that carries nothing but stripped tokens and
    // receipt words is machine packaging — drop the whole group so no
    // `( tarball )` husk survives. Groups with real words stay verbatim.
    const inner = group
      .slice(1, -1)
      .replace(/(?:\/var)?\/tmp\/\S+/g, "")
      .replace(/\S+\.tgz\b/g, "")
      .replace(/\btarballs?\b|\blogs?\b/gi, "");
    return /[a-z]/i.test(inner) ? group : "";
    });
    if (next === withoutGroups) break;
    withoutGroups = next;
  }
  const stripped = withoutGroups
    .replace(/(?:\/var)?\/tmp\/\S+/g, "")
    .replace(/\btarballs?\s+\S+\.tgz\b/gi, "")
    .replace(/\S+\.tgz\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped || value;
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
    // v0.38.39: machine paths are archive evidence, not chat evidence —
    // strip before clipping so the budget applies to the human text.
    if (content) details.push(`${line.slice(0, separator)}: ${clipSummaryValue(chatSafeDetailValue(content), valueBudget)}`);
  }
  return { outcome, details };
}

/** v0.38.20: the agent's `Next:` recap line goes stale the moment the
 * verdict lands — reprinting it next to the approval trailer reads as
 * complete-before-verify (field 2026-09-04: `Next: detached auditor
 * verdict decides.` printed above `— auditor … approved.`).
 * v0.38.39 (field 20260909_013733): the Codex close wants at most ONE
 * concrete next action, so the filter is now selective instead of total:
 * self-referential audit/process lines (`verdict decides`, `awaiting
 * approval`, …) still drop, but the first concrete action survives as
 * the closing bullet. The full six-label record stays in the archive. */
const STALE_NEXT_PATTERN = /auditor|verdict|approv|audit|settl|review/i;
/** The recorded-facts fallback Next is concrete (`review the durable
 * record at …`) and must survive the stale-Next filter (v0.38.45 audit:
 * /review/i ate it, leaving fallback approval chats with no next action). */
const RECORDED_FACTS_NEXT_PATTERN = /review the durable/i;
export function withoutStaleNext(details: string[] | undefined): string[] {
  const kept: string[] = [];
  let actionKept = false;
  for (const detail of details ?? []) {
    if (!/^\s*Next\s*:/i.test(detail)) {
      kept.push(detail);
      continue;
    }
    if (RECORDED_FACTS_NEXT_PATTERN.test(detail)) {
      if (actionKept) continue;
      actionKept = true;
      kept.push(detail);
      continue;
    }
    if (STALE_NEXT_PATTERN.test(detail)) continue;
    if (actionKept) continue;
    actionKept = true;
    kept.push(detail);
  }
  return kept;
}

/** Rich terminal voice (field 20260911_003839/003903/003907 — the
 * Antigravity close; v0.38.50 Gemini-gap survey audit/GEMINI-SUMMARY-GAP-2026-09-11.md:
 * grouped area sections with nested findings + file:line evidence, a
 * request-echo headline, a duration line, and an automatic table once
 * findings span 4+ groups). Scope is the terminal render only (chat +
 * transcript + archive human layer); progress cards, status line, and
 * external notifies keep their compact projections. Verbose by owner
 * choice: findings cap 12, values 400, table cells 400, Next 6. */
export const RICH_FINDINGS_CAP = 12;
export const RICH_VALUE_BUDGET = 400;
export const RICH_NEXT_CAP = 6;
/** v0.38.50: objective echo clipped to a headline-safe width. */
export const RICH_OBJECTIVE_ECHO_CHARS = 80;
/** v0.38.50: findings spanning this many groups render as a table
 * (the 12-row screen-by-screen example); fewer stay nested. */
export const RICH_TABLE_GROUP_THRESHOLD = 4;
/** v0.38.50: evidence tokens per finding cell — density, not a dump. */
export const RICH_EVIDENCE_TOKENS_PER_FINDING = 4;

export interface RichTerminalParts {
  headline: string;
  durationLine: string | null;
  findingLines: string[];
  tableLines: string[];
  nextLines: string[];
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function testsRowStatus(value: string): string {
  const fail = /(\d+)\s*fail/i.exec(value);
  if (fail && Number.parseInt(fail[1]!, 10) > 0) return "FAIL";
  if (/pass/i.test(value)) return "PASS";
  return "REPORTED";
}

function auditRowStatus(history: Goal["auditHistory"]): string {
  const entries = Array.isArray(history) ? history : [];
  const last = entries[entries.length - 1];
  if (!last) return "NO VERDICT";
  if (last.approved) return `APPROVED \u00d7${entries.length}`;
  if (last.disapproved) return `DISAPPROVED \u00d7${entries.length}`;
  if (last.impossible) return "IMPOSSIBLE";
  return "NO VERDICT";
}

/** Split a stale-filtered `Label: value` detail into a bold lead + body. */
function leadBody(detail: string): { lead: string; body: string } {
  const separator = detail.indexOf(":");
  if (separator < 0) return { lead: "Note", body: detail };
  return { lead: detail.slice(0, separator).trim() || "Note", body: detail.slice(separator + 1).trim() };
}

/**
 * v0.38.50: repo-relative `path:line` evidence tokens (soundManager.ts:333,
 * sim.ts:4505-4530). Absolute paths, home-dir paths, and machine temp
 * paths are NOT evidence — those stay in the archive only. Extraction is
 * mechanical substring movement, never inference.
 */
const EVIDENCE_TOKEN_PATTERN = /(?<![/~\w])[\w.][\w./-]*\.[A-Za-z0-9]{1,5}:\d+(?:-\d+)?/g;

export function extractEvidenceTokens(text: string): { text: string; evidence: string[] } {
  const evidence: string[] = [];
  const stripped = text
    .replace(EVIDENCE_TOKEN_PATTERN, (match) => {
      if (evidence.length < RICH_EVIDENCE_TOKENS_PER_FINDING && !evidence.includes(match)) evidence.push(match);
      return "";
    })
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return { text: stripped, evidence };
}

/**
 * v0.38.50: enforce the total-findings budget across groups in order —
 * groups that go empty are dropped so the table/nesting never shows a
 * bare area header.
 */
export function takeBudgetedGroups(groups: FindingGroup[]): FindingGroup[] {
  const out: FindingGroup[] = [];
  let remaining = RICH_FINDINGS_CAP;
  for (const group of groups) {
    if (remaining <= 0) break;
    const findings = group.findings.slice(0, remaining);
    if (findings.length === 0) continue;
    out.push({ title: group.title, findings });
    remaining -= findings.length;
  }
  return out;
}

/**
 * v0.38.50: one compact duration line from durable goal state — turns,
 * wall-clock elapsed since creation, and audit count. Only known facts
 * render (absent stays absent); null when nothing is known.
 */
export function buildDurationLine(goal: Goal, now = Date.now()): string | null {
  const segs: string[] = [];
  const turns = goal.telemetry?.turns;
  if (typeof turns === "number" && Number.isFinite(turns) && turns >= 0) {
    segs.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  }
  const started = Date.parse(goal.createdAt ?? "");
  if (Number.isFinite(started)) segs.push(`${fmtElapsed(now - started)} elapsed`);
  const audits = Array.isArray(goal.auditHistory) ? goal.auditHistory.length : 0;
  if (audits > 0) segs.push(`${audits} audit${audits === 1 ? "" : "s"}`);
  return segs.length > 0 ? `\u2014 ${segs.join(" \u00b7 ")}` : null;
}

/** Partition informing details into findings / Tests / next buckets. */
export function partitionRichDetails(details: string[]): { findings: string[]; tests: string[]; next: string[] } {
  const findings: string[] = [];
  const tests: string[] = [];
  const next: string[] = [];
  for (const detail of details) {
    if (/^\s*Tests\s*:/i.test(detail)) tests.push(detail);
    else if (/^\s*(Next|Unresolved|Left out)\s*:/i.test(detail)) next.push(detail);
    else findings.push(detail);
  }
  return { findings, tests, next };
}

/**
 * v0.38.50: request-echo headline — the title mirrors the ask (the
 * Gemini shape) with the outcome second. Without an objective the legacy
 * `## Done — outcome` shape stays, so direct unit callers are unaffected.
 */
export function requestEchoHeadline(kind: "Done" | "Aborted", objective: string | undefined, outcome: string): string {
  const echo = objective?.trim() ? clipSummaryValue(objective.trim(), RICH_OBJECTIVE_ECHO_CHARS) : null;
  return echo ? `## ${kind}: ${echo} \u2014 ${outcome}` : `## ${kind} \u2014 ${outcome}`;
}

/** Build the section parts shared by chat, transcript, and archive.
 * v0.38.50: agent-structured groups render as `#### n. Area` subsections
 * with nested evidence bullets; at RICH_TABLE_GROUP_THRESHOLD groups the
 * same facts render as an Area | Finding | Evidence table instead.
 * Without groups the flat six-label projection stays the fallback. */
export function buildRichTerminalParts(args: {
  outcome: string;
  details: string[];
  countsLine: string;
  auditHistory?: Goal["auditHistory"];
  objective?: string;
  durationLine?: string | null;
  groups?: FindingGroup[];
}): RichTerminalParts {
  const { findings, tests, next } = partitionRichDetails(args.details);
  const headline = requestEchoHeadline("Done", args.objective, args.outcome);
  const budgeted = takeBudgetedGroups(args.groups ?? []);
  const useTable = budgeted.length >= RICH_TABLE_GROUP_THRESHOLD;
  const findingLines: string[] = [];
  if (useTable) {
    findingLines.push("| Area | Finding | Evidence |", "| --- | --- | --- |");
    for (const group of budgeted) {
      for (const finding of group.findings) {
        const { text, evidence } = extractEvidenceTokens(finding);
        const { lead, body } = leadBody(text);
        findingLines.push(
          `| ${escapeTableCell(clipSummaryValue(group.title, RICH_OBJECTIVE_ECHO_CHARS))} | ${escapeTableCell(`**${lead}** \u2014 ${clipSummaryValue(body, RICH_VALUE_BUDGET)}`)} | ${escapeTableCell(evidence.join(", ") || "\u2014")} |`,
        );
      }
    }
  } else if (budgeted.length > 0) {
    budgeted.forEach((group, i) => {
      findingLines.push(`#### ${i + 1}. ${clipSummaryValue(group.title, RICH_OBJECTIVE_ECHO_CHARS)}`);
      for (const finding of group.findings) {
        const { lead, body } = leadBody(finding);
        findingLines.push(`- **${lead}** \u2014 ${clipSummaryValue(body, RICH_VALUE_BUDGET)}`);
      }
    });
  } else {
    findings.slice(0, RICH_FINDINGS_CAP).forEach((detail, i) => {
      const { lead, body } = leadBody(detail);
      findingLines.push(`${i + 1}. **${lead}** \u2014 ${clipSummaryValue(body, RICH_VALUE_BUDGET)}`);
    });
  }
  const tableRows: string[] = [];
  for (const detail of tests.slice(0, 2)) {
    const { body } = leadBody(detail);
    tableRows.push(`| Tests | ${testsRowStatus(body)} | ${escapeTableCell(clipSummaryValue(body, RICH_VALUE_BUDGET))} |`);
  }
  const auditStatus = auditRowStatus(args.auditHistory);
  if (auditStatus !== "NO VERDICT") {
    const auditBody = args.countsLine.replace(/^\u2014\s*/, "").replace(/\.\s*$/, "");
    tableRows.push(`| Audit | ${auditStatus} | ${escapeTableCell(clipSummaryValue(auditBody, RICH_VALUE_BUDGET))} |`);
  }
  const tableLines = tableRows.length > 0
    ? ["| Check | Status | Details |", "| --- | --- | --- |", ...tableRows]
    : [];
  const nextLines = next.slice(0, RICH_NEXT_CAP).map((detail) => {
    const { lead, body } = leadBody(detail);
    return `- **${lead}** \u2014 ${clipSummaryValue(body, RICH_VALUE_BUDGET)}`;
  });
  return {
    headline,
    durationLine: args.durationLine ?? null,
    findingLines,
    tableLines,
    nextLines,
  };
}

/** Compose parts + headline + section headers into markdown lines.
 * v0.38.50: the duration line rides directly under the headline. */
export function composeRichTerminalLines(parts: RichTerminalParts, opts?: { headline?: string }): string[] {
  const lines = [opts?.headline ?? parts.headline, ""];
  if (parts.durationLine) lines.push(parts.durationLine, "");
  if (parts.findingLines.length > 0) {
    lines.push("### Key Findings & Remediation", ...parts.findingLines, "");
  }
  if (parts.tableLines.length > 0) {
    lines.push("### Verification Summary", ...parts.tableLines, "");
  }
  if (parts.nextLines.length > 0) {
    lines.push("### Next", ...parts.nextLines, "");
  }
  return lines;
}

/** Rich human layer for the durable archive (owner: the archive IS for
 * humans). Same sections as chat, composed from durable goal state — the
 * raw six-label recap stays verbatim in `## Completion summary` as the
 * machine layer. Headline follows terminal status; aborted records never
 * wear a `Done` headline. */
export function buildRichArchiveSection(goal: Goal, status: Status, archivePath: string, findingGroups?: FindingGroup[]): string[] {
  const facts: CompletionSummaryFacts = { goal, status, archivePath };
  const summary = resolveCompletionSummary(facts, goal.completionSummary).summary;
  const brief = humanCompletionBrief(summary, 140, RICH_VALUE_BUDGET);
  const history = goal.auditHistory ?? [];
  const latest = history[history.length - 1];
  const approval = latest
    ? `\u2014 auditor ${latest.approved ? "approved" : latest.disapproved ? "disapproved" : latest.impossible ? "impossible" : "left no verdict"}.`
    : "\u2014 completed without a recorded auditor verdict.";
  const countsLine = buildAuditCountsLine(goal);
  const parts = buildRichTerminalParts({
    outcome: brief.outcome,
    details: withoutStaleNext(brief.details),
    countsLine,
    auditHistory: history,
    objective: goal.objective,
    durationLine: buildDurationLine(goal),
    groups: findingGroups,
  });
  return [
    ...composeRichTerminalLines(parts, {
      headline: status === "complete" ? parts.headline : requestEchoHeadline("Aborted", goal.objective, brief.outcome),
    }),
    trailerBullet(stripApprovalModel(approval)),
    trailerBullet(countsLine),
    trailerBullet(`\u2014 record: ${archivePath}`),
  ];
}

/** v0.38.20: the approval chat notify — outcome first, all bounded
 * informing details (the full record lives in the archive and the
 * transcript notice), then the approval trailer and the record pointer.
 * Five 120-char label lines scan as soup, not a summary (field
 * 2026-09-04); the stale Next never reaches the chat.
 * v0.38.25: optional `counts` audit-goal counts line rides between the
 * approval trailer and the record pointer (the pointer stays last).
 * v0.38.42: retained for backward compatibility + direct unit tests —
 * buildTerminalApprovalRender constructs chat lines inline because the
 * fold changes trailer arity, which this fixed-shape helper cannot express. */
export function buildApprovalChatLines(notice: {
  outcome: string;
  details: string[] | undefined;
  approval: string;
  record: string;
  counts?: string;
}): string[] {
  return [
    `✓ done — ${notice.outcome}`,
    // v0.38.37 (audit 2026-09-08): one verifiable-result bullet per
    // informing detail — the Codex closing shape.
    // v0.38.39: the approval/counts/record trailer rides as bullets too
    // (field 20260909_013733 — the `—` tail read as a second voice); the
    // record pointer stays last.
    ...withoutStaleNext(notice.details).map((detail) => `• ${detail}`),
    trailerBullet(notice.approval),
    ...(notice.counts ? [trailerBullet(notice.counts)] : []),
    trailerBullet(notice.record),
  ];
}

/** v0.38.39 (field 20260909_013733): the trailer rides as bullets too —
 * the Codex close is uniform `•` lines (`• Changed:` … `• record:`),
 * never a `•` block followed by dangling `—` lines. The `— ` sigil is
 * stripped at render; the input strings keep it for non-chat surfaces.
 * v0.38.42 (field 20260909_140404): the chat/transcript approval bullet
 * carries no model ID — the `provider/model` slug is machine trivia
 * outside an audit (the full model ID stays in the archive record).
 * The `auditor <model> approved` shape collapses to `auditor approved`;
 * any other approval voice passes through untouched. */
function stripApprovalModel(line: string): string {
  return line.replace(/auditor\s+\S+\s+approved/, "auditor approved");
}
function trailerBullet(line: string): string {
  return `• ${line.replace(/^—\s*/, "")}`;
}

/** v0.38.25: the audit-goal counts line — verdict proof ONLY, built from
 * durable goal state. Raw run stats (turns/file-writes/bash calls) read as
 * a machine receipt in user chat (field 2026-09-08 223522/223523); the
 * full execution evidence stays in the six-label archive record. Absent
 * facts are named as absent, never invented (recorded-facts honesty). */
export function buildAuditCountsLine(goal: Goal, auditNote?: string): string {
  const history = goal.auditHistory ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : undefined;
  const audit = auditNote ?? (latest === undefined
    ? "no auditor verdict was recorded"
    : (() => {
      const verdict = latest.approved ? "approved" : latest.impossible ? "impossible" : latest.disapproved ? "disapproved" : "no verdict";
      return `auditor ${verdict} (${history.length} verdict${history.length === 1 ? "" : "s"})`;
    })());
  return `— audit: ${audit}.`;
}

export interface TerminalApprovalRenderInput {
  goal: Goal;
  status: Status;
  stopReason?: string;
  archivePath?: string;
  completionSummary?: string;
  /** Path-specific voice, e.g. `— auditor X approved …` or `— completed without audit (your choice).` */
  approval: string;
  /** Path-specific record pointer, e.g. `— record: <path>`. */
  record: string;
  /** Extra trailing lines (inspection-session pointer, …). */
  extras?: string[];
  /** Override for the counts line (e.g. the no-audit path). */
  countsLine?: string;
  /** Override for the audit half of the counts line. */
  auditNote?: string;
  /** v0.38.37: what the agent deliberately left out (complete_goal leftOut). */
  leftOut?: string;
  /**
   * v0.38.50: agent-structured finding groups (complete_goal findingGroups,
   * sanitized at claim time). Absent keeps the flat six-label fallback.
   */
  findingGroups?: FindingGroup[];
}

export interface TerminalApprovalRender {
  /** The human-sees chat lines: outcome + bounded details + approval + counts + record (+ extras). */
  chatLines: string[];
  /** Compact single line for external notifies (pager/sound safe). */
  recap: string;
  /** Transcript-notice details: informing details (stale Next stripped) + approval. */
  transcriptLines: string[];
  /** The counts line riding the render. */
  countsLine: string;
  /** Brief outcome (chat line 1 without the `✓ done — ` prefix). */
  outcome: string;
  /** Approval trailer line (shared by chat + transcript surfaces). */
  approval: string;
}

/** v0.38.25: ONE canonical builder for every terminal approval surface —
 * chat notify, transcript notice, external notify, and the persisted
 * archive render. All approval paths (detached auditor, manual verify,
 * Esc-without-audit) build the same voice from the same resolved facts so
 * the surfaces cannot drift and a render can be persisted + replayed. */
export function buildTerminalApprovalRender(input: TerminalApprovalRenderInput): TerminalApprovalRender {
  const facts: CompletionSummaryFacts = {
    goal: input.goal,
    status: input.status,
    stopReason: input.stopReason,
    archivePath: input.archivePath,
  };
  const candidate = input.completionSummary ?? input.goal.completionSummary;
  const recap = compactTerminalCompletionSummary(facts, candidate);
  // Rich voice (field 20260911_*): the chat/transcript render uses a
  // verbose brief (200-char values) while the outcome headline keeps
  // the 140-char budget. Filler drops via the same briefValueContent
  // filter; absent stays absent.
  const richBrief = humanCompletionBrief(
    resolveCompletionSummary(facts, candidate).summary,
    140,
    RICH_VALUE_BUDGET,
  );
  // v0.38.37 (audit 2026-09-08): the deliberate non-do comes from the
  // agent's complete_goal leftOut claim — never invented. Filler ("none")
  // drops via the same briefValueContent filter; absent stays absent.
  const leftOut = input.leftOut?.trim();
  const leftOutContent = leftOut ? briefValueContent(leftOut) : null;
  const richDetails = leftOutContent
    ? [...richBrief.details, `Left out: ${clipSummaryValue(leftOutContent, RICH_VALUE_BUDGET)}`]
    : richBrief.details;
  const countsLine = input.countsLine ?? buildAuditCountsLine(input.goal, input.auditNote);
  // v0.38.42 (field 20260909_140404): one canonical approval bullet in
  // chat and transcript — no model ID in either, via-retry news kept. A
  // lone approval says the same thing as the counts line, so they fold
  // into one bullet carrying the verdict count; the standalone audit
  // bullet survives only with news (multiple, disapproved, or impossible
  // verdicts). The returned `approval` field keeps the full input string
  // for archive/persist consumers — the model ID leaves chat/transcript,
  // never the record.
  const history = input.goal.auditHistory ?? [];
  const chatApproval = stripApprovalModel(input.approval);
  const foldCounts = history.length === 1
    && history[0]?.approved === true
    && /approved/.test(chatApproval);
  const approvalBullet = foldCounts
    ? `• ${chatApproval.replace(/^—\s*/, "").replace(/\.\s*$/, "")} (${history.length} verdict).`
    : trailerBullet(chatApproval);
  const recordBullet = trailerBullet(input.record);
  // Rich voice: headline + Key Findings + Verification table + Next,
  // closed by the pinned trailer (approval/counts/record, record last).
  // The transcript mirrors chat without the record pointer and extras —
  // the record lives in chat and the archive, matching the old contract.
  const richParts = buildRichTerminalParts({
    outcome: richBrief.outcome,
    details: withoutStaleNext(richDetails),
    countsLine,
    auditHistory: input.goal.auditHistory,
    objective: input.goal.objective,
    durationLine: buildDurationLine(input.goal),
    groups: input.findingGroups,
  });
  const chatBody = composeRichTerminalLines(richParts);
  const transcriptBody = composeRichTerminalLines(richParts);
  return {
    chatLines: [
      ...chatBody,
      approvalBullet,
      ...(foldCounts ? [] : [trailerBullet(countsLine)]),
      recordBullet,
      ...(input.extras ?? []),
    ],
    recap,
    transcriptLines: [...transcriptBody, approvalBullet],
    countsLine,
    outcome: richBrief.outcome,
    approval: input.approval,
  };
}

/** Multi-line projection: one `Label: value` line per label with generous
 * word-bounded values. This is the user-facing `✓ done` block — six short
 * facts that stay scannable in chat. The single-line projection remains
 * for width-bound surfaces (TUI widget card, external notifies). */
export function completionSummaryLines(text: string | undefined, maxValueLength = 240, lineWidth?: number): string[] {
  const source = completionSummaryBody(text ?? "").replace(/\s+/g, " ").trim();
  const lower = source.toLowerCase();
  const positions = labelPositions(lower);
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
    const line = `${name}: ${clipSummaryValue(rawValue || "not recorded", maxValueLength)}`;
    // Audit 2026-09-06: optional width budget for width-bound surfaces —
    // the default 240-char values previously had no width-conscious path.
    // v0.38.30 audit: plain-text surface — use the ANSI-free truncator
    // (pi-tui truncateToWidth wraps the ellipsis in resets even for plain
    // text, polluting notify/log/pager consumers).
    return lineWidth && lineWidth > 0 ? truncateCells(line, lineWidth) : line;
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
  lineWidth?: number,
): string[] {
  return completionSummaryLines(resolveCompletionSummary(facts, candidate).summary, maxValueLength, lineWidth);
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
