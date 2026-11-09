/**
 * pi-goal-list-loop-audit — unreleased (GitHub #62 follow-up)
 * extensions/completion-audit-park.ts
 *
 * Why a parked completion claim lost its auditor, in terms the operator can
 * act on.
 *
 * Field 2026-11-09: a list item sat at `completion audit: parked — no review
 * recorded` with the action line "Fix the auditor/session issue, then /list
 * resume…". The actual cause was a session boundary — a reload landed while the
 * claim waited for its pre-audit admission boundary — and the operator checked
 * the auditor model against the session model, found them identical, and
 * reported a bogus diagnosis. One generic sentence was asserting a fault class
 * the durable record did not support.
 *
 * Lives in a leaf module (it imports only the provider vocabulary) because both
 * the park writer (`goal-recovery.ts`) and the two card renderers
 * (`goal-loop-display.ts`) need the same classification, and display already
 * imports `main-model-recovery` — so this direction adds no new cycle.
 */

import { isRecoverableProviderError } from "./main-model-recovery.js";

/** Why a parked claim lost its auditor. The reason strings come from a closed
 * set of callers (goal-activation, goal-session, the auditor hooks, the
 * heartbeat), so an unknown string degrades to `no-verdict` — the honest "no
 * verdict was produced" case — never to a model accusation. */
export type CompletionAuditParkCause = "session-boundary" | "watchdog" | "provider" | "verdict-apply" | "no-verdict";

export function classifyCompletionAuditParkReason(reason: string | undefined): CompletionAuditParkCause {
  const text = (reason ?? "").trim();
  // A host boundary produced these breadcrumbs; the auditor was never asked to
  // reach a verdict, so nothing about the auditor or its model is implicated.
  if (/^(?:session_shutdown|session_start|silent-host-successor|host-rebind)\b/i.test(text)) return "session-boundary";
  // The supervisor noticed the worker went silent — a real liveness event, but
  // still not proof of a configuration mistake.
  if (/^(?:stale-latch-recovery|heartbeat-recovery)\b/i.test(text)) return "watchdog";
  if (/apply-gate|verdict-apply/i.test(text)) return "verdict-apply";
  if (isRecoverableProviderError(text)) return "provider";
  return "no-verdict";
}

/** One-line human cause for the parked card. The raw breadcrumb is appended so
 * the durable ledger vocabulary stays visible without being the whole story. */
export function formatCompletionAuditParkCause(reason: string | undefined): string {
  const raw = (reason ?? "").trim();
  const suffix = raw ? ` (${raw})` : "";
  switch (classifyCompletionAuditParkReason(raw)) {
    case "session-boundary": return `the session changed before the auditor finished${suffix}`;
    case "watchdog": return `the auditor stopped reporting${suffix}`;
    case "provider": return `the provider failed the audit run${suffix}`;
    case "verdict-apply": return `the verdict could not be applied${suffix}`;
    default: return `the auditor exited without a verdict${suffix}`;
  }
}

/** The action line for a parked claim. Every cause gets its own sentence: a
 * session boundary has nothing to fix, and a provider failure names the
 * provider instead of implying the operator picked the wrong auditor model. */
export function completionAuditParkAction(reason: string | undefined, resumeCommand: string): string {
  switch (classifyCompletionAuditParkReason(reason)) {
    case "session-boundary":
      return `The completion claim is stored and was not judged: the session changed before the auditor finished, so nothing about your auditor or model setup is implicated. ${resumeCommand} starts exactly one fresh audit.`;
    case "watchdog":
      return `The completion claim is stored and was not judged: the auditor stopped reporting and the supervisor parked it rather than guess. ${resumeCommand} starts exactly one fresh audit.`;
    case "provider":
      return `The completion claim is stored and was not judged: the provider failed the audit run. Restore provider access (or pick another auditor model in /glla settings), then ${resumeCommand} starts exactly one fresh audit.`;
    case "verdict-apply":
      return `The completion claim is stored and its verdict could not be applied to this goal. ${resumeCommand} starts exactly one fresh audit of the current scope.`;
    default:
      return `The completion claim is stored and the auditor exited without a verdict. ${resumeCommand} starts exactly one fresh audit; if it repeats, check the auditor model and tool budget in /glla settings.`;
  }
}
