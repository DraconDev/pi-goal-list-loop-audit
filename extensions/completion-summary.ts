import { execFileSync } from "node:child_process";
import { sanitizeDisplayText, type FindingGroup, type GateRow, type Goal, type Status } from "./goal-loop-core.js";
import { fmtElapsed, truncateCells } from "./goal-loop-display.js";
import { normalizeFindingLead, clipSummaryValue } from "./finding-lead.js";
import { CARD_SECTION, LEGACY_CARD_SECTIONS } from "./card-sections.js";
export { clipSummaryValue };

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
 * Project a durable recap into one bounded notification line. Terminal
 * state keeps the complete multi-line text; this human projection omits
 * Tests by default and remains scannable. Missing human labels are retained
 * as `not recorded` so a compact notification cannot imply evidence that the
 * durable recap did not contain.
 */
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

/** Compact human recap. Tests/verification detail is omitted by default;
 * archive and evidence-focused callers pass `includeTests=true`. */
export function compactCompletionSummary(text: string | undefined, maxValueLength = 72, includeTests = false): string {
  const source = completionSummaryBody(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "not recorded";
  const lower = source.toLowerCase();
  const limit = Number.isFinite(maxValueLength) ? Math.max(8, Math.floor(maxValueLength)) : 72;
  const positions = labelPositions(lower);
  const labels = includeTests ? COMPLETION_SUMMARY_LABELS : COMPLETION_SUMMARY_LABELS.filter((label) => label !== "Tests:");
  const parts = labels.map((label) => {
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
    // D7: recap projections sanitize like every other human surface.
    return `${name}: ${clipSummaryValue(sanitizeDisplayText(value), limit)}`;
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
  const safeValue = sanitizeDisplayText(value);
  // v0.38.45 audit: loop the innermost-group strip to a fixpoint
  // (bounded) — a single pass left nested husks like "(log )" behind.
  let withoutGroups = stripMachineGroups(safeValue);
  const stripped = withoutGroups
    .replace(/(?:\/var)?\/tmp\/\S+/g, "")
    .replace(/\btarballs?\s+\S+\.tgz\b/gi, "")
    .replace(/(?<!\S)\S+\.tgz\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped || safeValue;
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
  // Retained for API compatibility. Historical claims belong in the
  // forensic archive, never in the latest approved human projection.
  _priorWholeWork?: string,
  includeTests = false,
): HumanCompletionBrief {
  const lines = completionSummaryLines(text, Math.max(outcomeBudget, valueBudget), undefined, includeTests);
  const rawOutcome = (lines[0] ?? "").replace(/^Outcome:\s*/, "");
  // A corrected claim replaces its rejected predecessor. Merging the
  // first claim here would restore stale counts and duplicate details.
  const outcomeSource = rawOutcome;
  // 2026-09-16 field shots: the headline echo must summarize the ask, not
  // flatten section-structured Outcome markdown into one clipped line. The
  // lead paragraph (text before the first section header) is the human
  // summary; headers ride only in the ### Summary section.
  const structured = structuredSummaryLines(text);
  const lead = structured
    ? (structured.join("\n").split(/\n(?=#{2,4}\s)/)[0] ?? "")
      .split("\n")
      .filter((l) => l.trim() && !/^#{1,4}\s/.test(l.trim()))
      .join(" ")
    : "";
  // D8: no invented "done" — an empty outcome says so honestly.
  const outcome = clipSummaryValue(briefValueContent(lead || outcomeSource) ?? "(outcome not recorded)", outcomeBudget);
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
/** D5: self-reference is a process noun NEAR a process-state verb, not a
 * bare keyword. The old /auditor|verdict|approv|audit|settl|review/i ate
 * concrete work ("Next: review pending PRs", "Next: audit the remaining
 * fixtures", "Next: settle the API contract"). A state verb LEADING
 * ("awaiting approval") is always a status report; a noun leading only
 * drops when a state verb follows within the window ("verdict decides").
 * Bare "review …" leads survive — reviewing things is real work. */
const STALE_NEXT_LEAD_VERB = /\b(await(?:ing)?|waiting for|pending|forthcoming|underway|in progress).{0,24}(auditor|verdict|approval|audit|settlement|review)/i;
const STALE_NEXT_LEAD_NOUN = /(auditor|verdict|approval|audit|settlement).{0,24}(decides?|pending|awaiting|forthcoming|underway|in progress)/i;
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
    if (STALE_NEXT_LEAD_VERB.test(detail) || STALE_NEXT_LEAD_NOUN.test(detail)) continue;
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
 * external notifies keep their compact projections.
 * v0.38.55 (full parity): findings, values, and Next render uncapped —
 * the only remaining render-side bounds are the headline echo (80), the
 * evidence-token density (4/finding), and the sanitize trust boundary
 * (12 groups x 20 findings, 10 gate rows); the brief value guard is 10k
 * chars against pathological megabytes. */
export const RICH_FULL_VALUE_BUDGET = 10_000;
/** v0.38.50: objective echo clipped to a headline-safe width. */
export const RICH_OBJECTIVE_ECHO_CHARS = 80;
/** v0.38.50: findings spanning this many groups render as a table
 * (the 12-row screen-by-screen example); fewer stay nested. */
export const RICH_TABLE_GROUP_THRESHOLD = 4;
/** v0.38.50: evidence tokens per finding cell — density, not a dump. */
export const RICH_EVIDENCE_TOKENS_PER_FINDING = 4;
/** Structured-long doctrine (field 2026-09-16 — the keyword-review close):
 * a section-structured label value is a working document, not a status
 * ping, and truncating it destroys its purpose. Structure is the price
 * of length: at least this many `##`–`####` section headers keeps the
 * value on the structured path; anything else keeps today's budgets.
 * Delivery-only: the terminal card and the archive human layer. Recycled
 * per-tick payloads (continuation, handoff, checkpoint) stay bounded. */
export const RICH_STRUCTURED_MIN_HEADERS = 2;
/** Structured-long guard against pathological megabytes: the tool call
 * carries no length bound, so the structured path still ends — with an
 * honest truncation note pointing at the archive, never silent soup. */
export const RICH_STRUCTURED_VALUE_BUDGET = 100_000;

/** Count markdown section headers (`##`–`####` with text) in raw text.
 * H1 (`# `) is a document title, not a section — it does not count. */
export function countSectionHeaders(text: string): number {
  const matches = (text ?? "").match(/^#{2,4}\s+\S/gm);
  return matches ? matches.length : 0;
}

export function isSectionStructured(text: string): boolean {
  return countSectionHeaders(text) >= RICH_STRUCTURED_MIN_HEADERS;
}

const STRUCTURED_LABELS = ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"];

/** Raw (newline-preserving) label value for the structured path. Labels
 * anchor to line starts and the last restatement wins — the same
 * doctrine as labelPositions on the flattened path (v0.38.45). Residual
 * ambiguity (a structured doc quoting `Changed:` at a line start) cuts
 * the value early and the detector usually falls back to clipped
 * rendering — doubt resolves to today's behavior, never to invention. */
export function rawLabelValue(text: string, label: string): string | null {
  const source = text ?? "";
  if (!source) return null;
  const openings: number[] = [];
  const openPattern = new RegExp(`^${label}`, "gim");
  for (const match of source.matchAll(openPattern)) openings.push(match.index ?? 0);
  if (openings.length === 0) return null;
  const start = openings[openings.length - 1]! + label.length;
  const restPattern = new RegExp(`^(${STRUCTURED_LABELS.filter((entry) => entry !== label).join("|")})`, "gim");
  restPattern.lastIndex = start;
  const next = restPattern.exec(source);
  const end = next ? (next.index ?? source.length) : source.length;
  const value = source.slice(start, end).trim();
  return value || null;
}

/** Drop parenthesized groups whose content is nothing but machine
 * packaging (paths, tarballs, log words) after inner stripping. Groups
 * with real words stay verbatim. Bounded to a fixpoint so nested husks
 * like "(log )" cannot survive. Shared by chat and structured strips. */
function stripMachineGroups(value: string): string {
  let out = value;
  for (let pass = 0; pass < 5; pass++) {
    const next = out.replace(/\([^()]*\)/g, (group) => {
      const inner = group
        .slice(1, -1)
        .replace(/(?:\/var)?\/tmp\/\S+/g, "")
        .replace(/(?<!\S)\S+\.tgz\b/g, "")
        .replace(/\btarballs?\b|\blogs?\b/gi, "");
      return /\w/.test(inner) ? group : "";
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Machine-token strip for structured lines. chatSafeDetailValue also
 * collapses multi-space runs, which would damage markdown table
 * alignment padding — structured lines keep their spacing and drop
 * only the archive-only tokens. */
function stripMachineTokens(line: string): string {
  return stripMachineGroups(line)
    .replace(/(?:\/var)?\/tmp\/\S+/g, "")
    // Attempt a greedy token match only at its start, not at every byte
    // of a long nonmatching token (quadratic on pathological summaries).
    .replace(/(?<!\S)\S+\.tgz\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+$/u, "");
}

/** Section vocabulary for the report card (field 2026-11-11 — "more like
 * opencode's end-of-task summary"). Re-exported from the leaf module
 * ./card-sections.js so the composer, the collapsed chat receipt and the
 * terminal renderer cannot drift apart without adding an import cycle. */
export { CARD_SECTION, LEGACY_CARD_SECTIONS } from "./card-sections.js";

/** Full Outcome body for the `### Summary` card section, or null when
 * the value is not section-structured (caller keeps today's budgets).
 * Newlines and tables survive; machine paths stay archive-only; the
 * pathological guard ends with an honest pointer, never silent soup. */
export function structuredSummaryLines(summary: string | undefined, label = "Outcome:"): string[] | null {
  const raw = rawLabelValue(summary ?? "", label);
  if (!raw || !isSectionStructured(raw)) return null;
  const lines = raw.split("\n").map((line) => stripMachineTokens(sanitizeDisplayText(line)));
  while (lines.length > 0 && !(lines[0] ?? "").trim()) lines.shift();
  while (lines.length > 0 && !(lines[lines.length - 1] ?? "").trim()) lines.pop();
  let text = lines.join("\n");
  const units = [...text];
  if (units.length > RICH_STRUCTURED_VALUE_BUDGET) {
    text = `${units.slice(0, RICH_STRUCTURED_VALUE_BUDGET).join("")}\n\n… (truncated for chat — full text in the archived record.)`;
  }
  return text.split("\n");
}

export interface RichTerminalParts {
  /** v0.38.55 (full parity): verdict banner — `## Done — auditor
   * approved (N verdicts)` and siblings. Never null on the terminal
   * path; the headline still echoes the request underneath. */
  banner: string | null;
  headline: string;
  durationLine: string | null;
  findingLines: string[];
  tableLines: string[];
  nextLines: string[];
  /** Human-facing unresolved/left-out concerns. Unlike the technical gate
   * inventory, these explain what the delivered change does not settle. */
  remainingLines: string[];
  /** Compact chat-only verification tail, shown only when explicitly
   * requested. The archive always keeps the full table. */
  verificationSummaryLine: string | undefined;
  /** True for the compact chat projection (false/absent retains the detailed
   * archive headings/tables). */
  chat?: boolean;
  /** v0.38.55 (full parity): final repository state section lines.
   * Empty when the state could not be read (absent stays absent). */
  repoLines: string[];
  /** Structured-long body (field 2026-09-16): full Outcome text with
   * newlines preserved, rendered as `### Summary`. Empty unless the
   * value earned the structured path — never a second copy of the
   * clipped headline echo. */
  summaryLines: string[];
  /** Field 2026-11-11: the prose lede under the short headline — the whole
   * outcome sentence when the headline had to shorten it. Empty when the
   * headline already carries the sentence. */
  ledeLines: string[];
}

function escapeTableCell(value: string): string {
  return sanitizeDisplayText(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function testsRowStatus(value: string): string {
  // Failure evidence anywhere wins, including a failed run followed by a
  // successful rerun. Notes themselves remain verbatim in both projections.
  const failures = value.matchAll(/\b(\d+)\s+(?:fail(?:ed|ures?|s)?|errors?)\b/gi);
  if ([...failures].some(match => Number(match[1]) > 0)) return "FAIL";
  const exits = value.matchAll(/\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s+(-?\d+)\b/gi);
  if ([...exits].some(match => Number(match[1]) !== 0)) return "FAIL";

  // PASS is a complete-parse result, not a keyword inference. Parse only
  // recognized result statements; every unknown clause downgrades the whole
  // row to REPORTED, regardless of positive counts elsewhere. This also
  // handles unfamiliar limitation wording without a growing negation list.
  // A bare absolute log citation is evidence metadata, not result prose.
  // Strip only that exact shape before splitting separators (paths use '/').
  const statement = value.replace(/\s+\(\/(?:[\w.-]+\/)*[\w.-]+\.log\)/g, "").trim();
  const clauses = statement.split(/\s*[;,/\n]\s*|[.!]\s+/);
  let hasSuccess = false;
  for (const clause of clauses) {
    let text = clause.trim().replace(/[.!]$/, "");
    // Bounded compatibility syntax for existing result labels/runners. Do not
    // discard arbitrary colon prefixes, parentheses or trailing explanation.
    text = text.replace(/^(?:(?:unit|integration|password)\s+(?:tests|checks)|integration):\s*/i, "");
    text = text.replace(/^(?:(?:bun|npm) (?:run )?test|full gate)\s+(?:[—–-]\s*)?/i, "");
    const count = /^(\d+)\s+(?:(?:tests|files)\s+)?(pass(?:ed)?|fail(?:ed|ures?|s)?|errors?|skip(?:ped|s)?)$/i.exec(text);
    if (count) {
      if (/^pass/i.test(count[2]!) && Number(count[1]) > 0) hasSuccess = true;
      continue;
    }
    if (/^(?:pass(?:ed)?|all (?:tests|checks) passed|(?:(?:routing|gate|unit|integration) )?(?:suite|tests|checks) passed)$/i.test(text)) {
      hasSuccess = true;
      continue;
    }
    return "REPORTED";
  }
  return hasSuccess ? "PASS" : "REPORTED";
}

function auditRowStatus(history: Goal["auditHistory"]): string {
  const entries = Array.isArray(history) ? history : [];
  const last = entries[entries.length - 1];
  if (!last) return "NO REVIEW";
  // v0.38.55 audit: count MATCHING reviews — the old total-entries
  // count misattributed mixed approve+disapprove histories.
  if (last.approved) return `approved (${entries.filter((e) => e.approved).length} review${entries.filter((e) => e.approved).length === 1 ? "" : "s"})`;
  if (last.disapproved) return `disapproved (${entries.filter((e) => e.disapproved).length} review${entries.filter((e) => e.disapproved).length === 1 ? "" : "s"})`;
  if (last.impossible) return "impossible";
  // Error entries (infra abort/auth/no-model) carry no verdict flag — they are
  // the absence of a review, reported in the same uppercase shape as the
  // empty-history case so the banner and the archive gate treat them alike.
  return "NO REVIEW";
}

/** Split a non-finding detail (`Next:`, `Unresolved:`, `Left out:`) into a
 * bold label and body. Finding details use `normalizeFindingLead` instead so
 * topical labels never masquerade as user-visible outcomes. */
function leadBody(detail: string): { lead: string; body: string } {
  const safeDetail = sanitizeDisplayText(detail);
  const separator = safeDetail.indexOf(":");
  if (separator < 0) return { lead: "Note", body: safeDetail };
  return { lead: safeDetail.slice(0, separator).trim() || "Note", body: safeDetail.slice(separator + 1).trim() };
}

/** v0.38.102: an enumeration written INLINE — "(1) … (2) … (3) …" — as one
 * unbroken line, rendered as an indented list instead.
 *
 * Field 2026-09-27 (Ghosty, billing kill-switch): a `leftOut` field carrying
 * seven distinct scope decisions arrived as a single 900-character bullet, so
 * the reasons were unreadable in the terminal card. The same shape hit `Next`.
 *
 * Two or more markers are required. A single "(1)" is prose that happens to
 * contain a parenthetical, not a list, and splitting it would mangle the
 * sentence. The lead sentence before the first marker is kept as the bullet
 * head so the gist still reads first. */
function expandInlineList(body: string, indent = "  "): string[] {
  const text = sanitizeDisplayText(body).trim();
  if (!text) return [];
  const markers = [...text.matchAll(/\((\d{1,2})\)\s+/g)];
  if (markers.length < 2) return [text];
  const lines: string[] = [];
  const lead = text.slice(0, markers[0]!.index!).trim();
  if (lead) lines.push(lead);
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!.index! + markers[i]![0].length;
    const end = i + 1 < markers.length ? markers[i + 1]!.index! : text.length;
    const item = text.slice(start, end).trim();
    if (item) lines.push(`${indent}- ${item}`);
  }
  return lines;
}

/** Normalize a human finding without exposing the legacy `Lead:` marker. */
function findingPresentation(finding: string, chat: boolean): { outcome: string; reason: string; evidence: string[] } {
  const parsed = normalizeFindingLead(sanitizeDisplayText(finding));
  const reasonParts = [
    parsed.reason,
    ...parsed.evidence,
  ].filter(Boolean);
  // v0.39.19 (field 2026-10-09 — `· , weight 0.62 at` on the terminal
  // card): token extraction can strand leading punctuation when the
  // evidence tokens ride mid-sentence, so strip a leading `,;:` husk.
  // Content words are untouched — only the join seam is cleaned.
  const normalizedReason = [...new Set(reasonParts)].join(" · ").trim().replace(/^[,;:]+/, "").trim();
  // v0.39.23 (field 2026-10-10 — Clean-Web card `- , - with …`): the same
  // stranded-punctuation husk can lead the outcome when the agent doubles
  // punctuation around the em-dash split. Strip it like the reason husk.
  const stripHusk = (text: string): string => text.trim().replace(/^[,;:]+/, "").trim();
  return {
    // Chat removes machine receipts; the archive keeps the full evidence
    // prose. The outcome/reason split itself is shared by both surfaces.
    outcome: stripHusk(chat ? chatNarrative(parsed.outcome) : sanitizeDisplayText(parsed.outcome)),
    reason: chat ? chatNarrative(normalizedReason) : sanitizeDisplayText(normalizedReason),
    evidence: parsed.evidence,
  };
}

/** v0.38.102: the GIST is the finding; the evidence rides indented beneath it.
 * Field 2026-09-27: a long `outcome — reason` line buried the outcome in its
 * own evidence, so the reader had to parse the whole sentence to learn what
 * actually changed. Now the outcome is the bullet and the reasoning is one
 * level down, where it supports rather than competes. */
function findingBullet(finding: string, chat: boolean): string[] {
  const semantic = normalizeFindingLead(sanitizeDisplayText(finding));
  const { outcome, reason } = findingPresentation(finding, chat);
  if (semantic.technical && chat) return [];
  // Report shape (field 2026-11-11 — "more like opencode's end-of-task
  // summary"): chat reads `- **lead** — evidence` on ONE line. The old two-
  // level shape (lead, then an indented reason) doubled every area's height
  // in the terminal and made the card scan as a list of orphaned fragments.
  // The archive keeps the two-level form because a .md reader benefits from
  // the indented supporting detail.
  if (chat) return reason ? [`- **${outcome}** \u2014 ${reason}`] : [`- **${outcome}**`];
  return reason ? [`- **${outcome}**`, `  - ${reason}`] : [`- **${outcome}**`];
}

/**
 * v0.38.50: repo-relative `path:line` evidence tokens (soundManager.ts:333,
 * sim.ts:4505-4530). Absolute paths, home-dir paths, and machine temp
 * paths are NOT evidence — those stay in the archive only. Extraction is
 * mechanical substring movement, never inference.
 */
// Consume the complete line list, including ranges and Svelte +page paths.
// Removing only the first location left screenshot-visible `(,2760)` husks.
const EVIDENCE_TOKEN_PATTERN = /(?<![/~+\w])[\w.+][\w.+/-]*\.[A-Za-z0-9]{1,8}:\d+(?:[-–]\d+)?(?:,\s*\d+(?:[-–]\d+)?)*\b/g;

export function extractEvidenceTokens(text: string): { text: string; evidence: string[] } {
  const evidence: string[] = [];
  const stripped = sanitizeDisplayText(text)
    .replace(EVIDENCE_TOKEN_PATTERN, (match) => {
      if (evidence.length < RICH_EVIDENCE_TOKENS_PER_FINDING && !evidence.includes(match)) evidence.push(match);
      // The token often rides in parentheses — move the wrapper too, so
      // no "()" husk remains. Groups that still carry words stay intact.
      return "";
    })
    .replace(/\(([^()]*)\)/g, (group, inner: string) => (/\w/.test(inner) ? group : ""))
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: stripped, evidence };
}

/**
 * v0.38.69 (Antigravity port): completion-claim evidence-density lint.
 * A walkthrough always ships areas + counts; GLLA richness rode optional
 * agent params, so a flat six-label claim with zero path:line tokens and
 * zero gate rows still passed. Returns a NOTE annotation when the claim
 * carries no verifiable pointer at all (no evidence tokens across the
 * summary and every group finding, and no gate rows) — the claim still
 * audits, but the terminal render falls back to recorded facts. Tokens in
 * finding groups count; gate rows count as density without tokens.
 */
export function completionSummaryDensityNote(
  summary: string | undefined,
  groups?: FindingGroup[],
  gates?: GateRow[],
): string | undefined {
  if (!summary?.trim()) return undefined;
  const pool = [summary, ...(groups ?? []).flatMap((group) => group.findings ?? [])].join("\n");
  const { evidence } = extractEvidenceTokens(pool);
  if (evidence.length > 0) return undefined;
  if ((groups ?? []).some((group) => (group.findings ?? []).some((finding) => {
    const parsed = normalizeFindingLead(finding);
    return parsed.reason.trim().length > 0;
  }))) return undefined;
  if ((gates ?? []).length > 0) return undefined;
  return "low evidence density: no path:line evidence tokens and no verification gate rows — add file:line pointers (e.g. extensions/goal-recovery.ts:847) or a gateRows inventory so the terminal render is verifiable";
}

/** A claim spans distinct work when its own recap names several files or
 * several changed areas. This is a capture-time heuristic over the claim
 * text the caller supplied — never a verdict about the work.
 *
 * Field 2026-11-07 (tab-hero completion card): a two-hour change to six
 * files closed as a four-sentence paragraph with one combined
 * `Changed:` clause, so every chat card and archive record read as a
 * single opaque bullet for the rest of the project. The claim was
 * *marked* low-density by the lint and still shipped, because the lint
 * only annotated. */

export const MULTI_AREA_MIN_PATHS = 3;

/** Repo-relative `path`, `path.ts`, or `path.ts:12` tokens in a recap value.
 * Directories do not count — a file is the smallest unit a reviewer can
 * open, and counting directories would let one `lib/` mention look like
 * scope. */
const CLAIM_PATH_PATTERN = /(?<![\w/~])(?:[\w.-]+\/)+[\w.-]*\.[A-Za-z0-9]{1,8}(?::\d+)?\b/g;

/** Distinct repo-relative paths named by a claim's own six-label values. */
export function completionSummaryChangedPaths(summary: string | undefined): string[] {
  const source = completionSummaryBody(summary ?? "");
  if (!source) return [];
  const changed = (() => {
    const match = /\bChanged:\s*/i.exec(source);
    if (!match) return "";
    const start = match.index + match[0].length;
    const rest = source.slice(start);
    const next = /\b(?:Outcome|Evidence|Tests|Unresolved|Next|Left out):/i.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  })();
  const pool = changed ? `${changed}\n${source.replace(changed, " ")}` : source;
  const paths: string[] = [];
  for (const match of pool.matchAll(CLAIM_PATH_PATTERN)) {
    const token = match[0].replace(/:\d+$/, "");
    if (!paths.includes(token)) paths.push(token);
  }
  return paths;
}

/**
 * v0.39.x (field 2026-11-07): does this claim describe multi-area work
 * without the structure that makes it readable? Returns the refusal text a
 * capture-time gate can hand back to the agent, or undefined when the claim
 * is either single-area (flat is genuinely correct) or already structured.
 *
 * Two independent signals name the work's breadth, because a claim's own
 * prose is the weakest one: the recap's `Changed:` value, and the goal's
 * durable telemetry change set (v0.38.100) which records every path the
 * work actually touched. The field case that motivated this gate named six
 * files in telemetry while its recap mentioned one screenshot — a gate that
 * read only the prose would have missed it entirely.
 *
 * The gate never invents detail and never blocks single-area work: it asks
 * for `findingGroups`/`gateRows` only when the work itself spans several
 * paths. An agent can satisfy it honestly in a few seconds (one group is
 * enough for genuinely coherent work), and the alternative — the previous
 * annotation-only lint — silently shipped unreadable cards for weeks.
 */
export function completionSummaryStructureGap(
  summary: string | undefined,
  groups?: FindingGroup[],
  gates?: GateRow[],
  changedFiles?: string[],
): string | undefined {
  if (!summary?.trim()) return undefined;
  if ((groups ?? []).length > 0 || (gates ?? []).length > 0) return undefined;
  const paths = [...new Set([...completionSummaryChangedPaths(summary), ...(changedFiles ?? [])])]
    .filter((path) => path.trim().length > 0);
  if (paths.length < MULTI_AREA_MIN_PATHS) return undefined;
  const shown = paths.slice(0, 6).join(", ");
  const more = paths.length > 6 ? ` (+${paths.length - 6} more)` : "";
  return (
    `complete_goal needs structure for multi-area work — this claim spans ${paths.length} paths ` +
    `(${shown}${more}) but supplied no findingGroups or gateRows, so the summary and the durable ` +
    `archive record it as one opaque bullet.\n\n` +
    `Re-submit with one findingGroups entry per work area ` +
    `({ title, findings: ["<user-visible outcome> — <concrete evidence or path:line>"] }), plus ` +
    `gateRows for the commands you actually ran ({ gate, command, scope, notes }). One group is ` +
    `enough when the paths really are one coherent area.\n\n` +
    `Single-area work stays a flat recap — omit both fields when the change really is one area. ` +
    `The claim was NOT sent to the auditor and no state changed.`
  );
}

/**
 * v0.38.50: one compact duration line from durable goal state — turns,
 * wall-clock elapsed since creation, and audit count. Only known facts
 * render (absent stays absent); null when nothing is known.
 */
/** Report meta line (field 2026-11-11): when the card has enough substance
 * for the meta to be a footnote, it closes the report as a short italic
 * line (`*9 turns · 5m elapsed · 1 audit*`) instead of sitting under the
 * headline where `—` alone made it read as a broken bullet. Unknown facts
 * stay absent; null means the card has no meta to show. */
export function buildDurationLine(goal: Goal, now = Date.now()): string | null {
  const segs: string[] = [];
  const turns = goal.telemetry?.turns;
  // Field 20260918_172705: a zero turns count means untracked telemetry,
  // not a known fact — omit it while elapsed/audits still render.
  if (typeof turns === "number" && Number.isFinite(turns) && turns > 0) {
    segs.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  }
  const started = Date.parse(goal.createdAt ?? "");
  if (Number.isFinite(started)) segs.push(`${fmtElapsed(now - started)} elapsed`);
  const audits = Array.isArray(goal.auditHistory) ? goal.auditHistory.length : 0;
  if (audits > 0) segs.push(`${audits} audit${audits === 1 ? "" : "s"}`);
  return segs.length > 0 ? `*${segs.join(" \u00b7 ")}*` : null;
}

/** Topic words for co-locating a problem and its action, never for
 * deleting a distinct claim. */
const RESTATEMENT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from",
  "in", "is", "it", "its", "of", "on", "or", "so", "the", "to", "was",
  "were", "with",
]);

/** Content words for cross-lead problem→action pairing (field 2026-10-02,
 * note.md). Full body, not the restatement head window: the shared topic
 * ("release cut") often sits at the tail of a long problem body. */
function pairingWords(detail: string): Set<string> {
  const body = detail.replace(/^\s*(?:Next|Unresolved)\s*:?/i, "");
  const words = body.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !RESTATEMENT_STOPWORDS.has(w));
  return new Set(words.slice(0, 60));
}

/** Shared-topic score for one problem/action pair. A pair needs ≥2 shared
 * content words with at least one long (≥5 chars) token, so generic
 * overlaps never attach an action to the wrong problem. Returns 0 when
 * the pair must not render together. */
function pairingScore(problem: Set<string>, action: Set<string>): number {
  let shared = 0;
  let longShared = 0;
  for (const word of action) {
    if (problem.has(word)) {
      shared++;
      if (word.length >= 5) longShared++;
    }
  }
  return shared >= 2 && longShared >= 1 ? shared : 0;
}

/** Partition informing details into findings / Tests / next buckets.
 * Field 20260918_172705: exact-duplicate lines collapse to one per bucket
 * (repeated claim details rendered as doubled rows).
 * Only exact duplicate details collapse. Shared-topic similarity cannot
 * prove equivalence: it used to erase differing qualifiers and actions.
 * Cross-section repeated leading sentences are removed only in chat;
 * original claim details and archive evidence remain intact. */
export function partitionRichDetails(details: string[]): { findings: string[]; tests: string[]; next: string[] } {
  const seen = new Set<string>();
  const push = (bucket: string[], detail: string): boolean => {
    const key = detail.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    bucket.push(detail);
    return true;
  };
  const findings: string[] = [];
  const tests: string[] = [];
  const next: string[] = [];
  for (const detail of details) {
    const semantic = normalizeFindingLead(detail);
    if (semantic.technical) {
      // Tests/verification belong in the evidence table, never in a Lead.
      // Verdict/audit details are represented by the independent review
      // trailer and are not a second human-facing finding.
      if (/^\s*(?:Tests?|Test Results|Verification)\s*:/i.test(detail)) push(tests, detail);
      continue;
    }
    if (/^\s*(Next|Unresolved|Left out)\s*:/i.test(detail)) {
      push(next, detail);
      continue;
    }
    push(findings, detail);
  }
  return { findings, tests, next };
}

/**
 * Report shape (field 2026-11-11, confirmed by the operator): the headline is
 * a report title — the first clause/idea of the outcome, never cut mid-thought
 * — and the rest rides as the prose lede underneath. A long outcome used to run
 * across the whole first line, and the archive then printed a SECOND headline
 * echoing the objective, so a reader had to parse two long sentences before
 * learning what happened. Nothing is invented and nothing is dropped: the split
 * only moves existing text, and a single clause with no natural boundary keeps
 * the whole sentence on the headline.
 */
export const RICH_HEADLINE_CHARS = 96;
/** A title shorter than this reads as a fragment (`Done. The rest …`). */
const MIN_TITLE_CHARS = 24;
/** An em-dash clause break can carry a shorter, punchier title safely — the
 * dash itself signals a title/explanation split rather than a sentence cut. */
const MIN_DASH_TITLE_CHARS = 12;
/** A remainder shorter than this is a trailing qualifier, not a lede. */
const MIN_LEDE_CHARS = 12;

/** Split an outcome into a headline title and its prose lede.
 *
 * Two natural boundaries, both already present in the text: an em-dash clause
 * break (`Outcome: X — Y`) and a sentence end (`X. Y`). Either only counts when
 * the left part is a usable title and the right part is substantial; otherwise
 * the whole value is the title and there is no lede. */
export function splitReportTitle(text: string, limit = RICH_HEADLINE_CHARS): { title: string; lede: string } {
  const safe = sanitizeDisplayText(text).trim();
  if (!safe) return { title: "", lede: "" };
  const usable = (title: string, lede: string, minTitle: number): { title: string; lede: string } | null => {
    const left = title.trim().replace(/[,;:]$/, "").trim();
    // A clause split turns a continuing sentence into a second sentence, so the
    // lede's first letter is capitalized. Only the letter case changes — no
    // word is added, removed or reordered.
    const right = lede.trim().replace(/^[\u2014\u2013-]\s*/, "").trim();
    const rightSentence = right ? right.charAt(0).toUpperCase() + right.slice(1) : "";
    if (left.length < minTitle || left.length > limit) return null;
    if (rightSentence.length < MIN_LEDE_CHARS) return null;
    return { title: left, lede: rightSentence };
  };
  // 1. An em-dash clause break: `X — Y` (the shape the archived claims use).
  const dash = /\s\u2014\s/u.exec(safe);
  if (dash) {
    const split = usable(safe.slice(0, dash.index), safe.slice(dash.index), MIN_DASH_TITLE_CHARS);
    if (split) return split;
  }
  // 2. An early sentence end, when the value keeps talking after it.
  for (const match of safe.matchAll(/[.!?](?=\s|$)/gu)) {
    const end = match.index + 1;
    if (end > limit) break;
    const split = usable(safe.slice(0, end - 1), safe.slice(end), MIN_TITLE_CHARS);
    if (split) return split;
  }
  // 3. The LAST clause break inside the title budget: a comma or semicolon
  // keeps the title informative for as long as it reads cleanly, instead of
  // cutting the sentence at its first idea.
  let clauseSplit: { title: string; lede: string } | null = null;
  for (const match of safe.matchAll(/[,;](?=\s)/gu)) {
    const at = match.index;
    if (at > limit) break;
    const split = usable(safe.slice(0, at), safe.slice(at + 1), MIN_DASH_TITLE_CHARS);
    if (split) clauseSplit = split;
  }
  if (clauseSplit) return clauseSplit;
  // 4. One long clause with no boundary: the whole sentence is the title. An
  // ellipsis would read as cut-off text, and wrapping is the renderer's job.
  return { title: safe, lede: "" };
}

export function requestEchoHeadline(kind: "Done" | "Aborted", outcome: string): string {
  return `## ${kind} \u2014 ${splitReportTitle(outcome).title}`;
}

/** The prose lede under the headline. Empty when the headline already carries
 * the whole outcome — never a duplicate of the title, never invented. */
function reportLede(outcome: string): string[] {
  const lede = splitReportTitle(outcome).lede;
  return lede ? [lede] : [];
}

/** Chat-only projection: keep explanations and counts, not command/hash receipts.
 * Repository-only findings are filtered separately; useful implementation
 * references in substantive explanations are not themselves bookkeeping. */
function chatNarrative(value: string): string {
  return stripMachineGroups(chatSafeDetailValue(sanitizeDisplayText(value))
    .replace(/\b(?:fixed in|commit|HEAD(?: at)?|built from)\s+`?[a-f0-9]{7,64}`?/gi, "")
    .replace(/\b(?=[a-f0-9]*[a-f])(?=[a-f0-9]*\d)[a-f0-9]{7,64}\b/gi, "")
    .replace(/`(?:bun|npm|npx|node|git|tsc)\s+[^`]+`/g, "")
    .replace(/\b(?:bun test|npm (?:run \S+|test)|npx tsc|tsc --noEmit)\b(?:\s+(?:--[\w=-]+|[\w./-]+\.(?:ts|js|mjs)))*/g, "")
    .replace(/\(\s*[,;:]*\s*\)/g, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim());
}

/** Suppression is lossy, so recognize only COMPLETE bookkeeping statements.
 * Unknown wording, mixed clauses and any separately supplied proof stay visible.
 * Never infer expendability from keywords or try to enumerate every possible
 * way an author can describe a limitation. Archive inputs are never filtered. */
function isRepositoryReceipt(value: string, proof = ""): boolean {
  if (proof.trim()) return false;
  const { lead, body } = leadBody(value);
  if (!/^(?:ledger|traceability(?: repair)?|repository state|repo state|working tree)$/i.test(lead)) return false;
  // Only a syntactically bounded document citation may follow a receipt.
  // Parenthetical prose (including limitations) must not be discarded.
  const statement = body.replace(/\s+\([\w./-]+\.md(?::\d+(?:[-–,]\d+)*)?(?:, commit [a-f0-9]{7,40})?\)\.?$/i, "").replace(/\.$/, "");
  const clauses = statement.split(/;\s*/);
  const receiptClauses = [
    /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) fix entries were checked$/i,
    /^the append-only guard preserved the original record(?: while adding the verified findings)?$/i,
    /^the closure record was corrected$/i,
    /^the underlying (?:list|chatter|reset)(?:, (?:list|chatter|reset))*(?: and (?:list|chatter|reset))? fixes remained unchanged$/i,
    /^(?:(?:the )?(?:working tree|repository state|repo state) (?:is |was )?)?(?:clean|committed|pushed)$/i,
  ];
  return clauses.every(clause => receiptClauses.some(pattern => pattern.test(clause)));
}

/** Build the section parts shared by chat, transcript, and archive.
 * v0.38.50: agent-structured groups render as `#### n. Area` subsections
 * with nested evidence bullets; at RICH_TABLE_GROUP_THRESHOLD groups the
 * same facts render as an Area | Finding | Evidence table instead.
 * Without groups the flat six-label projection stays the fallback.
 * v0.38.52: optional per-finding `tests` and agent `gates` remain detailed
 * archive evidence with mechanically derived statuses.
 * v0.38.55: no finding caps or value clipping. Chat suppresses technical
 * Tests/verification by default; the archive keeps the detailed evidence
 * table and machine layer. */
/** v0.38.55 (full parity): the verdict banner's second half, built from
 * the mechanically derived audit status — never agent-claimed. */
function bannerVerdict(auditStatus: string): string {
  if (auditStatus === "NO REVIEW") return "completed without a recorded completion review";
  if (auditStatus.startsWith("approved")) return `completion audit approved (${auditStatus.match(/\d+/)?.[0] ?? 1} review${auditStatus.match(/\d+/)?.[0] === "1" ? "" : "s"})`;
  if (auditStatus.startsWith("disapproved")) return `completion audit disapproved (${auditStatus.match(/\d+/)?.[0] ?? 1} review${auditStatus.match(/\d+/)?.[0] === "1" ? "" : "s"})`;
  if (auditStatus === "impossible") return "completion audit ruled impossible";
  // Any unrecognized status is the absence of a recorded review — never
  // claim a review was recorded.
  return "completed without a recorded completion review";
}

/** v0.38.55 (full parity): final repository state for the terminal card —
 * branch, HEAD, and tree cleanliness from durable git facts. Per-command
 * partial degradation (a failed subcommand blanks only its own line) with
 * short timeouts, so one stuck git call cannot wedge the approval path;
 * the changed-file list caps at 20 with an overflow count. Total failure
 * still returns undefined and the section stays out (absent is named by
 * omission, never invented). The render call sites own cwd. */
export function buildFinalRepoStateLines(cwd: string): string[] | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const branchRaw = run(["branch", "--show-current"]);
  const headRaw = run(["log", "-1", "--format=%h %s"]);
  const shortRaw = run(["status", "--short"]);
  const branch = branchRaw === undefined ? undefined : sanitizeDisplayText(branchRaw);
  const head = headRaw === undefined ? undefined : sanitizeDisplayText(headRaw);
  const short = shortRaw === undefined ? undefined : shortRaw.split("\n").map((line) => sanitizeDisplayText(line)).join("\n");
  if (!branch && !head && short === undefined) return undefined;
  const lines = [`Branch ${branch ?? "detached"}${head ? ` @ ${head}` : ""}`];
  if (short === undefined) lines.push("Tree state unreadable");
  else if (!short) lines.push("Tree clean");
  else {
    const files = short.split("\n");
    const shown = files.slice(0, 20).map((line) => `  ${line.trim()}`);
    if (files.length > 20) shown.push(`  \u2026and ${files.length - 20} more`);
    lines.push("Tree changed:", ...shown);
  }
  return lines;
}

export function buildRichTerminalParts(args: {
  outcome: string;
  details: string[];
  countsLine: string;
  auditHistory?: Goal["auditHistory"];
  objective?: string;
  durationLine?: string | null;
  groups?: FindingGroup[];
  gates?: GateRow[];
  /** v0.38.55: headline voice — Done on the terminal path, Aborted for
   * aborted archive records (which never wear a Done banner). */
  kind?: "Done" | "Aborted";
  /** v0.38.55 (full parity): final repository state lines (branch, HEAD,
   * tree cleanliness) from the render call site, which owns cwd access.
   * Absent keeps the section out — never invented. */
  repoState?: string[];
  /** Structured-long body lines from structuredSummaryLines. Absent
   * keeps the `### Summary` section out (unstructured summaries keep
   * today's headline-echo shape). */
  summaryLines?: string[];
  /** Chat favors explanations; the archive retains raw commands and tables. */
  chat?: boolean;
  /** v0.38.98: opt in to a compact verification tail in chat. The default
   * human summary stays about what changed and what remains; full test/gate
   * evidence remains in the archive. */
  showVerification?: boolean;
}): RichTerminalParts {
  const { findings, tests, next } = partitionRichDetails(args.chat
    ? args.details.filter(detail => !/^\s*Evidence\s*:/i.test(detail))
    : args.details);
  if (!args.chat) {
    // The archive preserves technical Verdict:/Audit: details in the evidence
    // table instead of dropping them — partitionRichDetails routes only
    // Tests:/Verification: lines to `tests` and discards the rest.
    for (const detail of args.details ?? []) {
      if (/^\s*(?:Verdict|Audit)\s*[:\-\u2013\u2014]/i.test(detail) && !tests.includes(detail)) tests.push(detail);
    }
  }
  const outcome = sanitizeDisplayText(args.outcome);
  const kind = args.kind ?? "Done";
  // Field 2026-11-11: ONE headline for both surfaces — the short result line.
  // The archive used to wear a verdict banner (`## Done — completion audit
  // approved (1 review)`) above a SECOND request-echo headline; the verdict
  // now closes the report as its receipt line, which is where a reader looks
  // for it.
  const headline = requestEchoHeadline(kind, outcome);
  const auditStatus = auditRowStatus(args.auditHistory);
  const banner = headline;
  const groups = (args.groups ?? []).map(group => {
    const entries = group.findings
      .map((finding, i) => ({ finding, proof: group.tests?.[i] }))
      .filter(({ finding, proof }) => {
        const semantic = normalizeFindingLead(sanitizeDisplayText(finding));
        if (semantic.technical && args.chat !== true) {
          // Technical-only claims are evidence, not Leads — but the archive
          // preserves them in the evidence table instead of dropping them.
          // Chat keeps the compact filter.
          tests.push(finding);
          return false;
        }
        // Technical-only claims are evidence, not Leads. Repository receipts
        // remain in the archive but are suppressed from the compact chat.
        return !semantic.technical && (args.chat === true ? !isRepositoryReceipt(finding, proof) : true);
      });
    return { ...group, findings: entries.map(entry => entry.finding), tests: entries.map(entry => entry.proof ?? "") };
  }).filter(group => group.findings.length > 0);
  const useTable = !args.chat && groups.length >= RICH_TABLE_GROUP_THRESHOLD;
  const findingLines: string[] = [];
  if (useTable) {
    findingLines.push("| Area | User-visible outcome | Evidence / reason |", "| --- | --- | --- |");
    for (const group of groups) {
      group.findings.forEach((finding, fi) => {
        const { outcome, reason } = findingPresentation(finding, false);
        // v0.38.52: test proof rides the Evidence cell (tables have no
        // sub-bullets); cells stay pipe-escaped. v0.38.55: unclipped.
        // v0.39.x (field 2026-11-07 tab-hero replay): the cell folded the
        // extracted tokens in a SECOND time even though findingPresentation
        // already appends them to `reason`, so `entrypoints/background.ts:41-46`
        // printed twice on one row. One fold, one cell.
        const proof = group.tests?.[fi] ? sanitizeDisplayText(group.tests[fi]).trim() : "";
        const evidenceCell = [
          reason || "not recorded",
          ...(proof ? [`Evidence: ${proof}`] : []),
        ].join(" \u00b7 ");
        findingLines.push(
          `| ${escapeTableCell(group.title)} | ${escapeTableCell(outcome)} | ${escapeTableCell(evidenceCell)} |`,
        );
      });
    }
  } else if (groups.length > 0) {
    groups.forEach((group, i) => {
      if (args.chat && i > 0) findingLines.push(''); // End prior area's list before the next.
      // Report shape (field 2026-11-11): each area is a `What changed · <area>`
      // subsection rather than `**1. Area**`, so the section, not a number,
      // names the work. Chat renders it as a bold label (the Pi TUI has no
      // heading style) and the archive file as a real `###` heading.
      const area = sanitizeDisplayText(group.title);
      findingLines.push(args.chat
        ? `**${CARD_SECTION.whatChanged} \u00b7 ${area}**`
        : `#### ${CARD_SECTION.whatChanged} \u00b7 ${area}`);
      group.findings.forEach((finding, fi) => {
        findingLines.push(...findingBullet(finding, args.chat === true));
        // Test proof is supporting evidence, not a second narrative. Keep it
        // on the archive's detailed finding; chat folds all gate outcomes into
        // the verification table below.
        const proof = group.tests?.[fi] ? sanitizeDisplayText(group.tests[fi]).trim() : "";
        if (proof && !args.chat) findingLines.push(`  - Evidence: ${proof}`);
      });
    });
  } else {
    // Report shape (field 2026-11-11): a claim without per-area groups renders
    // the same way the grouped shape does — one bullet per change, outcome first
    // with its evidence folded in — instead of a numbered list whose first item
    // could be a bare path. The archive keeps its numbered, indented form.
    findings.filter(detail => !args.chat || !isRepositoryReceipt(detail)).forEach((detail) => {
      const normalized = normalizeFindingLead(args.chat ? chatNarrative(detail) : detail);
      if (normalized.technical) {
        // Archive preserves flat Verdict:/Audit: details in the evidence table
        // (already routed above — this guards the fallback path); chat drops.
        return;
      }
      if (args.chat) {
        findingLines.push(...findingBullet(detail, true));
        return;
      }
      const reason = [...new Set([normalized.reason, ...normalized.evidence].filter(Boolean))].join(" \u00b7 ");
      findingLines.push(`- **${normalized.outcome}**`);
      if (reason) findingLines.push(`  - ${reason}`);
    });
  }
  const tableRows: string[] = [];
  // v0.38.52 (shots B/D): the agent inventory supersedes the mechanical
  // Tests rows — one curated gate list, never a duplicated one. Status
  // is derived, never claimed: PASS only when the notes say pass with
  // zero failures ("Clean exit 0"-style notes honestly stay REPORTED).
  // v0.38.55: every row renders with its repro command when any row
  // carries one (Stage | Command | Result | Notes parity) — no row cap.
  const gates = args.gates ?? [];
  // Field 2026-11-11: the gate table is part of the report on BOTH surfaces.
  // Chat earns a compact three-column shape (Gate | Command | Result); the
  // archive keeps the wide inventory (Command + Scope + Status + Notes) and
  // its completion-review row. Status stays DERIVED in every shape.
  const showCommand = args.chat ? true : gates.some((row) => row.command?.trim());
  if (gates.length > 0) {
    for (const row of gates) {
      const safeNotes = row.notes ? sanitizeDisplayText(row.notes).trim() : "";
      const derived = testsRowStatus(safeNotes);
      const notes = args.chat ? chatNarrative(safeNotes) : safeNotes;
      const command = row.command ? sanitizeDisplayText(row.command).trim() : "\u2014";
      const gate = sanitizeDisplayText(row.gate);
      const scope = row.scope ? sanitizeDisplayText(row.scope).trim() : "\u2014";
      if (args.chat) {
        // A PASS label is only printed when the notes actually prove a pass;
        // anything unproven keeps the raw wording instead of a status word.
        const result = notes ? (derived === "PASS" ? `PASS: ${notes}` : notes) : derived;
        tableRows.push(`| ${escapeTableCell(gate)} | ${escapeTableCell(command)} | ${escapeTableCell(result || "\u2014")} |`);
        continue;
      }
      tableRows.push(showCommand
        ? `| ${escapeTableCell(gate)} | ${escapeTableCell(command)} | ${escapeTableCell(scope)} | ${derived} | ${escapeTableCell(notes || "\u2014")} |`
        : `| ${escapeTableCell(gate)} | ${escapeTableCell(scope)} | ${derived} | ${escapeTableCell(notes || "\u2014")} |`);
    }
  } else {
    for (const detail of tests) {
      const { body } = leadBody(detail);
      const status = testsRowStatus(body);
      tableRows.push(`| Verification | ${status} | ${escapeTableCell(args.chat ? chatNarrative(body) : sanitizeDisplayText(body))} |`);
    }
  }
  if (!args.chat && gates.length > 0 && auditStatus !== "NO REVIEW") {
    // The review row rides the WIDE archive gate table only; the chat receipt
    // already closes with the verdict, so the compact three-column shape does
    // not repeat it as a pseudo-gate (field 2026-11-11).
    const auditBody = sanitizeDisplayText(args.countsLine).replace(/^\u2014\s*/, "").replace(/\.\s*$/, "").replace(/^completion review:\s*/i, "");
    tableRows.push(showCommand
      ? `| Completion review | \u2014 | review status | ${auditStatus} | ${escapeTableCell(auditBody)} |`
      : `| Completion review | review status | ${auditStatus} | ${escapeTableCell(auditBody)} |`);
  }
  if (!args.chat && gates.length === 0 && auditStatus !== "NO REVIEW") {
    const auditBody = sanitizeDisplayText(args.countsLine).replace(/^\u2014\s*/, "").replace(/\.\s*$/, "").replace(/^completion review:\s*/i, "");
    tableRows.push(`| Completion review | ${auditStatus} | ${escapeTableCell(auditBody)} |`);
  }
  // Chat is an account of what happened, not a test-run transcript. Keep
  // verification out of the default human view; an explicit user request may
  // opt into one compact supporting sentence. Unknown wording stays
  // "reported" rather than claimed pass, and the archive always keeps the
  // full status/table.
  let verificationSummaryLine: string | undefined;
  if (args.chat && args.showVerification === true && (gates.length > 0 || tests.length > 0)) {
    const gateNotes = gates.length > 0
      ? gates.map((row) => testsRowStatus(sanitizeDisplayText(row.notes ?? "")))
      : tests.map((detail) => testsRowStatus(leadBody(detail).body));
    const passed = gateNotes.filter((status) => status === "PASS").length;
    const failed = gateNotes.filter((status) => status === "FAIL").length;
    const reported = gateNotes.length - passed - failed;
    const parts = [
      failed > 0 ? `${failed} failed` : passed > 0 ? `${passed} passed` : undefined,
      reported > 0 ? `${reported} reported` : undefined,
    ].filter(Boolean);
    verificationSummaryLine = parts.length > 0 ? `${parts.join(", ")}.` : "Verification reported.";
  }
  // v0.38.55: the archive verification table always renders in full. Chat
  // renders its compact three-column form on the same rule (report shape,
  // field 2026-11-11) — verification is part of the report, not archive-only
  // trivia. `showVerification` now only adds the aggregate sentence for a
  // claim that supplied no gate inventory at all.
  const tableLines = tableRows.length > 0
    ? [
      gates.length > 0
        ? (args.chat ? "| Gate | Command | Result |" : showCommand ? "| Quality Gate | Command | Scope | Status | Notes |" : "| Quality Gate | Scope | Status | Notes |")
        : "| Verification | Status | Details |",
      gates.length > 0
        ? (args.chat ? "| --- | --- | --- |" : showCommand ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- |")
        : "| --- | --- | --- |",
      ...tableRows,
    ]
    : [];
  // v0.38.55: every concrete Next renders — no cap. Unresolved and Left out
  // are change-impact facts, not a second technical next step.
  // Field 2026-10-02 (note.md): a Next action that resolves an Unresolved
  // problem renders inline under that problem (`→ Next:`) — the card used
  // to state the same fact twice (problem under Remaining, its fix under
  // Next), burying what mattered. ### Next keeps only standalone actions.
  // Left out is decided scope, never a problem, so it never pairs. The
  // archive machine layer keeps the verbatim recap; only this human
  // projection pairs.
  const unresolvedDetails = next.filter((d) => /^\s*Unresolved\s*:/i.test(d));
  const remainingBodies = next.filter(d => /^\s*(?:Unresolved|Left out)\s*:/i.test(d))
    .map(d => leadBody(d).body.trim()).filter(Boolean);
  const nextDetails = next.filter((d) => /^\s*Next\s*:/i.test(d)).flatMap(detail => {
    if (!args.chat) return [detail];
    // Only exact whole-body equality proves repetition. Neither shared
    // prefixes nor punctuation establishes a safe semantic boundary.
    // Preserve the complete action whenever it carries any distinct text.
    return remainingBodies.includes(leadBody(detail).body.trim()) ? [] : [detail];
  });
  const problemWords = unresolvedDetails.map(pairingWords);
  const pairedByProblem = new Map<number, number[]>();
  const consumedActions = new Set<number>();
  nextDetails.forEach((action, actionIdx) => {
    const actionWords = pairingWords(action);
    let best = -1;
    let bestScore = 0;
    problemWords.forEach((words, problemIdx) => {
      const score = pairingScore(words, actionWords);
      if (score > bestScore) { bestScore = score; best = problemIdx; }
    });
    if (best >= 0) {
      consumedActions.add(actionIdx);
      const list = pairedByProblem.get(best) ?? [];
      list.push(actionIdx);
      pairedByProblem.set(best, list);
    }
  });
  const nextLines: string[] = [];
  for (const [actionIdx, detail] of nextDetails.entries()) {
    if (consumedActions.has(actionIdx)) continue;
    const { body } = leadBody(detail);
    const [head, ...rest] = expandInlineList(body);
    // The section itself names the action, so the per-line `**Next** —` prefix
    // is dropped on BOTH surfaces (field 2026-11-11).
    if (head) nextLines.push(`- ${head}`);
    nextLines.push(...rest);
  }
  const remainingLines: string[] = [];
  for (const detail of next.filter((d) => /^\s*(?:Left out|Unresolved)\s*:/i.test(d))) {
    const { lead, body } = leadBody(args.chat ? chatNarrative(detail) : detail);
    const [head, ...rest] = expandInlineList(body);
    remainingLines.push(`- **${lead}** — ${head ?? ""}`.trimEnd());
    remainingLines.push(...rest);
    if (/^\s*Unresolved\s*:/i.test(detail)) {
      // Paired actions relocate verbatim (the ### Next rendering, moved
      // under their problem) — pairing is co-location, not re-voicing.
      const problemIdx = unresolvedDetails.indexOf(detail);
      for (const actionIdx of pairedByProblem.get(problemIdx) ?? []) {
        const actionDetail = nextDetails[actionIdx] ?? "";
        const { lead: actionLead, body: actionBody } = leadBody(actionDetail);
        const [actionHead, ...actionRest] = expandInlineList(actionBody);
        remainingLines.push(`  → ${actionLead}: ${actionHead ?? ""}`.trimEnd());
        remainingLines.push(...actionRest);
      }
    }
  }
  return {
    banner,
    headline,
    durationLine: args.durationLine ?? null,
    findingLines,
    tableLines,
    nextLines,
    remainingLines,
    verificationSummaryLine,
    ...(args.chat ? { chat: true } : {}),
    repoLines: args.chat ? [] : (args.repoState ?? []).map((line) => sanitizeDisplayText(line)),
    summaryLines: (args.summaryLines ?? []).map((line) => sanitizeDisplayText(line)),
    ledeLines: reportLede(outcome),
  };
}

/** Demote agent-written markdown headings to TUI-safe bold for chat.
 * A `#`-heading line that survives into chat content renders literally
 * (the Pi TUI has no heading style); `**bold**` renders everywhere the
 * card does. Archive/non-chat lines bypass this — a .md file renders
 * headings natively. */
function terminalizeHeadings(line: string): string {
  return line.replace(/^(\s*)#{1,6}\s+(.*\S)\s*$/, "$1**$2**");
}

/** Compose parts into the end-of-task report card.
 *
 * Field 2026-11-11 ("more like opencode's end-of-task summary"): the card
 * is ONE document — headline, then `## Summary` carrying the outcome and
 * one `What changed · <area>` subsection per work area, then the always-on
 * `## Verification` gate table, `## Follow-up items`, `## Next steps`, the
 * archive-only repository state, and a single compact receipt line. The
 * pre-report shape split the same facts across Summary / What Changed /
 * Remaining / Verification Evidence / Next with a second headline and four
 * `•` trailer bullets, which is what made a finished goal read as an audit
 * log.
 *
 * Ordering guarantees kept from v0.38.55: findings precede verification,
 * verification precedes the follow-ups, and a resolved problem carries its
 * action inline (`→ Next:`) instead of restating it under Next steps. */
export function composeRichTerminalLines(parts: RichTerminalParts): string[] {
  const banner = sanitizeDisplayText(parts.banner ?? parts.headline);
  const headline = sanitizeDisplayText(parts.headline);
  const lines = [banner, ""];
  if (headline !== lines[0]) lines.push(headline, "");
  // The prose lede: the whole outcome sentence under the shortened headline
  // (field 2026-11-11). Absent when the headline already carries it.
  if (parts.ledeLines.length > 0) lines.push(...parts.ledeLines.map((line) => sanitizeDisplayText(line)), "");
  if (parts.durationLine) lines.push(sanitizeDisplayText(parts.durationLine), "");
  // Structured-long (field 2026-09-16): the full Outcome body rides its
  // own section between the headline and the findings — findings-first
  // order is preserved (findings, verification, Next keep their relative
  // order), the headline echo stays short, and the one-action Next rule
  // is untouched.
  // v0.39.19 (field 2026-10-09 — terminal card screenshot): the Pi TUI
  // renders bold/lists but NOT `#` headings, so `### What Changed` reached
  // the screen literally. Chat/terminal surfaces get ONE `##` level (the
  // TUI renders depth 2 without the `##` prefix); the archived markdown
  // keeps its `###` headings because a .md file renders them.
  const head = (text: string): string => (parts.chat ? `## ${text}` : `### ${text}`);
  // v0.39.23 (field 2026-10-10 — Clean-Web terminal screenshots): agents
  // write `###`/`####` headers INSIDE finding/remaining/next text and the
  // Pi TUI renders bold/lists but not `#` headings, so they reached the
  // screen literally. Chat-facing content demotes markdown headings to
  // bold (which the TUI renders); the archived markdown keeps them.
  const contentLine = (line: string): string => {
    const clean = sanitizeDisplayText(line);
    return parts.chat ? terminalizeHeadings(clean) : clean;
  };
  const summaryBlocks: string[] = [];
  if (parts.summaryLines.length > 0) summaryBlocks.push(...parts.summaryLines.map(contentLine));
  if (parts.findingLines.length > 0) {
    if (summaryBlocks.length > 0) summaryBlocks.push("");
    summaryBlocks.push(...parts.findingLines.map(contentLine));
  }
  if (summaryBlocks.length > 0) lines.push(head(CARD_SECTION.summary), ...summaryBlocks, "");
  // Section headings already supply these labels in chat. Keep the
  // explicit Left out distinction and preserve all archive labels verbatim.
  const sectionLine = (line: string): string => contentLine(parts.chat
    ? line.replace(/^(\s*-\s+)\*\*(?:Unresolved|Next)\*\*\s+—\s+/, '$1') : line);
  if (parts.remainingLines.length > 0) {
    lines.push(head(CARD_SECTION.followUp), ...parts.remainingLines.map(sectionLine), "");
  }
  if (parts.verificationSummaryLine) {
    lines.push(head(CARD_SECTION.verification), contentLine(parts.verificationSummaryLine), "");
  } else if (parts.tableLines.length > 0) {
    // Field 2026-11-11: the gate table always renders — a completion claim's
    // verification is part of the report a person reads, not archive-only
    // trivia. The archive widens the same table with commands and its review
    // row; chat drops only the mechanical narrow-width columns.
    lines.push(head(CARD_SECTION.verification), ...parts.tableLines.map((line) => contentLine(line)), "");
  }
  if (parts.nextLines.length > 0) {
    lines.push(head(CARD_SECTION.nextSteps), ...parts.nextLines.map(sectionLine), "");
  }
  if (parts.repoLines.length > 0) {
    lines.push(head(CARD_SECTION.repo), ...parts.repoLines.map((line) => `- ${sanitizeDisplayText(line)}`), "");
  }
  return lines;
}

/** Rich human layer for the durable archive (owner: the archive IS for
 * humans). Same sections as chat, composed from durable goal state — the
 * raw six-label recap stays verbatim in `## Completion summary` as the
 * machine layer. Headline follows terminal status; aborted records never
 * wear a `Done` headline. */
export function buildRichArchiveSection(goal: Goal, status: Status, archivePath: string, findingGroups?: FindingGroup[], gateRows?: GateRow[], priorWholeWorkOverride?: string): string[] {
  const facts: CompletionSummaryFacts = { goal, status, archivePath };
  const summary = resolveCompletionSummary(facts, goal.completionSummary).summary;
  // Preserve the original claim verbatim for forensic history only. The
  // final card must use the corrected terminal recap, not a rejected one.
  // archiveCurrentGoal captures history before pendingCompletion clears.
  const priorWholeWork = priorWholeWorkOverride ?? goal.pendingCompletion?.priorCompletionSummary;
  const brief = humanCompletionBrief(summary, 140, RICH_FULL_VALUE_BUDGET, priorWholeWork, true);
  const structured = structuredSummaryLines(summary);
  const history = goal.auditHistory ?? [];
  const latest = history[history.length - 1];
  const approval = latest
    ? `\u2014 completion audit ${latest.approved ? "approved" : latest.disapproved ? "disapproved" : latest.impossible ? "impossible" : "left no review"}.`
    : "\u2014 completed without a recorded completion review.";
  const countsLine = buildAuditCountsLine(goal);
  const parts = buildRichTerminalParts({
    outcome: brief.outcome,
    details: withoutStaleNext(brief.details),
    countsLine,
    auditHistory: history,
    objective: goal.objective,
    durationLine: buildDurationLine(goal),
    groups: findingGroups,
    gates: gateRows,
    // v0.38.55: aborted records never wear a Done banner/headline.
    kind: status === "complete" ? "Done" : "Aborted",
    ...(structured ? { summaryLines: structured } : {}),
  });
  return [
    ...composeRichTerminalLines(parts),
    // Report shape (field 2026-11-11): the archive closes with the same single
    // receipt line the chat card uses, then keeps the verbatim original claim
    // as a separate forensic appendix.
    `${[
      receiptSegment(stripApprovalModel(approval)),
      ...challengeDisclosure(goal).map(receiptSegment),
      receiptSegment(countsLine),
      receiptSegment(`\u2014 record: ${archivePath}`),
    ].filter(Boolean).join(" \u00b7 ")}.`,
    ...(priorWholeWork ? ["", "## Original completion claim (verbatim)", "", priorWholeWork] : []),
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
  // D7 audit: this projection owns its trust boundary — sanitize inputs
  // here (idempotent for already-sanitized brief parts) instead of
  // trusting every caller to pre-sanitize.
  return [
    `✓ done — ${sanitizeDisplayText(notice.outcome)}`,
    // v0.38.37 (audit 2026-09-08): one verifiable-result bullet per
    // informing detail — the Codex closing shape.
    // v0.38.39: the approval/counts/record trailer rides as bullets too
    // (field 20260909_013733 — the `—` tail read as a second voice); the
    // record pointer stays last.
    ...withoutStaleNext(notice.details).map((detail) => `• ${sanitizeDisplayText(detail)}`),
    trailerBullet(stripApprovalModel(notice.approval)),
    ...(notice.counts ? [trailerBullet(stripApprovalModel(notice.counts))] : []),
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
 * The raw `auditor <model> approved` shape collapses to a model-free
 * `completion audit approved`; any other approval voice passes through
 * untouched. */
function stripApprovalModel(line: string): string {
  return line
    .replace(/(?:auditor|completion audit)\s+\S+\s+approved/gi, "completion audit approved")
    .replace(/(?:auditor|completion audit)\s+\S+\s+disapproved/gi, "completion audit disapproved")
    .replace(/completed without audit/gi, "completed without a completion review")
    .replace(/\bauditor\b/gi, "completion audit")
    .replace(/\bverdict(s)?\b/gi, "review$1");
}
function trailerBullet(line: string): string {
  return `• ${sanitizeDisplayText(line).replace(/^—\s*/, "")}`;
}

/** One segment of the closing receipt line (field 2026-11-11). The old `•`
 * trailer voice is stripped to its words so the segments join into a single
 * `·`-separated line instead of a stack of bullets. A trailing period is
 * dropped except on the very last segment, where it closes the sentence. */
function receiptSegment(line: string): string {
  return sanitizeDisplayText(line).replace(/^\u2022\s*/, "").replace(/^—\s*/, "").replace(/\.\s*$/, "").trim();
}

/** v0.38.25: the audit-goal counts line — verdict proof ONLY, built from
 * durable goal state. Raw run stats (turns/file-writes/bash calls) read as
 * a machine receipt in user chat (field 2026-09-08 223522/223523); the
 * full execution evidence stays in the six-label archive record. Absent
 * facts are named as absent, never invented (recorded-facts honesty). */
export function buildAuditCountsLine(goal: Goal, auditNote?: string): string {
  const history = goal.auditHistory ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : undefined;
  const audit = auditNote ? stripApprovalModel(auditNote) : (latest === undefined
    ? "no review recorded"
    : (() => {
      const verdict = latest.approved ? "approved" : latest.impossible ? "impossible" : latest.disapproved ? "disapproved" : "no review";
      return `${verdict} (${history.length} review${history.length === 1 ? "" : "s"})`;
    })());
  // D7 audit: the auditNote override is caller text — sanitize at the
  // source so every trailer/compose consumer inherits a clean line.
  return `— completion review: ${sanitizeDisplayText(audit)}.`;
}

function challengeDisclosure(goal: Goal): string[] {
  const outcome = goal.auditHistory?.at(-1)?.challenge;
  if (!outcome?.startsWith("skipped:")) return [];
  const reason = outcome === "skipped: light-tier audit" ? "light-tier audit"
    : outcome === "skipped: rework-streak convergence" ? "rework-streak convergence"
      : "challenge could not be completed";
  return [`• Falsification pass skipped (${reason}).`];
}

export interface TerminalApprovalRenderInput {
  goal: Goal;
  status: Status;
  stopReason?: string;
  archivePath?: string;
  completionSummary?: string;
  /** Path-specific voice, e.g. `— completion audit approved …` or `— completed without a completion review (your choice).` */
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
  /**
   * v0.38.52: agent-supplied verification gate rows (complete_goal
   * gateRows, sanitized at claim time). Absent keeps the mechanical
   * 3-col verification table.
   */
  gateRows?: GateRow[];
  /** v0.38.98: show a compact verification sentence in the human terminal
   * summary when the user explicitly asks for it. Full evidence remains in
   * the archive regardless. */
  showVerification?: boolean;
  /**
   * v0.38.55 (full parity): final repository state lines for the
   * `### Final Repository State` section — build with
   * buildFinalRepoStateLines(cwd). Absent keeps the section out.
   */
  repoState?: string[];
  /** Original claim retained for compatibility and forensic history.
   * It must not override or merge into the latest approved human recap. */
  priorCompletionSummary?: string;
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
  // Rich voice (field 20260911_*): the chat/transcript render uses a
  // verbose brief (200-char values) while the outcome headline keeps
  // the 140-char budget. Filler drops via the same briefValueContent
  // filter; absent stays absent.
  // v0.38.55 (full parity): values ride unclipped — the card shares
  // everything the archive knows.
  const resolution = resolveCompletionSummary(facts, candidate);
  // A persisted fallback already satisfies the six-label validator. Detect
  // the system's reserved template as well as newly resolved fallbacks;
  // otherwise replaying an archived receipt resurrects telemetry as changes.
  const persistedFallback = /^Outcome: Objective ".*" archived with status=\w+\.$/m.test(candidate ?? "")
    && /^Evidence: goal .*; .*; .*\.$/m.test(candidate ?? "")
    && /^Tests: not recorded — .*terminal test result was captured/m.test(candidate ?? "");
  const humanSource = persistedFallback ? undefined : resolution.usedFallback ? candidate : resolution.summary;
  // A legacy/incomplete recap can still have useful human fields. Read those
  // directly for display; keep the strict recorded-facts resolver unchanged
  // for the durable archive and independent audit.
  const richBrief = humanCompletionBrief(
    humanSource,
    140,
    RICH_FULL_VALUE_BUDGET,
    input.priorCompletionSummary,
    input.showVerification === true,
  );
  // Structured-long (field 2026-09-16): a section-structured Outcome
  // earns the full `### Summary` section on the terminal card (and the
  // archive human layer). Headline echo, verification, Next, recap, and
  // every recycled payload keep their bounds.
  if ((resolution.usedFallback || persistedFallback) && richBrief.outcome === "(outcome not recorded)") {
    richBrief.outcome = input.status === "complete"
      ? "Work finished; a plain-language result was not recorded."
      : "Work stopped; a plain-language result was not recorded.";
  }
  const recap = richBrief.outcome;
  const structured = structuredSummaryLines(humanSource);
  // v0.38.37 (audit 2026-09-08): the deliberate non-do comes from the
  // agent's complete_goal leftOut claim — never invented. Filler ("none")
  // drops via the same briefValueContent filter; absent stays absent.
  const leftOut = input.leftOut?.trim();
  const leftOutContent = leftOut ? briefValueContent(leftOut) : null;
  const richDetails = leftOutContent
    ? [...richBrief.details, `Left out: ${leftOutContent}`]
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
  // Report shape (field 2026-11-11): the card closes with ONE receipt line —
  // `completion audit approved (1 review) · record: <path>` — instead of four
  // `•` bullets stacked under the findings. The old trailer repeated the
  // verdict three times in different voices (approval, counts, review row) and
  // read as audit bookkeeping attached to a report. Everything it carried
  // survives here: the model-free verdict, any falsification disclosure, the
  // verdict-count news when it is real news, and the record pointer last.
  const receiptSegments = [
    foldCounts
      ? `${receiptSegment(chatApproval)} (${history.length} review${history.length === 1 ? "" : "s"})`
      : receiptSegment(chatApproval),
    ...challengeDisclosure(input.goal).map(receiptSegment),
    ...(foldCounts ? [] : [receiptSegment(countsLine)]),
    receiptSegment(input.record),
  ].filter(Boolean);
  const receiptLine = `${receiptSegments.join(" \u00b7 ")}.`;
  // Rich voice: banner + headline + report sections, closed by the trailer.
  // Verification rides the report itself (field 2026-11-11) rather than being
  // archive-only trivia; `showVerification` still adds its aggregate sentence
  // for a claim that supplied no gate inventory.
  const richParts = buildRichTerminalParts({
    chat: true,
    showVerification: input.showVerification,
    outcome: richBrief.outcome,
    details: withoutStaleNext(richDetails),
    countsLine,
    auditHistory: input.goal.auditHistory,
    objective: input.goal.objective,
    durationLine: buildDurationLine(input.goal),
    groups: input.findingGroups,
    gates: input.gateRows,
    ...(input.repoState ? { repoState: input.repoState } : {}),
    ...(structured ? { summaryLines: structured } : {}),
  });
  const chatBody = composeRichTerminalLines(richParts);
  const transcriptBody = composeRichTerminalLines(richParts);
  const transcriptReceipt = receiptSegments.slice(0, -1).join(" \u00b7 ");
  return {
    chatLines: [
      ...chatBody,
      // Extras are secondary annotations, so they sit BEFORE the receipt:
      // the record pointer stays the last thing on every terminal summary.
      ...(input.extras ?? []),
      receiptLine,
    ],
    recap,
    transcriptLines: transcriptReceipt ? [...transcriptBody, transcriptReceipt] : transcriptBody,
    countsLine,
    outcome: richBrief.outcome,
    approval: input.approval,
  };
}

/** Multi-line projection: one `Label: value` line per human-facing label.
 * Technical Tests are omitted by default and can be included explicitly for
 * evidence-focused callers. The single-line projection remains for
 * width-bound surfaces (TUI widget card, external notifies). */
export function completionSummaryLines(text: string | undefined, maxValueLength = 240, lineWidth?: number, includeTests = false): string[] {
  const source = completionSummaryBody(text ?? "").replace(/\s+/g, " ").trim();
  const lower = source.toLowerCase();
  const positions = labelPositions(lower);
  return (includeTests ? COMPLETION_SUMMARY_LABELS : COMPLETION_SUMMARY_LABELS.filter((label) => label !== "Tests:")).map((label) => {
    const name = label.slice(0, -1);
    const current = positions.find((entry) => entry.label === label);
    if (!source || !current) return `${name}: not recorded`;
    const valueStart = current.start + label.length;
    const nextStart = positions
      .filter((entry) => entry.start > current.start)
      .map((entry) => entry.start)
      .sort((a, b) => a - b)[0] ?? source.length;
    const rawValue = source.slice(valueStart, nextStart).trim();
    // D7: recap projections sanitize like every other human surface.
    const line = `${name}: ${clipSummaryValue(sanitizeDisplayText(rawValue || "not recorded"), maxValueLength)}`;
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
  // v0.38.104: route through the shared cutter. The local `clean.slice(0, 217)`
  // cut UTF-16 code units, so an emoji straddling the index emitted a lone
  // surrogate into the durable archive line. clipSummaryValue is code-point
  // safe and cuts at a clause boundary, and one implementation now owns every
  // length cut in this module.
  return clipSummaryValue(objective, 220);
}

function stopReasonExcerpt(reason: string | undefined): string {
  return clipSummaryValue(reason ?? "", 260) || "not recorded";
}

function auditEvidence(goal: Goal): string {
  const history = goal.auditHistory;
  const latest = history && history.length > 0 ? history[history.length - 1] : undefined;
  if (!latest) return "no completion review was recorded";
  const verdict = latest.approved ? "approved" : latest.impossible ? "impossible" : latest.disapproved ? "disapproved" : "no review recorded";
  const model = safeFact(latest.model, "unknown model");
  return `latest completion review=${verdict} by ${model} at ${safeFact(latest.at)}`;
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
  // v0.38.100: execution now records the touched paths behind the counter —
  // name them (bounded) instead of reporting them missing. Pre-tracking
  // goals keep the old sentence.
  const changedFiles = (goal.telemetry?.files ?? []).filter((f): f is string => typeof f === "string" && f.length > 0);
  const changedOverflow = goal.telemetry?.filesOverflow ?? 0;
  const changed = !hasFileSignals
    ? "not recorded — no file-write signal was captured"
    : changedFiles.length === 0 && changedOverflow === 0
      ? `${goal.telemetry!.fileWrites} file-write signal(s) were recorded; changed paths were not captured`
      : (() => {
          const shown = changedFiles.slice(0, 20).join(", ");
          const extra = (changedFiles.length - Math.min(changedFiles.length, 20)) + changedOverflow;
          return `${goal.telemetry!.fileWrites} file-write signal(s) touched: ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`;
        })();
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
  includeTests = false,
): string {
  return compactCompletionSummary(resolveCompletionSummary(facts, candidate).summary, maxValueLength, includeTests);
}

/** Brief twin of compactTerminalCompletionSummary for the `✓ done` chat
 * notifies: same resolved facts, outcome + informing labels only. */
export function terminalHumanBrief(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
): HumanCompletionBrief {
  return humanCompletionBrief(resolveCompletionSummary(facts, candidate).summary, 140, 120, undefined, false);
}

/** Multi-line twin of compactTerminalCompletionSummary for the `✓ done`
 * chat notifies: same resolved facts, one `Label: value` line each. */
export function terminalCompletionSummaryLines(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
  maxValueLength = 240,
  lineWidth?: number,
  includeTests = false,
): string[] {
  return completionSummaryLines(resolveCompletionSummary(facts, candidate).summary, maxValueLength, lineWidth, includeTests);
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
  return compactCompletionSummary(summary, 72, false);
}
