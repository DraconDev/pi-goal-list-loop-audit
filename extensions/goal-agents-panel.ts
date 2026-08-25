// pi-goal-list-loop-audit — v0.35.29
// goal-agents-panel.ts — issue #15 subagent visibility (design:
// docs/DESIGN-subagent-visibility.md, scope agreed 2026-08-22).
//
// Pure rendering + data assembly for:
//   1. /glla agents            — tracked-subagent snapshot table
//   2. /glla agents --tail <id> — read-only child transcript tail
//   3. the widget agents segment (line built here, appended by the widget)
//
// Everything here is deterministic given its inputs; fs access happens only
// in tailChildTranscript through an injected reader so tests stay hermetic.

import * as path from "node:path";
import { sanitizeDisplayText } from "./goal-loop-core.js";

/** v0.35.45 (audit finding): the candidate scan reads a bounded TAIL of each
 * transcript, not the whole file — up to 25 files were previously read in
 * full, synchronously, on the main thread. 256 KiB is far more than any
 * needle window needs (summary prefix / agentType / recordId recur
 * throughout recent entries). */
export const TRANSCRIPT_SCAN_MAX_BYTES = 256 * 1024;

export interface AgentsPanelRow {
  recordId: string;
  agentType?: string;
  summary?: string;
  status: "running" | "hung" | "ended";
  spawnedAt: number;
  lastProgressAt: number;
  toolUses: number;
  outputTokens: number;
  silentMs: number;
  evidence: "record-frozen" | "event-only" | "live";
  action?: "abort-requested" | "unavailable" | "failed";
  endedOk?: boolean;
  endedAt?: number;
}

/** Human label: agentType + short summary. */
function rowLabel(row: AgentsPanelRow): string {
  const summary = (row.summary ?? "").replace(/\s+/g, " ").trim();
  return [row.agentType ?? "subagent", summary ? truncate(summary, 28) : ""].filter(Boolean).join(" · ");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + "…";
}

function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
  if (min > 0) return `${min}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

const PANEL_ROW_CAP = 20;

/** Render the /glla agents table. Running/hung first (hung topmost), then
 * ended; capped at PANEL_ROW_CAP rows with an explicit truncation notice. */
export function renderAgentsPanel(rows: AgentsPanelRow[], now: number, managerAvailable: boolean): string[] {
  if (rows.length === 0) {
    return ["No subagents tracked yet — spawn one via the Agent tool and it appears here.", "(evidence: glla's event probes" + (managerAvailable ? " + pi-subagents manager records" : "") + ")"];
  }
  const rank = (r: AgentsPanelRow): number => (r.status === "hung" ? 0 : r.status === "running" ? 1 : 2);
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.silentMs - b.silentMs);
  const shown = ordered.slice(0, PANEL_ROW_CAP);
  const lines: string[] = [];
  for (const row of shown) {
    const glyph = row.status === "ended" ? "✓" : row.status === "hung" ? "⚠" : "●";
    const stateWord = row.status === "ended"
      ? `ENDED ${row.endedOk === false ? "✗" : "ok"} ${fmtDuration((row.endedAt ?? now) - row.spawnedAt)}`
      : row.action === "abort-requested"
        ? `ABORTING ${fmtDuration(now - row.spawnedAt)}`
        : `${row.status === "hung" ? "HUNG?" : "RUNNING"} ${fmtDuration(now - row.spawnedAt)}`;
    lines.push(`${glyph} ${rowLabel(row)}  ${stateWord}`);
    lines.push(`  tools ${row.toolUses} · out ${row.outputTokens >= 1000 ? `${(row.outputTokens / 1000).toFixed(1)}k` : row.outputTokens} · silent ${fmtDuration(row.silentMs)}${row.evidence !== "live" ? ` (${row.evidence})` : ""}`);
    if (row.action === "abort-requested") {
      lines.push("  └ child-specific abort requested; partial output remains available while it settles");
    } else if (row.action === "unavailable") {
      lines.push("  └ no safe child-abort capability; inspect the child and interrupt explicitly if needed");
    } else if (row.action === "failed") {
      lines.push("  └ child-abort request failed; inspect the child and interrupt explicitly if needed");
    } else if (row.status === "hung") {
      lines.push("  └ check the Agents panel: a child whose counters stopped moving is hung, not thinking");
    }
  }
  if (ordered.length > shown.length) {
    lines.push(`… ${ordered.length - shown.length} more (oldest ended trimmed — cap ${PANEL_ROW_CAP})`);
  }
  return lines;
}

/** The ambient widget segment: hidden at zero tracked children by the caller. */
export function renderAgentsWidgetLine(rows: AgentsPanelRow[]): string | undefined {
  const active = rows.filter((r) => r.status !== "ended");
  if (active.length === 0) return undefined;
  const busiest = [...active].sort((a, b) => b.silentMs - a.silentMs)[0]!;
  const hung = busiest.action === "abort-requested"
    ? " ⚠ aborting"
    : busiest.status === "hung"
      ? " ⚠"
      : "";
  return `● ${active.length} agent${active.length === 1 ? "" : "s"} · ${(busiest.agentType ?? "subagent")} silent ${fmtDuration(busiest.silentMs)}${hung}`;
}

export interface TranscriptTailResult {
  ok: boolean;
  lines: string[];
  /** What was searched / read — surfaced to the user on failure. */
  detail: string;
}

/** Read-only tail of a child's session transcript. Candidate selection: all
 * .jsonl files in sessionsDir whose content mentions the child's summary or
 * agent type; most recently modified wins. NEVER resumes or attaches.
 * readFile is injected for tests; production passes fs.readFileSync-wrapped. */
export function tailChildTranscript(
  sessionsDir: string,
  row: { recordId: string; agentType?: string; summary?: string },
  opts: {
    lines?: number;
    readFile?: (file: string, maxBytes?: number) => Buffer;
    listDir?: (dir: string) => string[];
    statMtime?: (file: string) => number;
    now?: number;
  } = {},
): TranscriptTailResult {
  const wantLines = Math.max(1, Math.min(200, opts.lines ?? 20));
  const readFile = opts.readFile ?? (() => { throw new Error("no reader"); });
  // v0.35.45: readers may honor maxBytes (production does — partial tail
  // read); injected test readers ignore it and return the whole buffer.
  const scanRead = (file: string): Buffer => readFile(file, TRANSCRIPT_SCAN_MAX_BYTES);
  const listDir = opts.listDir ?? (() => []);
  const statMtime = opts.statMtime ?? (() => 0);
  let entries: string[];
  try {
    entries = listDir(sessionsDir);
  } catch (error) {
    return { ok: false, lines: [], detail: `cannot list ${sessionsDir}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
  }
  const needles = [row.summary?.slice(0, 48), row.agentType, row.recordId]
    .filter((n): n is string => typeof n === "string" && n.trim().length >= 6)
    .map((n) => n.toLowerCase());
  const candidates = entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(sessionsDir, f))
    .map((f) => ({ f, mtime: statMtime(f) }))
    .sort((a, b) => b.mtime - a.mtime);
  let matched: string | undefined;
  for (const candidate of candidates.slice(0, 25)) {
    try {
      const content = scanRead(candidate.f).toString("utf8").toLowerCase();
      if (needles.some((needle) => content.includes(needle))) { matched = candidate.f; break; }
    } catch { /* unreadable file — skip */ }
  }
  if (!matched) {
    return {
      ok: false,
      lines: [],
      detail: `no session file in ${sessionsDir} matches this child (searched ${candidates.length} transcripts for: ${needles.map((n) => `"${truncate(n, 24)}"`).join(", ") || "any needle"}) — the child may not persist a session, or it lives under another working directory`,
    };
  }
  try {
    const raw = readFile(matched).toString("utf8").split("\n").filter(Boolean);
    const formatted = raw.map(formatTranscriptEntry).filter(Boolean) as string[];
    return { ok: true, lines: formatted.slice(-wantLines), detail: `${matched} (last ${Math.min(wantLines, formatted.length)} of ${formatted.length})` };
  } catch (error) {
    return { ok: false, lines: [], detail: `cannot read ${matched}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
  }
}

/** Tolerant pi-session JSONL → `[role] text` line. Unparseable lines are
 * truncated raw so forensic value survives shape drift. v0.35.45: output is
 * ANSI/control-char sanitized — a hostile child transcript must not be able
 * to emit terminal escape sequences through ctx.ui.notify. */
export function formatTranscriptEntry(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const entry = JSON.parse(trimmed) as {
      type?: string;
      role?: string;
      message?: { role?: string; content?: unknown };
      content?: unknown;
    };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `[raw] ${truncate(sanitizeDisplayText(trimmed), 120)}`;
    const role = entry.message?.role ?? entry.role ?? entry.type ?? "?";
    const content = entry.message?.content ?? entry.content;
    const text = extractText(content);
    if (!text) return undefined;
    return `[${role}] ${truncate(sanitizeDisplayText(text).replace(/\s+/g, " ").trim(), 160)}`;
  } catch {
    return `[raw] ${truncate(sanitizeDisplayText(trimmed), 120)}`;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => typeof block === "string"
        ? block
        : typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "")
      .join(" ");
  }
  return "";
}
