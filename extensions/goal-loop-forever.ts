/**
 * pi-goal-list-loop-audit — v0.3.0
 * extensions/goal-loop-forever.ts
 *
 * Loop 3 core: metric parsing, improvement comparison, plateau detection.
 * Pure + dependency-free so unit tests can exercise it under plain node.
 *
 * Design rule (the anti-doorknob law): the loop only believes a number.
 * The orchestrator runs the user's measure command; the agent never
 * self-reports progress.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { piGlaDir } from "./goal-loop-core.js";

export type LoopDirection = "min" | "max";

export interface LoopMeasure {
  iteration: number;
  value: number | null;
  improved: boolean;
  at: string;
}

export interface LoopRefinement {
  at: string;
  iteration: number;
  oldTarget: string;
  newTarget: string;
  oldMeasureCmd: string;
  newMeasureCmd: string;
}

/** v0.28.17: stopReason marking a loop parked by the session-restore gate
 * (it was active when the last session ended; the fresh session holds it
 * until the user resumes with /loop). Exported so the display layer can
 * recognize held loops — they must stay VISIBLE in the status/widget,
 * unlike stopped loops which are genuinely gone. */
export const HELD_ON_RESTORE = "held: restored in a fresh session";

/** Reasons that represent a lifecycle/recovery hold rather than deliberate
 * operator intent. These may auto-resume on a validated successor session;
 * user stops, provider/manual safety stops, plateaus, and stuck brakes do not.
 * Keep the stalled prefixes narrow: the heartbeat's
 * `stalled: ... consecutive unproductive turns` is a deliberate safety brake,
 * not a lifecycle handoff. */
export function isLifecycleHeldLoopReason(reason?: string): boolean {
  return reason === HELD_ON_RESTORE
    || !!reason?.startsWith("extension api stale")
    || !!reason?.startsWith("stalled: continuation refires landed no turn")
    || !!reason?.startsWith("stalled: continuation start acknowledgement timed out")
    || !!reason?.startsWith("send-retry storm:");
}

export interface LoopState {
  target: string;
  /** v0.23.0: optional — a metricless "spec loop" (measure=none) has no
   * metric, no direction, and NO plateau stop; it ends only at max/time/
   * tokens bounds or /loop stop. */
  measureCmd?: string;
  direction?: LoopDirection;
  iteration: number;
  /** v0.23.0: 0 = unbounded (no iteration cap). Default 50. */
  maxIterations: number;
  plateauWindow: number;
  stallCount: number;
  /** v0.28.8 (E5): consecutive iterations where the measure printed NO
   * number. Tracked separately from stallCount — plateau judges movement
   * (a real number that didn't improve); a broken measure says nothing
   * about movement and must stop the loop with its own loud reason. */
  consecutiveNullMeasures?: number;
  /** v0.29.19: consecutive provider-error/user-abort turns. Exempt from
   * stall/stuck/plateau accounting (the model never got a say — a dead
   * turn is not evidence about the work); capped so an outage stops the
   * loop with an honest reason instead of burning turns forever. Field
   * 2026-07-31 (MiniMax token-plan 429 storm): hegemon false-plateau'd
   * with 13 open findings, polis with 3+, hellhunter stuck-stopped at
   * iter 93 — every counted turn was a dead 429 turn. */
  consecutiveErrors?: number;
  /** v0.29.19: audit plateau reprieves used so far (open findings remain
   * = the well isn't dry, so the plateau stop stands down). Bounded by
   * AUDIT_PLATEAU_MAX_REPRIEVES — the next plateau stop stands, honestly
   * named. */
  auditPlateauReprieves?: number;
  /** v0.29.19: one-shot shove injected into the next iteration's prompt
   * after a plateau reprieve; cleared on use. */
  auditReprieveNote?: string;
  bestValue: number | null;
  lastValue: number | null;
  /** v0.29.10: audit loops (measure counts open findings) get a deferred
   * baseline (first REAL measurement seeds best — the pre-discovery 0 is
   * degenerate) and audit-flavoured regression wording. */
  kind?: "audit";
  active: boolean;
  stopReason?: string;
  history: LoopMeasure[];
  startedAt: string;
  /** v0.15.0: arbitrary bounds (never "completion") — stop after this many hours. */
  timeLimitHours?: number;
  /** v0.15.0: arbitrary bounds — stop after this many tokens (input+output). */
  tokenBudget?: number;
  /** v0.15.0: accumulated loop tokens (input+output), orchestrator-counted. */
  tokensUsed?: number;
  /** v0.15.0: living spec — user-confirmed target/measure refinements. */
  refinements?: LoopRefinement[];
  /** branch=1 mode: scratch branch holding the loop's commits. */
  branchName?: string;
  /** branch=1 mode: the branch to return to on stop. */
  originalBranch?: string;
  /** v0.24.0 anti-repetition: rolling fingerprints of iteration replies. */
  recentPrints?: string[];
  /** v0.24.0: last few iteration texts (near-duplicate check + banned openings). */
  recentTexts?: string[];
  /** v0.24.0: rolling tool-result fingerprints {tool, hash, isError}. */
  recentToolResults?: { tool: string; hash: string; isError: boolean }[];
  /** v0.24.0: tool calls seen since the last completed iteration. */
  toolsThisTurn?: number;
  /** v0.24.0: consecutive iterations with zero tool calls. */
  toollessStreak?: number;
  /** v0.24.0: consecutive stuck interventions (resets on a clean iteration). */
  consecutiveStuck?: number;
  /** v0.24.0: the last stuck reason (for the intervention directive + ledger). */
  lastStuckReason?: string;
  /** v0.25.1: /loop start toolsamerepeat=N — legacy same-tool-same-result
   * check window. 0 disables it (multi-signal detector only). */
  toolSameRepeat?: number;
  /** v0.33.2: respec loops carry their spec file — drift detection
   * (specHash compared per tick), checkbox progress (specChecked →
   * spec_item_progress events), and the refine tool's specText write path. */
  specFile?: string;
  specHash?: string;
  specChecked?: number;
  /** v0.33.2: hypothesis feedback loop — the last turn's HYPOTHESIS line
   * plus the verdict computed against the metric movement, injected into
   * the next iteration's prompt. */
  lastHypothesis?: string;
  hypothesisFeedback?: string;
  /** v0.33.2: /loop refine <text> — the operator's respec suggestion rides
   * the next iteration's prompt; the agent proposes via propose_loop_refine. */
  refineHint?: string;
  /** v0.25.1: per-iteration progress-signal accumulators for the
   * multi-signal stuck gate. fileWrites bumps on write/edit tool results;
   * iterationStartHead/At snapshot when the iteration BEGAN so the tick can
   * count commits and spec_item_progress events produced during it. */
  iterMetrics?: {
    fileWrites: number;
    iterationStartHead?: string;
    iterationStartAt?: string;
  };
}

/** v0.25.1: stop reason for /loop finish — a clean "completed" end,
 * distinct from stuck/plateau/stopped-by-user. */
export function loopFinishStopReason(reason?: string): string {
  const r = (reason ?? "").trim();
  return `completed: ${r || "finished by user"}`;
}

/** v0.25.1: tool names that count as file-write progress signals for the
 * multi-signal stuck gate (item 3). */
export const LOOP_WRITE_TOOLS = ["write", "edit", "multi_edit", "write_file"] as const;

export function isLoopWriteTool(toolName: string): boolean {
  return (LOOP_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/** Scratch-branch name for branch=1 mode. Format pinned by tests. */
export function loopBranchName(startedAtIso: string, target: string): string {
  const stamp = startedAtIso.replace(/[^0-9]/g, "").slice(0, 14);
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "loop";
  return `pi-glla-loop/${stamp}-${slug}`;
}

export const LOOP_DEFAULTS = {
  maxIterations: 50,
  plateauWindow: 5,
};

/**
 * Apply a user-confirmed spec refinement (v0.15.0, propose_loop_refine).
 * The loop is a process against a LIVING spec: target/measure may be
 * sharpened mid-run. History keeps both eras via `refinements`. When the
 * measure changes, the old best/last values are a different scale — the
 * caller re-baselines with a fresh measurement and stall state resets.
 */
export function applyRefinement(
  loop: LoopState,
  refinement: LoopRefinement,
  newBaseline: number | null,
): void {
  loop.refinements = loop.refinements ?? [];
  loop.refinements.push(refinement);
  loop.target = refinement.newTarget;
  const measureChanged = refinement.newMeasureCmd !== refinement.oldMeasureCmd;
  loop.measureCmd = refinement.newMeasureCmd;
  if (measureChanged) {
    loop.bestValue = newBaseline;
    loop.lastValue = newBaseline;
    loop.stallCount = 0;
  }
}

/**
 * Parse the first number in measure-command output. Accepts integers,
 * decimals, negatives, and scientific notation; ignores surrounding text
 * (e.g. "score: 42" → 42). Returns null when no number is present — a
 * broken measure is a stall, never a crash.
 */
export function parseMetric(output: string): number | null {
  const m = output.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]!);
  return Number.isFinite(n) ? n : null;
}

/** Did `value` improve on `best` for this direction? First value is always a baseline. */
export function isImprovement(direction: LoopDirection, value: number, best: number | null): boolean {
  if (best === null) return true;
  return direction === "min" ? value < best : value > best;
}

export type LoopTickOutcome =
  | { kind: "continue"; improved: boolean; value: number | null }
  | { kind: "stop"; reason: string };

/**
 * Apply one measurement to the loop state (mutates + returns the outcome).
 * v0.15.0: a loop NEVER checks for completion — there is no done=. Stop
 * rules, in order: time bound, token bound, plateau (stall >= window),
 * iteration cap. All four are arbitrary ends; the metric only judges
 * movement, never arrival.
 */
export function applyMeasurement(loop: LoopState, value: number | null, at: string): LoopTickOutcome {
  loop.iteration++;
  // v0.35.42 (audit finding): a measure-CHANGING refinement starts a NEW
  // metric era. applyRefinement re-baselines best/last/stall but keeps
  // history — so OLD-era `improved` entries made both movement checks read
  // permanently true for the new era: the v0.35.31 flat-reading grace
  // could never apply after a measure-changing refine, and a dead NEW
  // metric could never earn its never-moved stop. Both checks are scoped
  // to the CURRENT era: everything after the last measure-changing
  // refinement's iteration (the next measured tick is +1).
  const lastMeasureChange = (loop.refinements ?? []).filter((r) => r.newMeasureCmd !== r.oldMeasureCmd).pop();
  const measureEraStart = lastMeasureChange ? lastMeasureChange.iteration : 0;
  // improved is judged BEFORE bestValue moves (post-mutation it would read false).
  const improved = value !== null && loop.direction !== undefined && isImprovement(loop.direction, value, loop.bestValue);
  if (value === null) {
    // E5: a null measure is NOT a stall — it carries no information about
    // improvement. Plateau stays reserved for real non-improving numbers.
    loop.consecutiveNullMeasures = (loop.consecutiveNullMeasures ?? 0) + 1;
  } else {
    loop.consecutiveNullMeasures = 0;
    // v0.35.31 (field: doomtap 2026-08-22): before the metric has EVER
    // demonstrated movement, a flat reading means the baseline is still
    // forming — under min with a pre-work zero (or max with an early
    // ceiling), every later productive reading scores "flat" and burned
    // plateau slots toward a false "plateau — best: 0" stop while the loop
    // was visibly fixing real work. Flat readings only count toward the
    // plateau once the metric has moved (an improvement on record, or a
    // bestValue that differs from the first measured value — the latter
    // covers resumed runs whose history restarted). Bounded below by the
    // never-moved cap so a dead metric still ends loudly.
    // Audit loops (kind === "audit") are EXEMPT from both halves of this
    // fix: they carry purpose-built deferred-baseline + reprieve plateau
    // semantics (v0.29.10/v0.29.19) and must keep their stall accounting
    // verbatim.
    const numericHistory = loop.kind === "audit" ? [] : loop.history.filter((h) => h.value !== null && h.iteration > measureEraStart);
    const metricHasMoved = loop.kind === "audit" || loop.history.some((h) => h.improved && h.iteration > measureEraStart)
      || (numericHistory.length === 0
        ? // No numeric readings yet this run: indistinguishable from a
          // resumed run with real prior movement — keep the conservative
          // legacy behavior (flat counts).
          true
        : typeof loop.bestValue === "number" && loop.bestValue !== numericHistory[0]!.value);
    if (improved) {
      loop.bestValue = value;
      loop.stallCount = 0;
    } else if (metricHasMoved) {
      loop.stallCount++;
    }
  }
  loop.lastValue = value;
  loop.history.push({ iteration: loop.iteration, value, improved, at });
  if (loop.history.length > 200) loop.history.splice(0, loop.history.length - 200);

  if (loop.timeLimitHours !== undefined) {
    const elapsedH = (Date.parse(at) - Date.parse(loop.startedAt)) / 3_600_000;
    if (Number.isFinite(elapsedH) && elapsedH >= loop.timeLimitHours) {
      loop.active = false;
      loop.stopReason = `time bound reached (${loop.timeLimitHours}h); best: ${loop.bestValue ?? "n/a"}`;
      return { kind: "stop", reason: loop.stopReason };
    }
  }
  if (loop.tokenBudget !== undefined && (loop.tokensUsed ?? 0) >= loop.tokenBudget) {
    loop.active = false;
    loop.stopReason = `token budget exhausted (${(loop.tokensUsed ?? 0).toLocaleString()} >= ${loop.tokenBudget.toLocaleString()}); best: ${loop.bestValue ?? "n/a"}`;
    return { kind: "stop", reason: loop.stopReason };
  }
  // E5: a broken measure command gets its OWN loud stop — never the
  // misleading "plateau — no improvement" (there was nothing to improve
  // against; the metric itself is dead).
  if ((loop.consecutiveNullMeasures ?? 0) >= loop.plateauWindow) {
    loop.active = false;
    loop.stopReason = `measure command broken — ${loop.consecutiveNullMeasures} consecutive iterations printed no number (cmd: \`${loop.measureCmd ?? "?"}\`). Fix the measure command, or /loop stop.`;
    return { kind: "stop", reason: loop.stopReason };
  }
  if (loop.stallCount >= loop.plateauWindow) {
    loop.active = false;
    loop.stopReason = `plateau — no improvement in ${loop.plateauWindow} consecutive iterations (best: ${loop.bestValue ?? "n/a"})`;
    return { kind: "stop", reason: loop.stopReason };
  }
  // v0.35.31: the never-moved grace above needs its own bound — a metric
  // that NEVER moves would otherwise dodge plateau forever. Twice the window
  // in measured iterations without one improvement is a loud, distinct stop
  // naming the actual suspect (direction/measureCmd), not a fake plateau.
  if (loop.kind !== "audit") {
  const numericHistory = loop.history.filter((h) => h.value !== null && h.iteration > measureEraStart);
  const measured = numericHistory.length;
  const metricNeverMoved = !loop.history.some((h) => h.improved && h.iteration > measureEraStart)
    && measured > 0
    && (typeof loop.bestValue !== "number" || loop.bestValue === numericHistory[0]!.value);
  if (metricNeverMoved && measured >= loop.plateauWindow * 2) {
    loop.active = false;
    loop.stopReason = `metric never moved — ${measured} measurements without one improvement against the initial reading (best: ${loop.bestValue ?? "n/a"}, dir ${loop.direction ?? "?"}). Check measureCmd/direction; /loop resume retries or /loop stop.`;
    return { kind: "stop", reason: loop.stopReason };
  }
  }
  if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) {
    loop.active = false;
    loop.stopReason = `max iterations reached (${loop.maxIterations}); best: ${loop.bestValue ?? "n/a"}`;
    return { kind: "stop", reason: loop.stopReason };
  }
  return { kind: "continue", improved, value };
}

/**
 * One iteration of a METRICLESS loop (v0.23.0, measure=none). There is no
 * number to judge movement, so there is no plateau — the loop ends only at
 * the time/token/iteration bounds or /loop stop. This is the Sisyphus mode:
 * work the spec until the bounds say stop. The doorknob risk is real and
 * accepted by the user explicitly; the iteration prompt demands one real,
 * inspectable change per turn.
 */
export function applyMetriclessTick(loop: LoopState, at: string): LoopTickOutcome {
  loop.iteration++;
  loop.history.push({ iteration: loop.iteration, value: null, improved: false, at });
  if (loop.history.length > 200) loop.history.splice(0, loop.history.length - 200);

  if (loop.timeLimitHours !== undefined) {
    const elapsedH = (Date.parse(at) - Date.parse(loop.startedAt)) / 3_600_000;
    if (Number.isFinite(elapsedH) && elapsedH >= loop.timeLimitHours) {
      loop.active = false;
      loop.stopReason = `time bound reached (${loop.timeLimitHours}h) after ${loop.iteration} iterations`;
      return { kind: "stop", reason: loop.stopReason };
    }
  }
  if (loop.tokenBudget !== undefined && (loop.tokensUsed ?? 0) >= loop.tokenBudget) {
    loop.active = false;
    loop.stopReason = `token budget exhausted (${(loop.tokensUsed ?? 0).toLocaleString()} >= ${loop.tokenBudget.toLocaleString()}) after ${loop.iteration} iterations`;
    return { kind: "stop", reason: loop.stopReason };
  }
  if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) {
    loop.active = false;
    loop.stopReason = `max iterations reached (${loop.maxIterations})`;
    return { kind: "stop", reason: loop.stopReason };
  }
  return { kind: "continue", improved: false, value: null };
}

/** Parse `/loop start` args into a config. Throws on missing pieces. */
export function parseLoopStartArgs(raw: string): {
  target: string;
  measureCmd: string;
  direction?: LoopDirection;
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force: boolean;
  timeLimitHours?: number;
  tokenBudget?: number;
  toolSameRepeat?: number;
} {
  // Key=value pairs first (measure= and direction= may hold quoted values),
  // the remaining text is the target. v0.35.4: quoted spans are TARGET
  // territory — a word=value inside the target's quotes ("make a=b work")
  // must not be consumed as a key — and UNKNOWN keys (typos such as
  // direcion=min, or target words containing =) are restored to the target
  // instead of silently vanishing.
  let rest = raw.trim();
  const kv = new Map<string, string>();
  const kvRe = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  const KNOWN_KEYS = new Set(["measure", "direction", "window", "max", "branch", "force", "done", "time", "tokens", "toolsamerepeat"]);
  const quoteSpans: Array<[number, number]> = [];
  const quoteRe = /"([^"]*)"|'([^']*)'/g;
  let qm: RegExpExecArray | null;
  while ((qm = quoteRe.exec(rest)) !== null) {
    quoteSpans.push([qm.index, qm.index + qm[0].length]);
  }
  const insideQuote = (index: number): boolean => quoteSpans.some(([s, e]) => index >= s && index < e);
  let m: RegExpExecArray | null;
  const spans: Array<[number, number]> = [];
  while ((m = kvRe.exec(rest)) !== null) {
    if (insideQuote(m.index)) continue; // key-looking text inside the target's quotes — leave it
    if (!KNOWN_KEYS.has(m[1]!.toLowerCase())) continue; // unknown key — leave it in the target
    kv.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
    spans.push([m.index, m.index + m[0].length]);
  }
  // Remove kv spans from the target text.
  let target = "";
  let cursor = 0;
  for (const [s, e] of spans) {
    target += rest.slice(cursor, s);
    cursor = e;
  }
  target += rest.slice(cursor);
  target = target.trim().replace(/^["']|["']$/g, "").trim();

  const measureRaw = (kv.get("measure") ?? "").trim();
  // v0.23.0: measure=none → metricless "spec loop" (Sisyphus mode). No
  // metric, no direction, no plateau — bounds and /loop stop only.
  // v0.23.6: a bare `/loop start "<target>"` IS the infinite command —
  // no measure= means metricless too. The Confirm dialog names "NO
  // plateau · NO iteration cap · /loop stop" before anything runs, so
  // the choice is never silent (the v0.23.0 rule). Metric loops keep
  // the 50-iteration default cap; metricless loops default to UNBOUNDED
  // (max=0) unless max= is given explicitly.
  const metricless = !measureRaw || measureRaw.toLowerCase() === "none";
  const dirRaw = (kv.get("direction") ?? "").toLowerCase();
  if (metricless && dirRaw) throw new Error("direction= is meaningless without a metric — add measure=\"<cmd>\" or drop direction=");
  if (!metricless && dirRaw !== "min" && dirRaw !== "max") throw new Error("missing direction=min|max (a metric loop needs to know which way is better; a bare /loop start \"<target>\" with no measure= is the infinite metricless form)");
  if (!target) throw new Error("missing target (what to improve), e.g. /loop start \"keep polishing the UI\" — bare start is metricless + unbounded; add measure=\"<cmd>\" direction=min|max for a metric loop");

  const window = Number.parseInt(kv.get("window") ?? "", 10);
  const max = Number.parseInt(kv.get("max") ?? "", 10);
  const branchRaw = (kv.get("branch") ?? "").toLowerCase();
  const forceRaw = (kv.get("force") ?? "").toLowerCase();
  // v0.15.0: done= is removed — a loop never checks for completion. Teach.
  if (kv.has("done")) {
    throw new Error(
      'done= was removed in v0.15.0 — "improve until X" is a GOAL, not a loop. ' +
      'Use /goal "<target>. Done when: <checkable criterion>" (the auditor verifies it). ' +
      "A loop is a process: it runs until /loop stop, plateau, max= iterations, time= hours, or tokens= budget.",
    );
  }
  const timeRaw = Number.parseFloat(kv.get("time") ?? "");
  const tokensRaw = Number.parseInt(kv.get("tokens") ?? "", 10);
  return {
    target,
    measureCmd: metricless ? "" : measureRaw,
    direction: metricless ? undefined : dirRaw as LoopDirection,
    plateauWindow: Number.isFinite(window) && window > 0 ? window : LOOP_DEFAULTS.plateauWindow,
    // v0.23.0: max=0 = truly unbounded (no iteration cap).
    // v0.23.6: metricless with no explicit max= defaults to UNBOUNDED —
    // an infinite loop is the point of the bare form. Metric loops keep
    // the 50-cap default.
    maxIterations: kv.has("max") ? (Number.isFinite(max) && max >= 0 ? max : LOOP_DEFAULTS.maxIterations) : metricless ? 0 : LOOP_DEFAULTS.maxIterations,
    branch: branchRaw === "1" || branchRaw === "true" || branchRaw === "yes",
    force: forceRaw === "1" || forceRaw === "true" || forceRaw === "yes",
    timeLimitHours: Number.isFinite(timeRaw) && timeRaw > 0 ? timeRaw : undefined,
    tokenBudget: Number.isFinite(tokensRaw) && tokensRaw > 0 ? tokensRaw : undefined,
    toolSameRepeat: (() => {
      const raw = (kv.get("toolsamerepeat") ?? "").trim();
      if (!raw) return undefined;
      const n = Number.parseInt(raw, 10);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    })(),
  };
}

// ---- /loop respec (v0.24.3) ----

/** Root-only spec candidates, in priority order. No fuzzy search. */
export const RESPEC_SPEC_CANDIDATES = ["SPEC.md", "spec.md"] as const;

/** Resolve every root spec candidate that exists (priority order). */
export function resolveSpecFiles(cwd: string): string[] {
  const found: string[] = [];
  for (const name of RESPEC_SPEC_CANDIDATES) {
    const p = join(cwd, name);
    try {
      if (existsSync(p) && statSync(p).isFile()) found.push(p);
    } catch { /* unreadable — keep looking */ }
  }
  return found;
}

/** Resolve the project spec in the root only; null when absent. */
export function resolveSpecFile(cwd: string): string | null {
  return resolveSpecFiles(cwd)[0] ?? null;
}

/**
 * The respec target. The spec is DATA, not gospel: the loop reconciles code
 * against it but reports stale/contradictory requirements instead of forcing
 * the code to match a bad spec. Rotation keeps it honest: implement one
 * iteration, audit the next (the doorknob failure is implementing nothing
 * while claiming polish).
 */
export function respecTarget(specName: string): string {
  return `Reconcile the codebase against ${specName} (the project spec in the root). Read the spec critically first: if a requirement is stale, contradictory, or wrong for the current codebase, report the discrepancy and move on — never force the code to match a bad spec. Otherwise pick the next gap between spec and code and close it. Rotate: one iteration implements a missing or outdated spec item, the next audits something already "implemented" against the spec and fixes what drifted.`;
}

// ---- /loop audit (v0.29.0) ----

/**
 * The audit loop's findings file — checkbox lines, append-only. The agent
 * appends new findings and checks off fixed ones; the ORCHESTRATOR counts
 * open boxes every iteration. The agent never self-reports progress.
 */
export const AUDIT_FINDINGS_REL = ".pi-glla/audit-loop/findings.md";

/**
 * The audit-loop measure command: count CLOSED findings. Prints exactly one
 * number in every file state (missing file / zero matches → 0). v0.29.14:
 * flipped from open-count/min — the open count PUNISHES DISCOVERY (a fresh
 * audit finding 11 real issues read as a regression: endless-td-style iter
 * 6 went 27→38→37 and nearly plateau-stopped mid-work). The closed count
 * is monotonic under the honesty law (a checked box requires a fix commit):
 * discovery alone doesn't move it, landing fixes does — so the plateau
 * stop fires only when NO FIXES LAND for the window: the honest dry well. */
export function auditMeasureCmd(): string {
  // v0.35.4: count only closed FIX findings. Checked DECIDED/DEFERRED lines
  // (the one-shot audit's decision records, projectAuditTarget step 4) carry
  // no fix commit — counting them as "closed findings" inflated the
  // monotonic metric without any fix landing and delayed the dry-well
  // plateau stop.
  return `c=$(grep -cE '^- \\[[xX]\\] FIX' ${AUDIT_FINDINGS_REL} 2>/dev/null); echo \${c:-0}`;
}

/**
 * The audit target. User's design (2026-07-29): "the looper running audits
 * to see where to progress and what to fix" — the thing that fires at the
 * end of goals and lists, finds the next batch of work, and works it.
 * Each iteration: fresh audit pass → append NEW findings → fix the top
 * open ones → check them off with the fix commit. Honesty laws: never
 * fabricate findings, never rewrite the file's history, never check a box
 * without the fix commit existing (committed with the repo's configured
 * identity, on the current branch — no invented identities or branches).
 */
export function auditTarget(): string {
  return `Audit the project for real problems and fix them, iteration by iteration — FIX-FIRST: the open backlog comes down before new hunting (user design 2026-07-30: "audit to fix then audit then fix again" — not find-and-present). Every iteration: (1) FIX the highest-severity OPEN finding(s) in ${AUDIT_FINDINGS_REL} — real fixes, committed — then check the box: "- [x] … — fixed in <commit>". An iteration that closes nothing while OPEN findings remain is a wasted iteration: if the top findings are genuinely blocked, say what blocks them in one line and work the first unblocked one — "no new action this turn" is never an acceptable iteration while open boxes exist. (2) RE-AUDIT on cadence, not every iteration — run a fresh audit pass (spawn Explore subagents for breadth; hunting real issues: bugs, broken flows, regressions, drift between docs and code, dead code, security holes; not style nits, not speculative refactors) ONLY when no OPEN findings remain, when roughly ten iterations have passed since the last pass, or when your own fixes plausibly broke something. (3) Append every NEW finding as one checkbox line "- [ ] SEVERITY: short description (file:line)" to ${AUDIT_FINDINGS_REL} (create the file on the first finding; append-only — never delete, rewrite, or reorder existing lines; never re-report a finding already listed). (4) Honesty law: never fabricate findings to look busy; never mark a finding fixed without the fix commit existing. The orchestrator counts CLOSED findings every iteration (direction=max): discovery alone does not move the metric — landing fixes does. When a full audit pass surfaces nothing new AND no open findings remain, say so plainly — the plateau stop ends the loop when the well is dry.`;
}

/** v0.29.19: how many times an audit loop's plateau stop stands down
 * while open findings remain. The plateau after the last reprieve stops
 * the loop with the honest "no closure despite K open findings" reason. */
export const AUDIT_PLATEAU_MAX_REPRIEVES = 2;

/** v0.29.19: orchestrator-side count of OPEN audit findings — the honest
 * "is the well dry" signal for audit-loop plateau decisions. The plateau
 * stop means "the well is dry"; with K open boxes it is objectively not. */
export function countOpenAuditFindings(cwd: string): number {
  try {
    const p = join(piGlaDir(cwd), "audit-loop/findings.md");
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf-8").split("\n").filter((l) => /^- \[[ \t]+\]/.test(l)).length;
  } catch {
    return 0;
  }
}

/** v0.33.2: the first OPEN finding's text — the reprieve note names what
 * to close, not just how many remain. */
export function topOpenAuditFinding(cwd: string): string | null {
  try {
    const p = join(piGlaDir(cwd), "audit-loop/findings.md");
    if (!existsSync(p)) return null;
    const line = readFileSync(p, "utf-8").split("\n").find((l) => /^- \[[ \t]+\]/.test(l));
    return line ? line.replace(/^- \[ \]\s*/, "").trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** v0.33.2: spec drift detection — short sha256 of the spec file. */
export function specFileHash(p: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(p, "utf-8")).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** v0.33.2: checked checkbox count in a spec file (spec_item_progress). */
export function countCheckedSpecItems(p: string): number | null {
  try {
    return readFileSync(p, "utf-8").split("\n").filter((l) => /^- \[x\]/i.test(l)).length;
  } catch {
    return null;
  }
}

// ---- /goal audit-project (v0.29.8) ----

/**
 * The one-shot project audit (user design 2026-07-30): "/loop audit keeps
 * firing — this would be fire and address what you can, present what is to
 * be decided; whether to fix a bug is not a decision." Same findings file
 * as the audit loop (one ledger per project — the loop can keep working
 * what the one-shot surfaced), but exactly ONE pass with a finish line the
 * isolated auditor verifies, and the triage law the loop doesn't have:
 * FIX findings (bugs, polish — nobody would say "leave that bug in") are
 * fixed autonomously; DECIDE findings (direction, trade-offs — two
 * reasonable answers exist) are presented, never touched. DECIDE lines use
 * "- [?]" so they never inflate the loop's open-findings measure.
 */
/** v0.31.0: /list audit — the collect-then-drain audit (user design
 * 2026-07-31: "this command could run a project audit, collect a bunch of
 * tasks, then do them all too"). Division of labor:
 *   /goal audit — one audited unit: audit + fix in the SAME pass (small scopes).
 *   /list audit — audit once, then every open finding becomes its own queued,
 *                 individually-audited list item (the actionables stop living
 *                 only inside findings.md — the user's "audits don't make a
 *                 list of actionables" pain).
 *   /loop audit — forever fix-first cadence for living codebases.
 * The collection item FIXES NOTHING: every fix lands as its own list item with
 * its own isolated audit trail. DECIDE findings are presented at collection
 * completion, never queued — a decision is not a task (the agent can't "do" it).
 * The marker survives restarts inside the objective itself (no schema change):
 * the completion fan-out matches on it.
 */
export const LIST_AUDIT_COLLECT_MARKER = "[LIST-AUDIT-COLLECT]";

export function listAuditCollectTarget(focus?: string): string {
  const scope = focus && focus.trim() ? focus.trim() : "the whole project";
  return `${LIST_AUDIT_COLLECT_MARKER} Run ONE project audit pass that COLLECTS work — the follow-up fixes are queued as separate list items, so this pass changes no code. Scope: ${scope}. (1) Run a FRESH audit pass over the codebase — spawn AT LEAST 3 Explore subagents in ONE message, one per subsystem, so the survey runs in parallel instead of serial through your own context — each with a TIGHT brief: named directories, a ~30-40 tool-use budget, and a ~150-line report cap ('if you near the token limit, stop and report what you have') — hunting real problems: bugs, broken flows, regressions, drift between docs and code, dead code, security holes. Not style nits, not speculative refactors. (2) Append every NEW finding to ${AUDIT_FINDINGS_REL} (create the file on the first finding; append-only — never delete, rewrite, or reorder existing lines; never re-report a finding already listed), classified: "- [ ] FIX: SEVERITY: short description (file:line)" for bugs and polish — and "- [?] DECIDE: short description (what the choice is, what each side costs)" for direction, trade-offs, and scope questions where two reasonable answers exist. (3) Change NOTHING — no fixes, no refactors, no drive-by edits: the orchestrator queues each open FIX finding as its own list item after this pass completes, and each fix lands with its own commit and its own audit. (4) DECIDE findings are appended as "- [?]" lines and NOTHING more — the orchestrator raises them to the user as questions after the pass completes; they are never queued and never silently fixed. (5) Honesty law: never fabricate findings to look busy; if the pass is genuinely clean, say so plainly — an empty findings set is a success, not a failure. Done when: the audit pass is complete and every finding it surfaced is appended to ${AUDIT_FINDINGS_REL} with the right classification (or the report states plainly that nothing was found).`;
}

/** One parsed open finding from the audit findings file. */
export interface AuditFindingLine {
  /** Raw finding text with the checkbox + optional "FIX:" prefix stripped. */
  text: string;
  /** Severity rank for sorting: 0 = CRITICAL … 4 = unclassified. */
  rank: number;
}

const AUDIT_SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/** v0.31.0: parse findings.md into the fan-out shape — OPEN boxes become
 * actionable findings (severity-sorted, stable within a rank), DECIDE boxes
 * ("- [?]") are returned separately for presentation (never queued). Tolerates
 * the /loop audit format (no "FIX:" prefix): any open box that isn't a
 * decision is actionable.
 */
export function parseAuditFindingsForFanout(md: string): { open: AuditFindingLine[]; decisions: string[] } {
  const open: AuditFindingLine[] = [];
  const decisions: string[] = [];
  md.split("\n").forEach((line, idx) => {
    const decide = line.match(/^\s*-\s*\[\?\]\s*(.*)$/);
    if (decide) {
      const text = (decide[1] ?? "").replace(/^DECIDE:\s*/i, "").trim();
      if (text) decisions.push(text);
      return;
    }
    const box = line.match(/^\s*-\s*\[[ \t]+\]\s*(.*)$/);
    if (!box) return;
    const text = (box[1] ?? "").replace(/^FIX:\s*/i, "").trim();
    if (!text) return;
    const sev = text.match(/^([A-Z]+)\s*:/);
    const rank = sev ? AUDIT_SEVERITY_ORDER.indexOf(sev[1]!) : -1;
    open.push({ text, rank: rank >= 0 ? rank : AUDIT_SEVERITY_ORDER.length + (idx / 100000) });
  });
  // Severity first; stable within a rank (file order) via the fractional idx.
  open.sort((a, b) => a.rank - b.rank);
  return { open, decisions };
}

/** v0.31.0: the list-item text for one finding — short objective + a checkable
 * Done when (the fix commit exists AND the box is checked with its hash, so
 * findings.md stays honest as the drain proceeds).
 */
export function listAuditFanoutItemText(finding: string): string {
  return `Fix audit finding: ${finding} — Done when: the fix is committed on the current branch with the repo's configured identity, and this finding's box in ${AUDIT_FINDINGS_REL} is checked ("- [x] … — fixed in <commit>").`;
}

/** v0.31.1: stacking-detection markers (junk-runner 2026-07-31: a held
 * one-shot audit goal + a running audit loop = two stacked audit initiatives
 * — the held one-shot read as "stalled" for 8h while the loop did all the
 * work, and the agent conflated them). The guards in goal.ts match on these;
 * the unit tests pin that the built targets still contain them.
 */
export const GOAL_AUDIT_ONESHOT_MARKER = "Run ONE project audit pass and leave the project in a known state";
export const LOOP_AUDIT_MARKER = "iteration by iteration — FIX-FIRST";

export function projectAuditTarget(focus?: string): string {
  const scope = focus && focus.trim() ? focus.trim() : "the whole project";
  return `${GOAL_AUDIT_ONESHOT_MARKER}. Scope: ${scope}. (1) Run a FRESH audit pass over the codebase — spawn AT LEAST 3 Explore subagents in ONE message, one per subsystem, so the survey runs in parallel instead of serial through your own context — each with a TIGHT brief: named directories, a ~30-40 tool-use budget, and a ~150-line report cap ('if you near the token limit, stop and report what you have') — hunting real problems: bugs, broken flows, regressions, drift between docs and code, dead code, security holes. Not style nits, not speculative refactors. (2) Append every NEW finding to ${AUDIT_FINDINGS_REL} (create the file on the first finding; append-only — never delete, rewrite, or reorder existing lines; never re-report a finding already listed), classified: "- [ ] FIX: SEVERITY: short description (file:line)" for bugs and polish — whether to fix these is NOT a decision — and "- [?] DECIDE: short description (what the choice is, what each side costs)" for direction, trade-offs, and scope questions where two reasonable answers exist. (3) Fix every NEW FIX finding from this pass — real fixes, committed with the repo's configured identity on the current branch (no invented identities or branches) — then check the box: "- [x] … — fixed in <commit>". (4) Change NOTHING for DECIDE findings — RAISE them instead: if any "- [?]" findings exist, present each one to the user with ask_user_question BEFORE calling complete_goal (one question per finding, options from the finding's own two sides plus "Defer"; prose numbered list if ask_user_question is unavailable; Esc = Defer), then record every answer in ${AUDIT_FINDINGS_REL} — replace the "- [?]" line with "- [x] DECIDED: <what was chosen> (<date>)" (or "- [x] DEFERRED") so it stops re-surfacing — and queue any chosen work with list_add. (5) Honesty law: never fabricate findings to look busy; never check a box without the fix commit existing; never silently turn a DECIDE into a fix. Done when: the audit pass is complete, every new FIX finding has a fix commit and a checked box in ${AUDIT_FINDINGS_REL}, and every DECIDE finding has been raised to the user and recorded as DECIDED/DEFERRED (or the report states plainly that none were found).`;
}
