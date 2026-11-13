/**
 * pi-goal-list-loop-audit — extensions/gate-receipts.ts
 *
 * v0.39.70: receipts for the contract gates GLLA itself ran.
 *
 * Before a completion claim reaches the auditor, the deterministic pre-audit
 * runs every mechanical command in the verification contract. Until v0.39.70
 * a PASSING run was thrown away: the auditor never saw it, re-ran the same
 * multi-minute gates under its own five-minute per-tool budget, and the field
 * record shows the cost — 282 of 483 audit reports re-ran a full-suite
 * command, and the most common audit error was an approval refused because
 * that re-run was cancelled at its budget.
 *
 * A receipt is evidence GLLA produced, not an executor claim: the command,
 * exit 0, wall time and the tail of its output, fenced to the working tree it
 * ran against. The auditor quotes it instead of re-running it, the regression
 * shield accepts it for the contract item it covers, and the completion card
 * shows it as a row GLLA ran.
 *
 * Leaf module: it imports only the dependency-free shield types, so the core
 * sanitizer, the prompt builder, both dispatch sites and the card can share
 * one definition without an import cycle.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { MechanicalGateReceipt } from "./goal-loop-shield.js";

export type { MechanicalGateReceipt } from "./goal-loop-shield.js";

/** Receipts kept on one claim. Contracts rarely name more than a handful of
 * mechanical commands; the cap keeps a hand-edited state file bounded. */
export const MAX_GATE_RECEIPTS = 12;
const MAX_RECEIPT_COMMAND_CHARS = 400;
const MAX_RECEIPT_TAIL_CHARS = 1_600;
const MAX_RECEIPT_DURATION_MS = 7 * 86_400_000;

/** Sanitize receipts at the state boundary: garbage degrades to absent. */
export function sanitizeGateReceipts(raw: unknown): MechanicalGateReceipt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MechanicalGateReceipt[] = [];
  for (const entry of raw.slice(0, MAX_GATE_RECEIPTS)) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.command !== "string" || !r.command.trim()) continue;
    if (r.exitCode !== 0) continue;
    const durationMs = typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0
      ? Math.min(MAX_RECEIPT_DURATION_MS, Math.floor(r.durationMs))
      : 0;
    out.push({
      command: r.command.slice(0, MAX_RECEIPT_COMMAND_CHARS),
      exitCode: 0,
      durationMs,
      outputTail: typeof r.outputTail === "string" ? r.outputTail.slice(-MAX_RECEIPT_TAIL_CHARS) : "",
      ...(typeof r.cwd === "string" && r.cwd ? { cwd: r.cwd.slice(0, 400) } : {}),
      ...(r.retried === true ? { retried: true } : {}),
      ...(r.observed === true ? { observed: true as const } : {}),
      ...(typeof r.treeFingerprint === "string" && /^[0-9a-f]{40,64}$/.test(r.treeFingerprint) ? { treeFingerprint: r.treeFingerprint } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Content fingerprint of the working tree (tracked + untracked, respecting
 * .gitignore), independent of commits. A sync daemon that auto-commits the
 * same bytes leaves the fingerprint unchanged; an edit after the gate ran
 * changes it, so a stale receipt is never handed to a later audit.
 *
 * Uses a throwaway index so the user's real index is never touched. Returns
 * undefined outside a git checkout or on any failure — callers then treat
 * receipts as valid only for the dispatch that produced them.
 */
export function workingTreeFingerprint(cwd: string): string | undefined {
  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-tree-"));
    const tmpIndex = path.join(tmpDir, "index");
    const baseOpts = { cwd, encoding: "utf8" as const, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    // Seed the throwaway index from the real one so git's stat cache skips
    // unchanged files — only modified paths are rehashed. Read-only on the
    // real index; a missing index just means a cold (slower) hash.
    try {
      const realIndex = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], baseOpts).trim();
      if (realIndex && fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    } catch { /* cold index */ }
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const opts = { ...baseOpts, env };
    execFileSync("git", ["add", "-A", "--", "."], opts);
    const tree = execFileSync("git", ["write-tree"], opts).trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
  } catch {
    return undefined;
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Receipts that are still valid for the tree as it is now. A missing
 * fingerprint on either side means "cannot prove freshness" → none. */
export function freshGateReceipts(
  receipts: MechanicalGateReceipt[] | undefined,
  recordedFingerprint: string | undefined,
  currentFingerprint: string | undefined,
): MechanicalGateReceipt[] | undefined {
  if (!receipts || receipts.length === 0) return undefined;
  if (!recordedFingerprint || !currentFingerprint || recordedFingerprint !== currentFingerprint) return undefined;
  return receipts;
}

/** Short human duration: 45s, 3m12s, 1h04m. */
export function formatReceiptDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * v0.39.70 (#5): the auditor's per-tool budget must not be smaller than a gate
 * GLLA has just watched take longer. With receipts the auditor should not
 * re-run the gate at all, but if it does (a targeted variant, a re-check), a
 * budget below the measured duration is a guaranteed cancellation — the
 * "approval refused: bash cancelled after 300s" failure. 1.5× headroom, never
 * below the configured base, never above the hard ceiling.
 */
export function receiptAwareToolTimeoutMs(
  baseMs: number,
  receipts: MechanicalGateReceipt[] | undefined,
  ceilingMs: number,
): number {
  const longest = Math.max(0, ...(receipts ?? []).map((r) => r.durationMs));
  if (!(longest > 0)) return baseMs;
  return Math.min(ceilingMs, Math.max(baseMs, Math.ceil(longest * 1.5)));
}

/** The prompt block. Contents are data; the caller escapes them. */
export function gateReceiptPromptLines(
  receipts: MechanicalGateReceipt[] | undefined,
  escape: (value: string) => string,
): string[] {
  if (!receipts || receipts.length === 0) return [];
  const lines = [
    "",
    "GLLA GATE RECEIPTS — commands GLLA ran itself, or observed exit 0 in the executor's own run, against this exact working tree (exit codes come from the tool transport; NOT executor-written text):",
    "- Each receipt below exited 0. Treat it as already-inspected raw evidence: quote its output tail in <evidence> for the contract item it covers instead of re-running the command.",
    "- Do NOT re-run these commands, the project's full suite, or an equivalent gate to re-establish what a receipt already shows — a re-run costs minutes, can exceed your per-tool budget, and a cancelled call can void your approval.",
    "- Spend your tool calls on what a receipt cannot show: that the changed paths actually implement the claim, that tests exercise the new behaviour, and anything the contract asks for that no receipt covers. A narrow, targeted command (one test file, one grep) is fine.",
    "<gate_receipts>",
  ];
  for (const r of receipts) {
    lines.push(
      `Receipt: ${escape(r.command)}`,
      `Result: exit 0 in ${formatReceiptDuration(r.durationMs)}${r.retried ? " (first attempt failed, bounded retry passed)" : ""}${r.observed ? " (observed in the executor's own run — exit code read from the bash tool result, tree unchanged since)" : ""}${r.cwd ? ` · cwd ${escape(r.cwd)}` : ""}`,
      "Output tail:",
      escape(r.outputTail || "(no output)"),
      "",
    );
  }
  lines.push("</gate_receipts>");
  return lines;
}

/** Stable digest of a receipt set (diagnostics / ledger). */
export function gateReceiptsDigest(receipts: MechanicalGateReceipt[] | undefined): string | undefined {
  if (!receipts || receipts.length === 0) return undefined;
  return crypto.createHash("sha256").update(JSON.stringify(receipts.map((r) => [r.command, r.durationMs]))).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// v0.39.71 (A): receipts OBSERVED in the executor's own gate run.
//
// The executor usually runs the contract gate itself right before claiming,
// and the pre-audit then ran the same gate again (about 14 minutes in this
// repository) before the auditor could start. Pi's bash tool result carries
// the exit code and wall time in `structuredContent` — evidence GLLA reads
// from the tool transport, not from anything the model wrote. A run counts
// only when:
//   - the command is EXACTLY a contract step (whitespace-normalized; a
//     trailing `2>&1` is allowed) — a pipeline (`… | tail`) reports the last
//     program's exit code, so it never counts, and a step with its own `cd`
//     target is left to the pre-audit;
//   - `structuredContent.exit_code === 0` and the result is not an error;
//   - the working tree is byte-identical (fingerprint) when the claim's
//     pre-audit would run. Any edit afterwards voids it.
// ---------------------------------------------------------------------------

export function normalizeGateCommand(command: string): string {
  return command.replace(/\s+2>&1\s*$/, "").replace(/\s+/g, " ").trim();
}

/** A contract step the executor's own run may satisfy (no pipe, no cwd). */
export function observableGateStep(step: { command: string; cwd?: string }): boolean {
  return !step.cwd && !/[|;&<>`$]/.test(normalizeGateCommand(step.command));
}

interface BashResultLike {
  toolName?: unknown;
  isError?: unknown;
  input?: unknown;
  content?: unknown;
  structuredContent?: unknown;
}

/** The receipt an exact, exit-0 contract-gate run proves — or undefined. */
export function observedGateReceipt(
  event: BashResultLike,
  steps: ReadonlyArray<{ command: string; cwd?: string }>,
  treeFingerprint: () => string | undefined,
): MechanicalGateReceipt | undefined {
  if (event.toolName !== "bash" || event.isError === true) return undefined;
  const input = event.input as { command?: unknown } | undefined;
  if (typeof input?.command !== "string") return undefined;
  const sc = event.structuredContent as { exit_code?: unknown; wall_time_seconds?: unknown; output?: unknown } | undefined;
  if (!sc || sc.exit_code !== 0) return undefined;
  const ran = normalizeGateCommand(input.command);
  const step = steps.find((s) => observableGateStep(s) && normalizeGateCommand(s.command) === ran);
  if (!step) return undefined;
  const fingerprint = treeFingerprint();
  if (!fingerprint) return undefined;
  const text = typeof sc.output === "string"
    ? sc.output
    : Array.isArray(event.content)
      ? event.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
      : "";
  const seconds = typeof sc.wall_time_seconds === "number" && Number.isFinite(sc.wall_time_seconds) && sc.wall_time_seconds >= 0 ? sc.wall_time_seconds : 0;
  const tail = text.trim();
  return {
    command: step.command,
    exitCode: 0,
    durationMs: Math.round(seconds * 1000),
    outputTail: tail.length > 1_500 ? "…" + tail.slice(-1_500) : tail,
    observed: true,
    treeFingerprint: fingerprint,
  };
}

/** Insert or replace the observed receipt for its command (latest wins). */
export function upsertObservedReceipt(list: MechanicalGateReceipt[] | undefined, receipt: MechanicalGateReceipt): MechanicalGateReceipt[] {
  const key = normalizeGateCommand(receipt.command);
  return [...(list ?? []).filter((r) => normalizeGateCommand(r.command) !== key), receipt].slice(-MAX_GATE_RECEIPTS);
}

/**
 * Observed receipts that cover EVERY contract step for the tree as it is now,
 * in contract order — or undefined (the pre-audit then runs as before). A
 * contract with any step that cannot be observed is never satisfied here.
 */
export function observedReceiptsCoveringContract(
  steps: ReadonlyArray<{ command: string; cwd?: string }>,
  observed: MechanicalGateReceipt[] | undefined,
  currentFingerprint: string | undefined,
): MechanicalGateReceipt[] | undefined {
  if (steps.length === 0 || !observed?.length || !currentFingerprint) return undefined;
  const out: MechanicalGateReceipt[] = [];
  for (const step of steps) {
    if (!observableGateStep(step)) return undefined;
    const match = observed.find((r) => r.observed === true && r.treeFingerprint === currentFingerprint
      && normalizeGateCommand(r.command) === normalizeGateCommand(step.command));
    if (!match) return undefined;
    out.push(match);
  }
  return out;
}
