/**
 * decision-auto-select.ts — the "don't get stuck on an odd question" clock.
 *
 * A decision pause waits for a human. When nobody is there (a long goal, an
 * unattended window, a popup the user walked away from), that wait has no
 * clock and the objective parks indefinitely — field complaint: "we get
 * stuck in case we are thrown an odd question".
 *
 * The operator opts in with `decisionAutoSelectMinutes` (off by default; the
 * menu default delay is 10 minutes). When armed, the RECOMMENDED option may
 * be adopted automatically after that delay — but only when it is a
 * continue-work action. Cancel, accept-as-complete, tweak, wipe, contract
 * amendments and generic prose choices are never adopted: those either end
 * the work, rewrite its scope, or decide content the operator was asked
 * about. Adopting them unattended would be a consent substitution, not an
 * unsticking.
 *
 * Two surfaces share this module so they cannot drift:
 *   - the `/goal decide` picker renders the host countdown and adopts at
 *     expiry (goal-commands.ts);
 *   - the heartbeat's durable backstop adopts a lingering decision pause even
 *     when no dialog ever opened (headless, popup disabled, Escape, restart).
 *
 * Pure module: types only, no settings/state/UI imports — the caller supplies
 * the configured delay and the observation time.
 */

import type { Goal } from "./goal-loop-core.js";

/** Default delay the menu shows when the operator turns auto-select on. */
export const DECISION_AUTO_SELECT_DEFAULT_MINUTES = 10;
/** Upper bound keeps a saved value sane; a longer fuse is just "off". */
export const DECISION_AUTO_SELECT_MAX_MINUTES = 24 * 60;

/** The only decision actions an absent operator may adopt: they keep the
 * objective moving. Everything else (cancel, accept, tweak, wipe, contract
 * amendment) needs a person. */
const CONTINUE_WORK_COMMANDS: ReadonlyArray<{ group: string; verb: string }> = [
  { group: "goal", verb: "resume" },
  { group: "list", verb: "next" },
  { group: "list", verb: "resume" },
  { group: "loop", verb: "resume" },
];

/** A glla slash command named inside an option label. */
interface NamedCommand {
  group: string;
  verb: string;
  /** `(…/goal resume)` — the picker runs it; otherwise the label is prose
   * that the picker steers to the agent before resuming. */
  executable: boolean;
}

function namedCommands(label: string): NamedCommand[] {
  const out: NamedCommand[] = [];
  const re = /\/(goal|list|loop|glla)\s+([a-z]+)/g;
  for (const match of label.matchAll(re)) {
    const group = match[1]!;
    const verb = match[2]!;
    // The picker's executable form is `(<group> <verb>)` at the end of the
    // label; that regex is duplicated in goal-commands.ts by contract.
    out.push({ group, verb, executable: new RegExp(`^\\(\\/${group}\\s+${verb}\\)`, "i").test(label.slice(match.index - 1)) });
  }
  return out;
}

/** The clean option text (the picker appends "  (recommended)" for display). */
export function decisionOptionText(option: string): string {
  return option.replace(/ {2}\(recommended\)$/, "");
}

export type AutoSelectVerdict =
  | { adoptable: true; shape: "command" | "steer"; verb: string }
  | { adoptable: false; reason: string };

/**
 * Can an absent operator adopt this recommended option?
 *
 * The rule is mechanical, never a judgment about the prose: exactly one glla
 * command may appear in the label, it must be a continue-work verb, and no
 * `/glla` action may appear at all (a recommendation that asks the operator
 * to change settings is a person's task, not work to resume).
 */
export function classifyAutoSelectOption(option: string | undefined): AutoSelectVerdict {
  const label = option ? decisionOptionText(option).trim() : "";
  if (!label) return { adoptable: false, reason: "the option text was empty" };
  const commands = namedCommands(label);
  if (commands.length === 0) {
    return {
      adoptable: false,
      reason: "it is a prose choice with no continue-work command (only `/goal resume`-class options can be adopted)",
    };
  }
  if (commands.some((command) => command.group === "glla")) {
    return { adoptable: false, reason: "it names a /glla action, which is the operator's own task" };
  }
  if (commands.length > 1) {
    return { adoptable: false, reason: "it names more than one action, so the real choice is still open" };
  }
  const only = commands[0]!;
  const allowed = CONTINUE_WORK_COMMANDS.some((entry) => entry.group === only.group && entry.verb === only.verb);
  if (!allowed) {
    return {
      adoptable: false,
      reason: `\`/${only.group} ${only.verb}\` does not keep the work going`,
    };
  }
  return { adoptable: true, shape: only.executable ? "command" : "steer", verb: `/${only.group} ${only.verb}` };
}

/** The configured delay, or undefined when the feature is off. */
export function resolveDecisionAutoSelectMinutes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > DECISION_AUTO_SELECT_MAX_MINUTES) return undefined;
  return value;
}

/** When the current decision question landed. Legacy records fall back to
 * `updatedAt`, which the pause write itself stamped. */
export function decisionPauseSince(goal: Pick<Goal, "pauseDecidedAt" | "updatedAt" | "createdAt"> | null | undefined): number | undefined {
  const raw = goal?.pauseDecidedAt ?? goal?.updatedAt ?? goal?.createdAt;
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

export interface DecisionAutoSelectCandidate {
  /** 1-based index the agent recommended. */
  index: number;
  option: string;
  verdict: AutoSelectVerdict;
}

/** Everything the two surfaces need before they advertise or adopt a pick. */
export function decisionAutoSelectCandidate(
  goal: Pick<Goal, "status" | "pauseKind" | "pauseOptions" | "pauseRecommended" | "pauseContractAmendment"> | null | undefined,
): DecisionAutoSelectCandidate | undefined {
  if (!goal || goal.status !== "paused" || goal.pauseKind !== "decision") return undefined;
  if (!goal.pauseOptions || goal.pauseOptions.length === 0) return undefined;
  const index = typeof goal.pauseRecommended === "number" ? Math.floor(goal.pauseRecommended) : 0;
  if (index < 1 || index > goal.pauseOptions.length) return undefined;
  const option = goal.pauseOptions[index - 1]!;
  // A contract amendment changes what "done" means. Its recommended option
  // is Accept, and that needs a person even when the command inside happens
  // to be a plain test command.
  const verdict: AutoSelectVerdict = goal.pauseContractAmendment
    ? { adoptable: false, reason: "it proposes a verification-contract amendment, which needs your explicit consent" }
    : classifyAutoSelectOption(option);
  return { index, option, verdict };
}

/** Is this pause past its configured delay? */
export function decisionAutoSelectDue(
  goal: Pick<Goal, "status" | "pauseKind" | "pauseOptions" | "pauseRecommended" | "pauseContractAmendment" | "pauseDecidedAt" | "updatedAt" | "createdAt"> | null | undefined,
  minutes: unknown,
  now: number,
): boolean {
  const resolved = resolveDecisionAutoSelectMinutes(minutes);
  if (resolved === undefined) return false;
  if (!decisionAutoSelectCandidate(goal)) return false;
  const since = decisionPauseSince(goal);
  if (since === undefined) return false;
  return now - since >= resolved * 60_000;
}

/** Remaining milliseconds until the durable adoption, or undefined when the
 * clock is off. Negative/zero means "due now". */
export function decisionAutoSelectRemainingMs(
  goal: Pick<Goal, "pauseDecidedAt" | "updatedAt" | "createdAt"> | null | undefined,
  minutes: unknown,
  now: number,
): number | undefined {
  const resolved = resolveDecisionAutoSelectMinutes(minutes);
  if (resolved === undefined) return undefined;
  const since = decisionPauseSince(goal);
  if (since === undefined) return undefined;
  return since + resolved * 60_000 - now;
}
