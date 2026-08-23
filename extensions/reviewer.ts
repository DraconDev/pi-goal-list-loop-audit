// pi-goal-list-loop-audit — v0.26.0
// extensions/reviewer.ts
//
// The Reviewer: post-completion follow-up enqueuer. Fires after a /goal
// completes or a /list queue empties, extracts curated findings from audit
// reports (and from the archive only for explicit manual review), classifies
// them by leverage, writes a review report, and cascades: bug/refactor
// findings → /list items (no Confirm, per the leverage principle),
// architectural findings → /goal proposal (Confirm), clean completions →
// audit /goal proposal, strategic-only → notify+idle.
//
// Deterministic by design (REVIEWER-DESIGN-2026-07-24: "makes NO new tool
// calls — purely analytical"). All side effects are injected so tests
// drive it without a pi host. /loop completions never trigger it.

import * as fs from "node:fs";
import * as path from "node:path";

import { piGlaDir, stateRootPending } from "./goal-loop-core.js";

export type ReviewerMode = "off" | "on" | "auto" | "aggressive";

export interface ReviewerConfig {
  enabled: boolean;
  /** v0.26.2: default = Confirm-gated cascade; auto = auto-loop — every
   * finding class (incl. architectural) and the clean-completion audit
   * become /list items with zero Confirms (strategic stays notify-only —
   * decisions never auto-fire); report = write the report + notify only. */
  mode: ReviewerMode;
  fireOn: Array<"goal-complete" | "list-complete">;
  doNotFireOn: string[];
  cascade: Array<"convert-findings-to-list" | "queue-leftovers" | "fire-audit-on-clean" | "notify-and-idle">;
  auditCadence: string;
  auditScope: string;
  maxFindingsPerReview: number;
  maxReviewsPerDay: number;
}

export const DEFAULT_REVIEWER_CONFIG: ReviewerConfig = {
  enabled: true,
  mode: "on",
  fireOn: ["goal-complete", "list-complete"],
  doNotFireOn: ["goal-aborted", "goal-paused"],
  cascade: ["convert-findings-to-list", "queue-leftovers", "notify-and-idle"],
  auditCadence: "every-clean-completion",
  auditScope: "regression-scan",
  maxFindingsPerReview: 10,
  maxReviewsPerDay: 20,
};

/** Merge a partial project-settings block over the defaults. v0.27.9:
 * migrate legacy `"default"` / `"report"` mode values to `"on"` (the
 * contract-compliant 4-mode set is now `off | on | auto | aggressive`). */
export function resolveReviewerConfig(block?: Partial<ReviewerConfig>): ReviewerConfig {
  const merged = { ...DEFAULT_REVIEWER_CONFIG, ...(block ?? {}) };
  if ((merged.mode as string) === "default" || (merged.mode as string) === "report") {
    merged.mode = "on";
  }
  return merged;
}

export type FindingClass = "bug" | "refactor" | "architectural" | "strategic";

export interface Finding {
  text: string;
  source: string;
  class: FindingClass;
}

/** Leverage classification (contract item 5). Order matters: strategic
 * and architectural win over bug/refactor — "should we rewrite this
 * broken schema" is a decision, not a fix. */
// v0.26.3: the bare words "architectural"/"strategic" are REMOVED — they
// self-matched the reviewer's own vocabulary ("architectural-class",
// "architectural findings", the docs' mode matrix) and produced 3 junk
// findings on the 0.26.2 completion, observed live.
// v0.34.83: the bare word "issue" is REMOVED from the bug regex — it
// matched every GitHub issue reference, "issue tracker", "this issue",
// etc. Observed live: a completion summary mentioning "GitHub issue #5"
// produced a junk bug finding on every recent goal, which is why
// newObjective prose was rewritten trigger-word-free as a workaround.
// Real bug markers stay (TODO/FIXME/bug/regression/broken/fixme).
const CLASS_PATTERNS: Array<{ class: FindingClass; re: RegExp }> = [
  { class: "strategic", re: /\bshould we\b|\bdeprecat|ship this\??/i },
  { class: "architectural", re: /\brewrite\b|new dependency|schema change|\bredesign\b/i },
  { class: "bug", re: /\bTODO\b|\bFIXME\b|\bbug\b|regression|broken|\bfixme\b/i },
  { class: "refactor", re: /could be cleaner|consider refactoring|duplicat|refactor|left ?out|follow[\s-]?up|deferred|could be improved|improvement|enhancement|consider adding|would be nice|nice to have/i },
];

/** v0.26.3: lines that never carry findings — code, markdown tables, and
 * the reviewer's own report/config vocabulary. Observed false positives
 * from the 0.26.2 completion: a test("…architectural…") name, the
 * INSTALL.md mode-matrix row, and ship-doc prose. */
const SKIP_LINE = /^\s*(test|it|describe|assert|expect)\s*\(|^\s*(const|let|var|function|import|export|require)\b|\{\s*\.\.\.\s*\}|,\s*\.\.\.$|^\s*\||^\s*[{\[\]}]|^\s*['"]|^\s*ℹ/; // ℹ = test-runner/status noise ("ℹ todo 0" was enqueued as a /list item by the 0.26.2 reviewer)
// v0.34.83: GitHub-issue references (and "issue tracker/board") added —
// defense in depth for the "issue" misparse. Any line that mentions a
// GitHub issue number is a citation, not a finding.
const REVIEWER_VOCAB = /architectural-class|bug-class|refactor-class|strategic-class|reviewer found|cascade step|\*\*Mode\*\*|problems\s*\/\s*\(?(improvements|architectural)|\bgithub\s+issue\b|\bgh-\d+|\bissue\s+(tracker|board|queue)\b/i;

export function classifyFindingText(line: string): FindingClass | undefined {
  // Strip list markers here too (extractFindings already does, but direct
  // callers/tests pass raw report lines like "- ℹ todo 0").
  const t = line.trim().replace(/^[-*>\s\[\]x]+/, "");
  if (t.length < 8) return undefined;
  if (SKIP_LINE.test(t) || REVIEWER_VOCAB.test(t)) return undefined;
  for (const { class: cls, re } of CLASS_PATTERNS) {
    if (re.test(t)) return cls;
  }
  return undefined;
}

/** v0.26.4: remove fenced code blocks and inline code spans. Quoted
 * code is how completion summaries leak vocabulary into extraction —
 * the 0.26.3 misfire matched a backticked reviewer.ts line containing
 * four architectural patterns. */
export function stripCodeSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/** v0.28.24: join hard-wrapped lines before classification. Completion
 * summaries and transcripts arrive wrapped at ~70 cols, and line-by-line
 * extraction sliced findings at the wrap point (field-observed in
 * hellhunter: a list item whose ENTIRE objective was "Run a post-completion
 * regression scan on the hellhunter codebase to" — the first visual line of
 * a wrapped paragraph, enqueued by the convert-findings-to-list cascade).
 * A line that doesn't end a sentence continues on the next line unless that
 * line starts a new list item or heading. */
export function unwrapHardWrappedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const startsNewItem = /^\s*([-*•>]|\d+[.)]|#)/.test(line);
    // v0.28.24: join only when the continuation starts LOWERCASE — the
    // mid-sentence signal. Punctuation-less standalone items ("TODO: fix x")
    // start uppercase/keyword and must NOT merge with the next item.
    const continuesSentence = /^[a-z]/.test(line.trimStart());
    if (
      prev !== undefined &&
      prev.trim().length > 0 &&
      line.trim().length > 0 &&
      !startsNewItem &&
      continuesSentence &&
      !/[.!?:;)"'\]]$/.test(prev.trimEnd())
    ) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trimStart()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** v0.28.24: a candidate ending in a dangling connector is a wrap/parse
 * fragment, not a finding ("…codebase to", "…the settings and"). */
const DANGLING_END = /\s(to|and|or|but|the|a|an|of|for|with|in|on|at|that|which|into|from|by|is|are|was|were|be|been|so|if|then|than|as|nor|yet|per|via)$/i;

/** v0.28.24: cut at a clause boundary, never mid-word — the finding text IS
 * the item's user-facing name once enqueued. */
export function cutAtClauseBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  const clause = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("; "),
    window.lastIndexOf(", "),
    window.lastIndexOf(" — "),
    window.lastIndexOf(": "),
  );
  if (clause >= Math.floor(max * 0.4)) return window.slice(0, clause + 1).trimEnd();
  const space = window.lastIndexOf(" ");
  return (space > 0 ? window.slice(0, space) : window).trimEnd();
}

/** Scan source texts line-by-line for finding-shaped content. Code
 * spans are stripped first (v0.26.4) — findings live in prose. Hard-wrapped
 * lines are joined (v0.28.24) — findings are sentence-shaped, not
 * visual-line-shaped. `completedObjective` (v0.28.24) dedupes findings that
 * merely restate the just-completed goal (exact-match dedupe at v0.28.16 was
 * too narrow — duplicates arrive as prefixes/paraphrases). */
export function extractFindings(sources: Array<{ name: string; text: string }>, max: number, completedObjective?: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const completedNorm = completedObjective ? normalizeObjective(completedObjective) : "";
  for (const { name, text } of sources) {
    for (const line of unwrapHardWrappedLines(stripCodeSpans(text)).split("\n")) {
      const cls = classifyFindingText(line);
      if (!cls) continue;
      const clean = cutAtClauseBoundary(line.trim().replace(/^[-*>\s\[\]x]+/, ""), 200);
      if (clean.length < 8 || seen.has(clean)) continue;
      if (DANGLING_END.test(clean) || /[,;:\u2014-]$/.test(clean)) continue; // v0.28.24: wrap/parse fragment
      if (completedNorm) {
        const nf = normalizeObjective(clean);
        if (nf.length >= 24 && (completedNorm.startsWith(nf) || nf.startsWith(completedNorm))) continue; // v0.28.24: restates the completed goal
      }
      seen.add(clean);
      out.push({ text: clean, source: name, class: cls });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** v0.34.61: superseded-disapproval curation (field-observed 2026-08-06:
 * goal lhy6nt round-1 DISAPPROVED → round-2 APPROVED; the reviewer mined
 * the round-1 report verbatim into 3 junk /list items and cascade-
 * activated one). v0.26.4 already excludes APPROVED reports (the
 * executor's own claims — meta-text); this adds the missing half: a
 * disapproval SUPERSEDED by a later approval on the same goal is ANSWERED
 * work — its required fixes are exactly what the approval verified, so
 * re-mining it re-queues already-fixed findings. The LAST verdict for the
 * goal decides: approved → zero audit sources; disapproved/error → all
 * disapproved/error reports for that goal (the goal ended on an open
 * verdict — its fixes are genuinely outstanding). */
export function curateAuditReviewSources(
  entries: Array<{ goalId?: string; verdict?: string; report?: string }>,
  goalId: string,
): Array<{ report: string; verdict: string }> {
  const mineable = entries.filter(
    (e) => e.goalId === goalId && (e.verdict === "disapproved" || e.verdict === "error") && typeof e.report === "string" && e.report.length > 0,
  );
  if (mineable.length === 0) return [];
  const lastForGoal = entries.filter((e) => e.goalId === goalId).at(-1);
  if (lastForGoal && lastForGoal.verdict === "approved") return [];
  return mineable.map((e) => ({ report: e.report as string, verdict: e.verdict as string }));
}

/**
 * Choose the text a reviewer may mine. An archived goal is state metadata:
 * its Objective and verification-contract prose routinely contains words
 * such as "bug", "regression", or "follow-up" and is not an independent
 * finding. Automatic postaudit scans therefore use only curated auditor
 * reports; an explicit manual review may still inspect the archive. This
 * prevents a clean approved completion from enqueuing fragments of its own
 * objective/contract as new list goals.
 */
export function buildReviewerSources(
  archiveText: string | undefined,
  auditReports: readonly string[],
  manual: boolean,
): Array<{ name: string; text: string }> {
  const sources: Array<{ name: string; text: string }> = [];
  if (manual && archiveText) sources.push({ name: "archive", text: archiveText });
  for (const report of auditReports) sources.push({ name: "audit", text: report });
  return sources;
}

/** Runaway prevention (contract item 6/9): a reviewer fire in the last
 * `windowMs` suppresses re-firing — reviewer-created work completing
 * immediately must not recursively fire the reviewer. */
export function reviewerFiredRecently(entries: Array<{ type: string; at?: string }>, windowMs: number, nowMs: number): boolean {
  return entries.some((e) => e.type === "reviewer_fired" && e.at !== undefined && nowMs - Date.parse(e.at) < windowMs);
}

/** Per-day cap (contract item 10). */
export function reviewsToday(entries: Array<{ type: string; at?: string }>, nowMs: number): number {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return entries.filter((e) => e.type === "reviewer_fired" && e.at?.startsWith(day)).length;
}

export interface ReviewReport {
  goalId: string;
  kind: "goal" | "list";
  objective: string;
  findings: Finding[];
  cascadeStep: string;
  mode: ReviewerMode;
  at: string;
}

export function formatReviewReport(r: ReviewReport): string {
  const byClass = (c: FindingClass) => r.findings.filter((f) => f.class === c);
  const section = (title: string, items: Finding[]) =>
    items.length === 0 ? "" : `\n## ${title}\n\n${items.map((f) => `- ${f.text} _(${f.source})_`).join("\n")}\n`;
  return [
    `# Review — ${r.goalId}`,
    "",
    `**Kind**: ${r.kind} · **At**: ${r.at} · **Mode**: ${r.mode}`,
    "",
    "## Summary",
    "",
    `Completed: ${r.objective.slice(0, 300)}`,
    "",
    `**Cascade step**: ${r.cascadeStep}`,
    "",
    `## Findings (${r.findings.length})`,
    section("Bug-class (enqueued to /list, no Confirm)", byClass("bug")),
    section("Refactor-class (enqueued to /list, no Confirm)", byClass("refactor")),
    section("Architectural-class (proposed as /goal, Confirm required)", byClass("architectural")),
    section("Strategic-class (notify only)", byClass("strategic")),
    r.findings.length === 0 ? "\n(none — completion looks clean)\n" : "",
  ].join("\n");
}

export function writeReviewReport(cwd: string, report: ReviewReport): string {
  const dir = path.join(piGlaDir(cwd), "reviews");
  if (stateRootPending()) return path.join(dir, `${report.goalId}-deferred.md`); // deferred — never create the cwd tree
  fs.mkdirSync(dir, { recursive: true });
  const ts = report.at.replace(/[:.]/g, "-");
  const file = path.join(dir, `${report.goalId}-${ts}.md`);
  fs.writeFileSync(file, formatReviewReport(report));
  return file;
}

/** Injectable side effects — goal.ts binds these to the live session. */
export interface ReviewerDeps {
  cwd: string;
  nowMs: number;
  /** /review <id> manual invocation — bypasses fireOn/doNotFireOn gates,
   * the refire window, and the day cap (the user asked explicitly). */
  manual?: boolean;
  ledgerEntries: Array<{ type: string; at?: string; value?: any }>;
  /** Source texts for finding extraction (archive md, audit reports). */
  sources: Array<{ name: string; text: string }>;
  enqueueListItems: (objectives: string[]) => void;
  /** Deliver a /goal proposal message to the session. Returns true when the
   * message was actually sent; false when the send failed (the v0.28.8 E4
   * contract — a failed send must NOT count as `proposed`, else the user is
   * told about phantom proposals that never arrived). */
  proposeGoal: (objective: string, reason: string) => boolean;
  notify: (message: string, level: "info" | "warning") => void;
  ledger: (type: string, value: Record<string, unknown>) => void;
}

export interface ReviewerOutcome {
  fired: boolean;
  suppressedReason?: string;
  report?: ReviewReport;
  reportPath?: string;
  enqueued: number;
  proposed: number;
  /** v0.27.5: the cascade step that actually fired (notify-and-idle | convert-findings-to-list | queue-leftovers | fire-audit-on-clean | propose-goal | aggressive-relaunch | duplicate-suppressed) — surfaces in /goal status and tests. v0.28.16: "duplicate-suppressed" = the clean completion WAS a regression scan, so the follow-up scan was deduped. */
  cascadeStep?: string;
}

export const REVIEWER_REFIRE_WINDOW_MS = 5 * 60_000;

/** v0.28.16: normalize an objective for duplicate-compare — lowercase,
 * goal-ids (yyyyMMddHHmmss-xxxxxx) become <id>, whitespace collapses. */
export function normalizeObjective(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\d{14}-[a-z0-9]{6}\b/g, "<id>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The reviewer lifecycle (contract item 1). */
export function runReviewer(
  config: ReviewerConfig,
  source: { kind: "goal" | "list"; goalId: string; objective: string; terminal: string },
  deps: ReviewerDeps,
): ReviewerOutcome {
  const none = (suppressedReason: string): ReviewerOutcome => ({ fired: false, suppressedReason, enqueued: 0, proposed: 0 });
  if (!config.enabled && !deps.manual) return none("the postaudit is disabled (/glla postaudit → Enabled)");
  // v0.27.5: "off" mode is the user-friendly way to silence the postaudit
  // — equivalent to enabled=false but exposed via the postaudit menu.
  if (config.mode === "off" && !deps.manual) return none("postaudit mode is off (/glla postaudit → Mode)");
  const event = source.kind === "goal" ? `${source.terminal}` : "list-complete";
  if (!deps.manual) {
    if (config.doNotFireOn.includes(event)) return none(`this event type (${event}) is excluded in /glla postaudit → fire-on`);
    if (source.kind === "goal" && source.terminal !== "goal-complete") return none(`the goal ended as ${source.terminal}, not a completion — no follow-up fires`);
    if (!config.fireOn.includes(source.kind === "goal" ? "goal-complete" : "list-complete")) return none("this event type is excluded in /glla postaudit → fire-on");
    // v0.26.2: in auto mode the queue emptying is the cascade's natural
    // rhythm, not a runaway — the refire window must not strangle it.
    // (The per-day cap below still bounds everything.)
    const refireWindowApplies = !(config.mode === "auto" && source.kind === "list");
    if (refireWindowApplies && reviewerFiredRecently(deps.ledgerEntries, REVIEWER_REFIRE_WINDOW_MS, deps.nowMs)) {
      deps.ledger("reviewer_suppressed", { reason: "refire-window", goalId: source.goalId });
      return none("a postaudit ran within the last 5 minutes (runaway prevention)");
    }
    const today = reviewsToday(deps.ledgerEntries, deps.nowMs);
    if (today >= config.maxReviewsPerDay) {
      deps.ledger("reviewer_suppressed", { reason: "day-cap", count: today, cap: config.maxReviewsPerDay, goalId: source.goalId });
      return none(`daily postaudit cap reached (${today}/${config.maxReviewsPerDay}) — /glla postaudit → Max reviews`);
    }
  }

  const findings = extractFindings(deps.sources, config.maxFindingsPerReview, source.objective);
  const bugs = findings.filter((f) => f.class === "bug" || f.class === "refactor");
  const architectural = findings.filter((f) => f.class === "architectural");
  const strategic = findings.filter((f) => f.class === "strategic");

  let enqueued = 0;
  let proposed = 0;
  let cascadeStep = "notify-and-idle";
  const auto = config.mode === "auto" || config.mode === "aggressive";
  const aggressive = config.mode === "aggressive";

  // Cascade: findings → list items (leverage: fix-without-confirm).
  const convertStep = source.kind === "goal" ? "convert-findings-to-list" : "queue-leftovers";
  if (bugs.length > 0 && config.cascade.includes(convertStep)) {
    deps.enqueueListItems(bugs.map((f) => f.text));
    enqueued = bugs.length;
    cascadeStep = convertStep;
  }
  // Architectural findings: default mode → /goal proposal WITH Confirm;
  // auto mode → /list items (the auto-loop rolls straight into them).
  // aggressive mode → enqueue AND relaunch as the next active goal
  // (skips both Confirm and the queue — the unattended rig never stops).
  if (architectural.length > 0) {
    if (aggressive) {
      deps.enqueueListItems(architectural.map((f) => f.text));
      // v0.27.5 aggressive: also propose the FIRST architectural finding
      // as a relaunch so the queue gets burned through even when the
      // unattended rig can't Confirm.
      if (
        deps.proposeGoal(
          architectural[0]!.text,
          `aggressive postaudit: relaunching as /goal without Confirm (${architectural.length} architectural findings total)`,
        )
      ) {
        proposed += 1;
      }
      enqueued += architectural.length;
      cascadeStep = "aggressive-relaunch";
    } else if (auto) {
      deps.enqueueListItems(architectural.map((f) => f.text));
      enqueued += architectural.length;
      cascadeStep = convertStep;
    } else {
      if (
        deps.proposeGoal(
          architectural.map((f) => f.text).join("; "),
          `reviewer found ${architectural.length} architectural-class finding(s) — needs your Confirm`,
        )
      ) {
        proposed += architectural.length;
      }
      cascadeStep = "propose-goal";
    }
  }
  // Clean completion → audit: default mode proposes a /goal (Confirm);
  // auto mode enqueues the audit as a /list item (no Confirm — the
  // cascade keeps rolling until the findings run dry).
  // aggressive mode → relaunch the audit goal directly (no Confirm).
  if (findings.length === 0 && config.cascade.includes("fire-audit-on-clean")) {
    const auditObjective = `Post-completion regression scan after ${source.goalId} (${config.auditScope})`;
    // v0.28.16: duplicate-scan dedupe — the reviewer fires ON completion,
    // so source.objective IS the most recent completion. If the goal that
    // just completed was itself this same scan (normalized: goal-ids
    // stripped), the proposal would be a scan-of-a-scan — the cascade loop
    // that fired twice on 2026-07-28. Suppress the proposal/enqueue (the
    // report is still written; the ledger records the reason).
    if (normalizeObjective(source.objective) === normalizeObjective(auditObjective)) {
      deps.ledger("reviewer_suppressed", { reason: "duplicate-scan", goalId: source.goalId, objective: auditObjective });
      cascadeStep = "duplicate-suppressed";
    } else if (aggressive) {
      if (deps.proposeGoal(auditObjective, "aggressive postaudit: clean completion — relaunching the regression scan as /goal")) {
        proposed++;
      }
      cascadeStep = "aggressive-relaunch";
    } else if (auto) {
      deps.enqueueListItems([auditObjective]);
      enqueued++;
      cascadeStep = "fire-audit-on-clean";
    } else {
      if (deps.proposeGoal(auditObjective, "reviewer: completion looks clean — firing the audit step")) {
        proposed++;
      }
      cascadeStep = "fire-audit-on-clean";
    }
  }

  const report: ReviewReport = {
    goalId: source.goalId,
    kind: source.kind,
    objective: source.objective,
    findings,
    cascadeStep,
    mode: config.mode,
    at: new Date(deps.nowMs).toISOString(),
  };
  const reportPath = writeReviewReport(deps.cwd, report);
  deps.ledger("reviewer_fired", {
    goalId: source.goalId,
    kind: source.kind,
    findings: findings.length,
    enqueued,
    proposed,
    cascadeStep,
    report: path.relative(deps.cwd, reportPath),
  });
  deps.notify(
    `Reviewer: ${findings.length} finding(s) — ${enqueued} enqueued to /list, ${proposed} proposed as /goal (${cascadeStep}). Report: ${path.relative(deps.cwd, reportPath)}`,
    "info",
  );
  if (strategic.length > 0) {
    deps.notify(`Reviewer: ${strategic.length} strategic finding(s) need YOUR call — see the report's Strategic section.`, "warning");
  }
  return { fired: true, report, reportPath, enqueued, proposed, cascadeStep };
}

/** /glla reviewer menu options, derived from the config — extracted so
 * the menu surface is unit-testable without a pi host. */
export function reviewerMenuOptions(cfg: ReviewerConfig): string[] {
  return [
    `Enabled — ${cfg.enabled ? "ON" : "OFF"}`,
    `Mode — ${cfg.mode} (off = silenced · on = Confirm-gated cascade · auto = auto-loop, no Confirms · aggressive = auto + relaunch)`,
    `Fire on goal-complete — ${cfg.fireOn.includes("goal-complete") ? "ON" : "OFF"}`,
    `Fire on list-complete — ${cfg.fireOn.includes("list-complete") ? "ON" : "OFF"}`,
    `Cascade: audit-on-clean — ${cfg.cascade.includes("fire-audit-on-clean") ? "ON" : "OFF"}`,
    `Max findings per review — ${cfg.maxFindingsPerReview}`,
    `Max reviews per day — ${cfg.maxReviewsPerDay}`,
    "Done",
  ];
}
