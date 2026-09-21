// pi-goal-list-loop-audit — v0.38.11 state-root owner inspection + consented
// takeover.
//
// The ownership fence (claimProcessOwner in loops/goal-session.ts) keeps two
// live pi hosts from writing one working-directory root. Until now a denied
// session got a dead-end warning and the user reached for `kill` in a
// terminal. These commands make the resolution built-in:
//
//   /glla owner     — who holds this root (pid, since, idle, session) + you
//   /glla takeover  — consented steal: dead/released/recycled owners are
//                     reclaimed without touching any process; a LIVE foreign
//                     owner is SIGTERMed only after an explicit confirm, only
//                     when it still looks like pi, and only claimed after its
//                     exit is verified. A survivor is never claimed — GLLA
//                     will not manufacture two live writers.
//
// The pid-reuse guard matters: pids recycle, so "owner pid alive" alone is
// not proof the owner survived. A current occupant that started AFTER the
// claim timestamp cannot be the claimant — it is unlinked without signaling.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendLedger } from "./goal-loop-core.js";
import { stateRootPending } from "./glla-state-root.js";
import {
  claimProcessOwner,
  isProcessAlive,
  readOwnerFile,
  refreshOwnershipStanding,
  removeOwnerFile,
  sessionManagerId,
  writeOwnerFile,
  __testOnlyResetOwnershipRecheck,
  type SessionOwnerRecord,
} from "./loops/goal-session.js";

/** Injectable process/filesystem surface — tests drive the full matrix
 * without touching real processes. */
export interface OwnerProcDeps {
  isAlive?: (pid: number) => boolean;
  /** Throw on failure (mirrors process.kill throw semantics). */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** Raw /proc/<pid>/cmdline with NULs, or null when unreadable. */
  readCmdline?: (pid: number) => string | null;
  /** Process start epoch ms, or null when unknowable (non-Linux etc). */
  procStartMs?: (pid: number) => number | null;
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  /** Settle window override (tests only — production always waits the full 5s). */
  settleMs?: number;
}

const defaultDeps = (): Required<OwnerProcDeps> => ({
  isAlive: (pid) => isProcessAlive(pid),
  signal: (pid, sig) => process.kill(pid, sig),
  readCmdline,
  procStartMs,
  now: () => Date.now(),
  sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)),
  settleMs: TAKEOVER_SETTLE_MS,
});

/** Best-effort raw cmdline (Linux /proc). Null everywhere else — callers
 * treat null as "unknown", never as evidence. */
export function readCmdline(pid: number): string | null {
  try {
    return fs.readFileSync(path.join("/proc", String(pid), "cmdline"), "utf8");
  } catch {
    return null;
  }
}

/** Best-effort process start epoch ms via /proc stat field 22 + btime.
 * Null when unknowable — the pid-reuse guard then abstains (no signal). */
export function procStartMs(pid: number): number | null {
  try {
    const stat = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    const fields = stat.slice(rparen + 2).split(" ");
    // After stripping "pid (comm)", index 0 is field 3 (state), so field
    // 22 (starttime) sits at index 19 — pinned by tests/state-root-owner.
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks)) return null;
    const btimeLine = fs.readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
    const btime = btimeLine ? Number(btimeLine.split(/\s+/)[1]) * 1000 : NaN;
    if (!Number.isFinite(btime)) return null;
    // Audit 2026-09-06: a hardcoded 100, never $CLK_TCK. A wrong divisor
    // skews the recycled verdict; 100 errs toward OVERESTIMATING occupant
    // age on non-100-HZ systems, which fails toward "still alive" (refuse
    // the signal, user closes by hand) instead of a false "recycled"
    // (silent claim under a live owner). An env override could flip that.
    const ticksPerSec = 100;
    return Math.round(btime + (startTicks / ticksPerSec) * 1000);
  } catch {
    return null;
  }
}

/** Short human name for a raw cmdline: basename of argv[0]. */
export function cmdlineComm(cmdline: string | null): string {
  if (!cmdline) return "(unknown)";
  const argv0 = cmdline.split("\0")[0] ?? "";
  const base = argv0.split("/").pop() ?? "";
  return base || "(unknown)";
}

/** Does this cmdline still look like a pi host? Permissive by design — the
 * explicit user confirm is the real authority; this only hard-refuses
 * positively-identified non-pi processes. Unknown (null) is NOT pi.
 * Audit 2026-09-06: the old basename-substring gate admitted `pip`,
 * `pilot`, `episode`, `capital` — anything containing "pi" — and the next
 * step past this gate is SIGTERM. Match the executable NAME now (exact
 * `pi`, `pi-…`/`pi_…` prefix, known script suffixes); anything else fails
 * closed and the user closes it by hand. */
/** Basenames of JS runtimes — `node script.mjs` shapes identify by argv[1]. */
const PI_RUNTIME_BASENAMES: ReadonlySet<string> = new Set(["node", "bun", "deno", "qjs", "tjs"]);

function executableNameLooksLikePi(base: string): boolean {
  if (!base) return false;
  if (base === "pi" || base.startsWith("pi-") || base.startsWith("pi_")) return true;
  const stem = base.replace(/\.(exe|cmd|bat|mjs|cjs|js)$/, "");
  return stem === "pi" || stem.startsWith("pi-") || stem.startsWith("pi_");
}

export function looksLikePi(cmdline: string | null): boolean {
  if (!cmdline) return false;
  const lowered = cmdline.toLowerCase().replaceAll("\0", " ");
  if (lowered.includes("pi-coding-agent")) return true;
  const toks = lowered.split(" ").filter(Boolean);
  const argv0 = toks[0]?.split("/").pop() ?? "";
  if (executableNameLooksLikePi(argv0)) return true;
  // `node|bun|deno <script>` launches: the SCRIPT names the process.
  const argv0Stem = argv0.replace(/\.(exe|cmd|bat)$/, "");
  if (PI_RUNTIME_BASENAMES.has(argv0Stem)) {
    const argv1 = toks[1]?.split("/").pop() ?? "";
    if (executableNameLooksLikePi(argv1)) return true;
  }
  return false;
}

/** Normalize the owner record's `at`: current writers store ms-epoch
 * numbers; tolerate ISO strings from any older/future writer. */
export function normalizeOwnerAt(at: unknown): number | null {
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string" && at.trim()) {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export type OwnerClass =
  | "none"
  | "self"
  | "released"
  | "dead"
  | "recycled"
  | "live-foreign";

/** Misclassifying a live owner as recycled manufactures two writers (we
 * unlink + claim while it keeps running). Misclassifying a recycled pid
 * as live merely asks the user. So the recycled verdict needs the
 * occupant to be younger than the claim by a wide margin — clock skew
 * (wall clock vs boot clock) can never fake 60s. */
export const RECYCLED_MARGIN_MS = 60_000;

/** Classify the record against this process. `startMs` is the current
 * occupant's process start (null = unknowable → never "recycled"). */
export function classifyOwner(
  record: SessionOwnerRecord | null,
  selfPid: number,
  occupant: { alive: boolean; startMs: number | null },
  now: number,
): OwnerClass {
  void now;
  if (!record || typeof record.pid !== "number") return "none";
  if (record.pid === selfPid) return "self";
  if (record.shutdownAt !== undefined || record.shutdownReason !== undefined) return "released";
  if (!occupant.alive) return "dead";
  const claimedAt = normalizeOwnerAt(record.at);
  if (claimedAt !== null && occupant.startMs !== null && occupant.startMs > claimedAt + RECYCLED_MARGIN_MS) return "recycled";
  return "live-foreign";
}

export interface DescribedOwner {
  pid: number;
  alive: boolean;
  comm: string;
  claimedAtMs: number | null;
  idleMs: number | null;
  sessionId?: string;
  ownerClass: OwnerClass;
}

export function describeOwner(
  record: SessionOwnerRecord | null,
  selfPid: number,
  partialDeps?: OwnerProcDeps,
): DescribedOwner | null {
  if (!record || typeof record.pid !== "number" || record.pid === selfPid) return null;
  const d = { ...defaultDeps(), ...(partialDeps ?? {}) };
  const cmdline = d.readCmdline(record.pid);
  const owner: DescribedOwner = {
    pid: record.pid,
    alive: d.isAlive(record.pid),
    comm: cmdlineComm(cmdline),
    claimedAtMs: normalizeOwnerAt(record.at),
    idleMs: null,
    sessionId: typeof record.ownerSessionId === "string" ? record.ownerSessionId : undefined,
    ownerClass: "live-foreign",
  };
  if (owner.claimedAtMs !== null) owner.idleMs = Math.max(0, d.now() - owner.claimedAtMs);
  owner.ownerClass = classifyOwner(record, selfPid, { alive: owner.alive, startMs: d.procStartMs(record.pid) }, d.now());
  void cmdline;
  return owner;
}

function fmtAge(ms: number | null): string {
  if (ms === null) return "unknown age";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Read-only status lines for /glla owner. Never writes, never signals. */
export function buildOwnerStatusLines(
  record: SessionOwnerRecord | null,
  selfPid: number,
  selfSessionId: string,
  partialDeps?: OwnerProcDeps,
): string[] {
  const d = { ...defaultDeps(), ...(partialDeps ?? {}) };
  const head = [`state root owner (this folder's .pi-glla/):`, `you: pid ${selfPid} · session ${selfSessionId}`];
  if (!record || typeof record.pid !== "number") {
    return [...head, `holder: none — the root is unclaimed. Your next goal/loop command claims it.`];
  }
  if (record.pid === selfPid) {
    return [...head, `holder: YOU (pid ${selfPid}) — goal/loop commands write normally.`];
  }
  const owner = describeOwner(record, selfPid, partialDeps);
  if (!owner) return [...head, `holder: YOU (pid ${selfPid}) — goal/loop commands write normally.`];
  const since = owner.claimedAtMs !== null ? new Date(owner.claimedAtMs).toISOString() : "unknown time";
  const lines = [
    ...head,
    `holder: pid ${owner.pid} (${owner.comm}) · claimed ${since} (${fmtAge(d.now() - (owner.claimedAtMs ?? d.now()))} ago)`,
  ];
  if (owner.sessionId) lines.push(`holder session: ${owner.sessionId}`);
  switch (owner.ownerClass) {
    case "released":
      lines.push(`state: RELEASED by its owner (quit) — your next command reclaims automatically.`);
      break;
    case "dead":
      lines.push(`state: owner process is DEAD — your next command reclaims automatically, nothing to kill.`);
      break;
    case "recycled":
      lines.push(`state: pid was RECYCLED (current occupant started after the claim) — safe to reclaim, the old owner is gone.`);
      break;
    case "live-foreign":
      lines.push(
        `state: LIVE foreign owner${owner.idleMs !== null ? ` · idle ${fmtAge(owner.idleMs)} (no heartbeat since claim)` : ""} — this session is read-only.`,
        `resolve: /glla takeover (explicit confirm; SIGTERMs pid ${owner.pid} after verification) or close the other host, then start fresh.`,
      );
      break;
    default:
      break;
  }
  return lines;
}

export type TakeoverResult =
  | { outcome: "reclaimed"; signaled: false; via: "none" | "self" | "released" | "dead" | "recycled" }
  | { outcome: "needs-confirm"; owner: DescribedOwner }
  | { outcome: "taken"; signaled: true; prevPid: number }
  | { outcome: "refused"; reason: "state-root-pending" | "not-pi-process" | "still-alive" | "claim-lost"; detail: string };

const TAKEOVER_SETTLE_MS = 5000;
const TAKEOVER_POLL_MS = 250;

/** Consented takeover core. Pure decision flow over injected deps; the only
 * UI (the confirm dialog) lives in the caller. Never claims while a
 * verified-live owner survives. */
export async function takeoverOwnerRoot(opts: {
  cwd: string;
  record: SessionOwnerRecord | null;
  confirmed: boolean;
  deps?: OwnerProcDeps;
}): Promise<TakeoverResult> {
  const d = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const cls = classifyOwner(opts.record, process.pid, {
    alive: typeof opts.record?.pid === "number" ? d.isAlive(opts.record.pid) : false,
    startMs: typeof opts.record?.pid === "number" ? d.procStartMs(opts.record.pid) : null,
  }, d.now());
  if (cls === "none" || cls === "self" || cls === "released" || cls === "dead") {
    if (!claimProcessOwner(opts.cwd)) {
      return { outcome: "refused", reason: "claim-lost", detail: "the root changed under us (a successor claimed first) — inspect with /glla owner and retry." };
    }
    appendLedger(opts.cwd, "owner_takeover", { via: cls, signaled: false, pid: process.pid });
    return { outcome: "reclaimed", signaled: false, via: cls };
  }
  // Recycled pid: the claimant is provably gone (current occupant is
  // younger than the claim). Unlink without signaling — the occupant is
  // some unrelated process that must never receive our SIGTERM.
  if (cls === "recycled") {
    removeOwnerFile(opts.cwd);
    if (!claimProcessOwner(opts.cwd)) {
      return { outcome: "refused", reason: "claim-lost", detail: "the root changed under us (a successor claimed first) — inspect with /glla owner and retry." };
    }
    appendLedger(opts.cwd, "owner_takeover", { via: "recycled", signaled: false, pid: process.pid, prevPid: opts.record?.pid });
    return { outcome: "reclaimed", signaled: false, via: "recycled" };
  }
  // Live foreign owner from here on.
  const owner = describeOwner(opts.record, process.pid, opts.deps);
  if (!owner || owner.ownerClass !== "live-foreign" || typeof opts.record?.pid !== "number") {
    // Raced: the owner died/released between our read and now. Re-run the
    // quiet path against a fresh read instead of signaling a stale pid.
    const fresh = readOwnerFile(opts.cwd);
    const freshCls = classifyOwner(fresh, process.pid, {
      alive: typeof fresh?.pid === "number" ? d.isAlive(fresh.pid) : false,
      startMs: typeof fresh?.pid === "number" ? d.procStartMs(fresh.pid) : null,
    }, d.now());
    if (freshCls === "live-foreign") {
      return { outcome: "needs-confirm", owner: describeOwner(fresh, process.pid, opts.deps) ?? owner as DescribedOwner };
    }
    return takeoverOwnerRoot({ cwd: opts.cwd, record: fresh, confirmed: opts.confirmed, deps: opts.deps });
  }
  if (!opts.confirmed) return { outcome: "needs-confirm", owner };
  const cmdline = d.readCmdline(owner.pid);
  if (!looksLikePi(cmdline)) {
    appendLedger(opts.cwd, "owner_takeover_refused", { reason: "not-pi-process", pid: owner.pid, comm: cmdlineComm(cmdline) });
    return { outcome: "refused", reason: "not-pi-process", detail: `pid ${owner.pid} identifies as "${cmdlineComm(cmdline)}", not pi — refusing to signal. Close it by hand if it really holds the root.` };
  }
  // Audit 2026-09-06: pid-recycling TOCTOU — the occupant may have turned
  // over between the looksLikePi read above and the signal below. Re-read
  // immediately before signaling; anything changed (or no longer pi)
  // refuses instead of SIGTERMs a stranger.
  const verifyCmdline = d.readCmdline(owner.pid);
  if (verifyCmdline !== cmdline || !looksLikePi(verifyCmdline)) {
    appendLedger(opts.cwd, "owner_takeover_refused", { reason: "owner-changed", pid: owner.pid, comm: cmdlineComm(verifyCmdline) });
    return { outcome: "refused", reason: "claim-lost", detail: `pid ${owner.pid} changed between verification and signal (now "${cmdlineComm(verifyCmdline)}") — refusing to signal a stranger. Inspect with /glla owner and retry.` };
  }
  try {
    d.signal(owner.pid, "SIGTERM");
  } catch (err) {
    // Signal failed (already exited, or permission): re-read — an exited
    // owner means the quiet path now applies.
    const fresh = readOwnerFile(opts.cwd);
    return takeoverOwnerRoot({ cwd: opts.cwd, record: fresh, confirmed: true, deps: opts.deps });
  }
  const settleMs = d.settleMs ?? TAKEOVER_SETTLE_MS;
  const deadline = d.now() + settleMs;
  while (d.isAlive(owner.pid)) {
    if (d.now() >= deadline) {
      appendLedger(opts.cwd, "owner_takeover_refused", { reason: "still-alive", pid: owner.pid });
      return { outcome: "refused", reason: "still-alive", detail: `pid ${owner.pid} survived SIGTERM after ${settleMs / 1000}s — NOT claimed (two live writers is worse than read-only). Close it by hand, then /glla takeover again.` };
    }
    await d.sleepMs(TAKEOVER_POLL_MS);
  }
  if (!claimProcessOwner(opts.cwd)) {
    return { outcome: "refused", reason: "claim-lost", detail: "the old owner exited but a successor claimed first — inspect with /glla owner." };
  }
  appendLedger(opts.cwd, "owner_takeover", { via: "takeover", signaled: true, pid: process.pid, prevPid: owner.pid });
  return { outcome: "taken", signaled: true, prevPid: owner.pid };
}

/** Throttled owner heartbeat: refreshes our claim's `at` so a challenger's
 * /glla owner can tell "actively working" from "suspended since morning".
 * writeOwnerFile already no-ops for foreign live owners, so this is safe to
 * call from any lifecycle event. */
const HEARTBEAT_MIN_MS = 60_000;
let lastHeartbeatAt = 0;
export function refreshOwnerHeartbeat(cwd: string, now = Date.now()): void {
  if (now - lastHeartbeatAt < HEARTBEAT_MIN_MS) return;
  lastHeartbeatAt = now;
  writeOwnerFile(cwd);
}
/** Test-only reset for the heartbeat throttle. */
export function __testOnlyResetOwnerHeartbeat(): void {
  lastHeartbeatAt = 0;
}

/** v0.38.12 (last-wins sessions): the newest MAIN session owns the root.
 * A live foreign owner is not a stop sign — it is the PREVIOUS session,
 * and it becomes irrelevant the moment a newer main host starts here.
 * Steal the claim (unlink + fresh claim) and ledger the handoff so
 * forensics can see who dethroned whom. The old process is never
 * signaled: on its next throttled recheck (`refreshOwnershipStanding`)
 * it sees a live foreign owner and stands down to read-only itself.
 *
 * Workers/subagents must never steal — `isMainHost` is false for every
 * non-host lifecycle contact (a subagent stealing the root from its own
 * main session would sideline the very session it serves). Those callers
 * keep the old refusal. Returns "stolen" after dethroning a live owner,
 * "reclaimed" for the quiet paths (missing/dead/released/self),
 * "refused" when we may not own (pending state root, worker contact,
 * or an unclaimable file). */
export function supersedeLiveOwnerRoot(
  cwd: string,
  opts: { isMainHost: boolean; bySession?: string },
): "stolen" | "reclaimed" | "refused" {
  if (stateRootPending()) return "refused";
  const record = readOwnerFile(cwd);
  const prevPid = typeof record?.pid === "number" ? record.pid : null;
  const prevAlive = prevPid !== null && prevPid !== process.pid && isProcessAlive(prevPid);
  if (!prevAlive) {
    return claimProcessOwner(cwd) ? "reclaimed" : "refused";
  }
  if (!opts.isMainHost) return "refused";
  // Audit 2026-09-06: two last-wins fences. (1) Same-session lineage is a
  // reclaim, not a steal — a session reload must not dethrone-notify
  // itself or flap the ledger. (2) An anonymous claimant (no session id)
  // cannot prove it is the NEWER main, so it may not silently dethrone a
  // live owner — explicit `/glla takeover` with confirm is the path.
  const prevSession = (record as { ownerSessionId?: unknown } | null)?.ownerSessionId;
  const claimantSession = opts.bySession ?? "unknown-session";
  // Audit 2026-09-07 (MEDIUM): compare-and-swap the unlink. Re-read before
  // destroying the record; when pid/at/instanceId changed since the entry
  // read, the owner is actively heartbeating and the steal must not destroy
  // a just-refreshed live record — refuse instead. A wedged (unchanged)
  // record still supersedes normally.
  const unchangedSinceRead = (): boolean => {
    const fresh = readOwnerFile(cwd);
    return !!fresh
      && fresh.pid === (record as { pid?: unknown } | null)?.pid
      && (fresh as { at?: unknown }).at === (record as { at?: unknown } | null)?.at
      && (fresh as { instanceId?: unknown }).instanceId === (record as { instanceId?: unknown } | null)?.instanceId;
  };
  if (typeof prevSession === "string" && prevSession !== "" && prevSession === claimantSession) {
    if (!unchangedSinceRead()) {
      appendLedger(cwd, "owner_supersede_refused", { reason: "record-changed", prevPid });
      return "refused";
    }
    removeOwnerFile(cwd);
    if (!claimProcessOwner(cwd)) return "refused";
    appendLedger(cwd, "owner_takeover", { via: "same-session", signaled: false, pid: process.pid, prevPid });
    return "reclaimed";
  }
  if (!claimantSession || claimantSession === "unknown-session") {
    appendLedger(cwd, "owner_supersede_refused", { reason: "anonymous-claimant", prevPid });
    return "refused";
  }
  if (!unchangedSinceRead()) {
    appendLedger(cwd, "owner_supersede_refused", { reason: "record-changed", prevPid });
    return "refused";
  }
  removeOwnerFile(cwd);
  if (!claimProcessOwner(cwd)) return "refused";
  appendLedger(cwd, "owner_superseded", {
    prevPid,
    prevAt: record?.at ?? null,
    prevSession: (record as { ownerSessionId?: unknown } | null)?.ownerSessionId ?? null,
    byPid: process.pid,
    bySession: opts.bySession ?? "unknown-session",
  });
  return "stolen";
}

/** The dethroned side of last-wins: notice we lost the root and stand
 * down to read-only. Ledgers the transition and notifies once per
 * holding owner (not on every poll). Callers must gate out foreign /
 * worker contexts themselves — a subagent never owns the root, so asking
 * it whether it "still" does would always answer lost. */
let stoodDownFor: { cwd: string; ownerPid: number } | null = null;
export function noteOwnershipStanding(ctx: ExtensionContext): void {
  const standing = refreshOwnershipStanding(ctx.cwd);
  if (standing === "held") {
    stoodDownFor = null;
    return;
  }
  if (standing !== "lost") return;
  const record = readOwnerFile(ctx.cwd);
  const ownerPid = typeof record?.pid === "number" ? record.pid : -1;
  if (stoodDownFor !== null && stoodDownFor.cwd === ctx.cwd && stoodDownFor.ownerPid === ownerPid) return;
  stoodDownFor = { cwd: ctx.cwd, ownerPid };
  appendLedger(ctx.cwd, "owner_stood_down", { ownerPid, ownerAt: record?.at ?? null });
  ctx.ui.notify(
    `glla: a newer session (pid ${ownerPid}) took over this folder's state root — this session is now read-only to prevent competing writes. Start a fresh session here to take it back.`,
    "warning",
  );
}
/** Test-only reset for the stand-down notice latch. */
export function __testOnlyResetStandDownNotice(): void {
  stoodDownFor = null;
  __testOnlyResetOwnershipRecheck();
}

function confirmBody(owner: DescribedOwner): string {
  const since = owner.claimedAtMs !== null ? new Date(owner.claimedAtMs).toISOString() : "unknown time";
  return [
    `Holder: pid ${owner.pid} (${owner.comm}) · claimed ${since}${owner.idleMs !== null ? ` · idle ${fmtAge(owner.idleMs)}` : ""}.`,
    ``,
    `Confirming sends SIGTERM to pid ${owner.pid} and claims this folder's state root for THIS session.`,
    `Confirm only if that session is expendable — its in-memory transcript dies with it (disk state survives).`,
  ].join("\n");
}

/** /glla owner — read-only inspection. Deliberately ungated: a denied
 * (read-only) session is exactly the one that needs this. */
export function cmdGllaOwner(ctx: ExtensionContext): void {
  const record = readOwnerFile(ctx.cwd);
  const lines = buildOwnerStatusLines(record, process.pid, sessionManagerId(ctx));
  ctx.ui.notify(lines.join("\n"), "info");
}

/** /glla takeover — consented steal with verification. Refuses while the
 * sessionDir is unresolved (claiming blind would fork the state). */
export async function cmdGllaTakeover(ctx: ExtensionContext): Promise<void> {
  if (stateRootPending()) {
    ctx.ui.notify("Takeover refused — the selected sessionDir is not resolved yet, so no live state was changed. Reload the host session and retry.", "warning");
    return;
  }
  const attempt = async (confirmed: boolean): Promise<TakeoverResult> =>
    takeoverOwnerRoot({ cwd: ctx.cwd, record: readOwnerFile(ctx.cwd), confirmed });
  const first = await attempt(false);
  if (first.outcome === "reclaimed") {
    ctx.ui.notify(
      first.via === "none"
        ? "State root was unclaimed — claimed for this session. Goal/loop commands write normally now."
        : first.via === "self"
          ? "State root already owned by this process — confirmed. Goal/loop commands write normally now."
          : `State root reclaimed (previous owner ${first.via}) — no process was signaled. Goal/loop commands write normally now.`,
      "info",
    );
    return;
  }
  if (first.outcome === "taken") {
    ctx.ui.notify(`Takeover complete — previous owner pid ${first.prevPid} exited after SIGTERM; this session owns the state root now.`, "info");
    return;
  }
  if (first.outcome === "refused") {
    ctx.ui.notify(`Takeover refused: ${first.detail}`, "warning");
    return;
  }
  // needs-confirm: the owner is live — put the verified facts in front of
  // the user and let them decide. No signal has been sent yet.
  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm("Take over this folder's state root?", confirmBody(first.owner));
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    ctx.ui.notify("Takeover aborted — nothing was signaled, nothing claimed. The other host still owns the root.", "info");
    return;
  }
  const second = await attempt(true);
  if (second.outcome === "taken") {
    ctx.ui.notify(`Takeover complete — previous owner pid ${second.prevPid} exited after SIGTERM; this session owns the state root now.`, "info");
  } else if (second.outcome === "reclaimed") {
    ctx.ui.notify("The previous owner exited on its own before the signal — reclaimed quietly, nothing was signaled.", "info");
  } else if (second.outcome === "refused") {
    ctx.ui.notify(`Takeover refused: ${second.detail}`, "warning");
  } else {
    ctx.ui.notify("Takeover aborted — the owner changed under us. Inspect with /glla owner and retry.", "warning");
  }
}
