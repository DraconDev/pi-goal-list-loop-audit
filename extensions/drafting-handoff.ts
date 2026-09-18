/** Observes an unfinished drafting handoff: a list/goal/loop drafting
 * turn that ends with commentary alone. The grill guidance is in effect
 * for the whole episode, so every drafting turn must end with a presented
 * picker, a stated next dependent question, or a concrete proposal — a
 * stop turn with substantive question-less commentary strands the user
 * (field 125335) exactly like the old dangling-intro shape it subsumes.
 * Silence, punctuation, and short acks alone are never evidence that a
 * user wait is broken. The caller owns lifecycle-fenced, once-only dispatch.
 */
const DRAFT_COMMENTARY_FLOOR = 40;
// A stated next dependent question is a legal drafting end — only
// commentary ALONE corrects. Keep tight: will-ask, next-question, and
// after-you-answer phrasing, never a bare "ask"/"question" mention
// (promising questions without stating the next one is the bug).
const STATED_NEXT_QUESTION_RE = new RegExp(
  [
    String.raw`\b(i[''’]ll|i will|let me)\b[^.!?]{0,100}\bask\b`,
    String.raw`\bnext\b[^.!?]{0,60}\bquestions?\b`,
    String.raw`\b(after|once)\b[^.!?]{0,60}\b(you (answer|reply)|your answer)\b`,
  ].join("|"),
  "i",
);
export class DraftingHandoffObserver {
  private answered = false;
  private notified = false;
  revision = 0;

  invalidate(): void { this.revision++; }

  reset(): void {
    this.invalidate();
    // A fresh drafting episode opens armed: the grill guidance is in
    // effect from turn one, so a commentary-only end strands the user
    // with or without prior Q&A (field 125335 had none to rely on).
    // Picker-outstanding, proposal-presented, and cancelled-picker turns
    // still disarm via noteToolResult below.
    this.answered = true;
    this.notified = false;
  }

  noteUserReply(): void { this.invalidate(); this.answered = true; }

  noteToolResult(toolName: string, answered: boolean): void {
    this.invalidate();
    // A new question or proposal supersedes earlier answer evidence, even
    // on Escape, missing details, error, or a rejected confirmation.
    if (toolName === "ask_user_question") this.answered = answered;
    if (toolName === "propose_goal_draft" || toolName === "propose_loop_draft") this.answered = false;
  }

  observe(text: string, stopReason: string | undefined): boolean {
    if (!this.answered || this.notified || stopReason !== "stop") return false;
    const trimmed = text.trim();
    // A real prose question waits without an autonomous retry.
    if (trimmed.includes("?")) return false;
    // Short acks are not substantive commentary.
    if (trimmed.length < DRAFT_COMMENTARY_FLOOR) return false;
    // A stated next dependent question ends the turn legally.
    if (STATED_NEXT_QUESTION_RE.test(trimmed)) return false;
    this.notified = true;
    this.answered = false;
    return true;
  }
}

export const draftingHandoff = new DraftingHandoffObserver();
export const DRAFT_HANDOFF_CORRECTION = "[DRAFT HANDOFF CORRECTION] You announced more questions but did not present them. Continue drafting now: use ask_user_question for the missing structured choices when available, or ask the genuinely free-form question in conversation. If the contract is already concrete, call the drafting proposal tool instead. Never invent answers or activate work without confirmation. This is a one-time correction, not a user answer.";
