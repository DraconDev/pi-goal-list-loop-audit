/** Observes a narrow, positively identified unfinished drafting handoff.
 * This is not a continuation scheduler: silence and punctuation alone are
 * never evidence that a user wait is broken. No provider sends occur here.
 */
export class DraftingHandoffObserver {
  private answered = false;
  private notified = false;

  reset(): void {
    this.answered = false;
    this.notified = false;
  }

  noteUserReply(): void { this.answered = true; }

  noteToolResult(toolName: string, answered: boolean): void {
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
export const DRAFT_HANDOFF_NOTICE = "Drafting needs attention: the agent announced more questions but did not present them. No work was activated. Reply ‘continue drafting’ to request the missing questions; GLLA will not retry automatically.";
