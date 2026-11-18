/**
 * decision-auto-select.ts — the "don't get stuck on an odd question" clock.
 *
 * A decision pause waits for a human. When nobody is there (a long goal, an
 * unattended window, a picker the user walked away from), that wait has no
 * clock and the objective parks indefinitely — field complaint: "we get stuck
 * in case we are thrown an odd question".
 *
 * The operator opts in with `decisionAutoSelectMinutes` (off by default; the
 * menu shows 10 minutes as the suggested fuse). When armed, the RECOMMENDED
 * option may be adopted after that delay — but only a continue-work answer:
 *
 *   - a continue-work glla command (`/goal resume`, `/list resume`,
 *     `/list next`, `/loop resume`) is executed, or
 *   - a prose/content choice is delivered to the agent as the picker itself
 *     does, then the work resumes.
 *
 * Cancel, accept-as-complete, tweak, pause, clear, stop, wipe, `/glla`
 * actions and verification-contract amendments are NEVER adopted: each one
 * ends the work, rewrites its scope, or answers content the operator was the
 * one asked about. An absent agent may not substitute consent for those.
 *
 * Two surfaces share this module so they cannot drift:
 *   - the `/goal decide` picker renders the remaining time and adopts at
 *     expiry (goal-commands.ts);
 *   - the heartbeat's durable backstop adopts a lingering decision pause even
 *     when no dialog ever opened (headless, popup disabled, Escape, restart).
 *
 * Pure module: types only, no settings/state/UI imports — callers supply the
 * configured delay and the observation time.
 */

import type { Goal } from "./goal-loop-core.js";

/** Suggested fuse the menu offers when the operator turns auto-select on. */
export const DECISION_AUTO_SELECT_DEFAULT_MINUTES = 10;
/** Upper bound keeps a saved value sane; a longer fuse is just "off". */
export const DECISION_AUTO_SELECT_MAX_MINUTES = 24 * 60;
/** A picker countdown shorter than this is pointless — below it, adopt now. */
export const DECISION_AUTO_SELECT_MIN_COUNTDOWN_MS = 5_000;

/** Actions an absent operator MAY adopt: they keep the objective moving. */
const CONTINUE_WORK_ACTIONS: ReadonlyArray<{ group: string; verb: string }> = [
  { group: "goal", verb: "resume" },
  { group: "list", verb: "resume" },
  { group: "list", verb: "next" },
  { group: "loop", verb: "resume" },
];

/** Actions that end, rewrite, or park the work — a person's call, always. */
const RESERVED_ACTIONS: ReadonlyArray<{ group: string; verb: string }> = [
  { group: "goal", verb: "cancel" },
  { group: "goal", verb: "accept" },
  { group: "goal", verb: "tweak" },
  { group: "goal", verb: "pause" },
  { group: "list", verb: "cancel" },
  { group: "list", verb: "pause" },
  { group: "list", verb: "clear" },
  { group: "list", verb: "remove" },
  { group: "list", verb: "rm" },
  { group: "loop", verb: "stop" },
  { group: "loop", verb: "cancel" },
  { group: "loop", verb: "pause" },
  { group: "loop", verb: "finish" },
];

/** A glla slash command named inside an option label. */
interface NamedAction {
  group: string;
  verb: string;
}

/** The picker's executable suffix form: `Label (/goal resume)`. */
const EXECUTABLE_SUFFIX = /\(\/(goal|list|loop|glla)\s+([a-z]+)\)\s*$/;

function namedActions(label: string): NamedAction[] {
  const out: NamedAction[] = [];
  for (const match of label.matchAll(/\/(goal|list|loop|glla)\s+([a-z]+)/g)) {
    out.push({ group: match[1]!, verb: match[2]! });
  }
  return out;
}

const isNamed = (action: NamedAction, table: ReadonlyArray<NamedAction>): boolean =>
  table.some((entry) => entry.group === action.group && entry.verb === action.verb);

/** The clean option text (the picker appends "  (recommended)" for display). */
export function decisionOptionText(option: string): string {
  return option.replace(/ {2}\(recommended\)$/, "");
}

export type AutoSelectVerdict =
  | { adoptable: true; shape: "command" | "steer" }
  | { adoptable: false; reason: string };

/**
 * Can an absent operator adopt this recommended option?
 *
 * Mechanical, never a judgment about the prose: a label that NAMES a reserved
 * action is out; a label that names a `/glla` action is out (that is the
 * operator's own settings task); anything else is a continue-work answer —
 * either an executable continue command, or content the picker delivers to
 * the agent before resuming.
 */
export function classifyAutoSelectOption(option: string | undefined): AutoSelectVerdict {
  const label = option ? decisionOptionText(option).trim() : "";
  if (!label) return { adoptable: false, reason: "the option text was empty" };
  const actions = namedActions(label);
  const reserved = actions.find((action) => isNamed(action, RESERVED_ACTIONS));
  if (reserved) {
    return { adoptable: false, reason: `\`/${reserved.group} ${reserved.verb}\` ends, rewrites, or parks the work` };
  }
  const settingsTask = actions.find((action) => action.group === "glla");
  if (settingsTask) {
    return { adoptable: false, reason: "it asks for a /glla change, which is the operator's own task" };
  }
  const executable = label.match(EXECUTABLE_SUFFIX);
  if (executable) {
    const [, group, verb] = executable;
    const action = { group: group!, verb: verb! };
    // An executable continue-work command is the picker's own action. Any
    // other executable command that is neither reserved nor continue-work
    // (a verb this build does not know) stays a plain resume of the prose.
    return { adoptable: true, shape: isNamed(action, CONTINUE_WORK_ACTIONS) ? "command" : "steer" };
  }
  return { adoptable: true, shape: "steer" };
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

type AutoSelectGoal = Pick<Goal,
  "status" | "pauseKind" | "pauseOptions" | "pauseRecommended" | "pauseContractAmendment">;

/** A goal record as the clock needs it: the pause fields plus the timestamps
 * the episode is measured from. */
export type AutoSelectGoalRecord = AutoSelectGoal & Pick<Goal, "pauseDecidedAt" | "updatedAt" | "createdAt">;

/** Everything the two surfaces need before they advertise or adopt a pick. */
export function decisionAutoSelectCandidate(goal: AutoSelectGoal | null | undefined): DecisionAutoSelectCandidate | undefined {
  if (!goal || goal.status !== "paused" || goal.pauseKind !== "decision") return undefined;
  if (!goal.pauseOptions || goal.pauseOptions.length === 0) return undefined;
  const index = typeof goal.pauseRecommended === "number" ? Math.floor(goal.pauseRecommended) : 0;
  if (index < 1 || index > goal.pauseOptions.length) return undefined;
  const option = goal.pauseOptions[index - 1]!;
  // A contract amendment changes what "done" means. Its recommended option is
  // Accept, and that needs a person even when the command inside it is plain.
  const verdict: AutoSelectVerdict = goal.pauseContractAmendment
    ? { adoptable: false, reason: "it proposes a verification-contract amendment, which needs your explicit consent" }
    : classifyAutoSelectOption(option);
  return { index, option, verdict };
}

/** Remaining milliseconds until the clock is due, or undefined when the clock
 * is off / the pause has no recommendation to consider. Zero/negative means
 * "due now".
 *
 * ARMED for ANY recommended decision option, including one that may not be
 * adopted: the clock's job is also to TELL the operator that their own
 * deadline passed on a question only they can answer (one
 * `decision_auto_select_refused` line). Only the ADOPTION is restricted. */
export function decisionAutoSelectRemainingMs(
  goal: AutoSelectGoalRecord | null | undefined,
  minutes: unknown,
  now: number,
): number | undefined {
  const resolved = resolveDecisionAutoSelectMinutes(minutes);
  if (resolved === undefined) return undefined;
  if (!decisionAutoSelectCandidate(goal)) return undefined;
  const since = decisionPauseSince(goal);
  if (since === undefined) return undefined;
  return since + resolved * 60_000 - now;
}

/** Is this pause past its configured delay (for ANY recommended option)?
 *
 * Armed means "the operator's own deadline passed". It does NOT mean an
 * adoption may happen: eligibility is `decisionAutoSelectAdoptable`. The
 * distinction is what lets a reserved recommendation (cancel, accept, tweak…)
 * still tell the operator that their clock expired while refusing to answer
 * the question for them.
 */
export function decisionAutoSelectDue(
  goal: AutoSelectGoalRecord | null | undefined,
  minutes: unknown,
  now: number,
): boolean {
  const remaining = decisionAutoSelectRemainingMs(goal, minutes, now);
  return remaining !== undefined && remaining <= 0;
}

/** Is the RECOMMENDED option both eligible for unattended adoption AND due?
 * This is the ONE gate the picker and the heartbeat share before adopting. */
export function decisionAutoSelectAdoptable(
  goal: AutoSelectGoalRecord | null | undefined,
  minutes: unknown,
  now: number,
): boolean {
  const candidate = decisionAutoSelectCandidate(goal);
  if (!candidate || !candidate.verdict.adoptable) return false;
  return decisionAutoSelectDue(goal, minutes, now);
}

/** The picker countdown: the durable clock, floored so a just-due pick can
 * still be read and cancelled. Undefined keeps the picker timeless — which
 * is deliberate for a recommendation the clock may NOT adopt (the dialog
 * must not dismiss itself on a question only the operator can answer). */
export function decisionAutoSelectCountdownMs(
  goal: AutoSelectGoalRecord | null | undefined,
  minutes: unknown,
  now: number,
): number | undefined {
  const candidate = decisionAutoSelectCandidate(goal);
  if (!candidate || !candidate.verdict.adoptable) return undefined;
  const remaining = decisionAutoSelectRemainingMs(goal, minutes, now);
  if (remaining === undefined) return undefined;
  return Math.max(DECISION_AUTO_SELECT_MIN_COUNTDOWN_MS, remaining);
}

/** One-line card truth for an armed pause, or undefined when the clock is off
 * or the recommendation may not be adopted. */
export function decisionAutoSelectCardLine(
  goal: AutoSelectGoalRecord | null | undefined,
  minutes: unknown,
  now: number,
): string | undefined {
  const candidate = decisionAutoSelectCandidate(goal);
  if (!candidate || !candidate.verdict.adoptable) return undefined;
  const remaining = decisionAutoSelectRemainingMs(goal, minutes, now);
  if (remaining === undefined) return undefined;
  const when = remaining <= 0 ? "now" : `in ${Math.max(1, Math.ceil(remaining / 60_000))}m`;
  return `auto-answers with option ${candidate.index} ${when} unless you decide first`;
}
