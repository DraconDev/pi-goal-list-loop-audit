// pi-goal-list-loop-audit — compact-failure lifecycle classification
//
// Pi's session_compact_failed event describes one attempt. In particular,
// willRetry means the host will continue the interrupted turn itself. GLLA
// must not rotate models, park work, or dispatch a competing continuation in
// that case. Terminal failures need one conservative distinction: a prompt
// that still cannot fit versus a summarizer whose bounded output was cut off.

export type CompactionFailureKind =
  | "retry-owned"
  | "aborted"
  | "from-extension"
  | "summarization-length"
  | "context-overflow"
  | "other-terminal";

export interface CompactionFailureEvent {
  reason?: string;
  errorMessage?: string;
  aborted?: boolean;
  willRetry?: boolean;
  fromExtension?: boolean;
}

export interface CompactionFailureClassification {
  kind: CompactionFailureKind;
  raw: string;
}

const OUTPUT_CAP_PATTERNS = [
  /generation hit the token cap/i,
  /summary(?: is)? incomplete/i,
  /incomplete summar(?:y|ization)/i,
  /summar(?:y|ization)[^\n]{0,120}(?:token cap|output[ -]?token|length limit|stopreason\s*[:=]\s*length)/i,
  /(?:output[ -]?token|max[_-]?tokens)[^\n]{0,80}(?:cap|limit|exceed|length)/i,
  /stop\s*reason\s*[:=]\s*["']?length\b/i,
] as const;

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[ _-]?length[^\n]{0,80}(?:exceed|too large|limit|overflow)/i,
  /context[ _-]?window[^\n]{0,80}(?:exceed|too large|limit|overflow)/i,
  /context[ _-]?length[^\n]{0,80}maximum/i,
  /maximum[^\n]{0,40}context[ _-]?length/i,
  /prompt[^\n]{0,80}(?:too large|exceeds? (?:the )?(?:model(?:'s)? )?context|does(?: not)? fit)/i,
  /input[ _-]?tokens?[^\n]{0,80}(?:exceed|too large|over (?:the )?limit)/i,
  /too many (?:input )?tokens/i,
] as const;

function firstMatch(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classify one host compaction failure without inspecting or mutating Pi state.
 * Precedence is deliberate: an explicit host retry or cancellation outranks
 * error text, and output-cap evidence outranks the event's generic overflow
 * reason so a truncated summary is not mislabeled as an uncompactable prompt.
 */
export function classifyCompactionFailure(event: CompactionFailureEvent): CompactionFailureClassification {
  const raw = typeof event.errorMessage === "string" ? event.errorMessage.trim() : "";
  if (event.willRetry === true) return { kind: "retry-owned", raw };
  if (event.aborted === true) return { kind: "aborted", raw };
  if (event.fromExtension === true) return { kind: "from-extension", raw };
  if (firstMatch(OUTPUT_CAP_PATTERNS, raw)) return { kind: "summarization-length", raw };
  if (firstMatch(CONTEXT_OVERFLOW_PATTERNS, raw)) return { kind: "context-overflow", raw };
  return { kind: "other-terminal", raw };
}
