// pi-goal-list-loop-audit — v0.27.2
// extensions/length-continue.ts
//
// Folded-in auto-continue for output-token truncation (was the standalone
// pi-length-continue 0.1.0, now deprecated). When ONE assistant response
// exceeds the model's provider-side per-response output cap, pi ends the
// turn with stopReason "length" and idles — a dead stop on unattended rigs.
// The tracker decides when to re-trigger; goal.ts's agent_end handler wires
// it BEFORE all turn bookkeeping: a truncated turn is not a completed turn
// (no telemetry), not a stall (no no-tool nudge), and must not run the
// loop measure or the normal goal continuation on half a response.
//
// Guards (same as the standalone):
//   - consecutive cap: after MAX back-to-back truncations, give up (once)
//     instead of burning quota in a truncation ping-pong. Any normally
//     finished turn resets the counter.
//   - the caller skips when messages are already pending (a queued message
//     triggers a turn anyway) and routes stale-handle errors to
//     goStaleTerminal (pi#7154).

export const LENGTH_CONTINUE_MAX = 3;

export const LENGTH_CONTINUE_TEXT = [
  "Your previous response was cut off at the model's per-response output token limit.",
  "Continue EXACTLY where you stopped — finish the current artifact, then keep going.",
  "Keep each individual response shorter from here: split large file writes into multiple smaller write/edit calls across turns instead of one giant response.",
].join(" ");

// v0.38.66 (PR #55, FOF11): goal-aware variant. When an active goal's worker
// response is truncated, the generic "keep going" nudge can send the model
// off on another full work pass even when the goal is already satisfied.
// Active goals get completion-aware recovery text instead: check
// satisfaction first, call complete_goal if done, otherwise finish only
// the interrupted work. Plain sessions keep LENGTH_CONTINUE_TEXT.
export const GOAL_LENGTH_CONTINUE_TEXT = [
  "Your previous response was cut off at the model's per-response output token limit.",
  "Continue EXACTLY where you stopped, but FIRST determine whether the active goal is already satisfied.",
  "If the goal is satisfied, do not start another research, audit, or implementation pass. Call complete_goal now with a concise completionSummary and verificationSummary so the independent auditor can verify the work.",
  "If the goal is not yet satisfied, finish only the interrupted work and continue toward the objective.",
  "Keep each individual response shorter from here: split large file writes into multiple smaller write/edit calls across turns instead of one giant response.",
].join(" ");

export interface LengthContinueTick {
  /** Send the continue message this round. */
  fire: boolean;
  /** The cap was just exceeded — notify the give-up exactly once. */
  giveUpNow: boolean;
  /** Current consecutive truncation streak (after this tick). */
  consecutive: number;
}

export interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export interface AssistantLengthMessageLike {
  stopReason?: string;
  usage?: {
    output?: number;
  };
  /** Provider error message, when stopReason is "error". */
  errorMessage?: string;
  /** Error type from provider (e.g., "exceed_context_size_error"). */
  errorType?: string;
}

export const LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT = 90;
export const LENGTH_CONTINUE_CONTEXT_STARVED_MAX_OUTPUT = 8;

/**
 * v0.34.19: distinguish a REAL overlong assistant response from pi's
 * context-safety clamp. Near the configured context ceiling,
 * pi-ai's clampMaxTokensToContext() can reduce max_tokens to 1; MiniMax then
 * returns stopReason "length" with ~1 output token. That is context
 * starvation: auto-compaction must own recovery. Sending LENGTH_CONTINUE_TEXT
 * here queues another 1-token request before pi's post-agent_end compaction
 * check and delays the actual cure (field: darklord 2026-08-02, 198,116 /
 * 198,179 total tokens of a 200,000 window, output=1 twice).
 *
 * v0.38.36: also detect explicit context-overflow provider errors
 * (e.g., "exceed_context_size_error", "exceeds the available context size")
 * which arrive as stopReason="error" with an errorMessage, not as
 * stopReason="length". These are also context starvation — the request
 * exceeded the model's context window before generation could start.
 */
export function isContextStarvedLengthStop(
  message: AssistantLengthMessageLike | null | undefined,
  contextUsage: ContextUsageLike | null | undefined,
): boolean {
  // Case 1: pi's context-safety clamp (stopReason="length" with tiny output)
  if (message?.stopReason === "length") {
    const output = message.usage?.output;
    if (typeof output === "number" && Number.isFinite(output) && output <= LENGTH_CONTINUE_CONTEXT_STARVED_MAX_OUTPUT) {
      const percent = typeof contextUsage?.percent === "number"
        ? contextUsage.percent
        : typeof contextUsage?.tokens === "number" && typeof contextUsage?.contextWindow === "number" && contextUsage.contextWindow > 0
          ? (contextUsage.tokens / contextUsage.contextWindow) * 100
          : null;
      return percent !== null && Number.isFinite(percent) && percent >= LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT;
    }
    return false; // Real overlong response, not context starvation
  }
  // Case 2: explicit provider context-overflow error (stopReason="error")
  if (message?.stopReason === "error") {
    const errMsg = (message.errorMessage ?? message.errorType ?? "").toLowerCase();
    if (
      errMsg.includes("exceed_context_size") ||
      errMsg.includes("exceeds the available context") ||
      errMsg.includes("exceeds the context window") ||
      (errMsg.includes("exceeds the model") && errMsg.includes("context")) ||
      (errMsg.includes("context window") && errMsg.includes("exceed"))
    ) {
      const percent = typeof contextUsage?.percent === "number"
        ? contextUsage.percent
        : typeof contextUsage?.tokens === "number" && typeof contextUsage?.contextWindow === "number" && contextUsage.contextWindow > 0
          ? (contextUsage.tokens / contextUsage.contextWindow) * 100
          : null;
      return percent !== null && Number.isFinite(percent) && percent >= LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT;
    }
  }
  return false;
}

export function makeLengthContinueTracker(max: number = LENGTH_CONTINUE_MAX) {
  let consecutive = 0;
  let gaveUp = false;
  return {
    tick(stopped: boolean): LengthContinueTick {
      if (!stopped) {
        consecutive = 0;
        gaveUp = false;
        return { fire: false, giveUpNow: false, consecutive: 0 };
      }
      consecutive++;
      if (consecutive > max) {
        const giveUpNow = !gaveUp;
        gaveUp = true;
        return { fire: false, giveUpNow, consecutive };
      }
      return { fire: true, giveUpNow: false, consecutive };
    },
    get consecutive(): number {
      return consecutive;
    },
  };
}

// Session-level singleton — one tracker per extension runtime. The factory
// calls resetLengthContinue() so an extension reload starts clean.
let tracker = makeLengthContinueTracker();

export function tickLengthContinue(stopped: boolean): LengthContinueTick {
  return tracker.tick(stopped);
}

export function resetLengthContinue(): void {
  tracker = makeLengthContinueTracker();
}
