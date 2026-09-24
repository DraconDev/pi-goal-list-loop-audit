import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const ACTION_REMINDER_CUSTOM_TYPE = "glla-action-reminder";

export type ActionReminderKind = "decision" | "blocked" | "error" | "wait" | "standby";

export type ActionReminderParkState = "stopped" | "automatic" | "redirect";

export interface ActionReminderDetails {
  kind: ActionReminderKind;
  reason: string;
  action: string;
  resumeCommand: string;
  resumeAt?: string;
  diagnostic?: string;
  parkState: ActionReminderParkState;
  /** The persisted goal is safe in every pause state. `parkState` separately
   * distinguishes a stopped turn, automatic wait, or redirect continuation. */
  safelyParked: true;
}

export interface ActionReminderPresentation {
  heading: string;
  why: string;
  next: string;
  resumeCommand?: string;
  resumeAt?: string;
  parkState: ActionReminderParkState;
}

export interface ActionReminderCopy {
  content: string;
  details: ActionReminderDetails;
  presentation: ActionReminderPresentation;
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
let pauseTurnGeneration = 0;
let pauseMarkerGeneration: number | null = null;

/** Bind the exact pause state and host owner to the turn pause_goal is about
 * to abort. A session/goal mismatch expires the marker instead of letting it
 * rewrite some later abort. */
export function markPauseAbort(marker: PauseAbortMarker): void {
  pauseAbortMarker = { ...marker };
  // Keep the public marker contract focused on the pause payload. A monotonic
  // generation captured at agent_start is the fence: consuming requires the
  // marker and its owner/goal to still belong to this exact turn.
  pauseMarkerGeneration = pauseTurnStartedAt === 0 ? null : pauseTurnGeneration;
}

export function markActionReminderTurnStart(): void {
  pauseTurnStartedAt = Date.now();
  pauseTurnGeneration++;
  pauseAbortMarker = null;
  pauseMarkerGeneration = null;
}

export function clearPauseAbort(): void {
  pauseAbortMarker = null;
  pauseTurnStartedAt = 0;
  pauseMarkerGeneration = null;
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
    || pauseMarkerGeneration === null
    || pauseMarkerGeneration !== pauseTurnGeneration
  ) {
    return null;
  }
  pauseAbortMarker = null;
  pauseMarkerGeneration = null;
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
  diagnostic?: string;
  parkState?: ActionReminderParkState;
}): ActionReminderCopy {
  const reason = input.reason.trim() || "The current turn cannot continue safely.";
  const suppliedAction = input.action?.trim();
  const action = suppliedAction || input.resumeCommand;
  const parkState = input.parkState ?? (
    input.kind === "wait" || input.kind === "standby" ? "automatic" : "stopped"
  );
  const automaticWake = parkState === "automatic";
  const presentation = buildPausePresentation({
    kind: input.kind,
    reason,
    action: input.kind === "decision" && !suppliedAction ? "" : action,
    resumeCommand: input.resumeCommand,
    resumeAt: input.resumeAt,
    parkState,
  });
  const diagnostic = input.diagnostic?.trim();
  const content = [
    presentation.heading,
    `Why: ${presentation.why}`,
    parkState === "redirect"
      ? "The saved goal is held while the current turn handles the new request."
      : "Your saved work is intact; this turn stopped before more work could be lost.",
    presentation.next,
    ...(diagnostic ? [`Diagnostic: ${diagnostic}`] : []),
  ].join("\n");
  return {
    content,
    details: {
      kind: input.kind,
      reason,
      action,
      resumeCommand: input.resumeCommand,
      resumeAt: input.resumeAt,
      diagnostic,
      parkState,
      safelyParked: true,
    },
    presentation,
  };
}

/** Normalize all reminder states into one hierarchy used by both transcript
 * copy and the TUI renderer. Raw transport/provider diagnostics stay outside
 * this model; callers may append them only after the actionable lines. */
export function buildPausePresentation(input: {
  kind: ActionReminderKind;
  reason: string;
  action: string;
  resumeCommand: string;
  resumeAt?: string;
  parkState: ActionReminderParkState;
}): ActionReminderPresentation {
  const why = input.reason.trim() || "The current turn cannot continue safely.";
  if (input.parkState === "redirect") {
    return {
      heading: "Goal safely parked — handling your new request now",
      why,
      next: `Next: ${input.action || input.resumeCommand}`,
      resumeCommand: input.resumeCommand,
      parkState: input.parkState,
    };
  }
  if (input.kind === "standby") {
    return {
      heading: "Waiting — work is safely parked",
      why,
      next: "No action is needed; the background completion will wake this work automatically.",
      parkState: input.parkState,
    };
  }
  if (input.kind === "wait") {
    return {
      heading: "Waiting — work is safely parked",
      why,
      next: input.resumeAt
        ? `The wait resumes automatically at ${input.resumeAt}.`
        : "The wait resumes automatically when its condition clears.",
      parkState: input.parkState,
    };
  }
  if (input.kind === "decision") {
    return {
      heading: "Decision needed — work is safely parked",
      why,
      next: input.action
        ? `Next: ${input.action}`
        : "Choose an option in the decision card, then resume.",
      resumeCommand: input.resumeCommand,
      parkState: input.parkState,
    };
  }
  return {
    heading: "Action needed — work is safely parked",
    why,
    next: `Next: ${input.action || input.resumeCommand}`,
    resumeCommand: input.resumeCommand,
    parkState: input.parkState,
  };
}

export function registerActionReminderRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(ACTION_REMINDER_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    const details = message.details as Partial<ActionReminderDetails> | undefined;
    const diagnostics = details?.diagnostic?.trim();
    const kind = details?.kind ?? "blocked";
    const color = kind === "error" ? "error" : kind === "decision" ? "accent" : "warning";
    const parkState = details?.parkState ?? (kind === "wait" || kind === "standby" ? "automatic" : "stopped");
    const presentation = buildPausePresentation({
      kind,
      reason: details?.reason ?? "",
      action: details?.action ?? details?.resumeCommand ?? "",
      resumeCommand: details?.resumeCommand ?? "",
      resumeAt: details?.resumeAt,
      parkState,
    });
    const heading = parkState === "redirect"
      ? `↪ GLLA ${presentation.heading}`
      : kind === "wait" || kind === "standby"
        ? `⏳ GLLA ${presentation.heading}`
        : `⏸ GLLA ${presentation.heading}`;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg(color, heading), 0, 0));
    box.addChild(new Text(theme.fg("dim", `Why: ${presentation.why}`), 0, 0));
    if (presentation.next) box.addChild(new Text(theme.fg("accent", presentation.next), 0, 0));
    if (presentation.parkState === "redirect") {
      box.addChild(new Text(theme.fg("dim", "The saved goal is held while the current turn handles the new request."), 0, 0));
    } else if (presentation.parkState === "stopped") {
      box.addChild(new Text(theme.fg("dim", "Your saved work is intact; this turn stopped before more work could be lost."), 0, 0));
    }
    if (presentation.resumeCommand && presentation.parkState !== "automatic") {
      box.addChild(new Text(theme.fg("dim", `Resume: ${presentation.resumeCommand}`), 0, 0));
    }
    if (diagnostics) {
      box.addChild(new Text(theme.fg("dim", `Diagnostic: ${diagnostics}`), 0, 0));
    }
    return box;
  });
}
