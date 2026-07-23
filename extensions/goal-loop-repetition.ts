/**
 * Loop anti-repetition (v0.24.0) — pure, stateless detectors for the failure
 * mode the plateau stop cannot see: the loop keeps "working" but the work is
 * the SAME work. Plateau watches the number; this watches the behavior.
 *
 * Clean-room implementation of standard techniques (rolling text
 * fingerprints, word-trigram Jaccard similarity, repeated-n-gram detection)
 * for pi-loop-mode's AGPL-licensed repertoire — no code shared.
 *
 * Everything here is a pure function; LoopState holds the rolling windows and
 * runLoopTick (loops/goal.ts) feeds them in. One mechanical predicate per
 * behavior — no fuzzy heuristics.
 */

import { createHash } from "node:crypto";

export const REPETITION = {
  /** Jaccard similarity at which two consecutive iterations count as a near-duplicate. */
  similarityThreshold: 0.8,
  /** Minimum normalized length before exact/near-duplicate checks apply (short replies repeat innocently). */
  minExactLength: 80,
  minSimilarLength: 60,
  /** Same fingerprint seen this often inside the rolling window = alternating repetition (A-B-A-B). */
  windowRepeat: 3,
  /** Rolling window sizes held on LoopState. */
  printWindow: 12,
  textWindow: 3,
  toolWindow: 6,
  /** Last N identical tool results (same tool, same output) = no new information. */
  toolResultRepeat: 3,
  /** Consecutive iterations with zero tool calls = narration only. */
  toollessIterations: 2,
  /** Degenerate single-response repetition (one sentence/word/phrase looping inside ONE reply). */
  degenerateMinLength: 150,
  degenerateSentenceRepeats: 4,
  degenerateWordRepeats: 16,
  degeneratePhraseRepeats: 8,
  degenerateMaxPhraseWords: 4,
  /** Escalation ladder: hard-reset directive after this many consecutive stuck turns… */
  hardResetAfter: 3,
  /** …and the loop STOPS after this many (bounded, surfaced — same philosophy as plateau). */
  maxInterventions: 5,
} as const;

/** Strip ANSI, collapse whitespace, lowercase — the canonical form all checks use. */
export function normalizeForPrint(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable short fingerprint of one reply's canonical form. */
export function textFingerprint(text: string): string {
  return createHash("sha256").update(normalizeForPrint(text).slice(0, 4000)).digest("hex").slice(0, 16);
}

/** Digits are volatile (counters, timestamps, PIDs) — blank them so "try port 8081" ≈ "try port 8082". */
function canonical(text: string): string {
  return normalizeForPrint(text).replace(/\d+/g, "#");
}

function wordTrigrams(text: string): Set<string> {
  const words = canonical(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length < 3) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + 3 <= words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Jaccard similarity over word trigrams: 0 = nothing shared, 1 = same shingle set. */
export function trigramSimilarity(a: string, b: string): number {
  const sa = wordTrigrams(a);
  const sb = wordTrigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

export interface DegenerateRepeat {
  kind: "sentence" | "word" | "phrase";
  unit: string;
  count: number;
}

function tokenRun(text: string): DegenerateRepeat | undefined {
  const tokens = normalizeForPrint(text).match(/[\p{L}\p{N}_'-]+/gu) ?? [];
  for (let width = 1; width <= REPETITION.degenerateMaxPhraseWords; width++) {
    const needed = width === 1 ? REPETITION.degenerateWordRepeats : REPETITION.degeneratePhraseRepeats;
    for (let start = 0; start + width * needed <= tokens.length; start++) {
      let run = 1;
      while (
        start + (run + 1) * width <= tokens.length &&
        tokens.slice(start, start + width).join("") === tokens.slice(start + run * width, start + (run + 1) * width).join("")
      ) {
        run++;
      }
      if (run >= needed) {
        return { kind: width === 1 ? "word" : "phrase", unit: tokens.slice(start, start + width).join(" "), count: run };
      }
    }
  }
  return undefined;
}

/** One sentence/word/phrase looping inside a SINGLE response (degenerate generation). */
export function findDegenerateRepeat(text: string): DegenerateRepeat | undefined {
  const canon = canonical(text);
  if (canon.length < REPETITION.degenerateMinLength) return undefined;
  const sentences = canon
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);
  if (sentences.length >= REPETITION.degenerateSentenceRepeats) {
    const counts = new Map<string, number>();
    for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
    let unit = "";
    let best = 0;
    for (const [s, n] of counts) if (n > best) { unit = s; best = n; }
    if (best >= REPETITION.degenerateSentenceRepeats && best / sentences.length >= 0.5) {
      return { kind: "sentence", unit, count: best };
    }
  }
  return tokenRun(text);
}

export interface ToolResultPrint {
  tool: string;
  hash: string;
  isError: boolean;
}

export interface LoopStuckInput {
  /** Last assistant text of the finished iteration. */
  assistantText: string;
  /** Rolling fingerprints INCLUDING the current iteration's (appended last). */
  recentPrints: string[];
  /** Previous iteration's assistant text (for the near-duplicate check). */
  previousText?: string;
  /** Rolling tool-result prints (most recent last). */
  recentToolResults: ToolResultPrint[];
  /** Consecutive iterations with zero tool calls, including this one. */
  toollessStreak: number;
}

function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

/**
 * The one classifier: given the rolling windows, WHY is the loop stuck —
 * or undefined when it's working normally. Checks run cheapest-and-most-
 * certain first; the first hit wins so the reason stays specific.
 */
export function detectLoopStuck(input: LoopStuckInput): string | undefined {
  const { assistantText, recentPrints, previousText, recentToolResults, toollessStreak } = input;

  // Narration only: iterations that never touch tools produce nothing inspectable.
  if (toollessStreak >= REPETITION.toollessIterations) {
    return `no tool calls for ${toollessStreak} iterations (narration only)`;
  }

  // Degenerate generation inside the current response.
  const degenerate = findDegenerateRepeat(assistantText);
  if (degenerate) {
    return `response degenerated: same ${degenerate.kind} repeated ${degenerate.count}× ("${clip(degenerate.unit, 60)}")`;
  }

  // Exact repeat of the immediately previous iteration.
  const lastTwo = recentPrints.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1] && normalizeForPrint(assistantText).length > REPETITION.minExactLength) {
    return "repeated the previous response exactly";
  }

  // Near-duplicate of the previous iteration (slight rephrasing defeats fingerprints).
  if (previousText && normalizeForPrint(assistantText).length > REPETITION.minSimilarLength) {
    const sim = trigramSimilarity(assistantText, previousText);
    if (sim >= REPETITION.similarityThreshold) {
      return `response ~${Math.round(sim * 100)}% similar to the previous iteration`;
    }
  }

  // Alternating repetition (A-B-A-B): the current fingerprint keeps recurring in the window.
  const current = recentPrints[recentPrints.length - 1];
  if (current && recentPrints.filter((p) => p === current).length >= REPETITION.windowRepeat) {
    return `same response ${REPETITION.windowRepeat}+ times in recent iterations`;
  }

  // Same tool, same output, three times running: the loop is re-reading a result it already has.
  const recentTools = recentToolResults.slice(-REPETITION.toolResultRepeat);
  if (
    recentTools.length === REPETITION.toolResultRepeat &&
    recentTools.every((r) => r.tool === recentTools[0]!.tool && r.hash === recentTools[0]!.hash)
  ) {
    return recentTools.every((r) => r.isError)
      ? `same ${recentTools[0]!.tool} error ${REPETITION.toolResultRepeat}× in a row`
      : `same ${recentTools[0]!.tool} result ${REPETITION.toolResultRepeat}× in a row (no new information)`;
  }

  return undefined;
}

/**
 * Rotating stuck interventions — a repeated identical nudge gets filtered as
 * noise, so each consecutive stuck turn gets a DIFFERENT instruction.
 * consecutiveStuck is 1-based (1 = first intervention).
 */
export function loopInterventionDirective(consecutiveStuck: number, reason: string, recentTexts: string[]): string {
  const strategies = [
    "Abandon the current angle entirely. Pick a genuinely different approach — different file, different technique — and execute it now.",
    "Switch to a part of the target you have NOT touched in recent iterations and make one concrete, inspectable change there.",
    "Write a short PROGRESS.md: current state, what was tried, what keeps failing, the next 3 concrete steps. Then execute step 1.",
    "Run the project's build/tests, pick exactly ONE failure or warning, and fix only that.",
    "Review your recent changes (git diff / git log), find one real problem in them, and fix it.",
  ];
  const strategy = strategies[(consecutiveStuck - 1) % strategies.length]!;
  let escalation = "";
  if (consecutiveStuck >= REPETITION.hardResetAfter) {
    const banned = recentTexts
      .map((t) => clip(normalizeForPrint(t), 40))
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(", ");
    escalation =
      ` HARD RESET (stuck intervention #${consecutiveStuck} in a row): forget your previous phrasing entirely.` +
      (banned ? ` Banned openings: ${banned}.` : "") +
      " Your FIRST action this turn must be a tool call that changes a file or produces new information — zero preamble text before it.";
  }
  return `⚠ STUCK — ${reason}.${escalation} ${strategy}`;
}

/**
 * Varied continuation lines for metricless iterations: identical prompts
 * invite identical answers, so the base instruction rotates by iteration.
 */
export function continueVariant(iteration: number): string {
  const variants = [
    "Advance the target with the next concrete, inspectable change.",
    "Continue: pick the next unit of work from your plan and do it now.",
    "Keep going — one real change that moves the target forward.",
    "Proceed with the next focused step toward the target.",
    "Make the next improvement; something you can point at in a diff.",
  ];
  return variants[iteration % variants.length]!;
}

/** Cap helper for the rolling windows on LoopState. */
export function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  const next = [...arr, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
