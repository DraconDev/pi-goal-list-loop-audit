import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactDisplayText, TWEAK_COMMAND, tweakSuggestionTruncated } from "./goal-loop-core.js";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { humanCheckTime, humanTextPreview } from "./human-handoff.js";

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
  /** Conditional retry copy; a resume command does not resolve a blocker. */
  resumeHint?: string;
  resumeCommand?: string;
  resumeAt?: string;
  parkState: ActionReminderParkState;
}

/** A tweak proposal rewrites the operator's objective or contract, so it is
a question for the operator — never an imperative decree. Field 2026-10-14
(hellhunter screenshot): an agent-authored `Run '/goal tweak "..."'`
suggested action rendered verbatim as `Next: Run ...`, reading as an order
to rewrite the contract. Frame it as a question while preserving the exact
command verbatim for copy-paste. Returns undefined for non-tweak actions. */
export function frameTweakSuggestion(action: string): string | undefined {
  const trimmed = action.trim();
  if (!TWEAK_COMMAND.test(trimmed)) return undefined;
  if (tweakSuggestionTruncated(trimmed)) {
    // Field 2026-10-27 (darkwave cut to "darkw"): the proposed replacement
    // arrived truncated, so no complete command exists to preserve verbatim.
    // Presenting the fragment as a command would ask the user to type a
    // broken edit. Route to the interactive flow instead: bare tweak
    // pre-fills the current text and the Confirm gate still applies.
    const root = /\/list\s+tweak\b/i.test(trimmed) ? "/list tweak" : "/goal tweak";
    return `Question: should this tweak be applied? The proposed edit text arrived truncated — run ${root} with no arguments to review and edit it interactively.`;
  }
  return `Question: should this tweak be applied? ${trimmed} — or reply with what you'd prefer instead.`;
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
// The message rewrite is one-shot; expected-abort classification must survive
// it until this exact turn ends so agent_end cannot emit a second warning.
let expectedPauseAbort: { marker: PauseAbortMarker; generation: number } | null = null;
type PausedAbortIdentity = Pick<PauseAbortMarker, "ownerSession" | "goalId" | "kind" | "reason" | "resumeAt">;
let observedPauseAbort: { identity: PausedAbortIdentity; generation: number } | null = null;
const samePause = (a: PausedAbortIdentity, b: PausedAbortIdentity): boolean =>
  a.ownerSession === b.ownerSession && a.goalId === b.goalId && a.kind === b.kind && a.reason === b.reason && a.resumeAt === b.resumeAt;

/** Observation only: never resumes work, proves a wake or suppresses retries
 * for another owner/turn/pause. Unexpected aborts remain visible once. */
export function observePausedHostAbort(identity: PausedAbortIdentity): "expected" | "unexpected" | "duplicate" {
  if (observedPauseAbort?.generation === pauseTurnGeneration && samePause(observedPauseAbort.identity, identity)) return "duplicate";
  observedPauseAbort = { identity: { ...identity }, generation: pauseTurnGeneration };
  return pauseTurnStartedAt !== 0 && expectedPauseAbort?.generation === pauseTurnGeneration && samePause(expectedPauseAbort.marker, identity)
    ? "expected" : "unexpected";
}

/** Bind the exact pause state and host owner to the turn pause_goal is about
 * to abort. A session/goal mismatch expires the marker instead of letting it
 * rewrite some later abort. */
export function markPauseAbort(marker: PauseAbortMarker): void {
  pauseAbortMarker = { ...marker };
  expectedPauseAbort = { marker: { ...marker }, generation: pauseTurnGeneration };
  observedPauseAbort = null;
  // Keep the public marker contract focused on the pause payload. A monotonic
  // generation captured at agent_start is the fence: consuming requires the
  // marker and its owner/goal to still belong to this exact turn.
  pauseMarkerGeneration = pauseTurnStartedAt === 0 ? null : pauseTurnGeneration;
}

export function markActionReminderTurnStart(): void {
  pauseTurnStartedAt = Date.now();
  pauseTurnGeneration++;
  expectedPauseAbort = null;
  observedPauseAbort = null;
  pauseAbortMarker = null;
  pauseMarkerGeneration = null;
}

export function clearPauseAbort(): void {
  expectedPauseAbort = null;
  observedPauseAbort = null;
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

/** Hosts may encode cancellation as an error stop. Recognizing this narrow
 * transport vocabulary is not sufficient to hide it: callers must also
 * consume the exact current-turn pause marker and match the saved pause. */
export function isPauseAbortMessage(message: { stopReason?: unknown; errorMessage?: unknown }): boolean {
  return message.stopReason === "aborted" || (message.stopReason === "error"
    && typeof message.errorMessage === "string"
    && /^(?:AbortError:\s*)?(?:This operation was aborted|The operation was aborted|Request was aborted|Operation aborted)\.?$/i.test(message.errorMessage.trim()));
}

export function buildAbortedAssistantNotice(input: {
  kind: ActionReminderKind;
  reason: string;
  action?: string;
  resumeCommand: string;
  resumeAt?: string;
}): string {
  const reminder = buildActionReminder(input);
  return reminder.presentation.parkState === "automatic"
    ? `Waiting saved; this turn ended intentionally. ${input.resumeAt ? `Next progress check: ${humanCheckTime(input.resumeAt)}.` : "See the waiting card for the next check."} Your work is saved.`
    : "GLLA paused this turn intentionally. Your work is saved; see the action card above for what to do next.";
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
  const action = input.kind === "decision" && !suppliedAction ? "" : suppliedAction || input.resumeCommand;
  const parkState = input.parkState ?? (
    input.kind === "wait" || input.kind === "standby" ? "automatic" : "stopped"
  );
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
    presentation.next,
    ...(presentation.resumeHint ? [presentation.resumeHint] : []),
    parkState === "redirect"
      ? "Your work is saved while I handle the new request."
      : parkState === "automatic"
        ? "Your work is saved. This turn ends intentionally; a host abort message does not mean the work was lost."
        : "Your work is saved.",
    ...(presentation.why !== compactDisplayText(reason) || diagnostic ? ["More details are available in the expanded message and /glla status."] : []),
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
  const displayed = { ...input, reason: compactDisplayText(input.reason), action: compactDisplayText(input.action), resumeCommand: compactDisplayText(input.resumeCommand), resumeAt: input.resumeAt ? compactDisplayText(input.resumeAt) : undefined };
  const why = humanTextPreview(displayed.reason) || "The current turn cannot continue safely.";
  if (displayed.parkState === "redirect") {
    return {
      heading: "Goal safely parked — handling your new request now",
      why,
      next: frameTweakSuggestion(displayed.action) ?? `Next: ${displayed.action || displayed.resumeCommand}`,
      resumeCommand: displayed.resumeCommand,
      parkState: displayed.parkState,
    };
  }
  if (displayed.kind === "standby") {
    return {
      heading: "Waiting",
      why,
      next: "No action is needed while this session is active. I will check the background result when it arrives.",
      parkState: displayed.parkState,
    };
  }
  if (displayed.kind === "wait") {
    return {
      heading: "Waiting — work saved",
      why,
      next: displayed.resumeAt
        ? `Next check: ${humanCheckTime(displayed.resumeAt)}. This is a progress check, not a promise of completion. No action is needed while the session is active and automatic checks are enabled; use /glla status if unsure.`
        : "No next check is scheduled. Use /glla status to check what is needed before waiting.",
      parkState: displayed.parkState,
    };
  }
  if (displayed.kind === "decision") {
    return {
      heading: "Your decision is needed",
      why,
      next: displayed.action
        ? (frameTweakSuggestion(displayed.action) ?? `Next: ${displayed.action}`)
        : "Choose an option in the decision card, then resume.",
      resumeCommand: displayed.resumeCommand,
      parkState: displayed.parkState,
    };
  }
  if (displayed.kind === "blocked") {
    // Missing actions in historical cards defaulted to the resume command.
    // Do not extract/invent a prerequisite from prose; keep the full reason
    // prominent and point to it when the only suggested action is retry.
    const resumeOnly = !displayed.action || /^(?:(?:run|use)\s+)?[`'"]?\/(?:goal|list|loop|glla)\s+resume[`'"]?[.!]?$/i.test(displayed.action);
    return {
      heading: "Your help is needed",
      why,
      next: resumeOnly
        ? "Next: Complete the requirement described above, then tell me the result."
        : (frameTweakSuggestion(displayed.action) ?? `Next: ${displayed.action}`),
      resumeHint: displayed.resumeCommand
        ? `Then use ${displayed.resumeCommand} to continue. Resuming alone does not fix the blocker.`
        : undefined,
      resumeCommand: displayed.resumeCommand,
      parkState: displayed.parkState,
    };
  }
  return {
    heading: "Work needs attention",
    why,
    next: frameTweakSuggestion(displayed.action) ?? `Next: ${displayed.action || displayed.resumeCommand}`,
    resumeCommand: displayed.resumeCommand,
    parkState: displayed.parkState,
  };
}

export function registerActionReminderRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(ACTION_REMINDER_CUSTOM_TYPE, (message, { outputPad, expanded }, theme) => {
    const details = message.details as Partial<ActionReminderDetails> | undefined;
    const diagnostics = compactDisplayText(details?.diagnostic ?? "");
    const kind = details?.kind ?? "blocked";
    const color = kind === "error" ? "error" : kind === "decision" || kind === "wait" || kind === "standby" ? "accent" : "warning";
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
    // A wait's check/action comes before its supporting reason. Blockers
    // still lead with the prerequisite the person needs to resolve.
    const timedWait = kind === "wait" && parkState === "automatic";
    if (timedWait) {
      box.addChild(new Text(theme.fg("accent", details?.resumeAt ? `Next check: ${humanCheckTime(details.resumeAt)}` : "No next check is scheduled."), 0, 0));
      box.addChild(new Text("This turn stopped intentionally to wait — not because the task failed.", 0, 0));
    }
    box.addChild(new Text(`Why: ${expanded ? compactDisplayText(details?.reason ?? presentation.why) : presentation.why}`, 0, 0));
    if (presentation.next) box.addChild(new Text(theme.fg("accent", timedWait && details?.resumeAt
      ? "No action is needed while this session is active and automatic checks are enabled. This is a progress check, not a promise of completion; use /glla status if unsure."
      : presentation.next), 0, 0));
    if (presentation.resumeCommand && presentation.parkState !== "automatic") {
      box.addChild(new Text(presentation.resumeHint ?? theme.fg("dim", `Resume: ${presentation.resumeCommand}`), 0, 0));
    }
    if (presentation.parkState === "redirect") {
      box.addChild(new Text(theme.fg("dim", "Your work is saved while I handle the new request."), 0, 0));
    } else {
      box.addChild(new Text(theme.fg("dim", "Your work is saved."), 0, 0));
    }
    if (expanded && diagnostics) {
      box.addChild(new Text(theme.fg("dim", `Diagnostic: ${diagnostics}`), 0, 0));
    } else if (!expanded && (diagnostics || presentation.why !== compactDisplayText(details?.reason ?? ""))) {
      box.addChild(new Text(theme.fg("dim", "More details: expand this message or use /glla status."), 0, 0));
    }
    return {
      render: (width: number) => width <= 0 ? [] : box.render(width).map((line) => truncateToWidth(line, width, "…")),
      invalidate: () => box.invalidate(),
    };
  });
}
