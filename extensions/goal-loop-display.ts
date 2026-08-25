/**
 * pi-goal-list-loop-audit — v0.9.0
 * extensions/goal-loop-display.ts
 *
 * Pure display builders for the live TUI (status line + above-editor widget).
 * No pi imports — unit tests exercise these directly. The orchestrator calls
 * No RUNTIME imports at all: tests run under `node --experimental-strip-types`,
 * which does not rewrite `.js` → `.ts` specifiers — a value import from
 * ./goal-loop-core.js breaks the suite (type-only imports are erased, safe).
 * ctx.ui.setStatus/setWidget with whatever these return.
 */

import { truncateToWidth as tuiTruncateToWidth, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

import type { Goal, MainModelRecovery, State } from "./goal-loop-core.js";
import { compactDisplayText, formatMainModelRecoveryStatus, isPersistenceDegraded, lastPersistenceFailure, sanitizeDisplayText, sanitizeProviderAuditReport, sanitizeProviderDisplayText, stripThinkBlocks } from "./goal-loop-core.js";
import { HELD_ON_RESTORE, type LoopState } from "./goal-loop-forever.js";
import { auditorSurfaceSuppressed } from "./loops/goal-auditor-surface.js";

/** v0.34.57 (OPEN-ISSUES bug #1.8 / tasklist item #2): the MAIN host is
 * NEVER detached — it is always SUPERVISING, regardless of any handle state.
 * The DETACHED label belongs exclusively to the AUDITOR worker (which runs
 * in a separate process). This constant is the one-line guard: every MAIN
 * host render in this module MUST use this label. See
 * DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md §3 ("Current MAIN is not
 * detached"). */
export const MAIN_HOST_LABEL = "MAIN HOST · SUPERVISING";

/** v0.28.17: a loop parked by the session-restore gate (was active when the
 * last session ended). Held loops must stay VISIBLE — before, only
 * state.loop?.active rendered anything and a reload made the loop vanish
 * from the always-on UI (user report 2026-07-29: "loops are the most
 * immature"). Stopped loops (any other stopReason) stay invisible. */
function heldLoop(state: State): LoopState | undefined {
  const l = state.loop;
  return l && !l.active && l.stopReason === HELD_ON_RESTORE ? l : undefined;
}

// ---- formatters ----

export function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  // Seconds stay visible up to the hour: the elapsed counter is the
  // liveness signal — minute-only granularity looks frozen on a 1s tick.
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function truncate(s: string, max: number): string {
  const safe = compactDisplayText(s);
  return safe.length <= max ? safe : safe.slice(0, Math.max(0, max - 1)) + "…";
}

function displayPauseReason(reason: string): string {
  return compactDisplayText(sanitizeProviderDisplayText(reason));
}

/** v0.33.1: painted strings measure by their terminal-cell width. */
function visibleLen(s: string): number {
  return tuiVisibleWidth(s);
}

/** v0.33.0: 5-cell meter with a rounding guard (command-code's rule — never
 * shows empty or full unless the value truly is 0 or 1). */
export function meter(frac: number, cells = 5): string {
  if (!Number.isFinite(frac) || frac <= 0) return "▱".repeat(cells);
  if (frac >= 1) return "▰".repeat(cells);
  let filled = Math.round(frac * cells);
  if (filled === 0) filled = 1;
  if (filled === cells) filled = cells - 1;
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

/** v0.33.0: one finished tool call, for the slim card's "last action" line.
 * v0.34.124: `at` — epoch when the result landed — lets the card drop
 * entries from a PREVIOUS goal (the ring outlived a goal change and
 * showed the old goal's `✓ complete_goal (0s)` on the new goal's card
 * for 14 minutes; note.md 221249). */
export interface RecentActionDisplay {
  name: string;
  arg?: string;
  ms: number;
  ok: boolean;
  at?: number;
}

/** v0.33.0: widget extras — the refire streak plus the recent-action feed. */
export type GoalDisplayActivity = "active" | "awaiting-first-turn" | "working" | "busy" | "queued" | "idle";

export interface ModelProvenanceDisplay {
  /** The primary model reference selected for the supervised work. */
  primary?: string;
  /** Whether the primary is an explicit pin or inherited from the session. */
  primarySource?: "pinned" | "inherited";
  /** Ordered backup references available to the main-model recovery policy. */
  fallbackRefs?: string[];
  /** References rejected by the explicit forbidden-model gate. */
  skippedForbiddenRefs?: string[];
  /** Model reference observed at the current main-host turn boundary. */
  handledTurn?: string;
  /** Model reference currently executing the detached audit, if any. */
  handledAudit?: string;
  /** Candidate provenance for the detached audit (setting/fallback/session). */
  handledAuditSource?: string;
}

export interface WidgetExtras {
  stalls?: number;
  recent?: RecentActionDisplay[];
  /** v0.35.29 (issue #15): ambient tracked-subagent segment — count + the
   * longest-silent child. Hidden at zero tracked children. */
  agents?: { line: string };
  /** Ephemeral host-session projection; never persisted as goal state. */
  activity?: GoalDisplayActivity;
  /** Last real host stream activity, excluding timer/UI ticks. */
  lastActivityAt?: number;
  /** Last stream event used as proof for the live-work indicator. */
  lastStreamActivityAt?: number;
  /** v0.34.124: an accepted continuation dispatch is pending — pi has the
   * follow-up but has not started the turn (the QUEUED "why"; note.md
   * 221249 "time ticking but nothing else"). */
  turnPending?: boolean;
  /** v0.34.66: final-only gate for the auditor's streamed report. Default
   * on: the widget hides the live per-token tail while the detached worker
   * streams, showing the text once the verdict lands (note.md #4 — "auditor
   * words one by one"). false = live tail. */
  auditorSilent?: boolean;
  /** v0.34.86: intermediate progress-signal gate for silent audits. Default
   * on: the phase label ("reading source…" / "writing report…") and the
   * report byte-counter render while the prose tail is muted. false =
   * the plain timer-only card (the pre-v0.34.86 silent look). */
  auditorProgressSignals?: boolean;
  /** Effective global main-model backup order for truthful recovery HUDs. */
  mainModelFallbacks?: string[];
  /** Truthful model-selection provenance for the active goal card/footer. */
  modelProvenance?: ModelProvenanceDisplay;
  /** v0.35.15: the most recent ended auditor quiet stretch (runtime only,
   * never persisted). The footer shows "silent Xm then resumed" while it is
   * fresh so a silence the user missed stays visible afterwards. */
  auditorQuietStretch?: { ms: number; endedAt: number };
}

/**
 * Word-wrap to `width`, capped at `maxLines` (v0.27.1). A pause is the one
 * state where the FULL text matters — the reason often carries a decision
 * the user must make (dedup choices, impossible-verdict narrowing), and a
 * 60-char truncate hid it. Over-long words are hard-split; when the cap
 * cuts content the last line ends with "…" (the pause-time notification
 * and /goal status always carry the full text).
 */
export function wrap(s: string, width: number, maxLines: number): string[] {
  const norm = compactDisplayText(s);
  const words = norm.split(" ").filter(Boolean);
  const all: string[] = [];
  let cur = "";
  for (let w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) { cur = next; continue; }
    if (cur) all.push(cur);
    while (w.length > width) { all.push(w.slice(0, width)); w = w.slice(width); }
    cur = w;
  }
  if (cur) all.push(cur);
  if (all.length === 0) all.push("");
  if (all.length <= maxLines) return all;
  const out = all.slice(0, maxLines);
  // The last kept line already fits within width — truncate() would leave it
  // unmarked, so force the ellipsis to signal "more in /goal status".
  out[maxLines - 1] = out[maxLines - 1]!.slice(0, Math.max(0, width - 1)) + "…";
  return out;
}

/**
 * Width-aware truncation budget (v0.22.2). The hardcoded caps are FLOORS for
 * narrow terminals; when the terminal is wider, lines may use the available
 * width instead of being cut at a fixed ~60 chars (pi-tasks truncates at
 * tui.terminal.columns — match that behavior). `prefixCols` is the visible
 * width of the static prefix on the line. String-array widgets are rendered by
 * pi's Text component with one cell of left and right padding, so reserve both
 * cells here; otherwise a final word can wrap onto an unexpected extra line.
 */
const WIDGET_HORIZONTAL_MARGIN = 2;

/** v0.34.67: paragraph spacer for the widget's worker/subagent text.
 * pi-tui skips whitespace-only widget lines (Text.render returns [] when
 * trim is empty), so the spacer carries a non-breaking space — invisible in
 * every renderer (terminal, π-web HTML), never collapsed, and never
 * misread as punctuation. Inserted between the auditing card's observation
 * paragraph (`tool:`, `latest:`, …) and the footer verdict line (note.md
 * 08-06 "visually subagents least need more spacing for text",
 * Screenshot_20260806_223836). v0.34.123: the previous dim "│ ·" hairline
 * rendered as a lone "·" where the box-drawing glyph is dropped (π-web),
 * which the user flagged as a stray dot (note.md 08-10, 220759). */
export const WORKER_TEXT_SPACER = "\u00A0";

function budgetFor(width: number | undefined, prefixCols: number, floor: number): number {
  if (!width || width <= 0) return floor;
  return Math.max(floor, width - WIDGET_HORIZONTAL_MARGIN - prefixCols);
}

function uniqueModelRefs(refs: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of refs ?? []) {
    if (typeof value !== "string") continue;
    const ref = value.trim();
    if (!ref || seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    out.push(ref);
  }
  return out;
}

/**
 * Keep model selection provenance on the same always-visible card as the
 * goal. These are projections of observed/configured refs, not a guess from
 * elapsed time: the primary source is explicit, forbidden refs stay visible
 * as skipped, and the handled refs are separate from the configured order.
 */
function modelSourceLabel(source: string): string {
  const key = source.trim().toLowerCase();
  if (key === "setting" || key === "pinned" || key === "auditor-pin") return "pinned";
  if (key === "session" || key === "session-fallback") return "inherited from session";
  if (key.includes("fallback")) return "fallback";
  return source.trim();
}

function modelProvenanceLines(provenance: ModelProvenanceDisplay | undefined, width?: number): string[] {
  if (!provenance) return [];
  const budget = budgetFor(width, 3, 60);
  const lines: string[] = [];
  const primary = typeof provenance.primary === "string" ? provenance.primary.trim() : "";
  if (primary) {
    const source = provenance.primarySource === "pinned" ? "pinned" : "inherited from session";
    lines.push(`model: primary ${truncate(primary, budget)} · ${source}`);
  }
  const fallbacks = uniqueModelRefs(provenance.fallbackRefs);
  if (fallbacks.length > 0) lines.push(`fallbacks: ${truncate(fallbacks.join(" → "), budget)}`);
  const skipped = uniqueModelRefs(provenance.skippedForbiddenRefs);
  if (skipped.length > 0) lines.push(`skipped forbidden: ${truncate(skipped.join(", "), budget)}`);
  const handledTurn = typeof provenance.handledTurn === "string" ? provenance.handledTurn.trim() : "";
  if (handledTurn) lines.push(`handled turn: ${truncate(handledTurn, budget)}`);
  const handledAudit = typeof provenance.handledAudit === "string" ? provenance.handledAudit.trim() : "";
  if (handledAudit) {
    const source = provenance.handledAuditSource?.trim() ? modelSourceLabel(provenance.handledAuditSource) : "";
    const via = source ? ` · via ${truncate(source, 24)}` : "";
    lines.push(`handled audit: ${truncate(handledAudit, Math.max(16, budget - via.length))}${via}`);
  }
  return lines;
}

// ---- semantic colors (optional; tests call without a theme → plain strings) ----

export type DisplayColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";
export interface DisplayTheme {
  fg(color: DisplayColor, text: string): string;
}
const paint = (theme: DisplayTheme | undefined, color: DisplayColor, text: string): string => (theme ? theme.fg(color, text) : text);

/**
 * A live-work capsule is only rendered in the persistent status bar when the
 * host/worker supplied real activity evidence. It is deliberately not tied
 * to elapsed time alone: a durable active state can outlive a dead or merely
 * queued turn. The stream age beside it is the evidence freshness signal.
 *
 * The pulse is a liveness accent, not a progress meter. It is only reachable
 * after real stream/tool evidence has been observed, and it never claims a
 * completion percentage or remaining-work estimate.
 */
const LIVE_SIGNAL_FRAMES = [
  "▁▂▄▆█▆",
  "▂▄▆█▆▄",
  "▄▆█▆▄▂",
  "▆█▆▄▂▁",
  "█▆▄▂▁▂",
  "▆▄▂▁▂▄",
  "▄▂▁▂▄▆",
  "▂▁▂▄▆█",
] as const;
const LIVE_SIGNAL_FRAME_MS = 750;

function liveSignalFrame(now: number): string {
  const index = Math.floor(Math.max(0, now) / LIVE_SIGNAL_FRAME_MS) % LIVE_SIGNAL_FRAMES.length;
  return LIVE_SIGNAL_FRAMES[index]!;
}

function paintLiveSignal(frame: string, theme?: DisplayTheme): string {
  if (!theme) return frame;
  return Array.from(frame).map((cell) => {
    const color: DisplayColor = cell === "█" ? "success" : cell === "▁" ? "muted" : "accent";
    return paint(theme, color, cell);
  }).join("");
}

function activityBadge(label: string, now: number, theme?: DisplayTheme): string {
  const parts = label.split(" · ").map((part) => {
    const color: DisplayColor = part === "LIVE" ? "success" : part === "WORKING" ? "accent" : "accent";
    return paint(theme, color, part);
  });
  const separator = paint(theme, "dim", " · ");
  const signal = paintLiveSignal(liveSignalFrame(now), theme);
  return `${paint(theme, "dim", "[")}${signal}${paint(theme, "dim", " ")}${parts.join(separator)}${paint(theme, "dim", "]")}`;
}
function activityStateBadge(label: string, theme: DisplayTheme | undefined, color: DisplayColor): string {
  return paint(theme, color, `[${label}]`);
}

/** Pause reasons that mean "something broke", not "waiting on the user". */
const ERROR_PAUSE = /token limit|stalled|infra|auditor.*fail/i;
const pauseIsError = (g: Goal): boolean => ERROR_PAUSE.test(g.pauseReason ?? "");

/** v0.28.22: the rendering class of a pause — declared kind wins; legacy
 * pauses (no kind) fall back to the error-regex so old states still
 * classify sensibly. */
type PauseKind = "decision" | "error" | "wait" | "blocked";
const pauseKind = (g: Goal): PauseKind | undefined => g.pauseKind ?? (pauseIsError(g) ? "error" : undefined);

/** A released completion claim is infrastructure debt, not a semantic verdict.
 * Keep the MAIN/worker roles explicit so a dead detached auditor cannot make
 * the host look detached or leave the user staring at an indefinite wait. */
function isCompletionAuditNoVerdict(g: Goal): boolean {
  return g.status === "paused"
    && !!g.pendingCompletion
    && g.pendingCompletion.phase === "recovery-pending"
    && /audit|verdict/i.test(g.pauseReason ?? "");
}

/** Recovery display is intentionally generic. Pause-rendering classifies by
 * pauseKind (decision / error / wait / blocked) and uses one
 * `auto-retrying · next probe in X` surface for retry-class pauses. Bounded
 * diagnostics remain in durable state and the ledger; cards do not guess a
 * provider-side reason. */

/** Active goals can carry an operational warning while the agent is being
 * re-engaged. Do not render those as an ordinary green `active` card: a
 * failed detached auditor is not progress, and a missing turn-start proof is
 * not work. A disapproval or regression-shield rejection is different:
 * the claim WAS evaluated, so never call either one "no verdict". */
interface ActiveAttention {
  label: string;
  color: DisplayColor;
  detail: string;
  /** A concise, durable excerpt survives when the continuation turn never starts. */
  feedback?: string;
}

interface LatestAuditFeedback {
  label: "auditor disapproved" | "regression shield";
  text: string;
}

function latestAuditFeedback(g: Goal): LatestAuditFeedback | undefined {
  if (auditorSurfaceSuppressed()) return undefined;
  const verdict = [...(g.auditHistory ?? [])].reverse().find((entry) =>
    (entry.disapproved || (entry.approved && entry.regressionShieldPassed === false))
    && typeof entry.report === "string"
    && entry.report.trim().length > 0,
  );
  if (!verdict?.report) return undefined;
  // Keep the actionable tail when the report has one. Verdict markers alone
  // are not feedback; naming that explicitly is better than rendering a
  // blank-looking disapproval card.
  const safeReport = sanitizeProviderAuditReport(verdict.report);
  const requiredFixes = safeReport.match(/(?:^|\n)\s*(?:#{1,6}\s*)?required fixes\b[\s\S]*/i)?.[0];
  const report = sanitizeDisplayText(requiredFixes ?? safeReport.slice(-320))
    .replace(/<\/?(?:approved|disapproved|impossible)(?:\s[^>]*)?\s*\/?>(?:\s*)/gi, "")
    .trim();
  if (!report) return undefined;
  return {
    label: verdict.disapproved ? "auditor disapproved" : "regression shield",
    text: truncate(report, 320),
  };
}

function activeAttention(g: Goal): ActiveAttention | undefined {
  if (g.status !== "active" || !g.pauseReason) return undefined;
  if (/regression shield/i.test(g.pauseReason)) {
    return {
      label: "regression shield — evidence gap",
      color: "error",
      detail: "auditor approved; regression shield found missing evidence",
      feedback: latestAuditFeedback(g)?.text,
    };
  }
  if (/auditor disapproved/i.test(g.pauseReason)) {
    return {
      label: "auditor disapproved — fix the gap",
      color: "error",
      detail: "auditor verdict: disapproved",
      feedback: latestAuditFeedback(g)?.text,
    };
  }
  if (/auditor|completion audit/i.test(g.pauseReason)) {
    return {
      label: "auditor blocked — no verdict",
      color: "error",
      detail: "completion claim was not evaluated",
    };
  }
  return {
    label: "attention needed",
    color: pauseIsError(g) ? "error" : "warning",
    detail: "the active work needs attention",
  };
}

/** v0.34.27: an accepted dispatch with no start proof is a trigger/queue
 * failure, not proof that the host session disappeared. Keep the red
 * interrupted presentation, but tell the user which recovery is safe. */
function interruptedForNoStart(g: Goal): boolean {
  return /continuation start acknowledgement timed out/i.test(g.interruptedReason ?? "");
}

/** A pending claim without the new `running` marker is a legacy or
 * replacement-interrupted audit. It must never render as an active auditor. */
function auditRecoveryPending(g: Goal): boolean {
  return g.status === "auditing" && !!g.pendingCompletion && g.pendingCompletion.phase !== "running";
}

// ---- status line (one-liner, always-on) ----

export interface AuditDisplayProgress {
  /** Model reference selected for the currently running detached attempt. */
  model?: string;
  /** Candidate provenance: pinned setting, fallback pin, or session fallback. */
  via?: string;
  currentTool?: string;
  /** JSON-safe tool arguments from the detached worker; display only a safe target summary. */
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  label?: string;
  phase?: "starting" | "running" | "thinking" | "tool_executing" | "producing_report" | "complete";
  elapsedMs?: number;
  /** Inferred start epoch for a live elapsed counter between worker events. */
  startedAt?: number;
  /** Latest non-verdict text observed from the worker's report stream. */
  recentOutput?: string[];
  /** Completed auditor tool calls retained by the worker for live context. */
  toolCalls?: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
  /** v0.34.56: explicit counts of unmatched tool start/end telemetry facts
   * (events that provably never paired). Shown honestly — never hidden, and
   * never silently re-paired into the paired toolCalls list. */
  unmatchedToolStarts?: number;
  unmatchedToolEnds?: number;
  /** Parent-observed progress-file change; useful for legacy callers. */
  lastEventAt?: number;
  /** Worker-side activity, excluding parent polls and UI refreshes. */
  lastActivityAt?: number;
  /** v0.34.86: monotonic report-stream byte count (text_delta chars) — the
   * silent-mode progress evidence that never reveals prose. */
  reportBytes?: number;
}

type AuditorDisplayPhase = "queued" | "running" | "quiet" | "blocked" | "awaiting-verdict";
/** v0.35.15: exported — the parent-side quiet watcher (goal-ui ticker) uses
 * the same threshold for the one-shot proactive notify so the notification
 * and the status chip can never disagree about when "quiet" begins. */
export const AUDITOR_QUIET_MS = 3 * 60_000;
/** v0.35.15: how long the "silent Xm then resumed" fact stays in the footer
 * after a quiet stretch ends — long enough to be seen, short enough not to
 * become permanent noise. */
const QUIET_STRETCH_VISIBLE_MS = 10 * 60_000;
const LIVE_ACTIVITY_MS = 15_000;

/** Use worker activity for liveness. Fall back to the parent event timestamp
 * for older callers/tests that only know when a progress file was observed. */
function auditorActivityAge(audit: AuditDisplayProgress | null | undefined, now: number): number | undefined {
  if (!audit) return undefined;
  // A detached progress record with a phase but no worker timestamp is the
  // pre-RPC/startup state. Do not turn the parent's poll time into fake
  // evidence that the worker has already done work. Keep the lastEventAt
  // fallback only for legacy callers that never supplied a phase.
  const at = audit.lastActivityAt ?? (audit.phase === undefined && audit.label !== "queued" ? audit.lastEventAt : undefined);
  if (at === undefined || !Number.isFinite(at)) return undefined;
  return Math.max(0, now - at);
}

function auditorLastActivity(audit: AuditDisplayProgress | null | undefined, now: number): string {
  if (!audit?.lastActivityAt || !Number.isFinite(audit.lastActivityAt)) return "";
  // v0.34.57 (H-code fix — DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05):
  // a future timestamp (worker clock ahead / skew) is NOT a fresh heartbeat.
  // Returning "" suppresses the misleading "0s ago" suffix the old
  // `Math.max(0, ...)` clamp produced. The companion gate in
  // `auditorHasLiveEvidence` also rejects future timestamps so the LIVE
  // badge does not render.
  if (audit.lastActivityAt > now) return "";
  return ` · worker activity ${fmtElapsed(now - audit.lastActivityAt)} ago`;
}

/** Keep the always-on status line useful even when the widget is hidden:
 * elapsed wall time, evidence freshness, and the next lifecycle transition
 * are display facts, not claims that the host is paused or that a verdict has
 * already landed. */
function auditorElapsedMs(audit: AuditDisplayProgress | null | undefined, now: number): number | undefined {
  const elapsed = audit?.elapsedMs;
  if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const startedAt = audit?.startedAt;
  if (startedAt !== undefined && Number.isFinite(startedAt) && startedAt <= now) {
    return Math.max(elapsed, now - startedAt);
  }
  return elapsed;
}

function auditorElapsedSuffix(audit: AuditDisplayProgress | null | undefined, now: number): string {
  const elapsed = auditorElapsedMs(audit, now);
  return elapsed === undefined ? "" : ` · elapsed ${fmtElapsed(elapsed)}`;
}

function auditorFreshnessSuffix(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase, now: number): string {
  const at = audit?.lastActivityAt;
  if (phase === "awaiting-verdict" && (at === undefined || !Number.isFinite(at))) return " · worker finished";
  if (at === undefined || !Number.isFinite(at)) return " · freshness pending";
  if (at > now) return " · freshness unknown";
  return now - at <= LIVE_ACTIVITY_MS ? " · fresh" : " · stale";
}

function auditorNextTransition(phase: AuditorDisplayPhase): string {
  switch (phase) {
    case "queued": return "detached worker start";
    case "running": return "worker completion → verdict";
    case "quiet": return "worker event or /goal cancel";
    case "blocked": return "retry/resolve or /goal cancel";
    case "awaiting-verdict": return "apply detached verdict";
  }
}

/** Summarize evidence without exposing the worker's report prose or think
 * blocks. Tool names, call counts, report byte counts, and the existence of a
 * final report are safe telemetry; the report itself remains behind the
 * existing silent/final-only gate. */
function auditorEvidenceSummary(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase): string | undefined {
  if (!audit) return undefined;
  const parts: string[] = [];
  if ((audit.recentOutput?.length ?? 0) > 0) {
    parts.push(phase === "awaiting-verdict" ? "final report" : "report stream observed");
  }
  if (typeof audit.reportBytes === "number" && Number.isFinite(audit.reportBytes) && audit.reportBytes > 0) {
    parts.push(`${fmtByteCount(audit.reportBytes)} report`);
  }
  const calls = audit.toolCalls?.length ?? 0;
  if (calls > 0) parts.push(`${calls} audit call${calls === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Project the detached worker's raw progress into the five user-facing
 * phases. A durable running claim without an observed progress event is not
 * green proof of work: it is explicitly waiting for a verdict.
 * v0.35.15: exported for the parent-side quiet watcher — one phase
 * projection, shared by the renderer and the notifier, so both surfaces
 * always agree on the current phase. */
export function auditorDisplayPhase(g: Goal, audit: AuditDisplayProgress | null | undefined, now: number): AuditorDisplayPhase {
  const label = audit?.label?.toLowerCase() ?? "";
  if (label === "queued") return "queued";
  if (/infra|error|failed|blocked|no verdict/.test(label)) return "blocked";
  if (audit?.phase === "complete") return "awaiting-verdict";
  const age = auditorActivityAge(audit, now);
  if (age !== undefined && age > AUDITOR_QUIET_MS) return "quiet";
  if (!audit && g.pendingCompletion?.phase === "running") return "awaiting-verdict";
  return "running";
}

/** v0.34.86: objective-vocabulary phase label for the silent-mode progress
 * signals. The coarse labels stay for everything else; these two are the
 * ones the audit note names ("reading source…" / "writing report…") and the
 * ones a long silent pass lingers on. Gated by auditorProgressSignals and
 * only applied while the coarse phase is running (quiet/blocked/awaiting
 * verdict keep their single state label). */
function auditorProgressPhaseLabel(audit: AuditDisplayProgress | null | undefined): string | undefined {
  switch (audit?.phase) {
    case "thinking": return "reading source…";
    case "producing_report": return "writing report…";
    default: return undefined;
  }
}

/** v0.34.86: humanize a byte/char count for the report byte-counter. */
function fmtByteCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function auditorPhaseLabel(phase: AuditorDisplayPhase): string {
  switch (phase) {
    case "queued": return "queued";
    case "running": return "running";
    case "quiet": return "quiet";
    case "blocked": return "blocked";
    case "awaiting-verdict": return "awaiting verdict";
  }
}

/** v0.35.15: at-a-glance glyph per auditor phase — the status footer is
 * dense text, and a distinct leading glyph lets a glance answer "is the
 * audit alive?" without reading the sentence. Kept in one map so the
 * renderer and tests share the exact vocabulary. */
export function auditorPhaseGlyph(phase: AuditorDisplayPhase): string {
  switch (phase) {
    case "queued": return "⋯";      // waiting to start
    case "running": return "▶";     // worker alive
    case "quiet": return "◌";       // silent — possibly stuck
    case "blocked": return "⛔";    // infra failure / needs intervention
    case "awaiting-verdict": return "✓"; // worker done, verdict pending
  }
}

/** v0.35.15: compact activity meter for the auditing footer — recency of
 * the last worker event as ▰▱ cells. Full = fresh evidence, draining as
 * the silence grows, empty at/after AUDITOR_QUIET_MS. Gives the same
 * "bar is draining" readability the loop's stall meter already has. */
function auditorActivityMeter(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase, now: number): string {
  const age = auditorActivityAge(audit, now);
  if (age === undefined) return meter(0);
  if (phase === "awaiting-verdict") return meter(1); // finished — full, not draining
  return meter(Math.max(0, Math.min(1, 1 - age / AUDITOR_QUIET_MS)));
}

/** Keep the broad liveness phase for compatibility, but expose the worker's
 * observed sub-phase so `running` does not look like a frozen icon/timer. */
function auditorObservedPhase(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase): string {
  if (phase !== "running") return auditorPhaseLabel(phase);
  switch (audit?.phase) {
    case "starting": return "starting";
    case "thinking": return "thinking";
    case "tool_executing": return "tool executing";
    case "producing_report": return "producing report";
    case "complete": return "awaiting verdict";
    default: return "running";
  }
}

function auditorPhaseForDisplay(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase, live: boolean): string {
  // Once a worker timestamp exists, a stale tool snapshot is historical
  // context, not a claim that the detached process is still in that call.
  if (!live && phase === "running" && audit?.lastActivityAt !== undefined && audit.currentTool) {
    return "last observed tool";
  }
  return auditorObservedPhase(audit, phase);
}

function auditorHasLiveEvidence(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase, now: number): boolean {
  if (phase !== "running" || audit?.lastActivityAt === undefined || !Number.isFinite(audit.lastActivityAt)) return false;
  // v0.34.57 (H-code fix): reject future timestamps. A lastActivityAt in the
  // future is clock-skew or a stuck worker, NOT a fresh heartbeat. The old
  // comparison `now - lastActivityAt <= LIVE_ACTIVITY_MS` treated any
  // non-positive age as live, so a future timestamp rendered LIVE + "0s ago"
  // forever.
  if (audit.lastActivityAt > now) return false;
  return now - audit.lastActivityAt <= LIVE_ACTIVITY_MS;
}

/** The worker's JSON argument prefix may contain a full command or path. Only
 * expose a basename-like target in the TUI; never dump arbitrary arguments. */
function auditorToolTarget(args: string | undefined): string | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value = parsed.path ?? parsed.file_path;
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const clean = compactDisplayText(value);
    const target = clean.split(/[\\/]/).filter(Boolean).at(-1);
    return target ? truncate(target, 32) : undefined;
  } catch {
    return undefined;
  }
}

/** Return one safe, compact report-stream line. Think blocks and verdict-only
 * markers are intentionally omitted: this is activity telemetry, not a
 * second verdict surface. Join the retained fragments before stripping so an
 * unterminated streamed `<think>` block suppresses its later fragments too. */
function latestAuditorOutput(audit: AuditDisplayProgress | null | undefined): string | undefined {
  // recentOutput is detached-worker telemetry, not durable diagnostics, but
  // it can still contain the provider's raw 403/429/Token Plan payload while
  // the worker is live or waiting for the verdict. Apply the same whole-report
  // projection used by audit history before selecting the latest line.
  const stream = sanitizeProviderAuditReport(stripThinkBlocks((audit?.recentOutput ?? []).join("\n")))
    .replace(/<\/?(?:approved|disapproved|impossible)(?:\s[^>]*)?\/?>(?:\s*)/gi, "");
  for (const entry of stream.split("\n").reverse()) {
    const clean = compactDisplayText(sanitizeDisplayText(entry)).trim();
    if (clean) return truncate(clean, 180);
  }
  return undefined;
}

function lastAuditorTool(audit: AuditDisplayProgress | null | undefined): string | undefined {
  const name = audit?.toolCalls?.at(-1)?.name;
  return typeof name === "string" && name.trim() ? truncate(name, 30) : undefined;
}

function goalDisplayActivity(g: Goal, extras?: WidgetExtras): GoalDisplayActivity {
  if (g.status !== "active") return "active";
  return extras?.activity ?? "active";
}

function hostLastActivity(extras: WidgetExtras | undefined, now: number): string {
  const at = extras?.lastActivityAt;
  if (at === undefined || !Number.isFinite(at)) return "";
  return ` · last host activity ${fmtElapsed(Math.max(0, now - at))} ago`;
}

function hostLastStream(extras: WidgetExtras | undefined, now: number): string {
  const at = extras?.lastStreamActivityAt;
  if (at === undefined || !Number.isFinite(at)) return "";
  return ` · last stream ${fmtElapsed(Math.max(0, now - at))} ago`;
}

/** Paused-state lifecycle projection. Pausing is durable, but it is not a
 * blank state: users need to know who owns recovery, whether queue work is
 * parked safely, when the host last made progress, and what happens next.
 * These helpers are display-only; they never infer or mutate lifecycle state. */
function pausedRecoveryOwner(g: Goal, state: State): string {
  if (isCompletionAuditNoVerdict(g)) return "detached auditor recovery";
  if (state.mainModelRecovery) {
    return "main-model recovery";
  }
  switch (pauseKind(g)) {
    case "decision": return "user decision";
    case "error": return "user action";
    case "wait": return "glla recovery timer";
    case "blocked": return "manual action";
    default: return "manual resume";
  }
}

function pausedLastActivity(g: Goal, extras: WidgetExtras | undefined, now: number): string {
  const at = extras?.lastActivityAt;
  if (at !== undefined && Number.isFinite(at) && at > 0 && at <= now) {
    return `last host activity ${fmtElapsed(now - at)} ago`;
  }
  const hasEvidence = !!g.telemetry || (g.usage?.tokensUsed ?? 0) > 0 || (g.auditHistory?.length ?? 0) > 0;
  return hasEvidence ? "last host activity not available" : "last host activity not observed";
}

/** The goal's total wall-clock age. This intentionally includes parked,
 * recovery, and auditor time; it is not a claim about active model compute. */
function goalTotalText(g: Goal, now: number): string {
  const startedAt = Date.parse(g.createdAt);
  return Number.isFinite(startedAt) ? `total ${fmtElapsed(Math.max(0, now - startedAt))}` : "";
}

function pausedNextTransition(g: Goal, state: State, now: number): string {
  const resume = g.policy === "list" ? "/list resume" : "/goal resume";
  const retryAt = state.mainModelRecovery?.retryAt ? Date.parse(state.mainModelRecovery.retryAt) : Number.NaN;
  if (Number.isFinite(retryAt) || state.mainModelRecovery?.pendingModelSwitch) {
    // Never claim a provider-side reset at a particular time. The :00:30
    // hourly retry is only an extra attempt, and the next transition is an
    // automatic retry.
    // The parked head remains authoritative while recovery state is still
    // present, including after retryAt has passed but before the recovery
    // dispatch clears/unparks the goal. Do not claim "resuming now" on the
    // same line that says the goal is still parked in recovery.
    return "retrying automatically";
  }
  const resumeAt = g.pauseResumeAt ? Date.parse(g.pauseResumeAt) : Number.NaN;
  if (Number.isFinite(resumeAt)) {
    return resumeAt <= now ? "resuming now" : `auto-retry in ${fmtElapsed(resumeAt - now)}`;
  }
  if (isCompletionAuditNoVerdict(g)) {
    const retryAt = g.pendingCompletion?.recoveryRetryAt
      ? Date.parse(g.pendingCompletion.recoveryRetryAt)
      : g.pauseResumeAt ? Date.parse(g.pauseResumeAt) : Number.NaN;
    if (Number.isFinite(retryAt)) {
      return retryAt <= now ? "automatic auditor retry due now" : `automatic auditor retry in ${fmtElapsed(retryAt - now)}`;
    }
    return `${resume} starts a fresh auditor`;
  }
  switch (pauseKind(g)) {
    case "decision": return `user decision → ${resume}`;
    case "error": return `manual action → ${resume}`;
    case "blocked": return resume;
    case "wait": return "recovery timer";
    default: return resume;
  }
}

function pausedLifecycleLines(g: Goal, state: State, extras: WidgetExtras | undefined, now: number): [string, string] {
  const queued = state.list?.length ?? 0;
  return [
    `lifecycle: safely parked · owner: ${pausedRecoveryOwner(g, state)} · ${queued > 0 ? `${queued} queued` : "queue empty"}`,
    `${pausedLastActivity(g, extras, now)} · next: ${pausedNextTransition(g, state, now)}`,
  ];
}

function pausedStatusSuffix(g: Goal, state: State, extras: WidgetExtras | undefined, now: number, queueFirst = false): string {
  const [lifecycle, transition] = pausedLifecycleLines(g, state, extras, now);
  const queueLabel = (state.list?.length ?? 0) > 0 ? `${state.list!.length} queued` : "queue empty";
  const lifecycleText = lifecycle.replace(/^lifecycle: /, "");
  const repair = g.repairTarget ? ` · replan required: ${truncate(g.repairTarget.objective.replace(/\s+/g, " "), 100)}` : "";
  if (queueFirst) {
    return ` · ${queueLabel} · ${lifecycleText.replace(` · ${queueLabel}`, "")} · ${transition}${repair}`;
  }
  return ` · ${lifecycleText} · ${transition}${repair}`;
}

/**
 * One-line status for ctx.ui.setStatus("pi-glla", …).
 * Returns undefined when nothing is being supervised (clears the segment).
 */
/** v0.35.15: the exported status line. When `/glla pause` has frozen the
 * supervisor, EVERY state gets a leading ⏸ supervisor chip — the user must
 * be able to see at a glance that automatic machinery is off, in every
 * lifecycle branch (active/auditing/paused/loop/recovery). The chip is
 * injected after the literal `glla:` prefix so no per-branch edit can
 * forget it and a future branch inherits it for free. */
export function buildStatusText(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, extras?: WidgetExtras): string | undefined {
  const base = buildStatusTextBase(state, audit, now, theme, extras);
  if (!base || typeof state.supervisorPausedAt !== "number") return base;
  return base.replace(/^glla:/, `glla: ${paint(theme, "warning", "⏸ supervisor")} ·`);
}

function buildStatusTextBase(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, extras?: WidgetExtras): string | undefined {
  if (state.loop?.active) {
    const l = state.loop;
    // v0.26.1: surface the refire streak — a spinning supervisor is the
    // zombie signature (hegemon incident: 619 refires, 0 turns).
    const stallSuffix = (extras?.stalls ?? 0) > 0 ? ` · ${paint(theme, "warning", `stalls:${extras!.stalls}`)}` : "";
    // v0.23.0: metricless spec loop — no arrow/best/stall, no plateau.
    if (!l.measureCmd) {
      return `glla: loop ${paint(theme, "accent", "∞")} iter ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""} · metricless${stallSuffix}`;
    }
    const arrow = paint(theme, "accent", l.direction === "min" ? "↓" : "↑");
    const stallText = `stall ${l.stallCount}/${l.plateauWindow}`;
    const stall = l.stallCount >= l.plateauWindow - 1 ? paint(theme, "warning", stallText) : stallText;
    return `glla: loop ${arrow} iter ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"} · best ${l.bestValue ?? "n/a"} · ${stall}${stallSuffix}`;
  }
  const g = state.goal;
  const held = heldLoop(state);
  if (state.loop && !state.loop.active && state.mainModelRecovery?.kind === "loop") {
    const summary = formatMainModelRecoveryStatus(state.mainModelRecovery, extras?.mainModelFallbacks);
    return `glla: ${paint(theme, "warning", "⏳ loop recovery")}${summary.map((line) => ` · ${line.replace(/^Main-model recovery: /, "")}`).join("")}`;
  }
  // v0.28.17: a held loop rides every goal state as a compact suffix.
  const heldSuffix = held ? paint(theme, "warning", " · loop⏸held") : "";
  if (!g) {
    if (state.mainModelRecovery) {
      const summary = formatMainModelRecoveryStatus(state.mainModelRecovery, extras?.mainModelFallbacks);
      return `glla: ${paint(theme, "warning", "⏳ main-model recovery")}${summary.map((line) => ` · ${line.replace(/^Main-model recovery: /, "")}`).join("")}`;
    }
    if (held) return `glla: loop ${paint(theme, "warning", "⏸ held")} · iter ${held.iteration} — /loop to resume`;
    if ((state.list?.length ?? 0) > 0) return waitingListStatus(state, now, theme);
    return undefined;
  }
  if (g.status === "auditing") {
    const host = paint(theme, "accent", MAIN_HOST_LABEL);
    if (auditRecoveryPending(g)) {
      return `glla: ${host} · ${paint(theme, "warning", "audit recovery pending")}${heldSuffix}`;
    }
    const phase = auditorDisplayPhase(g, audit, now);
    const live = auditorHasLiveEvidence(audit, phase, now);
    // v0.34.86: objective-vocabulary phase label when progress signals are
    // on — "auditor reading source…" names the work the coarse "thinking"
    // label hid. Opt-out via auditorProgressSignals.
    const signals = extras?.auditorProgressSignals !== false;
    const observed = signals && phase === "running"
      ? (auditorProgressPhaseLabel(audit) ?? auditorPhaseForDisplay(audit, phase, live))
      : auditorPhaseForDisplay(audit, phase, live);
    // v0.35.15: leading phase glyph + draining activity meter — a glance
    // answers "is the audit alive?" without reading the sentence.
    const phaseText = `auditor ${auditorPhaseGlyph(phase)} ${observed}`;
    const color = phase === "blocked" || phase === "quiet" ? "warning" : live ? "success" : "accent";
    const activityMeter = auditorActivityMeter(audit, phase, now);
    const label = live
      ? `${paint(theme, "success", phaseText)} ${paint(theme, "accent", activityMeter)} ${activityBadge("AUDITOR · DETACHED · LIVE", now, theme)}`
      : `${paint(theme, color, phaseText)} ${paint(theme, color === "warning" ? "warning" : "dim", activityMeter)}`;
    // A current tool is present-tense evidence only while its worker
    // heartbeat is fresh. Older snapshots stay useful as `last tool:` facts,
    // never as a claim that the detached process is still in that call.
    const staleSnapshot = !live && (phase !== "running" || audit?.lastActivityAt !== undefined);
    const toolName = audit?.currentTool
      ? truncate(audit.currentTool, 30)
      : lastAuditorTool(audit);
    const tool = toolName
      ? staleSnapshot ? ` · last tool: ${toolName}` : ` · ${toolName}`
      : "";
    const evidence = auditorEvidenceSummary(audit, phase);
    const elapsed = auditorElapsedSuffix(audit, now);
    const workerActivity = auditorLastActivity(audit, now);
    const freshness = auditorFreshnessSuffix(audit, phase, now);
    // v0.35.15: once a quiet stretch ends and activity resumes, keep the
    // fact visible for 10 minutes so the user learns the silence happened
    // even if they missed the proactive notify (the seed's exact complaint:
    // "only 8 minutes of not reporting anything … would be best to know").
    const stretch = extras?.auditorQuietStretch;
    const stretchSuffix = stretch && Number.isFinite(stretch.ms) && stretch.ms >= AUDITOR_QUIET_MS
      && now - stretch.endedAt <= QUIET_STRETCH_VISIBLE_MS
      ? ` · ${paint(theme, "warning", `silent ${fmtElapsed(stretch.ms)} then resumed`)}`
      : "";
    const next = ` · next: ${auditorNextTransition(phase)}`;
    return `glla: ${host} · ${label}${tool}${evidence ? ` · evidence: ${evidence}` : ""}${elapsed}${workerActivity}${freshness}${stretchSuffix}${next} · detached worker${heldSuffix}`;
  }
  if (g.status === "paused") {
    // v0.28.22: the status line names the ACTIONABILITY, not the reason —
    // "decision needed" / "action needed" / "waiting" tell you at a glance
    // whether the session needs you. Legacy pauses keep the reason dump.
    // v0.34.1: the policy word leaves the status line — the widget's head
    // chip already names the type ("list item"), so "glla: list ⏸ …" doubled
    // it. Status line = state/actionability only.
    if (isCompletionAuditNoVerdict(g)) {
      // v0.34.87: surface separation — a paused item is NOT host-bearing.
      // The old line claimed "MAIN HOST · SUPERVISING" while the card read
      // "paused · 1h 31m": two contradictory surfaces (note.md Screenshots
      // 161659/161718). The MAIN host is not supervising anything while the
      // item is parked; the status line leads with the pause (goal state)
      // and names the resume action — glla's "session idle, awaiting
      // /list resume". The v0.34.57 MAIN_HOST_LABEL guard still covers
      // host-bearing states (auditing); this paused state is deliberately
      // not host-bearing anymore.
      const resume = g.policy === "list" ? "/list resume" : "/goal resume";
      const retryAt = g.pendingCompletion?.recoveryRetryAt
        ? Date.parse(g.pendingCompletion.recoveryRetryAt)
        : g.pauseResumeAt ? Date.parse(g.pauseResumeAt) : Number.NaN;
      const retry = Number.isFinite(retryAt)
        ? retryAt <= now ? "auto-retry due now" : `auto-retry in ${fmtElapsed(retryAt - now)}`
        : resume;
      return `glla: ${paint(theme, "warning", "⏸ paused")} · ${paint(theme, "dim", "auditor parked — no verdict")} · ${retry}${pausedStatusSuffix(g, state, extras, now, true)}${heldSuffix}`;
    }
    const kind = pauseKind(g);
    if (kind === "decision") return `glla: ${paint(theme, "accent", "⏸ decision needed")}${pausedStatusSuffix(g, state, extras, now)}${heldSuffix}`;
    if (kind === "error") return `glla: ${paint(theme, "error", `⏸ action needed — ${truncate(displayPauseReason(g.pauseReason ?? ""), 30)}`)}${pausedStatusSuffix(g, state, extras, now)}${heldSuffix}`;
    if (kind === "wait" || kind === "blocked") {
      // v0.34.12: live countdown (the UI ticker keeps rendering through a
      // timed wait) — "auto-retry in 23m" beats a static clock time, and a
      // passed resumeAt says "resuming…" instead of lying about the past.
      // Every retry-class pause renders the same ⏳ auto-retrying… line +
      // countdown; blocked pauses without a recovery timer render as
      // ⏸ action needed. A main-model manual hold names its recovery owner.
      const rms = g.pauseResumeAt ? Date.parse(g.pauseResumeAt) - now : Number.NaN;
      const when = Number.isFinite(rms)
        ? rms <= 0 ? " · resuming…" : ` · auto-retry in ${fmtElapsed(rms)}`
        : "";
      if (kind === "blocked") {
        const label = state.mainModelRecovery?.manualResumeRequired === true
          ? "⏸ manual recovery hold"
          : `⏸ action needed${when}`;
        return `glla: ${paint(theme, "warning", label)}${pausedStatusSuffix(g, state, extras, now)}${heldSuffix}`;
      }
      // v0.34.102 (field: dracon-platform 2026-08-08 091828 "pi did not
      // start a turn"): a wait-pause parked on mainModelRecovery must name
      // the blocker, not promise a live retry. "auto-retrying · auto-retry
      // in 42m" read as pi actively starting turns; in fact NO turn starts
      // while the goal is parked in recovery. Mirror the queued-envelope
      // wording so both surfaces agree. Do not promise a provider-side reset
      // time; the hourly retry is only an extra retry.
      const parked = state.mainModelRecovery?.retryAt ? Date.parse(state.mainModelRecovery.retryAt) : Number.NaN;
      if (Number.isFinite(parked) || state.mainModelRecovery?.pendingModelSwitch) {
        const label = "⏳ main-model recovery — retrying automatically";
        return `glla: ${paint(theme, "dim", label)}${pausedStatusSuffix(g, state, extras, now)}${heldSuffix}`;
      }
      return `glla: ${paint(theme, "dim", `⏳ auto-retrying${when}`)}${pausedStatusSuffix(g, state, extras, now)}${heldSuffix}`;
    }
    const label = `paused ⏸ ${truncate(displayPauseReason(g.pauseReason ?? ""), 40)}`;
    return `glla: ${paint(theme, pauseIsError(g) ? "error" : "warning", label)}${pausedStatusSuffix(g, state, extras, now)}${heldSuffix}`;
  }
  if (g.status === "active") {
    const recoverySummary = formatMainModelRecoveryStatus(state.mainModelRecovery, extras?.mainModelFallbacks);
    const withRecovery = (value: string): string => recoverySummary.length > 0
      ? `${value} · ${recoverySummary.map((line) => line.replace(/^Main-model recovery: /, "")).join(" · ")}`
      : value;
    // v0.28.1 (S1/S2): a stale-handle interrupt keeps the goal ACTIVE.
    // It outranks any older operational note on the same state snapshot.
    if (g.interruptedAt) {
      const label = interruptedForNoStart(g)
        ? "⚠ turn start not observed — automatic retry held"
        : "⚠ interrupted — stale handle · /new (or a fresh session_start) rebinds";
      return withRecovery(`glla: ${paint(theme, "error", label)}${heldSuffix}`);
    }
    const attention = activeAttention(g);
    if (attention) {
      return withRecovery(`glla: ${paint(theme, attention.color, `⚠ ${attention.label}`)}${heldSuffix}`);
    }
    const activity = goalDisplayActivity(g, extras);
    // v0.34.97: while the post-compaction grace window is open, surface
    // "compacting…" so the user knows the session just shrank. The chip
    // survives reload because lastCompactionAt is persisted on State.
    const compactAgeMs = state.lastCompactionAt ? now - state.lastCompactionAt : Number.POSITIVE_INFINITY;
    const compacting = Number.isFinite(compactAgeMs) && compactAgeMs >= 0 && compactAgeMs < 180_000; // COMPACTION_GRACE_MS = 3 min
    if (compacting) {
      return withRecovery(`glla: ${paint(theme, "warning", `⏳ compacting… (${fmtElapsed(compactAgeMs)} ago)`)}${heldSuffix}`);
    }
    if (activity === "awaiting-first-turn") {
      return withRecovery(`glla: ${activityStateBadge("AWAITING FIRST TURN", theme, "warning")}${heldSuffix}`);
    }
    if (activity === "idle") {
      const idleDetails = [
        goalTotalText(g, now),
        hostLastActivity(extras, now).replace(/^ · /, ""),
        (state.list?.length ?? 0) > 0 ? `${state.list!.length} queued` : "",
      ].filter(Boolean);
      return withRecovery(`glla: ${activityStateBadge("IDLE", theme, "warning")}${idleDetails.length > 0 ? ` ${idleDetails.join(" · ")}` : ""}${heldSuffix}`);
    }
    // v0.34.39: distinguish durable state from evidence of a live host turn.
    // A spinner is reserved for recent stream/tool evidence; BUSY without
    // that evidence is deliberately static so a hung provider cannot look
    // like progress. Queued work is neither idle nor currently executing.
    if (activity === "busy") {
      const busyDetails = [
        goalTotalText(g, now),
        g.taskList ? `${countDone(g)}/${countTotal(g)} tasks` : "",
        hostLastStream(extras, now).replace(/^ · /, ""),
        (state.list?.length ?? 0) > 0 ? `${state.list!.length} queued` : "",
      ].filter(Boolean);
      return withRecovery(`glla: ${activityStateBadge("BUSY", theme, "warning")}${busyDetails.length > 0 ? ` ${busyDetails.join(" · ")}` : ""}${heldSuffix}`);
    }
    // v0.34.16: a fresh session_start owns the handoff. A cold boot still
    // follows the global autoResume setting, so the widget names the actual
    // lifecycle rather than promising terminal keystroke recovery.
    // v0.24.7: list policy gets its own wording — a queue item is not a goal.
    // v0.28.11 (U10): goal policy joins it — "list 29" read as a command
    // fragment; "29 queued" says what the number IS. Both policies now
    // render "… · N queued".
    const n = state.list?.length ?? 0;
    const live = activity === "working";
    const queued = activity === "queued";
    const marker = live
      ? activityBadge("LIVE · WORKING", now, theme)
      : queued
        ? activityStateBadge("QUEUED", theme, "warning")
        : activityStateBadge("ACTIVE", theme, "accent");
    // When recovery parks a queued goal, name the blocker — `[QUEUED] 12m
    // 26s` reads as a stalled queue with no WHY. State.mainModelRecovery is
    // the bounded envelope's parked state; the status line says what is
    // blocking without adding chat spam or a guessed reset time.
    const recovery = state.mainModelRecovery;
    const blockedByRecovery = queued && recovery && recovery.retryAt;
    const recoverySuffix = blockedByRecovery ? ` · parked on provider recovery` : "";
    // Keep the screenshot-proven order: state, elapsed, freshness, then
    // queue/task context. It scans like a compact instrument readout and
    // remains useful when the above-editor card is hidden or scrolled away.
    const details = [
      goalTotalText(g, now),
      g.taskList ? `${countDone(g)}/${countTotal(g)} tasks` : "",
      live ? hostLastStream(extras, now).replace(/^ · /, "") : "",
      // v0.34.124: the QUEUED "why" — an accepted dispatch that pi has not
      // started, and the last real activity age. A ticking timer with no
      // freshness told the user nothing (note.md 221249).
      queued && extras?.turnPending ? "turn pending" : "",
      queued ? hostLastActivity(extras, now).replace(/^ · /, "") : "",
      n > 0 ? `${n} queued` : "",
    ].filter(Boolean);
    return withRecovery(`glla: ${marker}${details.length > 0 ? ` ${details.join(" · ")}` : ""}${recoverySuffix}${heldSuffix}`);
  }
  // v0.34.65: a terminal goal names its outcome + wall duration instead of
  // clearing the segment (note.md 2026-08-07: "this seems weak for a complete
  // goal"). A held loop without a goal still outranks on its own.
  if (g.status === "complete" || g.status === "aborted") {
    const done = g.status === "complete";
    // v0.34.89: one-line dim SUMMARY, not a loud status claim. The full
    // verdict/reason lives in the archive + /goal status; the status bar
    // names the outcome + wall duration like history (Screenshot_20260807
    // _231205/231236 — the completed goal read as still-active work).
    return `glla: ${paint(theme, "dim", `${done ? "✓ done" : "✗ aborted"} · ${fmtElapsed(goalDurationMs(g, now))}`)}${heldSuffix}`;
  }
  if (held) return `glla: loop ${paint(theme, "warning", "⏸ held")} · iter ${held.iteration} — /loop to resume`;
  return undefined;
}

function countDone(g: Goal): number {
  let n = 0;
  const walk = (ts: Array<{ status: string; subtasks?: any[] }>) => {
    for (const t of ts) {
      if (t.status === "complete") n++;
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(g.taskList?.tasks ?? []);
  return n;
}

function countTotal(g: Goal): number {
  let n = 0;
  const walk = (ts: Array<{ subtasks?: any[] }>) => {
    for (const t of ts) {
      n++;
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(g.taskList?.tasks ?? []);
  return n;
}

// ---- above-editor widget (multi-line panel) ----

/**
 * Widget lines for ctx.ui.setWidget("pi-glla", lines).
 * Returns undefined when nothing is worth showing.
 */
export function buildWidgetLines(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] | undefined {
  const inner = buildWidgetLinesInner(state, audit, now, theme, width, extras);
  // v0.35.29 (issue #15): the agents segment rides every card shape —
  // appended before the persistence-degradation banner so that warning
  // keeps its first-line contract.
  if (inner && extras?.agents) inner.push(extras.agents.line);
  // v0.28.6 (E1): a persistence failure outranks everything — first line,
  // on every render, until a write lands again.
  let lines: string[] | undefined = inner;
  if (inner && isPersistenceDegraded()) {
    const err = lastPersistenceFailure();
    lines = [paint(theme, "error", `⚠ persistence degraded — .pi-glla writes failing (${truncate(err?.error ?? "disk error", 40)}); state in RAM`), ...inner];
  }
  // String-array widgets are wrapped by pi-tui's Text component, whose
  // paddingX=1 consumes one cell on each side. Keep every emitted line inside
  // that content width so long detail/status strings never wrap a trailing
  // segment (for example, `50s`) into a stray next line.
  if (lines && width && width > 0) {
    const contentWidth = Math.max(1, width - WIDGET_HORIZONTAL_MARGIN);
    return lines.map((line) => tuiTruncateToWidth(line, contentWidth, "…"));
  }
  return lines;
}

function waitingListStatus(state: State, _now: number, theme?: DisplayTheme): string {
  const queue = state.list ?? [];
  const head = queue[0];
  const objective = head?.objective?.trim() ? sanitizeDisplayText(head.objective) : "unnamed queued item";
  const hold = typeof state.loadHoldAt === "number" ? " · held on restore" : "";
  return `glla: ${paint(theme, "accent", "LIST QUEUED")} · ${queue.length} waiting · next: ${truncate(objective, 72)} · /list next${hold}`;
}

function waitingListLines(state: State, theme?: DisplayTheme, width?: number): string[] {
  const queue = state.list ?? [];
  const head = queue[0];
  const objective = head?.objective?.trim() ? sanitizeDisplayText(head.objective) : "unnamed queued item";
  const objectiveBudget = budgetFor(width, visibleLen("├─ up next: "), 56);
  const action = typeof state.loadHoldAt === "number"
    ? "held on restore · /list next starts the queue"
    : "/list next starts the queue · /list show to inspect";
  return [
    `${paint(theme, "accent", "↻")} ${paint(theme, "accent", "list queued")} · ${queue.length} waiting`,
    `├─ up next: ${truncate(objective, objectiveBudget)}`,
    `└─ ${paint(theme, "warning", action)}`,
  ];
}

function buildWidgetLinesInner(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] | undefined {
  if (state.loop?.active) return loopLines(state.loop, now, theme, width, extras);
  if (state.loop && !state.loop.active && state.mainModelRecovery?.kind === "loop") return parkedLoopRecoveryLines(state.loop, state.mainModelRecovery, now, theme, width, extras?.mainModelFallbacks);
  if (!state.goal && state.mainModelRecovery) return standaloneRecoveryLines(state.mainModelRecovery, now, theme, width, extras?.mainModelFallbacks);
  const g = state.goal;
  const held = heldLoop(state);
  if (!g) {
    // v0.28.17: no visible goal — the held loop gets its own card.
    if (held) return heldLoopLines(held, now, theme, width);
    // v0.35.61: a waiting-only list is live durable work even without an
    // active list goal. Paint an actionable queue card instead of returning
    // undefined; otherwise carryover/sidecar work disappears until reload.
    if ((state.list?.length ?? 0) > 0) return waitingListLines(state, theme, width);
    // v0.35.30: durable last-outcome retention. After an archive the slot is
    // empty; without this the widget goes blank and a finished audit reads
    // as "closed with no verdict" (field: 2026-08-22 screenshots). One dim
    // line for the retention window, then silent.
    const o = state.lastOutcome;
    if (o && Number.isFinite(Date.parse(o.at)) && now - Date.parse(o.at) < LAST_OUTCOME_RETENTION_MS) {
      return [lastOutcomeLine(o, theme, width)];
    }
    return undefined;
  }
  if (g.status === "complete" || g.status === "aborted") {
    // v0.34.65: terminal goals render instead of vanishing (a finished batch
    // left no trace — note.md 2026-08-07). v0.34.89: that render is now a
    // single dim SUMMARY line (`─ done · <objective> · took X`), not a full
    // card — the old card read like an active item (Screenshot_20260807_231205).
    return completedGoalLines(g, now, theme, width);
  }
  const lines = goalLines(g, state, audit, now, theme, width, extras);
  // v0.28.17: a held loop rides the goal card as a trailing line.
  if (held) {
    lines.push(`${paint(theme, "warning", "⏸")} ${truncate(held.target, budgetFor(width, 3, 64))}`);
    lines.push(`└─ ${paint(theme, "dim", `loop held · iter ${held.iteration} — /loop to resume`)}`);
  }
  return lines;
}

/** Recovery card for a loop parked by the main-model wall. */
function parkedLoopRecoveryLines(loop: LoopState, recovery: MainModelRecovery, now: number, theme?: DisplayTheme, width?: number, configuredBackups: string[] = []): string[] {
  return [
    `${paint(theme, "warning", "⏳")} ${truncate(loop.target, budgetFor(width, 3, 56))} · loop parked · iter ${loop.iteration}`,
    ...formatMainModelRecoveryStatus(recovery, configuredBackups).map((line) => `├─ ${paint(theme, "dim", line)}`),
    `└─ ${paint(theme, "warning", "work is saved · /loop resume retries the recovery, /loop stop drops it")}`,
  ];
}

/** v0.28.17: standalone card for a restore-held loop (no goal visible). */
function standaloneRecoveryLines(recovery: MainModelRecovery, now: number, theme?: DisplayTheme, width?: number, configuredBackups: string[] = []): string[] {
  const current = recovery.active ?? recovery.primary;
  const wall = "main-model recovery";
  const summary = formatMainModelRecoveryStatus(recovery, configuredBackups);
  return [
    `${paint(theme, "warning", "⏳")} ${paint(theme, "accent", wall)} · ${truncate(current, budgetFor(width, 3, 36))}`,
    ...summary.map((line) => `├─ ${paint(theme, "dim", line)}`),
    `└─ ${paint(theme, "dim", "work is saved · /glla resume or the matching goal/list/loop resume retries")}`,
  ];
}

function heldLoopLines(l: LoopState, now: number, theme?: DisplayTheme, width?: number): string[] {
  return [
    `${paint(theme, "warning", "⏸")} ${truncate(l.target, budgetFor(width, 3, 64))}`,
    `├─ loop held · iter ${l.iteration} · ${fmtElapsed(now - Date.parse(l.startedAt))} so far`,
    `└─ ${paint(theme, "dim", "held by the session-restore gate — /loop to resume, /loop stop to drop")}`,
  ];
}

// Branch lines sit flush-left (pi-tasks convention): pi's widget renderer
// adds its own one-space gutter, so any indent here doubles up.
function goalLines(g: Goal, state: State, audit: AuditDisplayProgress | null | undefined, now: number, theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] {
  // Head glyph is ● (not ◆): U+25C6 renders as a color-emoji diamond in some
  // terminal fonts and ignores ANSI color; ● takes the paint everywhere.
  const interrupted = g.status === "active" && !!g.interruptedAt;
  const attention = activeAttention(g);
  // v0.34.102: a paused goal with a live mainModelRecovery park is
  // RECOVERING, not paused — the loop is actively probing/rearming in the
  // background while recovery holds (field: dracon-platform 2026-08-08
  // 090343 "working while displaying paused here"; the rearm storm streak
  // 19 was firing while the head chip said ⏸ paused). The status line already
  // renders ⏳ auto-retrying for these; the widget head must not contradict it.
  const recovering = g.status === "paused" && !!state.mainModelRecovery && (!!state.mainModelRecovery.retryAt || !!state.mainModelRecovery.pendingModelSwitch);
  const icon =
    interrupted
      ? paint(theme, "error", "⚠")
      : attention
        ? paint(theme, attention.color, "⚠")
        : recovering
          ? paint(theme, "dim", "⏳")
          : g.status === "paused"
            ? paint(theme, pauseIsError(g) ? "error" : "warning", "⏸")
            : g.status === "auditing"
              ? paint(theme, "accent", "⟡")
              : paint(theme, "success", "●");
  // v0.24.7: a list item is named as such and points at /list — before,
  // the widget called it "active" and hinted "/goal status", reading as if
  // queue work were a standalone goal.
  const isList = g.policy === "list";
  const statusWord = interrupted
    ? paint(theme, "error", "interrupted")
    : attention
      ? paint(theme, attention.color, attention.label)
      : recovering
        ? paint(theme, "dim", "recovering")
        : g.status === "active"
          ? paint(theme, "success", "active")
          : g.status;
  // v0.33.0: slim card — status folds INTO the head line as middot segments
  // (filter(Boolean).join, the universal CLI idiom). Line 2 is the live
  // "last action · next task" line; the footer stays the hint line.
  // v0.28.30: the type stays visible — v0.33.0 names it via the "list item"
  // header segment (list policy) and the distinct card icons (● goal,
  // ∞/↓/↑ loop, ⟡ auditing, ⏸ paused) + the type-named footer verbs.
  // Token segment only when a budget is set (v0.22.0): the guard is opt-in,
  // and "0/0 tok" carried no information when off.
  const tokenLimit = g.usage?.tokensLimit ?? 0;
  const headSegs: string[] = [];
  if (isList) headSegs.push("list item");
  if (g.agentRole) headSegs.push(`${g.agentRole} role`);
  headSegs.push(statusWord);
  const total = goalTotalText(g, now);
  if (total) headSegs.push(total);
  const taskTotal = countTotal(g);
  if (taskTotal > 0) headSegs.push(`${countDone(g)}/${taskTotal} ${paint(theme, "dim", meter(countDone(g) / taskTotal))}`);
  const tokUsed0 = g.usage?.tokensUsed ?? 0;
  if (tokenLimit > 0) headSegs.push(paint(theme, "dim", `${fmtTokens(tokUsed0)}/${fmtTokens(tokenLimit)} ${meter(tokUsed0 / tokenLimit)}`));
  else if (tokUsed0 > 0) headSegs.push(paint(theme, "dim", `${fmtTokens(tokUsed0)} tok`));
  // v0.28.30: the type stays visible — v0.33.0 names it via the "list item"
  // header segment (list policy) and the distinct card icons (● goal,
  // ∞/↓/↑ loop, ⟡ auditing, ⏸ paused) + the type-named footer verbs.
  // Token segment only when a budget is set (v0.22.0): the guard is opt-in,
  // and "0/0 tok" carried no information when off.
  // v0.33.1: the head must FIT the terminal — the segments are fixed, so
  // the objective absorbs whatever room is left (was: objective budgeted
  // alone, segments appended unbudgeted → 140-col heads at width 100).
  const segsText = headSegs.join(` ${paint(theme, "dim", "·")} `);
  const objBudget = width && width > 0
    ? Math.max(16, width - WIDGET_HORIZONTAL_MARGIN - 2 - 3 - visibleLen(segsText))
    : 48;
  const head = `${icon} ${truncate(g.objective.replace(/\s+/g, " "), objBudget)} ${paint(theme, "dim", "·")} ${segsText}`;
  const lines = [head];
  if (g.repairTarget) {
    lines.push(`├─ ${paint(theme, "warning", `REPLAN REQUIRED · original target: ${truncate(g.repairTarget.objective.replace(/\s+/g, " "), Math.max(30, (width ?? 80) - 28))}`)}`);
    const repairStep = g.repairTarget.replanPromptedAt
      ? "/list resume retries one bounded replan turn"
      : "one bounded replan turn calls propose_task_list; confirm it to resume";
    lines.push(`├─ ${paint(theme, "dim", `Recovery: ${repairStep}`)}`);
  }
  // A model switch crosses an asynchronous boundary while the goal remains
  // active. Keep the complete durable recovery projection on the widget too;
  // otherwise the head says only "active" while pending/attempted/skipped
  // candidates are invisible until the goal is parked.
  if (g.status === "active" && state.mainModelRecovery) {
    const recoverySummary = formatMainModelRecoveryStatus(state.mainModelRecovery, extras?.mainModelFallbacks);
    recoverySummary.forEach((line, i) => {
      lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, "dim", line.replace(/^Main-model recovery: /, ""))}`);
    });
  }
  // Model provenance is a card fact, not a notification: keep it visible
  // across active, interrupted, auditing, and paused branches. In
  // particular, never replace a configured forbidden ref with "none" — the
  // skipped line explains why it did not handle the turn.
  const provenance = modelProvenanceLines(extras?.modelProvenance, width);
  provenance.forEach((line, i) => {
    lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, "dim", line)}`);
  });
  if (interrupted) {
    const resumeCmd = isList ? "/list resume" : "/goal resume";
    if (interruptedForNoStart(g)) {
      lines.push(`├─ ${paint(theme, "error", "continuation was accepted, but pi did not start a turn")}`);
    } else {
      lines.push(`├─ ${paint(theme, "error", "host session lost — waiting for fresh session_start")}`);
    }
    // Lifecycle interruption must not hide a semantic verdict that already
    // landed. The continuation may be gone, but auditHistory is durable and
    // its required-fixes excerpt is the work the user must act on next.
    const feedback = latestAuditFeedback(g);
    if (feedback) {
      const feedbackColor: DisplayColor = feedback.label === "auditor disapproved" ? "error" : "warning";
      lines.push(`├─ ${paint(theme, feedbackColor, `${feedback.label} — durable required fixes`)}`);
      wrap(`latest audit feedback: ${feedback.text}`, budgetFor(width, 3, 60), 3).forEach((w) => {
        lines.push(`│  ${paint(theme, feedbackColor, w)}`);
      });
    }
    const recovery = interruptedForNoStart(g)
      ? `automatic re-sends are stopped · ${resumeCmd} to retry once`
      : `/new to rebind · ${resumeCmd} if it does not resume`;
    lines.push(`└─ ${paint(theme, "warning", recovery)}`);
    return lines;
  }
  // Activity is intentionally a single-surface HUD: the persistent status
  // bar owns LIVE/BUSY/QUEUED/IDLE and stream age. The card stays about the
  // goal and its durable recent action, avoiding the duplicated live badge
  // that made the above-editor panel look noisy.
  if (g.status === "auditing") {
    const host = paint(theme, "accent", MAIN_HOST_LABEL);
    if (auditRecoveryPending(g)) {
      lines.push(`├─ ${host} · auditor: ${paint(theme, "warning", "recovery pending — previous audit was interrupted")}`);
      lines.push(`└─ ${paint(theme, "dim", "stored completion claim is safe; a fresh session will retry it")}`);
      return lines;
    }
    const phase = auditorDisplayPhase(g, audit, now);
    const phaseLive = auditorHasLiveEvidence(audit, phase, now);
    // v0.34.86: objective-vocabulary phase label when progress signals are
    // on ("reading source…" / "writing report…"); the coarse label otherwise.
    const signals = extras?.auditorProgressSignals !== false;
    const phaseLabel = signals && phase === "running"
      ? (auditorProgressPhaseLabel(audit) ?? auditorPhaseForDisplay(audit, phase, phaseLive))
      : auditorPhaseForDisplay(audit, phase, phaseLive);
    const detail = audit?.label && audit.label !== "queued" && audit.label !== "running"
      ? ` · ${truncate(audit.label, 30)}`
      : "";
    // The status bar is the single activity HUD. Keep the widget's audit line
    // factual and compact; the ⟡ head icon plus this phase identify the
    // detached verifier without repeating the animated status badge.
    lines.push(`├─ ${host} · auditor: ${phaseLabel}${detail} · detached worker`);

    // Show observed worker facts, not a made-up percentage or semantic claim.
    // This is the difference between “the timer moved” and “I can see what
    // the detached worker last did.”
    const observations: string[] = [];
    // A stale progress snapshot must not keep presenting its old tool as
    // currently executing. Only fresh worker telemetry earns the present
    // tense; otherwise show it as the last observed tool and omit duration.
    if (phase === "running" && phaseLive && audit?.currentTool) {
      const target = auditorToolTarget(audit.currentToolArgs);
      const duration = audit.currentToolStartedAt !== undefined && Number.isFinite(audit.currentToolStartedAt)
        ? ` · ${fmtElapsed(now - audit.currentToolStartedAt)}`
        : "";
      observations.push(`tool: ${truncate(audit.currentTool, 30)}${target ? ` → ${target}` : ""}${duration}`);
    } else {
      const lastTool = lastAuditorTool(audit) ?? (audit?.currentTool ? truncate(audit.currentTool, 30) : undefined);
      if (lastTool) observations.push(`last tool: ${lastTool}`);
    }
    const latest = latestAuditorOutput(audit);
    // v0.34.66: final-only default (note.md #4 — "auditor words one by
    // one", Screenshot_20260804_211341/211506). With auditorSilent on
    // (default) the live per-token tail is hidden while the worker
    // streams; the text surfaces only at awaiting-verdict, when the
    // report is FINAL. off restores the live tail.
    const silent = extras?.auditorSilent !== false;
    if (latest) {
      if (!silent || phase === "awaiting-verdict") observations.push(`latest: ${latest}`);
      // v0.34.86: silent-mode byte counter — progress evidence without prose.
      // "report stream muted — 12.4 KB written" beats a dead timer.
      else if (extras?.auditorProgressSignals !== false && typeof audit?.reportBytes === "number" && audit.reportBytes > 0)
        observations.push(`report stream muted — ${fmtByteCount(audit.reportBytes)} written · final text at verdict`);
      else observations.push("report stream muted — final text at verdict");
    }
    // A complete snapshot may have no current tool, so retain a compact,
    // protocol-safe evidence summary beside the last tool/final report facts.
    const evidence = auditorEvidenceSummary(audit, phase);
    if (evidence) observations.push(`evidence: ${evidence}`);
    const unmatchedStarts = audit?.unmatchedToolStarts ?? 0;
    const unmatchedEnds = audit?.unmatchedToolEnds ?? 0;
    if (unmatchedStarts + unmatchedEnds > 0) {
      observations.push(`unmatched tool events: ${unmatchedStarts} start / ${unmatchedEnds} end — explicitly unpaired, never falsely matched`);
    }
    observations.forEach((observation, i) => {
      lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, "dim", observation)}`);
    });
    // v0.34.67: paragraph spacing — the worker/subagent text paragraph gets
    // one dim hairline row of breathing room before the card footer (the
    // pinned WORKER_TEXT_SPACER; a truly empty line would be skipped by
    // pi-tui's Text renderer).
    if (observations.length > 0) lines.push(paint(theme, "dim", WORKER_TEXT_SPACER));

    const activity = auditorActivityAge(audit, now);
    const last = auditorLastActivity(audit, now);
    if (phase === "quiet") {
      const quietMs = activity ?? 0;
      lines.push(`└─ ${paint(theme, "warning", `auditor quiet ${fmtElapsed(quietMs)}${last} — may be stuck; /goal cancel discards the claim`)}`);
    } else if (phase === "blocked") {
      lines.push(`└─ ${paint(theme, "warning", `auditor blocked${audit?.label ? ` — ${truncate(audit.label, 44)}` : ""}${last}`)}`);
    } else if (phase === "awaiting-verdict") {
      lines.push(`└─ ${paint(theme, "dim", `waiting for detached verdict${last}`)}`);
    } else if (phase === "queued") {
      lines.push(`└─ ${paint(theme, "dim", "detached worker queued — completion claim is durable")}`);
    } else {
      const detachedElapsed = auditorElapsedMs(audit, now);
      if (detachedElapsed !== undefined && detachedElapsed > 0) {
        const firstEvent = audit?.lastActivityAt === undefined ? " · waiting for first worker event" : "";
        lines.push(`└─ ${paint(theme, "dim", `${fmtElapsed(detachedElapsed)} in detached worker${firstEvent}${last}`)}`);
      } else {
        lines.push(`└─ ${paint(theme, "dim", `detached worker, audit tools${last || " · waiting for first worker event"}`)}`);
      }
    }
    return lines;
  }
  if (g.status === "paused" && g.pauseReason) {
    if (isCompletionAuditNoVerdict(g)) {
      // v0.34.87: parked, not blocked — the item is paused, so the auditor
      // is NOT failing; it is parked with the stored claim. "blocked" next
      // to "⏸ paused" read as live failure ("auditor: blocked — no
      // verdict" while the session shows working…) — two contradictory
      // surfaces. Parked vocabulary names the goal state: the audit waits.
      const retryAt = g.pendingCompletion?.recoveryRetryAt
        ? Date.parse(g.pendingCompletion.recoveryRetryAt)
        : g.pauseResumeAt ? Date.parse(g.pauseResumeAt) : Number.NaN;
      const retryNote = Number.isFinite(retryAt)
        ? retryAt <= now ? " · bounded retry due now" : " · bounded retry scheduled"
        : "";
      lines.push(`├─ ${paint(theme, "warning", `auditor: parked — no verdict${retryNote}`)}`);
      lines.push(`├─ ${paint(theme, "dim", "the stored completion claim was not evaluated — the audit waits while the item is paused")}`);
      const [lifecycle, transition] = pausedLifecycleLines(g, state, extras, now);
      lines.push(`├─ ${paint(theme, "dim", lifecycle)}`);
      lines.push(`│  ${paint(theme, "dim", transition)}`);
      lines.push(`└─ ${paint(theme, "warning", sanitizeProviderDisplayText(g.pauseSuggestedAction ?? `The claim is safe; ${isList ? "/list resume" : "/goal resume"} starts exactly one fresh auditor.`))}`);
      return lines;
    }
    const [lifecycle, transition] = pausedLifecycleLines(g, state, extras, now);
    lines.push(`├─ ${paint(theme, "dim", lifecycle)}`);
    lines.push(`│  ${paint(theme, "dim", transition)}`);
    const kind = pauseKind(g);
    const isErr = kind === "error";
    const budget = budgetFor(width, 3, 60);
    // v0.28.22: actionability banner — a decision pause, an operational
    // failure, and a time-gated wait must not look alike (user report:
    // "if something actionable is going on it can be hard to tell").
    // Every retry-class pause with a recovery timer renders the same uniform
    // "auto-retrying · next probe in X" line regardless of the underlying
    // provider wording. Manual-resume wording is removed; autoResume:true
    // honors "keep going" and recovery-cleared paths auto-unpark blocked
    // pauses whose retry state has resolved.
    const retryMs = (kind === "wait" || kind === "blocked") && g.pauseResumeAt
      ? Date.parse(g.pauseResumeAt) - now
      : Number.NaN;
    // v0.34.102: a paused goal parked on mainModelRecovery is recovering —
    // name the park in the card body too (field: dracon-platform
    // 2026-08-08 090343 "working while displaying paused"). The hourly
    // retry is an extra attempt, not a provider reset-time claim.
    const parkedAt = state.mainModelRecovery?.retryAt ? Date.parse(state.mainModelRecovery.retryAt) : Number.NaN;
    if (kind === "decision") lines.push(`├─ ${paint(theme, "accent", "decision needed — your call unblocks this")}`);
    else if (kind === "error") lines.push(`├─ ${paint(theme, "error", "action needed — this won't fix itself")}`);
    else if (Number.isFinite(parkedAt) || state.mainModelRecovery?.pendingModelSwitch) {
      const recoveryLabel = "main-model recovery — retrying automatically";
      lines.push(`├─ ${paint(theme, "dim", recoveryLabel)}`);
      const recoverySummary = formatMainModelRecoveryStatus(state.mainModelRecovery, extras?.mainModelFallbacks);
      recoverySummary.forEach((line) => lines.push(`│  ${paint(theme, "dim", line.replace(/^Main-model recovery: /, ""))}`));
    }
    else if (Number.isFinite(retryMs)) {
      const when = retryMs <= 0 ? "now" : `next probe in ${fmtElapsed(retryMs)}`;
      lines.push(`├─ ${paint(theme, "dim", `auto-retrying · ${when}`)}`);
    } else if (kind === "blocked" && state.mainModelRecovery?.manualResumeRequired === true) {
      lines.push(`├─ ${paint(theme, "warning", "manual recovery hold — automatic probes stopped")}`);
    } else if (kind === "blocked") {
      lines.push(`├─ ${paint(theme, "warning", "blocked — waiting for manual action")}`);
    } else if (kind === "wait") {
      lines.push(`├─ ${paint(theme, "dim", "paused — waiting on a recovery timer")}`);
    }
    // v0.27.1: wrap reason + suggested action (see wrap()). v0.28.22:
    // decision/wait reasons cap at 2 lines — the options/countdown below
    // carry the actionable content; error reasons keep 3. v0.34.64: retry-
    // class pauses (the auto-retrying line above) suppress the reason dump
    // — the recovery timer is the actionable content; dumping raw 429 JSON
    // under it just confuses the card.
    const reasonPaint = isErr ? "error" : kind === "wait" ? "dim" : "warning";
    if (!Number.isFinite(retryMs)) {
      wrap(displayPauseReason(g.pauseReason), budget, kind === "decision" || kind === "wait" ? 2 : 3).forEach((w, i) => {
        lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, reasonPaint, w)}`);
      });
    }
    // v0.28.22: decision options — one numbered line each (Claude Code /
    // muselinn-Ask convention), the recommended one accented and flagged.
    if (kind === "decision" && g.pauseOptions && g.pauseOptions.length > 0) {
      g.pauseOptions.slice(0, 6).forEach((opt, i) => {
        const rec = g.pauseRecommended === i + 1;
        const text = `${i + 1}. ${truncate(opt, budget - 4)}${rec ? " ◂ recommended" : ""}`;
        lines.push(`│  ${paint(theme, rec ? "accent" : "dim", text)}`);
      });
      if (g.pauseOptions.length > 6) lines.push(`│  ${paint(theme, "dim", `… and ${g.pauseOptions.length - 6} more`)}`);
    }
    // v0.28.22: wait countdown — moved into the auto-retrying line above
    // (v0.34.64). The old separate `resumes X — or /goal resume now` line
    // implied manual rescue was the path; autoResume + the recovery-cleared
    // path now own "keep going" instead. Drop the manual nudge.
    // v0.27.1: what survives the pause — the first question at a pause is
    // "did I lose the work?". Answer it on the card.
    // v0.27.9: when the goal has no telemetry yet (restored-in-fresh-session
    // before the first turn), render "awaiting first turn" instead of "saved"
    // — the latter was misleading because no work was ever "saved" before the
    // session ended.
    const spent: string[] = [];
    const tokUsed = g.usage?.tokensUsed ?? 0;
    const audits = g.auditHistory?.length ?? 0;
    if (tokUsed > 0) spent.push(`${fmtTokens(tokUsed)} tok spent`);
    if (audits > 0) spent.push(`${audits} audit${audits === 1 ? "" : "s"}`);
    const hasTelemetry = spent.length > 0;
    const savedLine = hasTelemetry
      ? `saved — ${spent.join(" · ")} · resumes exactly here`
      : `awaiting first turn — resumes exactly here`;
    if (g.pauseSuggestedAction) {
      lines.push(`├─ ${paint(theme, "dim", truncate(savedLine, budget))}`);
      const wrapped = wrap(sanitizeProviderDisplayText(g.pauseSuggestedAction), budget, 3);
      // v0.28.22: for ACTION NEEDED pauses the action is the point — pop it.
      const actionPaint = kind === "error" ? "warning" : "dim";
      wrapped.forEach((w, i) => lines.push(`${i === wrapped.length - 1 ? "└─" : "│ "} ${paint(theme, actionPaint, w)}`));
    } else {
      lines.push(`└─ ${paint(theme, "dim", truncate(savedLine, budget))}`);
    }
    return lines;
  }
  if (attention) {
    const budget = budgetFor(width, 3, 60);
    lines.push(`├─ ${paint(theme, attention.color, attention.detail)}`);
    if (attention.feedback) {
      // The detached result may arrive after the host continuation has
      // stalled. Keep the actionable report on the always-visible card; do
      // not make the user rely on a turn that may never start.
      wrap(`latest audit feedback: ${attention.feedback}`, budget, 3).forEach((w) => {
        lines.push(`│  ${paint(theme, attention.color, w)}`);
      });
    } else {
      wrap(displayPauseReason(g.pauseReason!), budget, 3).forEach((w) => {
        lines.push(`│  ${paint(theme, attention.color, w)}`);
      });
    }
    if (g.pauseSuggestedAction) {
      wrap(sanitizeProviderDisplayText(g.pauseSuggestedAction), budget, 2).forEach((w, i, all) => {
        lines.push(`${i === all.length - 1 ? "└─" : "│ "} ${paint(theme, "warning", w)}`);
      });
    } else {
      lines.push(`└─ ${paint(theme, "dim", "inspect /goal status before continuing")}`);
    }
    return lines;
  }
  // v0.33.0: "last action · next task" — Claude's done-row format meets the
  // pending queue. Segments join with a dim middot; missing ones drop out.
  // v0.34.124: the ring is not goal-scoped — entries from the PREVIOUS
  // goal outlive activation and painted the new goal's card with the old
  // ✓ complete_goal (0s) while the new goal sat waiting (note.md 221249).
  // Show only the latest action stamped after this goal's creation (5s
  // grace absorbs the activation race); unstamped legacy entries stay
  // visible (pre-v0.34.124 rings, test fixtures).
  const goalStart = Date.parse(g.createdAt);
  const goalScopedActions = [...(extras?.recent ?? [])].reverse().find((a) => {
    if (a.at === undefined) return true;
    return !Number.isFinite(goalStart) || a.at >= goalStart - 5_000;
  });
  const act = goalScopedActions;
  const mid: string[] = [];
  if (act) {
    mid.push(`${paint(theme, act.ok ? "success" : "error", act.ok ? "✓" : "✗")} ${act.name}${act.arg ? ` ${paint(theme, "dim", truncate(act.arg, 24))}` : ""}${act.ms > 0 ? ` ${paint(theme, "dim", `(${fmtElapsed(act.ms)})`)}` : ""}`);
  }
  const next = nextPending(g);
  if (next) mid.push(`next: ${truncate(next, budgetFor(width, 9, 40))}`);
  if (mid.length > 0) lines.push(`├─ ${mid.join(` ${paint(theme, "dim", "·")} `)}`);
  const queue = state.list?.length ?? 0;
  // v0.34.43: a long-running list needs one concrete glimpse beyond the
  // counter. Keep it compact and truthful: state.list is the waiting queue,
  // so show only its immediate next item and how long it has waited. The
  // complete queue remains available through /list; this is a visual trail,
  // not a second queue surface.
  if (isList && queue > 0) {
    const nextItem = state.list?.[0];
    if (nextItem) {
      const added = Date.parse(nextItem.addedAt);
      const age = Number.isFinite(added) ? ` · waiting ${fmtElapsed(now - added)}` : "";
      const prefix = `↳ ${queue} waiting · up next: `;
      const objectiveBudget = budgetFor(width, visibleLen(`├─ ${prefix}`) + visibleLen(age), 40);
      lines.push(`├─ ${paint(theme, "accent", "↳")} ${queue} waiting · up next: ${truncate(nextItem.objective, objectiveBudget)}${paint(theme, "dim", age)}`);
    }
  }
  const footer = isList
    ? `${queue > 0 ? `${queue} queued · ` : ""}/list · /glla`
    : `${queue > 0 ? `${queue} queued · ` : ""}/goal status · /glla`;
  lines.push(`└─ ${paint(theme, "dim", footer)}`);
  return lines;
}

/** v0.34.65: wall-clock duration for a terminal goal. updatedAt is the last
 * mutation (the archive/completion stamp), createdAt the start. Clamped ≥ 0;
 * unusable timestamps fall back to 0 (no duration shown). */
function goalDurationMs(g: Goal, now: number): number {
  const end = Date.parse(g.updatedAt);
  const start = Date.parse(g.createdAt);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  return Math.max(0, end - start);
}

/**
 * v0.34.65: terminal-goal rendering. The widget used to vanish the instant a
 * goal completed — a finished batch with an empty list left no trace of what
 * ran or how long it took (note.md 2026-08-07, Screenshot_20260807_093742
 * "this seems weak for a complete goal").
 * v0.34.89: that became a full card (objective + ✓ complete · took X +
 * verdict sub-line) that read like an ACTIVE item sitting on the surface
 * forever (Screenshot_20260807_231205/231236). Now: ONE compact dim summary
 * line — `─ done · <objective> · took X` — history, not a second surface.
 * The verdict/reason stays in the archive and /goal status.
 */
/** v0.35.30: retention window for the last-outcome widget line. Long enough
 * to answer "did the audit ever finish?" when the user returns to a session
 * whose agent turn ended at claim time; short enough to go silent rather
 * than haunt the surface for days. */
export const LAST_OUTCOME_RETENTION_MS = 24 * 60 * 60_000;

/** One dim line: `✓ done · <stopReason> · <recap>` (approved) or
 * `▪ ended · <stopReason> · <recap>` (aborted/cancelled). History, not a
 * second surface — mirrors completedGoalLines' v0.34.89 compactness rule. */
function lastOutcomeLine(o: NonNullable<import("./goal-loop-core.js").State["lastOutcome"]>, theme?: DisplayTheme, width?: number): string {
  const glyph = o.ok ? "✓ done" : "▪ ended";
  const color = o.ok ? "success" : "dim";
  const segs = `${glyph} · ${truncate(sanitizeDisplayText(o.title).replace(/\s+/g, " "), 40)}`;
  const recapBudget = width && width > 0
    ? Math.max(16, width - WIDGET_HORIZONTAL_MARGIN - 4 - visibleLen(segs))
    : 44;
  const recap = o.recap ? ` · ${truncate(sanitizeDisplayText(o.recap).replace(/\s+/g, " "), recapBudget)}` : "";
  return paint(theme, color, `${segs}${recap}`);
}

function completedGoalLines(g: Goal, now: number, theme?: DisplayTheme, width?: number): string[] {
  const done = g.status === "complete";
  const why = g.status === "aborted" ? (g.stopReason ?? g.pauseReason) : undefined;
  const segs = `${done ? "✓ done" : "✗ aborted"} · ${why ? `${truncate(sanitizeDisplayText(why).replace(/\s+/g, " "), 28)} · ` : ""}took ${fmtElapsed(goalDurationMs(g, now))}`;
  const objBudget = width && width > 0
    ? Math.max(16, width - WIDGET_HORIZONTAL_MARGIN - 4 - visibleLen(segs))
    : 44;
  // v0.34.91: the end-of-goal summary says WHAT HAPPENED — the agent's own
  // completion recap when one was captured at complete_goal, the objective
  // only as a fallback (legacy goals, or aborts where the reason already
  // carries the story). The objective echo alone read like a ticket title,
  // not a recap (Screenshot_20260808_012905).
  const recap = done && g.completionSummary?.trim()
    ? g.completionSummary.replace(/\s+/g, " ").trim()
    : g.objective.replace(/\s+/g, " ");
  return [`${paint(theme, "dim", "─")} ${paint(theme, "dim", `${done ? "✓ done" : "✗ aborted"} · ${truncate(recap, objBudget)} · ${segs}`)}`];
}

function loopLines(l: LoopState, now: number, theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] {
  // v0.33.0: slim loop card — header icon names the kind (∞ metricless,
  // ↓/↑ metric), all state folds into middot segments; line 2 is the live
  // "last action" line; footer is hints. The old per-line "loop ∞ iter" /
  // "best/last/stall" rows collapse into the header.
  const stallNote = (extras?.stalls ?? 0) > 0 ? ` ${paint(theme, "dim", "·")} ${paint(theme, "warning", `stalls:${extras!.stalls}`)}` : "";
  const icon = !l.measureCmd ? paint(theme, "accent", "∞") : paint(theme, "accent", l.direction === "min" ? "↓" : "↑");
  const segs: string[] = [];
  segs.push(`iter ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations} ${paint(theme, "dim", meter(l.iteration / l.maxIterations))}` : ""}`);
  segs.push(fmtElapsed(now - Date.parse(l.startedAt)));
  if (l.measureCmd) {
    segs.push(`best ${paint(theme, "success", `${l.bestValue ?? "n/a"}`)}`);
    segs.push(`last ${l.lastValue ?? "n/a"}`); // v0.33.1: a plateauing loop's current reading stays visible
    const stallText = `stall ${l.stallCount}/${l.plateauWindow}`;
    segs.push(l.stallCount >= l.plateauWindow - 1 ? paint(theme, "warning", stallText) : stallText);
  }
  const segsText = segs.join(` ${paint(theme, "dim", "·")} `);
  const targetBudget = width && width > 0
    ? Math.max(16, width - WIDGET_HORIZONTAL_MARGIN - 2 - 3 - visibleLen(segsText) - visibleLen(stallNote))
    : 44;
  const lines = [`${icon} ${truncate(l.target, targetBudget)} ${paint(theme, "dim", "·")} ${segsText}${stallNote}`];
  const act = extras?.recent?.[extras.recent.length - 1];
  if (act) {
    lines.push(`├─ ${paint(theme, act.ok ? "success" : "error", act.ok ? "✓" : "✗")} ${act.name}${act.arg ? ` ${paint(theme, "dim", truncate(act.arg, 24))}` : ""}${act.ms > 0 ? ` ${paint(theme, "dim", `(${fmtElapsed(act.ms)})`)}` : ""}`);
  }
  const footer = !l.measureCmd
    ? "metricless (no plateau) · /loop stop · /loop refine" // v0.33.2: the verb exists now
    : `${l.kind === "audit" ? "metric: closed findings" : truncate(l.measureCmd, budgetFor(width, 3, 30))} · /loop stop`;
  lines.push(`└─ ${paint(theme, "dim", footer)}`);
  if (l.branchName) lines.push(`⎇ ${paint(theme, "muted", truncate(l.branchName, budgetFor(width, 3, 50)))}`);
  return lines;
}

function nextPending(g: Goal): string | undefined {
  const tasks = g.taskList?.tasks ?? [];
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.status === "pending") return t.title;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return undefined;
}
