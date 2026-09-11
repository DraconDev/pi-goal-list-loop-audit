import * as fs from "node:fs";
import * as path from "node:path";
import { appendLedger, ensureDirs, nowIso, piGlaDir, runPersistStep } from "./goal-loop-core.js";
import { stateRootPending } from "./glla-state-root.js";

/** Durable terminal-summary outbox. A toast or a live host is not delivery:
 * only a confirmed visible session message acknowledges a render. */

export interface PendingApprovalRender {
  goalId: string;
  objective: string;
  chatLines: string[];
  createdAt: string;
  deliveredAt?: string;
}

/** Cap: the sidecar is a spillway, not a log. Delivered renders are kept
 * briefly for inspection; undelivered ones are never dropped by the cap. */
const MAX_STORED_RENDERS = 20;
const MAX_REPLAY_PER_CONTACT = 5;
// v0.38.30 audit: bound the sidecar behind the "each is ~1KB" comment — a
// long approval trailer used to grow the 20-entry file without bound.
const MAX_RENDER_CHAT_LINES = 60;
const MAX_RENDER_LINE_CHARS = 1000;

export function approvalRenderStorePath(cwd: string): string {
  return path.join(piGlaDir(cwd), "pending-approval-renders.json");
}

function isValidRender(entry: unknown): entry is PendingApprovalRender {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.goalId === "string" && e.goalId.length > 0
    && typeof e.objective === "string"
    && Array.isArray(e.chatLines)
    && e.chatLines.every((line) => typeof line === "string")
    && typeof e.createdAt === "string"
    && (e.deliveredAt === undefined || typeof e.deliveredAt === "string");
}

function readRenders(cwd: string): PendingApprovalRender[] {
  let raw: string;
  try {
    raw = fs.readFileSync(approvalRenderStorePath(cwd), "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const valid = parsed.filter(isValidRender);
    if (valid.length !== parsed.length) {
      appendLedger(cwd, "terminal_approval_render_store_invalid", {
        dropped: parsed.length - valid.length,
        kept: valid.length,
      });
      // v0.38.30 audit: repair the file after ledgering once — otherwise
      // every user command re-appended the same ledger while the file
      // stayed corrupt. Best-effort; a failed rewrite simply ledgers again.
      writeRenders(cwd, valid);
    }
    return valid;
  } catch {
    appendLedger(cwd, "terminal_approval_render_store_invalid", { dropped: "all", kept: 0 });
    writeRenders(cwd, []);
    return [];
  }
}

function writeRenders(cwd: string, renders: PendingApprovalRender[]): boolean {
  // v0.38.49 audit: pending sessionDir resolution defers every write that
  // would otherwise recreate <cwd>/.pi-glla — the sidecar is no exception.
  if (stateRootPending()) return false;
  const landed = runPersistStep("persistApprovalRender", () => {
    ensureDirs(cwd);
    const file = approvalRenderStorePath(cwd);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(renders, null, 2), "utf-8");
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* renamed or write failed */ }
    }
    return true;
  });
  return landed === true;
}

/** Enqueue before attempting delivery. Only replay can acknowledge it. */
export function persistApprovalRender(cwd: string, render: {
  goalId: string;
  objective: string;
  chatLines: string[];
}): boolean {
  const at = nowIso();
  const existing = readRenders(cwd);
  // v0.38.30 truncation (also code-point-safe): compare what WOULD be
  // stored, so an identical re-persist of long lines still dedups.
  const incomingLines = render.chatLines.slice(0, MAX_RENDER_CHAT_LINES)
    .map((line) => [...line].slice(0, MAX_RENDER_LINE_CHARS).join(""));
  // Dedup has two layers. (1) An UNDELIVERED entry for the goal means a
  // render is already queued — a second persist before delivery changes
  // nothing. (2) v0.38.45 audit: delivered history dedups only EXACT
  // duplicates (a repeated settlement re-persisting identical lines must
  // not double-notify) — but a re-approval carries new verdict lines, and
  // dropping those silently hid an archive-failure retry's chat summary
  // while the caller believed it queued. Content, not goalId, decides.
  if (existing.some((entry) => !entry.deliveredAt && entry.goalId === render.goalId)) return true;
  const sameLines = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((line, i) => line === b[i]);
  if (existing.some((entry) =>
    entry.deliveredAt && entry.goalId === render.goalId && sameLines(entry.chatLines, incomingLines))) return true;
  const entry: PendingApprovalRender = {
    goalId: render.goalId,
    // v0.38.30 audit: code-point truncation (char slice split surrogate
    // pairs) + bounded chat lines (the 20-entry cap never bound bytes).
    objective: [...render.objective].slice(0, 300).join(""),
    chatLines: incomingLines,
    createdAt: at,
  };
  // The cap trims DELIVERED history only: undelivered renders are never
  // dropped (each is ~1KB and any user command replays them, so the
  // undelivered tail is self-draining in practice).
  const undelivered = existing.filter((e) => !e.deliveredAt);
  const delivered = existing.filter((e) => e.deliveredAt);
  const deliveredBudget = Math.max(0, MAX_STORED_RENDERS - undelivered.length - 1);
  const next = [...undelivered, entry, ...(deliveredBudget > 0 ? delivered.slice(-deliveredBudget) : [])];
  if (!writeRenders(cwd, next)) return false;
  appendLedger(cwd, "terminal_approval_render_persisted", {
    goalId: render.goalId,
    delivered: false,
    lines: render.chatLines.length,
  });
  return true;
}

/** Replay oldest first through the ownership-fenced sender, with bounded
 * fair rotation. A queued, refused, or unconfirmed send stays pending.
 * Session identity deduplicates retries even when writing deliveredAt
 * fails after the message landed. */
export function replayUndeliveredApprovalRenders(
  ctx: { cwd: string },
  deliver: (entry: PendingApprovalRender) => boolean = () => false,
  onlyGoalId?: string,
): number {
  const renders = readRenders(ctx.cwd);
  if (renders.length === 0) return 0;
  const inScope = (e: PendingApprovalRender) => !e.deliveredAt && (!onlyGoalId || e.goalId === onlyGoalId);
  const pending = renders.filter(inScope).slice(0, MAX_REPLAY_PER_CONTACT);
  if (pending.length === 0) return 0;
  const at = nowIso();
  let replayed = 0;
  for (const entry of pending) {
    try {
      if (!deliver(entry)) continue;
      entry.deliveredAt = at;
      replayed += 1;
      appendLedger(ctx.cwd, "terminal_approval_render_replayed", {
        goalId: entry.goalId,
        createdAt: entry.createdAt,
      });
    } catch {
      // Leave undelivered for the next live contact; never break the
      // command that triggered the replay.
      break;
    }
  }
  // Fair rotation: the window above always takes the oldest pending
  // entries, so persistently unconfirmed receipts used to pin the head
  // forever and a later render was never attempted in that session.
  // Attempted-but-still-pending entries rotate behind the unattempted
  // in-scope tail — stable within each group, delivered and out-of-scope
  // entries untouched — so every pending render is attempted within
  // ceil(n/MAX_REPLAY_PER_CONTACT) contacts. No entry is dropped and the
  // confirmation rules are unchanged; rotation alone never acknowledges.
  const stalled = pending.filter((e) => !e.deliveredAt);
  let rotated = false;
  if (stalled.length > 0 && renders.filter(inScope).length > pending.length) {
    const moved = new Set(stalled);
    const rest = renders.filter((e) => !moved.has(e));
    let insertAt = rest.length;
    rest.forEach((e, i) => { if (inScope(e)) insertAt = i + 1; });
    rest.splice(insertAt, 0, ...stalled);
    renders.length = 0;
    renders.push(...rest);
    rotated = true;
  }
  if (replayed > 0 || rotated) writeRenders(ctx.cwd, renders);
  return replayed;
}

