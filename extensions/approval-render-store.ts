import * as fs from "node:fs";
import * as path from "node:path";
import { appendLedger, ensureDirs, nowIso, piGlaDir, runPersistStep } from "./goal-loop-core.js";
import { stateRootPending, withStateRootSnapshot } from "./glla-state-root.js";
import { withOwnerMutation } from "./owner-file-protocol.js";
import { MAX_RENDER_CHAT_LINES, MAX_RENDER_LINE_CHARS } from "./terminal-summary-limits.js";

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
// v0.38.55 audit: raised for the uncapped full-parity card (findings +
// full table + repo state routinely exceed 60 lines) — a stored render
// must replay verbatim, so the store bound stays above realistic cards.

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

/** null means an existing store could not be recovered. Only ENOENT is
 * an empty queue: replacing an unreadable/corrupt queue loses obligations. */
function readRenders(cwd: string): PendingApprovalRender[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(approvalRenderStorePath(cwd), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    appendLedger(cwd, "terminal_approval_render_store_unreadable", {
      code: (error as NodeJS.ErrnoException).code ?? "unknown",
    });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isValidRender)) throw new Error("invalid render store");
    return parsed;
  } catch {
    // Preserve all original bytes, including valid entries in a partially
    // invalid array. Recovery must not silently acknowledge their delivery.
    appendLedger(cwd, "terminal_approval_render_store_invalid", { preserved: true });
    return null;
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

/** Only pure queue mutations run under the cross-process protocol. */
function mutateRenders(cwd: string, action: (current: PendingApprovalRender[]) => boolean): boolean {
  if (stateRootPending()) return false;
  return runPersistStep("mutateApprovalRenders", () => {
    ensureDirs(cwd);
    return withOwnerMutation(approvalRenderStorePath(cwd), () => {
      const current = readRenders(cwd);
      return current !== null && action(current);
    }) === true;
  }) === true;
}

function renderIdentity(entry: PendingApprovalRender): string {
  return JSON.stringify([entry.goalId, entry.createdAt, entry.objective, entry.chatLines]);
}
const inFlightRenders = new Map<string, Set<string>>();

/** Enqueue before attempting delivery. Only replay can acknowledge it. */
export function persistApprovalRender(cwd: string, render: {
  goalId: string;
  objective: string;
  chatLines: string[];
}): boolean {
  return withStateRootSnapshot(() => mutateRenders(cwd, existing => {
    const at = nowIso();
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
  }));
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
  return withStateRootSnapshot(() => {
    if (stateRootPending()) return 0;
    const renders = readRenders(ctx.cwd);
    if (renders === null || renders.length === 0) return 0;
    const file = approvalRenderStorePath(ctx.cwd);
    const inFlight = inFlightRenders.get(file) ?? new Set<string>();
    inFlightRenders.set(file, inFlight);
    const inScope = (e: PendingApprovalRender) => !e.deliveredAt && (!onlyGoalId || e.goalId === onlyGoalId);
    const pending = renders.filter(e => inScope(e) && !inFlight.has(renderIdentity(e))).slice(0, MAX_REPLAY_PER_CONTACT);
    const attempted = new Set<string>();
    let replayed = 0;
    try {
      for (const entry of pending) {
        const key = renderIdentity(entry);
        // Nested replay may have acknowledged a later entry already.
        const current = readRenders(ctx.cwd);
        if (current === null) break;
        if (!current.some(e => renderIdentity(e) === key && inScope(e)) || inFlight.has(key)) continue;
        attempted.add(key);
        inFlight.add(key);
        try {
          // Host delivery is deliberately outside the mutation lock.
          if (!deliver(entry)) continue;
          replayed++;
          const at = nowIso();
          mutateRenders(ctx.cwd, latest => {
            const match = latest.find(e => renderIdentity(e) === key);
            if (!match || match.deliveredAt) return true;
            match.deliveredAt = at;
            return writeRenders(ctx.cwd, latest);
          });
          appendLedger(ctx.cwd, "terminal_approval_render_replayed", { goalId: entry.goalId, createdAt: entry.createdAt });
        } catch { break; }
        finally { inFlight.delete(key); }
      }
      // Rotate only attempted entries still pending in the CURRENT queue.
      // This retains callback enqueues and nested replay acknowledgements.
      if (attempted.size) mutateRenders(ctx.cwd, latest => {
        const stalled = latest.filter(e => inScope(e) && attempted.has(renderIdentity(e)));
        if (!stalled.length || latest.filter(inScope).length <= stalled.length) return true;
        const moved = new Set(stalled);
        const rest = latest.filter(e => !moved.has(e));
        let insertAt = rest.length;
        rest.forEach((e, i) => { if (inScope(e)) insertAt = i + 1; });
        rest.splice(insertAt, 0, ...stalled);
        return writeRenders(ctx.cwd, rest);
      });
      return replayed;
    } finally {
      if (inFlight.size === 0) inFlightRenders.delete(file);
    }
  });
}
