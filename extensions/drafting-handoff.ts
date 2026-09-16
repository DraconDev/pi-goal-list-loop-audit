/** Observes a narrow, positively identified unfinished drafting handoff.
 * Silence and punctuation alone are never evidence that a user wait is
 * broken. The caller owns lifecycle-fenced, once-only dispatch.
 */
export class DraftingHandoffObserver {
  private answered = false;
  private notified = false;
  revision = 0;

  invalidate(): void { this.revision++; }

  reset(): void {
    this.invalidate();
    this.answered = false;
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
    const lastLine = text.trim().split("\n").at(-1)?.trim() ?? "";
    // Match the field screenshot's dangling introduction, not a real
    // question, imperative request, option list, or arbitrary short reply.
    if (!/^(?:two|three|four|[2-4]) (?:final |remaining )?(?:policy )?(?:choices|questions|decisions) (?:will|would) make (?:the |our )?(?:implementation )?(?:contract|scope|plan) concrete:\s*$/i.test(lastLine)) return false;
    if (text.includes("?")) return false;
    this.notified = true;
    this.answered = false;
    return true;
  }
}

export const draftingHandoff = new DraftingHandoffObserver();
export const DRAFT_HANDOFF_CORRECTION = "[DRAFT HANDOFF CORRECTION] You announced more questions but did not present them. Continue drafting now: use ask_user_question for the missing structured choices when available, or ask the genuinely free-form question in conversation. If the contract is already concrete, call the drafting proposal tool instead. Never invent answers or activate work without confirmation. This is a one-time correction, not a user answer.";
