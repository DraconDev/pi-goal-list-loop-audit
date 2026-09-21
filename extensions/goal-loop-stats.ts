// pi-goal-list-loop-audit — v0.25.2
// extensions/goal-loop-stats.ts
//
// /glla stats: per-project ledger rollups. Scans .pi-glla/active.jsonl
// across every project on the rig and produces the cross-project table
// the spec-driven verifier (v0.25 design) will be hardened against.
// Pure helpers take strings/paths so tests drive them from tmpdirs —
// no dependencies beyond node stdlib (contract boundary).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ledgerFiles, piGlaDir, scanLedgerRecords } from "./goal-loop-core.js";

export interface LedgerEntry {
  type: string;
  at?: string;
  value?: any;
}

export interface GoalTelemetry {
  turns: number;
  fileWrites: number;
  bashCalls: number;
}

/** Minimal per-goal shape the rollup reasons about (the ledger's `state`
 * snapshots carry the full goal object; archived goals keep their last). */
export interface GoalRollupSource {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  usage?: { tokensUsed?: number };
  auditHistory?: Array<{ approved?: boolean; disapproved?: boolean; error?: string }>;
  telemetry?: GoalTelemetry;
  runToDone?: boolean;
}

/** Outcome metrics: what finished, how long it took, what it cost, and
 * whether run-to-done goals finish differently from supervised ones.
 * Unknowns stay unknown — a goal without timing/usage data is skipped,
 * never counted as zero. */
export interface GoalOutcomes {
  completed: number;
  aborted: number;
  open: number;
  /** Mean auditHistory length over completed goals with history. */
  avgRoundsToApproval: number;
  /** Mean wall-clock hours from first ledger sighting to archive. */
  avgWallClockHrs: number;
  /** Mean tokensUsed over completed goals with usage data. */
  tokensPerCompleted: number;
  runToDoneCompleted: number;
  runToDoneAborted: number;
  /** Supervised bucket doubles as legacy-unknown: pre-v0.38.73 goals
   * carry no flag. */
  supervisedCompleted: number;
  supervisedAborted: number;
}

export interface ProjectRollup {
  project: string;
  goalsCreated: number;
  auditsApproved: number;
  auditsDisapproved: number;
  auditsError: number;
  avgTurns: number;
  avgWrites: number;
  prematureCount: number;
  /** Total token usage across goals (cost in tokens — no price data on
   * this rig; documented in INSTALL.md). */
  totalCost: number;
  lastActive: string;
  /** v0.38.74: outcome metrics (see GoalOutcomes). */
  outcomes: GoalOutcomes;
}

/** Premature-success thresholds (spec-driven verifier design §3): an
 * approved goal with almost no turns, no real editing, and no
 * verification commands is a "claimed done in 12 turns with 0 file
 * writes" pattern the auditor should have caught. */
export const PREMATURE_THRESHOLDS = {
  maxTurns: 50,
  maxFileWrites: 5,
  maxBashCalls: 8,
} as const;

export function parseLedgerEntries(jsonl: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e === "object" && typeof e.type === "string") out.push(e as LedgerEntry);
    } catch {
      /* malformed line — skip */
    }
  }
  return out;
}

/** Flag the "approved too easily" pattern. Goals without telemetry
 * (archived before v0.25.2) are UNKNOWN, not premature — we do not
 * back-convict historical goals on missing data. */
export function detectPrematureSuccess(goal: GoalRollupSource): boolean {
  const audits = goal.auditHistory ?? [];
  const approved = audits.filter((a) => a.approved).length;
  if (approved === 0) return false;
  const t = goal.telemetry;
  if (!t) return false;
  return (
    t.turns < PREMATURE_THRESHOLDS.maxTurns &&
    t.fileWrites < PREMATURE_THRESHOLDS.maxFileWrites &&
    t.bashCalls < PREMATURE_THRESHOLDS.maxBashCalls
  );
}

interface RollupAccumulator {
  goalsCreated: number;
  lastActive: string;
  finalGoal: Map<string, GoalRollupSource>;
  archived: Map<string, { status: string; at: string }>;
  firstSeen: Map<string, string>;
}

function newRollupAccumulator(): RollupAccumulator {
  return { goalsCreated: 0, lastActive: "", finalGoal: new Map(), archived: new Map(), firstSeen: new Map() };
}

function entryGoalId(e: LedgerEntry): string | undefined {
  const direct = e.value?.goalId;
  if (typeof direct === "string" && direct) return direct;
  const nested = e.value?.goal?.id;
  if (typeof nested === "string" && nested) return nested;
  return undefined;
}

function addRollupEntry(acc: RollupAccumulator, e: LedgerEntry): void {
  if (e.at && e.at > acc.lastActive) acc.lastActive = e.at;
  if (e.type === "goal_created") acc.goalsCreated++;
  if (e.type === "state" && e.value?.goal?.id) {
    acc.finalGoal.set(String(e.value.goal.id), e.value.goal as GoalRollupSource);
  }
  const gid = entryGoalId(e);
  if (gid && e.at && !acc.firstSeen.has(gid)) acc.firstSeen.set(gid, e.at);
  if (e.type === "goal_archived" && gid && e.at && typeof e.value?.status === "string") {
    acc.archived.set(gid, { status: e.value.status, at: e.at });
  }
}

function finishRollup(project: string, acc: RollupAccumulator): ProjectRollup {
  let auditsApproved = 0;
  let auditsDisapproved = 0;
  let auditsError = 0;
  let prematureCount = 0;
  let totalCost = 0;
  let turnsSum = 0;
  let turnsN = 0;
  let writesSum = 0;
  let writesN = 0;
  for (const goal of acc.finalGoal.values()) {
    for (const a of goal.auditHistory ?? []) {
      if (a.approved) auditsApproved++;
      else if (a.disapproved) auditsDisapproved++;
      else if (a.error) auditsError++;
    }
    if (detectPrematureSuccess(goal)) prematureCount++;
    totalCost += goal.usage?.tokensUsed ?? 0;
    if (goal.telemetry) {
      turnsSum += goal.telemetry.turns;
      turnsN++;
      writesSum += goal.telemetry.fileWrites;
      writesN++;
    }
  }
  return {
    project,
    goalsCreated: acc.goalsCreated,
    auditsApproved,
    auditsDisapproved,
    auditsError,
    avgTurns: turnsN > 0 ? Math.round((turnsSum / turnsN) * 10) / 10 : 0,
    avgWrites: writesN > 0 ? Math.round((writesSum / writesN) * 10) / 10 : 0,
    prematureCount,
    totalCost,
    lastActive: acc.lastActive,
  };
}

/** Roll up one project's ledger. Pure over the parsed entries — the file
 * read happens in rollupProject. */
export function rollupEntries(project: string, entries: LedgerEntry[]): ProjectRollup {
  const acc = newRollupAccumulator();
  for (const entry of entries) addRollupEntry(acc, entry);
  return finishRollup(project, acc);
}

export function rollupProject(projectPath: string): ProjectRollup | undefined {
  const files = ledgerFiles(projectPath);
  if (files.length === 0) return undefined;
  const acc = newRollupAccumulator();
  try {
    scanLedgerRecords(projectPath, (entry) => addRollupEntry(acc, entry));
  } catch {
    return undefined;
  }
  return finishRollup(projectPath, acc);
}

/** Project discovery (contract item 6). Sources:
 *  1. ~/.pi/agent/sessions/ — session dir names encode their cwd
 *     (`--home-dracon-chat-` ≈ /home/dracon/chat); cheap, no file scans.
 *  2. A bounded walk under ~ (maxdepth 6, pruning node_modules/.git and
 *     hidden dirs) for .pi-glla/ directories — catches projects no
 *     session has visited. (Deviation from the contract's one-level walk:
 *     one level would miss the very projects cited — polis is depth 5.)
 *  3. The current cwd.
 * Only roots with a real .pi-glla/active.jsonl survive. Budget-guarded:
 * the walk stops after `budgetMs`. */
export function discoverGllaProjects(opts: { home?: string; cwd?: string; budgetMs?: number } = {}): string[] {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const budgetMs = opts.budgetMs ?? 2000;
  const deadline = Date.now() + budgetMs;
  const found = new Set<string>();

  const hasLedger = (dir: string): boolean => {
    try {
      fs.accessSync(path.join(piGlaDir(dir), "active.jsonl"));
      return true;
    } catch {
      return false;
    }
  };

  // Source 1: session dir names.
  try {
    const sessionsDir = path.join(home, ".pi", "agent", "sessions");
    for (const name of fs.readdirSync(sessionsDir)) {
      // --home-dracon-chat- → /home/dracon/chat (best-effort decode:
      // strip leading/trailing dashes, then replace -- → /- and - → /).
      const decoded = name.replace(/^-+|-+$/g, "").replace(/--/g, "\0").replace(/-/g, "/").replace(/\0/g, "-");
      const candidate = "/" + decoded;
      if (hasLedger(candidate)) found.add(candidate);
    }
  } catch {
    /* no sessions dir */
  }

  // Source 2: bounded walk — targeted roots FIRST (~/Dev, ~/chat hold the
  // rig's projects; polis sits at depth 5), the general home walk last
  // with whatever budget remains. Deep/wide dirs that never hold projects
  // are pruned.
  const PRUNE = new Set(["node_modules", ".git", ".pi", ".cache", ".npm", ".local", ".config", "Downloads", "Pictures", "Videos", "Music", ".mozilla", ".vscode", "snap", ".steam", ".wine"]);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || Date.now() > deadline) return;
    if (hasLedger(dir)) {
      found.add(dir);
      return; // no nested projects below a project root
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (Date.now() > deadline) return;
      if (!e.isDirectory()) continue;
      if (PRUNE.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of [path.join(home, "Dev"), path.join(home, "chat")]) {
    if (Date.now() > deadline) break;
    walk(root, 1);
  }
  walk(home, 0);

  // Source 3: cwd.
  if (hasLedger(cwd)) found.add(cwd);

  return [...found].sort();
}

/** Contract item 4: premature filter — only projects with
 * premature_count > 0, sorted by premature ratio descending. */
export function filterPremature(rollups: ProjectRollup[]): ProjectRollup[] {
  return rollups
    .filter((r) => r.prematureCount > 0)
    .sort((a, b) => b.prematureCount / Math.max(1, b.goalsCreated) - a.prematureCount / Math.max(1, a.goalsCreated));
}

function shortProject(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatRollupTable(rollups: ProjectRollup[]): string {
  const header = "| project | goals | approved | disapproved | errors | avg turns | avg writes | premature | tokens | last active |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|";
  const rows = rollups.map(
    (r) =>
      `| ${shortProject(r.project)} | ${r.goalsCreated} | ${r.auditsApproved} | ${r.auditsDisapproved} | ${r.auditsError} | ${r.avgTurns} | ${r.avgWrites} | ${r.prematureCount} | ${r.totalCost.toLocaleString()} | ${r.lastActive ? r.lastActive.slice(0, 10) : "—"} |`,
  );
  return [header, sep, ...rows].join("\n");
}

/** JSON schema matches the table exactly (contract item 2). */
export function formatRollupJson(rollups: ProjectRollup[]): string {
  return JSON.stringify(
    rollups.map((r) => ({
      project: r.project,
      goals_created: r.goalsCreated,
      audits_approved: r.auditsApproved,
      audits_disapproved: r.auditsDisapproved,
      audits_error: r.auditsError,
      avg_turns: r.avgTurns,
      avg_writes: r.avgWrites,
      premature_count: r.prematureCount,
      total_cost: r.totalCost,
      last_active: r.lastActive || null,
    })),
    null,
    2,
  );
}
