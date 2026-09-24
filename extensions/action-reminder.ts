import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const ACTION_REMINDER_CUSTOM_TYPE = "glla-action-reminder";

export type ActionReminderKind = "decision" | "blocked" | "error" | "wait" | "standby";

export interface ActionReminderDetails {
  kind: ActionReminderKind;
  reason: string;
  action: string;
  resumeCommand: string;
  resumeAt?: string;
  safelyParked: true;
}

export interface ActionReminderCopy {
  content: string;
  details: ActionReminderDetails;
}

export interface PauseAbortMarker {
  ownerSession: unknown;
  goalId: string;
  kind: ActionReminderKind;
  reason: string;
  action?: string;
  resumeCommand: string;
  resumeAt?: string;
}

let pauseAbortMarker: PauseAbortMarker | null = null;
let pauseTurnStartedAt = 0;

/** Bind the exact pause state and host owner to the turn pause_goal is about
 * to abort. A session/goal mismatch expires the marker instead of letting it
 * rewrite some later abort. */
export function markPauseAbort(marker: PauseAbortMarker): void {
  pauseAbortMarker = { ...marker, turnStartedAt: pauseTurnStartedAt };
  // Keep the public marker contract focused on the pause payload. The
  // internal copy carries the turn fence used by consumePauseAbort().
  Object.defineProperty(pauseAbortMarker, "turnStartedAt", { value: pauseTurnStartedAt, enumerable: false });
}

export function markActionReminderTurnStart(): void {
  pauseTurnStartedAt = Date.now();
  pauseAbortMarker = null;
}

export function clearPauseAbort(): void {
  pauseAbortMarker = null;
}

/** Consume a pending pause marker only when this exact owner, goal, and turn
 * still match. `aborted` distinguishes the expected assistant abort from any
 * other message_end that happens to arrive first. */
export function consumePauseAbort(input: {
  ownerSession: unknown;
  goalId?: string;
  aborted: boolean;
}): PauseAbortMarker | null {
  const marker = pauseAbortMarker;
  if (!marker) return null;
  if (
    !input.aborted
    || marker.ownerSession !== input.ownerSession
    || marker.goalId !== input.goalId
    || pauseTurnStartedAt === 0
  ) {
    return null;
  }
  pauseAbortMarker = null;
  return marker;
}

export function buildAbortedAssistantNotice(input: {
  kind: ActionReminderKind;
  reason: string;
  action?: string;
  resumeCommand: string;
  resumeAt?: string;
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
  resumeAt?: string;
}): ActionReminderCopy {
  const reason = input.reason.trim() || "The current turn cannot continue safely.";
  const action = input.action?.trim() || input.resumeCommand;
  const automaticWait = input.kind === "wait" || input.kind === "standby";
  const heading = input.kind === "decision"
    ? "Decision needed — work is safely parked"
    : automaticWait
      ? "Waiting — work is safely parked"
      : "Action needed — work is safely parked";
  const next = input.kind === "decision"
    ? "Choose an option in the decision card, then resume."
    : input.kind === "standby"
      ? "No action is needed; the background completion will wake this work automatically."
      : input.kind === "wait"
        ? input.resumeAt
          ? `The wait resumes automatically at ${input.resumeAt}.`
          : "The wait resumes automatically when its condition clears."
        : `Next: ${action}`;
  const content = [
    heading,
    `Why: ${reason}`,
    "Your saved work is intact; this turn stopped before more work could be lost.",
    next,
  ].join("\n");
  return {
    content,
    details: {
      kind: input.kind,
      reason,
      action,
      resumeCommand: input.resumeCommand,
      resumeAt: input.resumeAt,
      safelyParked: true,
    },
  };
}

export function registerActionReminderRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(ACTION_REMINDER_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    const details = message.details as Partial<ActionReminderDetails> | undefined;
    const kind = details?.kind ?? "blocked";
    const color = kind === "error" ? "error" : kind === "decision" ? "accent" : "warning";
    const automaticWait = kind === "wait" || kind === "standby";
    const heading = kind === "standby"
      ? "⏳ GLLA waiting — work is safely parked"
      : kind === "wait"
        ? "⏳ GLLA timed wait — work is safely parked"
        : kind === "decision"
          ? "⏸ GLLA decision needed — work is safely parked"
          : "⏸ GLLA action needed — work is safely parked";
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg(color, heading), 0, 0));
    if (details?.reason) box.addChild(new Text(theme.fg("dim", `Why: ${details.reason}`), 0, 0));
    if (details?.action && !automaticWait) box.addChild(new Text(theme.fg("accent", `Next: ${details.action}`), 0, 0));
    if (kind === "standby") box.addChild(new Text(theme.fg("dim", "No action is needed; background completion wakes this work automatically."), 0, 0));
    if (kind === "wait") {
      box.addChild(new Text(theme.fg("dim", details?.resumeAt
        ? `Auto-resume: ${details.resumeAt}`
        : "The wait resumes automatically when its condition clears."), 0, 0));
    }
    if (details?.resumeCommand && !automaticWait) box.addChild(new Text(theme.fg("dim", `Resume: ${details.resumeCommand}`), 0, 0));
    return box;
  });
}
