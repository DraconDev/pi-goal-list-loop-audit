import { registerOwnedTestProcess } from "../scripts/test-process-registry.mjs";
/**
 * pi-goal-list-loop-audit — v0.2.0
 * extensions/goal-loop-shield.ts
 *
 * regression_shield — evidence-matching enforcement plus the shell-free
 * mechanical-check runner (audit 2026-09-20: the "pure, dependency-free"
 * claim below predates the runner section; only the matching helpers are
 * pure — checkRegressionShield/contractItems/parseAuditorVerdict).
 *
 * When a goal has a verification contract, an <approved/> verdict is only
 * accepted if the auditor's report carries an <evidence> section that
 * references every contract item. This kills the "auditor ran bash true and
 * approved" class of bamboozle that pi-goal-x's author explicitly documented
 * as a known hole.
 *
 * Kept free of pi imports so unit tests can exercise it under plain node.
 */

import { resolveCanonicalRunnerCommand } from "./goal-loop-backoff.js";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIST_ITEM_PREFIX = /^(?:[-*•]\s+|\d+[.)]\s+)/;

/** Split a verification contract into its individual checkable items. */
export function contractItems(contract: string): string[] {
  const stripped = contract
    .split("\n")
    .map((l) => l.trim())
    .map((l) => {
      const m = /^(?:done when|verify|verified when|verification|done)\s*:\s*/i.exec(l);
      return { text: m ? l.slice(m[0].length) : l, criterion: m !== null };
    });
  // A contract with list structure defines its checkable items by the list:
  // surrounding prose (a wrapped parenthetical preamble, a trailer) is
  // commentary, not criteria (dracon-log field bug 2026-09-29: preamble
  // fragments became unmatchable "items" and the shield blocked genuine
  // approvals forever). A done-when line is itself a criterion, not prose.
  // Shapeless contracts keep the old every-line behavior.
  const hasListItems = stripped.some((l) => LIST_ITEM_PREFIX.test(l.text));
  return stripped
    .map((l) => ({ text: l.text.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""), listed: l.criterion || LIST_ITEM_PREFIX.test(l.text) }))
    .filter((l) => l.text.length > 0)
    .filter((l) => !hasListItems || l.listed)
    .map((l) => l.text)
    // Boundary lines ("Out of scope: ...") constrain the auditor's judgment;
    // they are not deliverables and have no evidence to quote (v0.22.6).
    .filter((l) => !/^out of scope\b/i.test(l))
    // Preamble lines are not checkable items (v0.23.4, darklord field bug:
    // "Done when ALL of the following are true:" survived as an "item" —
    // the prefix strip only fires when a colon directly follows "done
    // when" — and the shield then blocked TWO genuine approvals forever,
    // because no evidence can reference a preamble). Two mechanical
    // predicates: a line still ending in a colon introduces a list, and a
    // "(done when) (all of) the following ..." line IS the introducer.
    .filter((l) => !l.endsWith(":"))
    .filter((l) => !/^(?:done when\s+)?(?:all of\s+)?the following\b/i.test(l));
}

export interface RegressionShieldResult {
  passed: boolean;
  missingItems: string[];
  hasEvidenceBlock: boolean;
}

/** Strip prose punctuation glued to a token ("file/element." → "file/element").
 * v0.34.77 (GitHub #5): Unicode-aware — \p{L}\p{N} with the /u flag keeps
 * CJK letters. The old ASCII-only class treated every Chinese character as
 * punctuation, so a pure-Chinese token like 调研报告文件 shrank to nothing. */
function stripEdgePunct(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}/_.-]+$/u, "");
}

/**
 * Is a candidate token present in the report? Compound tokens joined by
 * "-" or "/" (left-cropped, file/element, Phaser/Svelte) count as present
 * when ALL their segments (len >= 3) appear — a good-faith report writes
 * "no cropped strip on the left", not the contract's literal compound.
 */
function tokenPresent(candidate: string, reportLower: string): boolean {
  const c = candidate.toLowerCase();
  if (reportLower.includes(c)) return true;
  // v0.34.77 (GitHub #5): Han (CJK) tokens match by exact substring only —
  // Chinese words have no compound-segment decomposition, so the ASCII
  // segment rule below would wrongly reject a quoted 章节 line.
  if (/\p{Script=Han}/u.test(c)) return reportLower.includes(c);
  const segments = c.split(/[-/]+/).filter((s) => s.length >= 3);
  return segments.length > 1 && segments.every((s) => reportLower.includes(s));
}

/** v0.34.77 (GitHub #5): punctuation-edge-normalized lowercase for the
 * no-candidate fallback — a verbatim quote that drops the item's trailing
 * full-width colon (章节： → 章节) still counts as a reference. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").replace(/\s+/g, " ");
}

/**
 * Check an approved auditor report against the verification contract.
 * Rules (deliberately simple + auditable):
 *   1. The report must contain an <evidence> ... </evidence> block.
 *   2. Every contract item must be referenced inside the report by ANY of
 *      its top-3 longest tokens (>= 5 chars, edge punctuation stripped;
 *      compounds match via their segments). v0.22.6: the previous
 *      single-longest-word rule false-rejected genuine approvals when the
 *      longest word was contract-only vocabulary ("left-cropped") or had
 *      prose punctuation glued on ("file/element.") — three real approved
 *      audits on hegemon were converted to disapprovals that way.
 */
export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
  const evidenceMatch = /<evidence>[\t\n\r ]*([\s\S]*?)<\/evidence>/i.exec(report);
  const hasEvidenceBlock = evidenceMatch !== null;
  const items = contractItems(contract);
  const missingItems: string[] = [];
  // Contract references must live inside the evidence block. Searching the
  // whole report let an auditor satisfy the shield by repeating the contract
  // in prose while leaving the evidence block empty or unrelated.
  const evidenceLower = (evidenceMatch?.[1] ?? "").toLowerCase();
  for (const item of items) {
    // v0.34.77 (GitHub #5): Unicode-aware token split — \p{L}\p{N} treats
    // CJK characters as letters, so a pure-Chinese contract line is ONE
    // candidate token instead of a pile of delimiters.
    const candidates = item
      .split(/[^\p{L}\p{N}_.\-/]+/u)
      .map(stripEdgePunct)
      .filter((w) => w.length >= 5)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    const addressed = candidates.length > 0
      ? candidates.some((c) => tokenPresent(c, evidenceLower))
      : evidenceLower.includes(normalizeForMatch(item));
    if (!addressed) missingItems.push(item);
  }
  return {
    passed: hasEvidenceBlock && missingItems.length === 0,
    missingItems,
    hasEvidenceBlock,
  };
}

/**
 * v0.24.2: pure auditor-verdict parser (approved / disapproved / impossible).
 * Lives here (not goal-loop-auditor.ts) so tests can import it without
 * dragging in the auditor's relative .js imports. The final nonblank line
 * is the only authoritative verdict location; prose tags are not verdicts.
 */
export function parseAuditorVerdict(output: string): { approved: boolean; disapproved: boolean; impossible: boolean; impossibleReason?: string } {
  // A few RPC/test transports serialize newlines as literal `\\n` text;
  // normalize that wire representation without relaxing the final-line gate.
  const normalizedOutput = output.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
  const finalLine = normalizedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const impossibleMatch = /^<impossible>([\s\S]*?)<\/impossible>$/i.exec(finalLine);
  // The final line is the only authoritative verdict location.
  return {
    approved: /^<approved\/>$/i.test(finalLine),
    disapproved: /^<disapproved\/>$/i.test(finalLine),
    impossible: impossibleMatch !== null,
    impossibleReason: impossibleMatch?.[1]?.trim().slice(0, 300) || undefined,
  };
}

/** A command under negation ("no longer uses `bun run dev`") is prohibited or
 * illustrative, not an affirmed gate. Checked in the text immediately before
 * a backticked command; the trailing set covers negation after the command
 * ("`npm test` is not run in CI"). Bare items test the qualifier-stripped
 * candidate, so an affirmed "passes ..." tail is not vetoed by its own
 * wording ("npm test passes without warnings"). */
const MECHANICAL_NEGATION = /\b(?:no\s+longer|never|not|cannot|uses?\s+no|avoids?|removes?|drops?|prohibits?|forbids?|bans?|without|instead\sof|must\s+not|does?\s+not)\b|n't\b/i;
const MECHANICAL_NEGATION_TRAILING = /\b(?:is|are|was|were)\s+(?:not|never|no\s+longer)\b/i;
const MECHANICAL_NEGATION_WINDOW = 48;
const MECHANICAL_NEGATION_TRAILING_WINDOW = 40;

/** Run-script names that never exit by convention (dev servers, watchers).
 * An exit-0 gate on one of these can only burn the round's time budget, so
 * extraction rejects them and the AI auditor judges server behavior instead. */
const MECHANICAL_SERVER_RUN_SCRIPT = /^(?:(?:npm|bun|pnpm|yarn)\s+run\s+|yarn\s+)(?:dev|serve|watch|daemon|preview|start)\b/i;
const MECHANICAL_SERVER_SCRIPT_NAME = /(?:^|[._-])(?:server|serve|daemon|watch)(?:[._-]|$)/i;
/** `python -m` modules that never exit (denylist — `-m unittest`, `-m pytest`
 * and friends are legitimate one-shot gates). */
const MECHANICAL_SERVER_PYTHON_MODULES = new Set(["http.server", "SimpleHTTPServer"]);

function isServerModeMechanicalCommand(part: string): boolean {
  if (MECHANICAL_SERVER_RUN_SCRIPT.test(part)) return true;
  if (!/^python3?\s+/i.test(part)) return false;
  // Skip interpreter flags (`-u`, `-W ...`) to the script or `-m` module.
  const tokens = part.trim().split(/\s+/).slice(1);
  let i = 0;
  while (i < tokens.length && tokens[i]!.startsWith("-") && tokens[i] !== "-m" && tokens[i] !== "-c") i++;
  if (tokens[i] === "-m") return MECHANICAL_SERVER_PYTHON_MODULES.has(tokens[i + 1] ?? "");
  if (tokens[i] === "-c") return false;
  const base = (tokens[i] ?? "").split("/").at(-1) ?? "";
  return base !== "" && MECHANICAL_SERVER_SCRIPT_NAME.test(base);
}

/**
 * v0.35.7: Extract mechanical shell command gates from a verification contract.
 * Captures explicit commands (e.g. `npm test`, `tsc --noEmit`, `cargo test`)
 * for deterministic fast-fail pre-auditing before spawning the heavy LLM worker.
 */
export function extractMechanicalCheckCommands(contract: string): string[] {
  if (!contract) return [];
  const items = contractItems(contract);
  const commands: string[] = [];
  for (const item of items) {
    const backtickMatches = [...item.matchAll(/`([^`]+)`/g)];
    if (backtickMatches.length > 0) {
      for (const m of backtickMatches) {
        const before = item.slice(Math.max(0, (m.index ?? 0) - MECHANICAL_NEGATION_WINDOW), m.index ?? 0);
        if (MECHANICAL_NEGATION.test(before)) continue;
        const after = item.slice((m.index ?? 0) + m[0]!.length, (m.index ?? 0) + m[0]!.length + MECHANICAL_NEGATION_TRAILING_WINDOW);
        if (MECHANICAL_NEGATION_TRAILING.test(after)) continue;
        const inner = m[1]!.trim();
        const parts = inner.split(/\s*&&\s*|\s*;\s*/);
        for (let part of parts) {
          part = part.trim();
          if (!part || isServerModeMechanicalCommand(part)) continue;
          if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python3?\s+-m\s+unittest|python3?\s+[^\s]+|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(part)) {
            commands.push(part);
          }
        }
      }
      continue;
    }
    let candidate = item.trim();
    candidate = candidate.replace(/\s+(?:passes(?:\s+cleanly|\s+with\s+zero\s+errors)?|exits\s+0|returns\s+0|cleanly|completes(?:\s+successfully)?|succeeds(?:\s+cleanly)?|successfully).*$/i, "").trim();
    if (MECHANICAL_NEGATION.test(candidate)) continue;
    if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python3?\s+-m\s+unittest|python3?\s+[^\s]+|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(candidate)) {
      if (!isPlausibleBareMechanicalCandidate(candidate)) continue;
      const parts = candidate.split(/\s*&&\s*|\s*;\s*/);
      for (let part of parts) {
        part = part.trim();
        if (!part || isServerModeMechanicalCommand(part)) continue;
        if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python3?\s+-m\s+unittest|python3?\s+[^\s]+|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(part)) {
          commands.push(part);
        }
      }
    }
  }
  return commands;
}

function isPlausibleBareMechanicalCandidate(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/);
  let baseLen = 1;
  if (/^npm\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^bun\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^pnpm\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^yarn\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^cargo\s+(?:test|check|build)/i.test(candidate)) baseLen = 2;
  else if (/^go\s+test/i.test(candidate)) baseLen = 2;
  else if (/^(?:npm|bun|pnpm|yarn)\s+(?:test|vitest|jest)/i.test(candidate)) baseLen = 2;
  else if (/^tsc\b/i.test(candidate)) baseLen = 1;
  else if (/^pytest\b/i.test(candidate)) baseLen = 1;
  else baseLen = 2;
  const args = tokens.slice(baseLen);
  if (args.length === 0) return true;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (arg.includes("/") || arg.includes(".") || arg.includes(":")) continue;
    if (/^[A-Za-z]+(-[A-Za-z]+)*$/.test(arg)) return false;
  }
  return true;
}

export interface MechanicalCheckResult {
  passed: boolean;
  /** v0.38.103: pass = green; fail = the gate ran and the work is red;
   * inconclusive = containment (timeout/kill/limits/abort) — the gate never
   * produced a verdict on the work. `passed` stays true iff pass, so
   * existing boolean consumers keep their meaning. */
  outcome: MechanicalCheckOutcome;
  /** Set exactly when outcome is inconclusive — which containment fired. */
  inconclusiveReason?: MechanicalInconclusiveReason;
  failedCommand?: string;
  output?: string;
  exitCode?: number;
  /** v0.35.20: set when the first attempt failed transiently and the single
   * bounded retry passed — honest evidence of the wobble, not a silent mask. */
  recoveredRetryNote?: string;
}

/** v0.38.103: mechanical outcome classes. A killed gate is evidence of
 * nothing about the product — callers must route `inconclusive` to the
 * infra path, never to a disapproval verdict. */
export type MechanicalCheckOutcome = "pass" | "fail" | "inconclusive";

/** v0.38.103: which containment produced an inconclusive outcome. */
export type MechanicalInconclusiveReason =
  | "timeout"
  | "aborted"
  | "output-limit"
  | "process-group-limit"
  | "filter-incomplete";

export function containmentReason(run: {
  timedOut: boolean;
  aborted: boolean;
  outputLimit: boolean;
  processGroupLimit: boolean;
}): MechanicalInconclusiveReason | null {
  if (run.timedOut) return "timeout";
  if (run.aborted) return "aborted";
  if (run.outputLimit) return "output-limit";
  if (run.processGroupLimit) return "process-group-limit";
  return null;
}

/** v0.38.103: load-scaling ceiling for mechanical gate budgets. A gate that
 * needs 25 minutes idle gets at most 50 under saturation — beyond that the
 * run is inconclusive promptly instead of holding a worker past the hour.
 * (v0.39.18: example numbers follow DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS.) */
export const MECHANICAL_LOAD_SCALE_MAX = 2;

/** v0.38.103: pure load-scaling math (pinned by unit test): 1× while
 * 1-minute load is at or under cpu count, linear to MECHANICAL_LOAD_SCALE_MAX
 * past it. Unusable inputs degrade to the base budget, never to unbounded. */
export function loadScaledTimeoutMs(baseMs: number, load1: number, cpuCount: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs) : DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS;
  const cpus = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1;
  const load = Number.isFinite(load1) && load1 >= 0 ? load1 : 0;
  const factor = Math.min(MECHANICAL_LOAD_SCALE_MAX, Math.max(1, load / cpus));
  return Math.round(base * factor);
}

/** v0.38.103: host-aware wrapper — reads os.loadavg/os.cpus once. Any read
 * failure degrades to the base budget. */
export function scaledMechanicalTimeoutMs(baseMs: number): number {
  try {
    const load = os.loadavg()[0] ?? 0;
    const cpus = os.cpus()?.length ?? 1;
    return loadScaledTimeoutMs(baseMs, load, cpus);
  } catch {
    return Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs) : DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS;
  }
}

/**
 * Mechanical checks are intentionally a small, shell-free command language.
 * Contract text is not trusted input: accepting `npm test; ...` and passing it
 * to a shell would turn the verification gate into arbitrary code execution.
 */
const SAFE_MECHANICAL_COMMAND = /^[A-Za-z0-9_./:@=+,-]+(?:[ \t]+[A-Za-z0-9_./:@=+,-]+)*$/;

export function isSafeMechanicalCommand(command: string): boolean {
  return SAFE_MECHANICAL_COMMAND.test(command.trim());
}

/**
 * Accept one deliberately narrow assertion form used by verification
 * contracts that need both a file existence/size check and a literal marker
 * check. It is expanded into two shell-free invocations; arbitrary `&&`, `||`,
 * pipes, substitutions, redirects, and additional programs remain rejected.
 */
function safeFileMarkerCompound(command: string): string[] | null {
  const match = /^test\s+-([sf])\s+([A-Za-z0-9_./:@=+,-]+)\s+&&\s+grep\s+-q\s+(['"]?)([A-Za-z0-9_./:@=+,-]+)\3\s+([A-Za-z0-9_./:@=+,-]+)$/i.exec(command.trim());
  if (!match) return null;
  const [, flag, testPath, , marker, grepPath] = match;
  if (!testPath || !marker || !grepPath) return null;
  // Do not let a literal become a second grep option or a test flag. The
  // allowlisted assertion is for file paths and marker text, not option
  // forwarding.
  if ([testPath, marker, grepPath].some((value) => value.startsWith("-"))) return null;
  return [`test -${flag} ${testPath}`, `grep -q ${marker} ${grepPath}`];
}

/**
 * v0.38.18 (track 1: endless-td pipe-syntax wedge): a narrow pipeline form.
 * Contracts legitimately truncate noisy suites (`bun test 2>&1 | tail -n 4`);
 * rejecting the `|` deterministically fast-failed finished work with no
 * agent-side remedy. A pipeline is accepted only when EVERY segment is
 * independently safe: the head is an ordinary safe command (resolved through
 * the canonical runner exactly like a bare command) and each tail segment is
 * an allowlisted text filter. Execution never touches a shell — the head
 * runs through runMechanicalCommand and each filter is spawned with piped
 * stdio. The pipeline passes iff the HEAD exits 0 (pipefail-head semantics:
 * `tail` exits 0 even when the suite is red, so the tail's status is
 * meaningless); filters only truncate evidence. `2>&1` on the head is
 * accepted and ignored — head output already merges stderr. Every other
 * redirect, substitution, quote, or second program stays exit-126 rejected.
 */
const MECHANICAL_HEAD_REDIRECT = /\s*2>&1\s*$/;
const MECHANICAL_TAIL_FILTER = /^(?:tail|head)\s+-[nc]\s+\d{1,6}$/;
const MECHANICAL_GREP_FILTER = /^grep\s+(?:-[a-z]+\s+)?[A-Za-z0-9_./:@=+,%-]+$/;

function isAllowlistedMechanicalFilter(segment: string): boolean {
  return MECHANICAL_TAIL_FILTER.test(segment) || MECHANICAL_GREP_FILTER.test(segment);
}

interface MechanicalPipeline {
  head: string;
  filters: string[];
}

/** Split a `head | filter | ...` command, or return null when any segment
 * is outside the narrow allowed shape (callers fall through to the 126
 * unsafe rejection). Naive `|` splitting is safe here: quotes and
 * escapes are rejected characters, so a `|` is always a real pipe. */
export function parseMechanicalPipeline(command: string): MechanicalPipeline | null {
  if (!command.includes("|")) return null;
  const segments = command.split("|").map((s) => s.trim());
  if (segments.length < 2 || segments.some((s) => !s)) return null;
  let head = segments[0]!.replace(MECHANICAL_HEAD_REDIRECT, "").trim();
  if (!head) return null;
  if (!isSafeMechanicalCommand(head)) return null;
  const filters = segments.slice(1);
  if (!filters.every(isAllowlistedMechanicalFilter)) return null;
  return { head, filters };
}

const MECHANICAL_FILTER_STAGE_TIMEOUT_MS = 30_000;

function runMechanicalFilterStage(
  input: string,
  filter: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number; timedOut: boolean; aborted?: boolean; launchError?: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ output: "", exitCode: 1, timedOut: false, aborted: true });
      return;
    }
    const [program = "", ...args] = filter.split(/[ \t]+/);
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      registerOwnedTestProcess(child);
    } catch (error) {
      resolve({ output: "", exitCode: 1, timedOut: false, launchError: error instanceof Error ? error.message : String(error) });
      return;
    }
    let output = "";
    let settled = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    const finish = (result: { output: string; exitCode: number; timedOut: boolean; aborted?: boolean; launchError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      kill();
      finish({ output: output.slice(-MECHANICAL_OUTPUT_TAIL_CHARS), exitCode: 1, timedOut: false, aborted: true });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      kill();
      finish({ output: output.slice(-MECHANICAL_OUTPUT_TAIL_CHARS), exitCode: 1, timedOut: true });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MECHANICAL_OUTPUT_TAIL_CHARS * 2) {
        output = output.slice(-MECHANICAL_OUTPUT_TAIL_CHARS);
      }
    });
    child.stderr?.on("data", () => { /* filter diagnostics never enter evidence */ });
    child.on("error", (error) => {
      finish({ output: "", exitCode: 1, timedOut: false, launchError: error.message });
    });
    child.on("close", (code) => {
      finish({ output: output.slice(-MECHANICAL_OUTPUT_TAIL_CHARS), exitCode: code ?? 1, timedOut: false });
    });
    // head/grep may intentionally close stdin before all buffered evidence
    // arrives. Writable errors are asynchronous and escape a try/catch.
    // Expected pipe closure still waits for the filter's bounded exit;
    // other transport failures make the stage inconclusive.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      kill();
      finish({ output: "", exitCode: 1, timedOut: false, launchError: error.message });
    });
    try {
      child.stdin?.write(input);
      child.stdin?.end();
    } catch { /* stdin already closed */ }
  });
}

async function runMechanicalPipeline(
  cwd: string,
  pipeline: MechanicalPipeline,
  rawCommand: string,
  scripts: Record<string, string>,
  effectiveTimeoutMs: number,
  signal: AbortSignal | undefined,
  effectiveProcessGroupSize: number,
): Promise<MechanicalCheckResult> {
  if (process.platform === "win32") {
    return {
      passed: false,
      outcome: "fail",
      failedCommand: rawCommand,
      output: "Mechanical pipelines need POSIX coreutils (tail/head/grep) and are not supported on Windows; reword the contract line to a bare runner invocation.",
      exitCode: 126,
    };
  }
  const { program, args } = resolveCanonicalRunnerCommand(pipeline.head, scripts);
  if (!program) {
    return { passed: false, outcome: "fail", failedCommand: rawCommand, output: "Empty mechanical command.", exitCode: 126 };
  }
  // ONE bounded automatic retry for the whole pipeline on a plain head
  // failure (mirrors the single-command v0.35.20 retry); containment
  // events fail immediately without a second untrusted process tree.
  let firstFailure: { output: string; exitCode: number } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const head = await runMechanicalCommand(cwd, program, args, effectiveTimeoutMs, signal, effectiveProcessGroupSize);
    if (head.timedOut || head.aborted || head.outputLimit || head.processGroupLimit) {
      return { passed: false, outcome: "inconclusive", inconclusiveReason: containmentReason(head) ?? "timeout", failedCommand: rawCommand, ...formatMechanicalFailure(head, effectiveTimeoutMs) };
    }
    let stageInput = head.output;
    let stageFailed: { output: string; exitCode: number } | null = null;
    for (const filter of pipeline.filters) {
      const stage = await runMechanicalFilterStage(stageInput, filter, MECHANICAL_FILTER_STAGE_TIMEOUT_MS, signal);
      if (stage.aborted) {
        return { passed: false, outcome: "inconclusive", inconclusiveReason: "aborted", failedCommand: rawCommand, output: stage.output, exitCode: 1 };
      }
      if (stage.timedOut || stage.launchError) {
        stageFailed = {
          output: `[pipeline filter '${filter}' did not complete: ${stage.timedOut ? "timed out" : stage.launchError}]`,
          exitCode: 1,
        };
        break;
      }
      stageInput = stage.output;
    }
    if (stageFailed) {
      return { passed: false, outcome: "inconclusive", inconclusiveReason: "filter-incomplete", failedCommand: rawCommand, ...stageFailed };
    }
    if (head.exitCode === 0) {
      return { passed: true, outcome: "pass" };
    }
    const evidence = [`[pipeline head exited ${head.exitCode}]`, stageInput || "(no output survived the filters)"]
      .join("\n")
      .slice(-MECHANICAL_OUTPUT_TAIL_CHARS);
    if (attempt === 1) {
      firstFailure = { output: evidence, exitCode: head.exitCode };
    } else {
      return {
        passed: false,
        outcome: "fail",
        failedCommand: rawCommand,
        output: `[mechanical pipeline retried once after a failed first attempt (head exit ${firstFailure!.exitCode}); second attempt also failed — output tail below]\n` + evidence,
        exitCode: head.exitCode,
      };
    }
  }
  return { passed: false, outcome: "fail", failedCommand: rawCommand, output: firstFailure?.output ?? "", exitCode: firstFailure?.exitCode ?? 1 };
}

/** v0.39.18: default mechanical gate budget 10min → 25min. The v0.35.16
 * 10-minute ceiling repeated its own failure mode: this repo's honest gates
 * outgrew it (`npm run test:all` ≈ 9.5min over 379 files, `npm run
 * release:check` longer still), so every milestone/auditor gate on a slow
 * host fast-failed as INCONCLUSIVE-timeout — a non-verdict that blocks goal
 * completion exactly like the 60s ceiling blocked approvals in 2026-08.
 * The timeout still bounds genuinely hung commands (a hung gate is killed
 * and reads inconclusive, never failed); it no longer bounds honest slow
 * ones. All other rails are unchanged: process-group cap, 64MB output cap,
 * tail-kept evidence, and the 2× load-scale ceiling (≤50min worst case on a
 * saturated host — accepted, because killing an honest gate produces no
 * verdict and strands the objective, which is worse than holding the
 * worker). Raise deliberately: tests/mechanical-inconclusive.test.ts pins
 * this value. */
export const DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS = 1_500_000;
const MECHANICAL_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MECHANICAL_OUTPUT_TAIL_CHARS = 64 * 1024;
const MECHANICAL_CHILD_SHUTDOWN_GRACE_MS = 1_000;
const MECHANICAL_FORCE_KILL_SETTLE_MS = 250;
/** A verification command may be project code, but it must not be able to
 * consume the host by recursively forking faster than the wall timeout can
 * react. This is intentionally generous for parallel test runners while
 * still stopping the 1,000-process self-invocation shape observed in the
 * field. Linux is the only platform with a cheap process-group census; the
 * existing timeout/tree teardown remains the portable fallback elsewhere. */
export const MAX_MECHANICAL_PROCESS_GROUP_SIZE = 256;
const MECHANICAL_PROCESS_GROUP_POLL_MS = 100;

interface MechanicalCommandRun {
  output: string;
  exitCode: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  aborted: boolean;
  outputLimit: boolean;
  processGroupLimit: boolean;
  processGroupLimitSize: number;
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function linuxProcessGroupId(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const group = Number(fields[2]); // stat field 5, after pid/comm/state/ppid
    return Number.isInteger(group) && group > 1 ? group : undefined;
  } catch {
    return undefined;
  }
}

function linuxProcessGroupSize(group: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return undefined;
  }
  let count = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || linuxProcessGroupId(pid) !== group) continue;
    count++;
  }
  return count;
}

function destroyChildStreams(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* best effort */ }
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!childIsRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve();
    };
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

function signalMechanicalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || !child.pid) return false;
  try {
    // Mechanical commands are spawned detached below, making the PID the
    // POSIX process-group leader. A negative PID reaches recursive shells,
    // interpreters, and grandchildren instead of leaving a fork chain behind.
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalMechanicalProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (signalMechanicalProcessGroup(child, signal)) return true;
  try { return child.kill(signal); } catch { return false; }
}

async function terminateMechanicalProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    if (child.pid && childIsRunning(child)) {
      let killer: ChildProcess | undefined;
      try {
        killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await waitForChildExit(killer, MECHANICAL_CHILD_SHUTDOWN_GRACE_MS);
      } catch {
        /* direct fallback below */
      }
    }
    if (childIsRunning(child)) {
      try { child.kill(); } catch { /* best effort */ }
      await waitForChildExit(child, MECHANICAL_FORCE_KILL_SETTLE_MS);
    }
    destroyChildStreams(child);
    return;
  }

  if (childIsRunning(child)) {
    signalMechanicalProcess(child, "SIGTERM");
    await waitForChildExit(child, MECHANICAL_CHILD_SHUTDOWN_GRACE_MS);
  }
  // Even when the direct command obeys TERM, its descendants may not. The
  // group kill after the direct exit closes the orphan-descendant hole.
  if (child.pid) signalMechanicalProcessGroup(child, "SIGKILL");
  if (childIsRunning(child)) signalMechanicalProcess(child, "SIGKILL");
  await waitForChildExit(child, MECHANICAL_FORCE_KILL_SETTLE_MS);
  destroyChildStreams(child);
}

function normalizeMechanicalProcessGroupLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2
    ? Math.min(MAX_MECHANICAL_PROCESS_GROUP_SIZE, value)
    : MAX_MECHANICAL_PROCESS_GROUP_SIZE;
}

function appendMechanicalOutputTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MECHANICAL_OUTPUT_TAIL_CHARS
    ? combined
    : combined.slice(-MECHANICAL_OUTPUT_TAIL_CHARS);
}

/**
 * Environment for a mechanical check: the parent environment plus the
 * project's own `node_modules/.bin` first on PATH (when it exists), so
 * bare contract bins (`tsc`, `eslint`, `wxt`, …) resolve exactly as they do
 * under `npm run`. Pure and unit-testable via the exported helper below.
 */
export function mechanicalCheckEnv(cwd: string): NodeJS.ProcessEnv {
  const localBin = path.join(cwd, "node_modules", ".bin");
  let isDir = false;
  try {
    isDir = fs.statSync(localBin).isDirectory();
  } catch { /* absent — parent PATH stands */ }
  if (!isDir) return { ...process.env };
  const parentPath = process.env.PATH ?? "";
  const alreadyFirst = parentPath === localBin
    || parentPath.startsWith(localBin + path.delimiter);
  if (alreadyFirst) return { ...process.env };
  return {
    ...process.env,
    PATH: parentPath ? `${localBin}${path.delimiter}${parentPath}` : localBin,
  };
}

function runMechanicalCommand(
  cwd: string,
  program: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  maxProcessGroupSize = MAX_MECHANICAL_PROCESS_GROUP_SIZE,
): Promise<MechanicalCommandRun> {
  return new Promise((resolve) => {
    const processGroupLimitSize = normalizeMechanicalProcessGroupLimit(maxProcessGroupSize);
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd,
        // A mechanical command is untrusted project code. Give it its own
        // process group so timeout/abort cleanup reaches every descendant.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // v0.38.23 (field 2026-09-05): a contract naming a project-local bin
        // (`tsc --noEmit`, `eslint`, `wxt build`) spawned it BARE, but bare
        // names only resolve via the parent PATH — node_modules/.bin was
        // never consulted, so a green tree fast-failed with `spawn tsc
        // ENOENT` while the project's own `bun run check` passed. npm-run
        // parity: resolve project-local bins first, exactly as `npm run`
        // does for every script it executes.
        env: mechanicalCheckEnv(cwd),
      });
      registerOwnedTestProcess(child);
    } catch (error) {
      resolve({
        output: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        timedOut: false,
        aborted: false,
        outputLimit: false,
        processGroupLimit: false,
        processGroupLimitSize,
      });
      return;
    }

    let stdoutTail = "";
    let stderrTail = "";
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimit = false;
    let processGroupLimit = false;
    let launchError: string | undefined;
    let termination: Promise<void> | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let processGroupTimer: NodeJS.Timeout | undefined;
    let settleFallbackTimer: NodeJS.Timeout | undefined;
    let closeSeen = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const settle = (code: number | null, childSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (processGroupTimer) clearInterval(processGroupTimer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      signal?.removeEventListener("abort", onAbort);
      const output = [stdoutTail, stderrTail, launchError].filter(Boolean).join("\n");
      destroyChildStreams(child);
      resolve({
        output,
        exitCode: code ?? (childSignal || timedOut || aborted || outputLimit || launchError ? 1 : 0),
        ...(childSignal ? { signal: childSignal } : {}),
        timedOut,
        aborted,
        outputLimit,
        processGroupLimit,
        processGroupLimitSize,
      });
    };

    const settleAfterTermination = (code: number | null, childSignal: NodeJS.Signals | null): void => {
      if (!termination) {
        settle(code, childSignal);
        return;
      }
      void termination.then(() => {
        if (closeSeen) {
          settle(code, childSignal);
          return;
        }
        // A descendant that escaped the process group can keep a pipe open;
        // do not let that defeat the bounded runner, but give normal stdio a
        // short window to drain before returning the diagnostic tail.
        settleFallbackTimer ??= setTimeout(() => settle(exitCode, exitSignal), MECHANICAL_FORCE_KILL_SETTLE_MS);
        settleFallbackTimer.unref?.();
      });
    };

    const requestTermination = (reason: "timeout" | "abort" | "output-limit" | "process-limit"): void => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (reason === "output-limit") outputLimit = true;
      if (reason === "process-limit") processGroupLimit = true;
      termination ??= terminateMechanicalProcessTree(child).catch(() => {});
      // A descendant that keeps a stdio pipe open must not hold this promise
      // forever after its process group has been terminated.
      settleAfterTermination(exitCode, exitSignal);
    };

    const onAbort = (): void => requestTermination("abort");
    const onOutput = (target: "stdout" | "stderr") => (chunk: Buffer | string): void => {
      if (settled) return;
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text, "utf8");
      if (target === "stdout") stdoutTail = appendMechanicalOutputTail(stdoutTail, text);
      else stderrTail = appendMechanicalOutputTail(stderrTail, text);
      if (outputBytes > MECHANICAL_MAX_OUTPUT_BYTES) requestTermination("output-limit");
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onOutput("stdout"));
    child.stderr?.on("data", onOutput("stderr"));
    child.once("error", (error) => {
      launchError = error instanceof Error ? error.message : String(error);
      if (termination) settleAfterTermination(exitCode, exitSignal);
      else settle(1, null);
    });
    // A command can exit while a grandchild keeps an inherited stdio pipe
    // open, or can daemonize a child with stdio ignored. Clean up the owned
    // detached group on every direct exit, not only on timeout, so a green or
    // red check cannot strand a background process tree behind it.
    child.once("exit", (code, childSignal) => {
      exitCode = code;
      exitSignal = childSignal;
      termination ??= terminateMechanicalProcessTree(child).catch(() => {});
      settleAfterTermination(code, childSignal);
    });
    child.once("close", (code, childSignal) => {
      closeSeen = true;
      exitCode = code;
      exitSignal = childSignal;
      if (termination) settleAfterTermination(code, childSignal);
      else settle(code, childSignal);
    });
    timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
    timer.unref?.();
    const processGroup = child.pid ? linuxProcessGroupId(child.pid) : undefined;
    if (processGroup !== undefined) {
      processGroupTimer = setInterval(() => {
        if (settled || !childIsRunning(child)) return;
        const size = linuxProcessGroupSize(processGroup);
        if (size !== undefined && size > processGroupLimitSize) requestTermination("process-limit");
      }, MECHANICAL_PROCESS_GROUP_POLL_MS);
      processGroupTimer.unref?.();
    }
    if (signal?.aborted) requestTermination("abort");
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatMechanicalFailure(run: MechanicalCommandRun, timeoutMs: number): { output: string; exitCode: number } {
  const body = run.output.trim() || (run.signal ? `Process terminated by ${run.signal}` : "Command failed");
  const banner = run.timedOut
      ? `[mechanical check killed after ${Math.round(timeoutMs / 1000)}s — process tree terminated; output tail below]`
      : run.aborted
        ? "[mechanical check aborted — process tree terminated; output tail below]"
        : run.processGroupLimit
          ? `[mechanical check exceeded its ${run.processGroupLimitSize}-process group safety limit — process tree terminated; output tail below]`
          : run.outputLimit
            ? "[mechanical check exceeded its 64MB output limit — process tree terminated; output tail below]"
            : "";
  const evidence = body.length > 4000 ? "…[truncated head]\n" + body.slice(-4000) : body;
  return { output: (banner ? banner + "\n" : "") + evidence, exitCode: run.exitCode };
}

/** v0.35.7: Execute mechanical pre-audit checks deterministically.
 *
 * v0.35.16: default timeout 60s → 10min. The old 60s ceiling killed
 * LEGITIMATE long gates mid-run: this repo's own contract command,
 * `npm run release:check`, needs ~3 minutes (full suite + tsc + Jiti smoke
 * + pack), so every deterministic pre-audit fast-failed with a truncated
 * head-of-output report that showed startup logs instead of any failure —
 * twice in the field (2026-08-21 14:17 and 16:01 disapprovals), burning two
 * auditor rounds on a gate that could never pass inside its own bound. The
 * timeout still bounds genuinely hung commands; it no longer bounds honest
 * slow ones. Failed output now keeps the TAIL, not the head — the end of a
 * killed/failed run shows what was actually happening at death.
 */
export async function runMechanicalPreAuditChecks(
  cwd: string,
  commands: string[],
  timeoutMs = DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS,
  signal?: AbortSignal,
  maxProcessGroupSize = MAX_MECHANICAL_PROCESS_GROUP_SIZE,
  opts?: { loadScale?: boolean },
): Promise<MechanicalCheckResult> {
  if (!commands || commands.length === 0) return { passed: true, outcome: "pass" };
  const baseTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS;
  // v0.38.103: scale the budget with host load (capped 2×) unless the
  // caller disables it — a gate that needs 25 minutes idle must not be
  // killed at 25:00 sharp on a saturated host and then read as a verdict.
  // (v0.39.18: example numbers follow DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS.)
  const effectiveTimeoutMs = opts?.loadScale === false ? baseTimeoutMs : scaledMechanicalTimeoutMs(baseTimeoutMs);
  const effectiveProcessGroupSize = normalizeMechanicalProcessGroupLimit(maxProcessGroupSize);
  const recoveredRetries: string[] = [];
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg && typeof pkg.scripts === "object" && pkg.scripts) scripts = pkg.scripts;
  } catch { /* no package.json — nothing to resolve */ }
  for (const rawCommand of commands) {
    const cmd = rawCommand.trim();
    const compound = safeFileMarkerCompound(cmd);
    if (compound) {
      // Run each allowlisted assertion independently so no shell ever parses
      // the conjunction. Keep the original compound text in a failure result
      // so the auditor sees which contract item failed.
      for (const step of compound) {
        // Pass the caller's base (not the scaled value): scaling applies
        // once per check, never compounded per recursion level.
        const stepResult = await runMechanicalPreAuditChecks(cwd, [step], baseTimeoutMs, signal, effectiveProcessGroupSize, opts);
        if (!stepResult.passed) return { ...stepResult, failedCommand: rawCommand };
      }
      continue;
    }
    // v0.38.18 (track 1): narrow `head | tail/head/grep` pipelines run
    // shell-free before the single-command gate below.
    const pipeline = parseMechanicalPipeline(cmd);
    if (pipeline) {
      const pipelineResult = await runMechanicalPipeline(cwd, pipeline, rawCommand, scripts, effectiveTimeoutMs, signal, effectiveProcessGroupSize);
      if (!pipelineResult.passed) return pipelineResult;
      continue;
    }
    if (!isSafeMechanicalCommand(cmd)) {
      return {
        passed: false,
        outcome: "fail",
        failedCommand: rawCommand,
        output: cmd.includes("|")
          ? "Rejected unsafe mechanical pipeline syntax; only `command | tail -n N`, `command | head -n N`, and `command | grep <literal>` are allowed (no redirects except a trailing 2>&1, no second program)."
          : "Rejected unsafe mechanical command syntax; only a single executable followed by literal arguments is allowed.",
        exitCode: 126,
      };
    }
    const [rawProgram] = cmd.split(/[ \t]+/);
    // v0.35.18: a contract that names a raw runner ("bun test") must run the
    // project's CANONICAL invocation of it — package.json scripts encode the
    // flags the suite requires (serialization/isolation/timeouts). Running
    // the bare runner ignores that configuration and fails spuriously while
    // the real gate is green (field: fourth audit round, 2026-08-21).
    // (scripts are loaded once above the loop so the pipeline path shares them.)
    const { program, args } = resolveCanonicalRunnerCommand(cmd, scripts);
    if (!program) {
      return { passed: false, outcome: "fail", failedCommand: rawCommand, output: "Empty mechanical command.", exitCode: 126 };
    }
    // v0.35.20: ONE bounded automatic retry per failed mechanical command.
    // Field (sixth audit round, 2026-08-21): the gate died MID-RUN under
    // machine load ~30 (output ends inside a passing file, no runner
    // summary, exit 1) while the identical tree passed green twice in
    // isolation — resource contention, not a red suite. A deterministic
    // contract command that genuinely fails stays red on both attempts;
    // only transient deaths get a second chance. The retry is bannered in
    // the returned evidence so the auditor sees it happened.
    let firstFailure: { output: string; exitCode: number } | null = null;
    let passed = false;
    for (let attempt = 1; attempt <= 2 && !passed; attempt++) {
      const run = await runMechanicalCommand(cwd, program, args, effectiveTimeoutMs, signal, effectiveProcessGroupSize);
      if (!run.timedOut && !run.aborted && !run.outputLimit && !run.processGroupLimit && run.exitCode === 0) {
        passed = true;
        continue;
      }
      const failure = formatMechanicalFailure(run, effectiveTimeoutMs);
      // A timeout, caller abort, or output-limit breach is a containment
      // event, not a transient test wobble. Retrying would immediately start
      // another untrusted process tree and can recreate the incident.
      // v0.38.103: containment is INCONCLUSIVE, not failure — the gate never
      // produced evidence about the work. Callers route this to infra retry,
      // never to a disapproval verdict.
      if (run.timedOut || run.aborted || run.outputLimit || run.processGroupLimit) {
        return {
          passed: false,
          outcome: "inconclusive",
          inconclusiveReason: containmentReason(run) ?? "timeout",
          failedCommand: rawCommand,
          output: failure.output,
          exitCode: failure.exitCode,
        };
      }
      if (attempt === 1) {
        firstFailure = failure;
      } else {
        return {
          passed: false,
          outcome: "fail",
          failedCommand: rawCommand,
          output: firstFailure
            ? `[mechanical check retried once after a failed first attempt (exit ${firstFailure.exitCode}); second attempt also failed — output tail below]\n` + failure.output
            : failure.output,
          exitCode: failure.exitCode,
        };
      }
    }
    if (passed && firstFailure) {
      // First attempt failed, second PASSED — recoverable transience; keep
      // checking later contract commands instead of treating this one as the
      // whole contract.
      recoveredRetries.push(`[mechanical check ${rawProgram}: first attempt failed (exit ${firstFailure.exitCode}); automatic retry passed]`);
    }
  }
  return { passed: true, outcome: "pass", ...(recoveredRetries.length ? { recoveredRetryNote: recoveredRetries.join(" ") } : {}) };
}

/** v0.38.103: shaped verdict for a non-passing mechanical result — pure so
 * the pre-audit call site and its test share it. `fail` becomes the
 * historical fast-fail disapproval; `inconclusive` becomes an infra error
 * (approved:false, disapproved:false) that enters the durable retry plan
 * instead of the rework loop. */
export interface MechanicalPreAuditVerdict {
  approved: boolean;
  disapproved: boolean;
  impossible: false;
  error?: string;
  output: string;
}

export function mechanicalPreAuditVerdict(result: MechanicalCheckResult): MechanicalPreAuditVerdict {
  const evidence = result.output ?? "";
  if (result.outcome === "inconclusive") {
    const reason = result.inconclusiveReason ?? "unknown";
    return {
      approved: false,
      disapproved: false,
      impossible: false,
      error: `mechanical gate inconclusive (${reason}): \`${result.failedCommand ?? "contract command"}\` could not complete — not a verdict on the work`,
      output: `Deterministic Pre-Audit Inconclusive: Mechanical contract check ${reason}: \`${result.failedCommand ?? "contract command"}\`\n\n<evidence>\n${evidence}\n</evidence>`,
    };
  }
  return {
    approved: false,
    disapproved: true,
    impossible: false,
    output: `<disapproved/>\n\nDeterministic Pre-Audit Fast-Fail: Mechanical contract check failed: \`${result.failedCommand}\` (exit code ${result.exitCode})\n\n<evidence>\n${evidence}\n</evidence>`,
  };
}
