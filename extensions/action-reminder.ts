import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const ACTION_REMINDER_CUSTOM_TYPE = "glla-action-reminder";

export type ActionReminderKind = "decision" | "blocked" | "error" | "wait" | "standby";

export interface ActionReminderDetails {
  kind: ActionReminderKind;
  reason: string;
  action: string;
  resumeCommand: string;
  safelyParked: boolean;
}

export interface ActionReminderCopy {
  content: string;
  details: ActionReminderDetails;
}

let pauseAbortMarker = false;

/** Mark the exact host turn that pause_goal is about to abort. The marker is
 * consumed by message_end so an unrelated user abort cannot be rewritten. */
export function markPauseAbort(): void {
  pauseAbortMarker = true;
}

export function consumePauseAbort(): boolean {
  const marked = pauseAbortMarker;
  pauseAbortMarker = false;
  return marked;
}

export function buildAbortedAssistantNotice(input: {
  kind: ActionReminderKind;
  reason: string;
  action?: string;
  resumeCommand: string;
}): string {
  const reminder = buildActionReminder(input);
  const next = input.kind === "decision"
    ? "Choose an option, then resume."
    : input.kind === "standby"
      ? "No manual action is needed; the background completion wakes this work."
      : `Next: ${reminder.details.action}`;
  return `GLLA paused this turn safely — ${reminder.details.reason} ${next}`;
}

/** Build the durable, user-facing explanation for a GLLA pause. Pi's core
 * abort renderer may still print its generic transport line; this message is
 * the GLLA-owned card that tells the user what happened and what to do next. */
export function buildActionReminder(input: {
  kind: ActionReminderKind;
  reason: string;
  action?: string;
  resumeCommand: string;
}): ActionReminderCopy {
  const reason = input.reason.trim() || "The current turn cannot continue safely.";
  const action = input.action?.trim() || input.resumeCommand;
  const parked = input.kind !== "standby";
  const heading = parked ? "Action needed — work is safely parked" : "Waiting — work is safely parked";
  const next = input.kind === "decision"
    ? "Choose an option in the decision card, then resume."
    : input.kind === "standby"
      ? "No action is needed; the background completion will wake this work automatically."
      : `Next: ${action}`;
  const content = [
    heading,
    `Why: ${reason}`,
    parked ? "Your saved work is intact; this turn stopped before more work could be lost." : "The turn is waiting without requiring manual intervention.",
    next,
  ].join("\n");
  return {
    content,
    details: {
      kind: input.kind,
      reason,
      action,
      resumeCommand: input.resumeCommand,
      safelyParked: parked,
    },
  };
}

export function registerActionReminderRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(ACTION_REMINDER_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    const details = message.details as Partial<ActionReminderDetails> | undefined;
    const kind = details?.kind ?? "blocked";
    const color = kind === "error" ? "error" : kind === "decision" ? "accent" : "warning";
    const heading = kind === "standby"
      ? "⏳ GLLA waiting — work is safely parked"
      : kind === "decision"
        ? "⏸ GLLA decision needed — work is safely parked"
        : "⏸ GLLA action needed — work is safely parked";
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg(color, heading), 0, 0));
    if (details?.reason) box.addChild(new Text(theme.fg("dim", `Why: ${details.reason}`), 0, 0));
    if (details?.action && kind !== "standby") box.addChild(new Text(theme.fg("accent", `Next: ${details.action}`), 0, 0));
    if (kind === "standby") box.addChild(new Text(theme.fg("dim", "No action is needed; background completion wakes this work automatically."), 0, 0));
    if (details?.resumeCommand && kind !== "standby") box.addChild(new Text(theme.fg("dim", `Resume: ${details.resumeCommand}`), 0, 0));
    return box;
  });
}
