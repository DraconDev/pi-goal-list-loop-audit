// pi-goal-list-loop-audit — v0.35.52
// extensions/context-hygiene.ts
//
// note.md Now: "failed requests add to the context, while clearly adding
// nothing of value" — field evidence (polis session, 2026-08-23): a run of
// failed turns (503 server_error, "Provider finish_reason: network_error",
  // "Retry failed after 3 attempts: Retry cancelled") accumulated until the
// estimated context hit 122.7% of the 200k window, and auto-compaction then
// failed on its own bloated summarization input.
//
// Mechanism (verified in pi sources): when retries are exhausted, the failed
// assistant message (stopReason "error", errorMessage set, content typically
// empty or partial) STAYS in agent state and the session — pi strips it from
// live state only for mid-flight retries. Every later LLM call receives it,
// and compaction summarizes it. Nothing downstream filters these.
//
// The durable bounded rule: project error-only assistant turns OUT of the
// effective context — EXCEPT the most recent one, which stays so the model
// can see WHY the previous attempt failed on the immediate retry send. Only
// turns with NO tool-call blocks are dropped (an error turn that emitted
// tool calls owns paired toolResult messages and must stay intact); only
// stopReason "error" is projected ("aborted" turns are user-intent
// boundaries and are never touched). Session transcripts on disk are NOT
// modified — this is a per-send projection, exactly like the v0.35.51
// payload guard; a second application point prunes the same turns from the
// compaction summarization input (the preparation object is shared by
// reference with the compaction runner).
//
// Pure module — no pi runtime, no fs — so the rule is unit-testable in
// isolation; the orchestration layer (goal-activation.ts) registers the
// context/compaction hooks and writes the context_hygiene ledger entries.

/** How many of the most recent failed turns stay visible. One is enough for
 * retry continuity; older failures are pure noise. */
export const DEFAULT_KEEP_RECENT_ERROR_TURNS = 1;

export interface FailedTurnDrop {
  messageIndex: number;
  errorMessage?: string;
}

export interface FailedTurnResult {
  /** The projected message list (same identity when nothing was dropped). */
  messages: readonly unknown[];
  dropped: FailedTurnDrop[];
  /** Failed turns kept (the most recent window). */
  kept: number;
}

export interface ContextHygieneOptions {
  keepRecentErrorTurns?: number;
}

/** True when the block is a tool call (an error turn carrying these owns
 * paired toolResult messages and is never droppable). */
function isToolCallBlock(block: unknown): boolean {
  return typeof block === "object" && block !== null
    && (block as { type?: unknown }).type === "toolCall";
}

/**
 * A failed error-only assistant turn: stopReason "error", content carrying
 * no tool-call blocks. Partial text/thinking from a stream that died
 * mid-flight is projected too — the transcript keeps it; the effective
 * context does not need it.
 */
export function isFailedErrorOnlyTurn(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { role?: unknown; stopReason?: unknown; content?: unknown };
  if (m.role !== "assistant" || m.stopReason !== "error") return false;
  if (!Array.isArray(m.content)) return false;
  return !m.content.some(isToolCallBlock);
}

/**
 * Project failed error-only assistant turns out of the message list. The
 * most recent `keepRecentErrorTurns` failed turns are kept (bounded rule);
 * older ones are dropped entirely. Returns the input array identity when
 * nothing needs dropping.
 */
export function dropFailedErrorOnlyTurns(
  messages: readonly unknown[],
  opts: ContextHygieneOptions = {},
): FailedTurnResult {
  const keepRecent = typeof opts.keepRecentErrorTurns === "number" && opts.keepRecentErrorTurns >= 0
    ? opts.keepRecentErrorTurns
    : DEFAULT_KEEP_RECENT_ERROR_TURNS;

  const failedIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (isFailedErrorOnlyTurn(message)) failedIndexes.push(index);
  });
  if (failedIndexes.length <= keepRecent) {
    return { messages, dropped: [], kept: failedIndexes.length };
  }

  const dropSet = new Set(failedIndexes.slice(0, failedIndexes.length - keepRecent));
  const dropped: FailedTurnDrop[] = [...dropSet].map((messageIndex) => ({
    messageIndex,
    errorMessage: (messages[messageIndex] as { errorMessage?: string } | null)?.errorMessage,
  }));
  const projected = messages.filter((_, index) => !dropSet.has(index));
  return { messages: projected, dropped, kept: keepRecent };
}

/**
 * In-place application to a CompactionPreparation-shaped object (the runner
 * passes the same object to `compact()` after the extension event, so
 * property reassignment propagates). Returns the number of dropped turns
 * across both message arrays; never throws over shape surprises.
 */
export function pruneCompactionPreparation(
  preparation: unknown,
  opts: ContextHygieneOptions = {},
): number {
  if (typeof preparation !== "object" || preparation === null) return 0;
  const prep = preparation as { messagesToSummarize?: unknown; turnPrefixMessages?: unknown };
  let dropped = 0;
  for (const key of ["messagesToSummarize", "turnPrefixMessages"] as const) {
    const list = prep[key];
    if (!Array.isArray(list)) continue;
    const result = dropFailedErrorOnlyTurns(list, opts);
    if (result.dropped.length > 0) {
      prep[key] = result.messages;
      dropped += result.dropped.length;
    }
  }
  return dropped;
}
