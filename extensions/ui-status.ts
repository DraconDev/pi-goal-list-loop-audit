import type { State, MainModelRecoveryRuntime } from './goal-loop-core.js';

/** Presentation only. Never use these states as dispatch permissions. */
export type ExecutionHealth = 'idle' | 'complete' | 'cancelled' | 'running' | 'tool-wait'
  | 'retry-armed' | 'queued' | 'blocked' | 'dormant' | 'unconfirmed';
export interface UiStatusEvidence {
  /** Both values must match the adapter's currently bound work/generation. */
  ownerKey: string;
  generation: number;
  session: 'open' | 'closed' | 'unknown';
  observedAt: number;
  lastActivityAt?: number;
  turnActive?: boolean;
  turnQueued?: boolean;
  tool?: { name: string; startedAt: number; budgetMs: number };
  recovery?: MainModelRecoveryRuntime;
}
export interface UiStatusContext {
  now: number;
  /** Absent for fleet observations lacking an independently verified host. */
  generation?: number;
  evidence?: UiStatusEvidence;
  workflowIssue?: string;
}
export interface UiStatus {
  mode: 'goal' | 'list' | 'loop' | 'project' | 'idle';
  workflow: string;
  execution: ExecutionHealth;
  actionability: 'automatic' | 'user' | 'inspect' | 'none';
  objective?: string;
  ownerKey?: string;
  provenance: 'runtime' | 'saved';
  lastActivityAt?: number;
  retryAt?: string;
  retryKind?: 'regular' | 'hourly';
  blocker?: string;
  workflowIssue?: string;
  nextAction: string;
}

export const UI_OBSERVATION_FRESH_MS = 30_000;
const epoch = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const validTime = (value: number | undefined, now: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now;

/** Stable identity of the selected work, not whichever global slot is filled. */
export function uiStatusOwnerKey(state: State): string | undefined {
  if (state.loop?.active) return `loop:${state.loop.startedAt}`;
  if (state.goal) return `goal:${state.goal.id}`;
  if (state.loop) return `loop:${state.loop.startedAt}`;
  return undefined;
}

/** Durable workflow + explicitly attributed observations. No filesystem,
 * clock, singleton, mutation or timer is permitted in this projection. */
export function projectUiStatus(state: State, context: UiStatusContext): UiStatus {
  const { now } = context;
  const ownerKey = uiStatusOwnerKey(state);
  const loop = state.loop?.active || !state.goal ? state.loop : undefined;
  const goal = loop ? undefined : state.goal;
  const mode = loop ? loop.builder ? 'project' : 'loop' : goal ? goal.policy === 'list' ? 'list' : 'goal' : 'idle';
  const workflow = loop?.builder?.phase ?? (loop ? 'polishing' : goal?.pendingCompletion?.phase === 'settling' ? 'settling' : goal?.status === 'auditing' ? 'auditing' : goal ? 'working' : 'idle');
  const resume = mode === 'list' ? '/list resume' : loop ? '/loop resume' : '/goal resume';
  const base: UiStatus = { mode, workflow, execution: ownerKey ? 'unconfirmed' : 'idle',
    actionability: ownerKey ? 'inspect' : 'none', ownerKey,
    objective: loop?.builder?.vision ?? loop?.target ?? goal?.objective,
    provenance: 'saved', workflowIssue: context.workflowIssue,
    nextAction: ownerKey ? '/glla status to inspect execution' : 'No saved work' };
  const finish = (execution: ExecutionHealth, actionability: UiStatus['actionability'], nextAction: string, blocker?: string): UiStatus =>
    ({ ...base, execution, actionability, nextAction, ...(blocker ? { blocker } : {}) });
  if (goal?.status === 'complete' || loop?.builder?.phase === 'complete') return finish('complete', 'none', 'No action needed');
  if (goal?.status === 'aborted') return finish('cancelled', 'none', 'No action needed');
  if (!ownerKey) return base;
  if (typeof state.supervisorPausedAt === 'number') return finish('blocked', 'user', '/glla resume releases the supervisor hold', 'Supervisor paused');
  if (typeof state.loadHoldAt === 'number') return finish('blocked', 'user', '/glla resume grants continuation consent', 'Held on session restore');
  const recovery = state.mainModelRecovery;
  const recoveryOwned = recovery && (recovery.owner?.kind === 'goal' ? recovery.owner.id === goal?.id
    : recovery.owner?.kind === 'loop' ? recovery.owner.startedAt === loop?.startedAt
    : !recovery.owner && (recovery.kind === 'goal' ? !!goal : !!loop));
  const providerWait = recoveryOwned && !recovery?.manualResumeRequired
    && (!!recovery?.retryAt || !!recovery?.pendingModelSwitch);
  if (goal?.status === 'paused' && goal.pauseKind !== 'wait' && goal.pauseKind !== 'standby' && !providerWait) {
    return finish('blocked', 'user', goal.pauseSuggestedAction ?? `${resume} when the prerequisite is resolved`, goal.pauseReason ?? 'Work paused');
  }
  if (recoveryOwned && recovery?.manualResumeRequired) return finish('blocked', 'user', `${resume} after resolving the recovery prerequisite`, recovery.reason);
  if (loop && !loop.active && !providerWait && !loop.backgroundWait) return finish('blocked', 'user', `${resume} when ready`, loop.stopReason ?? 'Loop held');
  const evidence = context.evidence;
  const matches = evidence && context.generation !== undefined && evidence.generation === context.generation
    && evidence.ownerKey === ownerKey && validTime(evidence.observedAt, now)
    && now - evidence.observedAt <= UI_OBSERVATION_FRESH_MS;
  if (matches) {
    base.provenance = 'runtime';
    if (validTime(evidence.lastActivityAt, now)) base.lastActivityAt = evidence.lastActivityAt;
    if (evidence.session === 'closed') return finish('dormant', 'user', 'Reopen the project to inspect or continue', 'Session observed closed');
    if (evidence.recovery?.hold) return finish('blocked', 'user', '/glla status for the required recovery action', evidence.recovery.hold);
    if (evidence.session === 'open') {
      const tool = evidence.tool;
      if (tool && validTime(tool.startedAt, now) && Number.isFinite(tool.budgetMs) && tool.budgetMs > 0 && now - tool.startedAt < tool.budgetMs) {
        return finish('tool-wait', 'automatic', 'Tool timeout handling is automatic');
      }
      if (recoveryOwned && evidence.recovery && (evidence.recovery.retryTimerArmed || evidence.recovery.hourlyTimerArmed)) {
        base.retryKind = evidence.recovery.retryTimerArmed ? 'regular' : 'hourly';
        if (base.retryKind === 'regular' && epoch(recovery?.retryAt) !== undefined) base.retryAt = recovery?.retryAt;
        return finish('retry-armed', 'automatic', base.retryKind === 'hourly' ? 'Hourly recovery probe is armed' : 'Automatic recovery timer is armed', recovery?.reason);
      }
      if (evidence.turnActive || (base.lastActivityAt !== undefined && now - base.lastActivityAt <= UI_OBSERVATION_FRESH_MS)) return finish('running', 'automatic', 'Observed work is in progress');
      if (evidence.turnQueued) return finish('queued', 'automatic', 'Turn queued; execution start not yet observed');
    }
  }
  const savedActivity = epoch(goal?.pendingCompletion?.lastActivityAt);
  if (validTime(savedActivity, now)) base.lastActivityAt = savedActivity;
  if (recoveryOwned && epoch(recovery?.retryAt) !== undefined) base.retryAt = recovery?.retryAt;
  return finish('unconfirmed', 'inspect', '/glla status to inspect execution', providerWait ? 'Retry saved; execution unconfirmed' : undefined);
}
