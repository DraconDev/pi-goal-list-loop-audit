import type { State, MainModelRecoveryRuntime } from './goal-loop-core.js';
import { unconfirmedCompactionStatus, type CompactionStatus } from './compaction-status.js';
import { humanCheckTime } from './human-handoff.js';

/** Presentation only. Never use these states as dispatch permissions. */
export type ExecutionHealth = 'idle' | 'complete' | 'cancelled' | 'running' | 'tool-wait'
  | 'retry-armed' | 'waiting' | 'queued' | 'blocked' | 'dormant' | 'unconfirmed';
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
  /** Observed heartbeat registration for this exact saved assessment deadline. */
  scheduledCheck?: { resumeAt: string; heartbeatArmed: boolean };
  backgroundWait?: { waitId: string; registered: boolean; lastActivityAt?: number };
  compaction?: CompactionStatus;
}
export interface UiStatusContext {
  now: number;
  /** Absent for fleet observations lacking an independently verified host. */
  generation?: number;
  evidence?: UiStatusEvidence;
  /** Host admission remains distinct from detached worker liveness. */
  compactionEvidence?: Pick<UiStatusEvidence, 'ownerKey' | 'generation' | 'session' | 'observedAt' | 'compaction'>;
  workflowIssue?: string;
  /** Observed persistence hold from the admitted host, never a dispatch gate here. */
  persistenceHold?: string;
  /** v0.40.1: pi started without a loaded conversation; GLLA defers resume
   * until the transcript loads (or the user runs /glla resume). */
  loadPending?: boolean;
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
  checkAt?: string;
  wakeOwner?: string;
  blocker?: string;
  workflowIssue?: string;
  nextAction: string;
  pauseSource?: 'agent' | 'user' | 'system' | 'unknown';
  resumeAction?: string;
  /** Durable queue depth, so the footer never drops waiting work (v0.35.61). */
  queueDepth?: number;
  /** Saved-recovery honesty note for unconfirmed retries (never an armed-timer claim). */
  recoveryNote?: string;
  compaction?: CompactionStatus;
  /** Renderer-attributed detached audit facts, never dispatch permissions. */
  auditPhase?: 'queued' | 'running' | 'quiet' | 'stalled' | 'stopped' | 'blocked' | 'awaiting-verdict';
  auditLive?: boolean;
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
  const workflow = loop?.builder?.phase ?? (loop ? 'polishing' : goal?.status === 'complete' ? 'complete' : goal?.status === 'aborted' ? 'cancelled' : goal?.pendingCompletion?.phase === 'settling' ? 'settling' : goal?.status === 'auditing' ? 'auditing' : goal?.status === 'paused' ? 'paused' : goal ? 'working' : 'idle');
  const resume = mode === 'list' ? '/list resume' : loop ? '/loop resume' : '/goal resume';
  const base: UiStatus = { mode, workflow, execution: ownerKey ? 'unconfirmed' : 'idle',
    actionability: ownerKey ? 'inspect' : 'none', ownerKey,
    objective: loop?.builder?.vision ?? loop?.target ?? goal?.objective,
    provenance: 'saved', workflowIssue: context.workflowIssue,
    nextAction: ownerKey ? '/glla status to inspect execution' : 'No saved work' };
  if (goal?.status === 'paused') {
    base.pauseSource = goal.pauseSource === 'agent' || goal.pauseSource === 'user' || goal.pauseSource === 'system'
      ? goal.pauseSource : 'unknown';
  }
  // v0.35.61: waiting work rides every footer — a queue beside live work
  // is durable context, not a second card. Set before any finish() so all
  // executions carry it.
  if (ownerKey) {
    const host = context.compactionEvidence ?? context.evidence;
    const sample = host?.compaction;
    const fresh = host && host.ownerKey === ownerKey && context.generation !== undefined
      && host.generation === context.generation && host.session === 'open'
      && validTime(host.observedAt, now) && now - host.observedAt <= UI_OBSERVATION_FRESH_MS
      && sample && validTime(sample.observedAt, now) && now - sample.observedAt <= UI_OBSERVATION_FRESH_MS;
    base.compaction = fresh ? sample : unconfirmedCompactionStatus();
  }
  const queued = state.list?.length ?? 0;
  if (queued > 0) base.queueDepth = queued;
  const finish = (execution: ExecutionHealth, actionability: UiStatus['actionability'], nextAction: string, blocker?: string): UiStatus =>
    ({ ...base, execution, actionability, nextAction, ...(blocker ? { blocker } : {}) });
  if (goal?.status === 'complete' || loop?.builder?.phase === 'complete') return finish('complete', 'none', 'No action needed');
  if (goal?.status === 'aborted') return finish('cancelled', 'none', 'No action needed');
  if (!ownerKey) return base;
  if (context.persistenceHold) return finish('blocked', 'user', 'Resolve persistence failure before continuing; /glla status for details', context.persistenceHold);
  if (typeof state.supervisorPausedAt === 'number') return finish('blocked', 'user', '/glla resume releases the supervisor hold', 'Supervisor paused');
  if (typeof state.loadHoldAt === 'number') return finish('blocked', 'user', '/glla resume grants continuation consent', 'Held on session restore');
  // v0.40.1 (field Screenshot_20261113_115355): a fresh pi with no
  // conversation loaded yet. GLLA deliberately waits, so the saved work is
  // neither "unconfirmed execution" nor whatever the previous session's last
  // pause said ("provider error") — it is waiting on the user to load it.
  if (context.loadPending) return finish('blocked', 'user', 'Load or resume the conversation in pi, or run /glla resume', 'Waiting for pi to load the conversation');
  const evidence = context.evidence;
  const matches = evidence && context.generation !== undefined && evidence.generation === context.generation
    && evidence.ownerKey === ownerKey && validTime(evidence.observedAt, now)
    && now - evidence.observedAt <= UI_OBSERVATION_FRESH_MS;
  if (matches && evidence.session === 'closed') {
    const prerequisite = goal?.status === 'paused' && goal.pauseKind !== 'wait' && goal.pauseKind !== 'standby';
    return { ...finish('dormant', 'user', prerequisite
      ? `Reopen project; ${goal.pauseSuggestedAction ?? (goal.pauseKind === 'decision' ? '/goal decide resolves the pending choice' : `${resume} only after resolving the saved prerequisite`)}`
      : 'Reopen project; /glla status',
    prerequisite && goal.pauseReason ? `Session observed closed; ${goal.pauseReason}` : 'Session observed closed'),
    provenance: 'runtime' };
  }
  const recovery = state.mainModelRecovery;
  const recoveryOwned = recovery && (recovery.owner?.kind === 'goal' ? recovery.owner.id === goal?.id
    : recovery.owner?.kind === 'loop' ? recovery.owner.startedAt === loop?.startedAt
    : !recovery.owner && (recovery.kind === 'goal' ? !!goal : !!loop));
  const providerWait = recoveryOwned && !recovery?.manualResumeRequired
    && (!!recovery?.retryAt || !!recovery?.pendingModelSwitch);
  const legacyProviderPause = providerWait && goal?.pauseKind !== 'decision'
    && (goal?.pauseReason ?? '').startsWith('main model recovery');
  // v0.39.31 (incident Screenshot_20261012_110844/111046): a settling
  // claim is settled — the verdict is durable, the archive is owed. Name
  // the state on the projection so the user does not read a parked
  // settlement as "blocked". The retry that races the archive is fenced
  // upstream in retryStoredCompletionAudit; this branch names the
  // durable fact for the surface.
  if (goal?.pendingCompletion?.phase === 'settling') {
    return finish('blocked', 'automatic', `${resume} when the archive lands (or runs the settlement driver again on the next wake)`, 'verdict applied · awaiting archive');
  }
  if (goal?.status === 'paused' && goal.pauseKind !== 'wait' && goal.pauseKind !== 'standby' && !legacyProviderPause) {
    base.resumeAction = goal.pauseKind === 'decision'
      ? `${mode === 'list' ? '/list decide' : '/goal decide'} resolves the pending choice`
      : `After completing the required action, use ${resume} to continue`;
    return finish('blocked', 'user', goal.pauseSuggestedAction ?? (goal.pauseKind === 'decision' ? `${mode === 'list' ? '/list decide' : '/goal decide'} to resolve the pending choice` : 'Complete the requirement described below, then report the result'), goal.pauseReason ?? 'Work paused');
  }
  if (recoveryOwned && recovery?.manualResumeRequired) return finish('blocked', 'user', `${resume} after resolving the recovery prerequisite`, recovery.reason);
  if (loop && !loop.active && !providerWait && !loop.backgroundWait) return finish('blocked', 'user', `${resume} when ready`, loop.stopReason ?? 'Loop held');
  const background = loop?.backgroundWait ?? goal?.backgroundWait;
  if (background) base.wakeOwner = 'Owned dependency completion/reconciliation';
  const scheduledCheck = goal?.status === 'paused' && goal.pauseKind === 'wait'
    && !goal.pendingCompletion && !providerWait && epoch(goal.pauseResumeAt) !== undefined;
  if (scheduledCheck) {
    base.checkAt = goal!.pauseResumeAt;
    base.wakeOwner = 'GLLA assessment heartbeat';
  }
  if (matches) {
    base.provenance = 'runtime';
    if (validTime(evidence.lastActivityAt, now)) base.lastActivityAt = evidence.lastActivityAt;
    if (evidence.recovery?.hold) return finish('blocked', 'user', '/glla status for the required recovery action', evidence.recovery.hold);
    if (evidence.session === 'open') {
      if (background) {
        const sample = evidence.backgroundWait;
        const registered = sample?.waitId === background.id && sample.registered;
        const progress = registered && validTime(sample?.lastActivityAt, now)
          && now - sample.lastActivityAt <= UI_OBSERVATION_FRESH_MS;
        // Parent-host stream activity is never evidence of worker progress.
        base.lastActivityAt = sample?.waitId === background.id && validTime(sample.lastActivityAt, now)
          ? sample.lastActivityAt : undefined;
        return finish(progress ? 'running' : registered ? 'waiting' : 'unconfirmed',
          registered ? 'automatic' : 'inspect', registered
            ? progress ? 'Background activity observed; assess on owned completion/reconciliation'
              : 'Waiting on owned dependencies; activity unknown/stale, not proof of a stuck worker'
            : 'Background checkpoint saved; live completion/reconciliation registration unconfirmed — /glla status');
      }
      if (scheduledCheck) {
        const registered = evidence.scheduledCheck?.resumeAt === base.checkAt
          && evidence.scheduledCheck?.heartbeatArmed === true;
        return finish(registered ? 'waiting' : 'unconfirmed', registered ? 'automatic' : 'inspect',
          registered
            ? `Next check: ${humanCheckTime(base.checkAt!)}. No action needed while this session is active; this checks progress, not completion.`
            : `Check saved for ${humanCheckTime(base.checkAt!)}. Automatic checking is not confirmed; use /glla status`,
          registered ? undefined : 'A check time is saved, but no automatic check is registered');
      }
      const tool = evidence.tool;
      if (tool && validTime(tool.startedAt, now) && Number.isFinite(tool.budgetMs) && tool.budgetMs > 0 && now - tool.startedAt < tool.budgetMs) {
        return finish('tool-wait', 'automatic', 'Tool timeout handling is automatic');
      }
      if (recoveryOwned && evidence.recovery && (evidence.recovery.retryTimerArmed || evidence.recovery.hourlyTimerArmed)) {
        base.retryKind = evidence.recovery.retryTimerArmed ? 'regular' : 'hourly';
        if (base.retryKind === 'regular' && epoch(recovery?.retryAt) !== undefined) base.retryAt = recovery?.retryAt;
        return finish('retry-armed', 'automatic', base.retryKind === 'hourly' ? 'Probe when hourly timer fires' : 'Retry when recovery timer fires', recovery?.reason);
      }
      if (evidence.turnActive || (base.lastActivityAt !== undefined && now - base.lastActivityAt <= UI_OBSERVATION_FRESH_MS)) {
        const nextTask = goal?.taskList?.tasks.find(task => task.status !== 'complete');
        return finish('running', 'automatic', nextTask?.title ?? (base.workflow === 'replanning' ? 'Plan the next increment; scope unchanged' : 'Observed work is in progress'));
      }
      if (evidence.turnQueued) return finish('queued', 'automatic', 'Turn queued; execution start not yet observed');
    }
  }
  if (background) return finish('unconfirmed', 'inspect',
    'Background checkpoint saved; host/activity/wake unconfirmed — /glla status');
  const savedActivity = epoch(goal?.pendingCompletion?.lastActivityAt);
  if (validTime(savedActivity, now)) base.lastActivityAt = savedActivity;
  if (recoveryOwned && epoch(recovery?.retryAt) !== undefined) base.retryAt = recovery?.retryAt;
  // v0.38.31: a saved retry names its recovery owner with the unconfirmed
  // qualifier inline, so the status line never reads as an armed probe it
  // cannot prove.
  if (providerWait) base.recoveryNote = 'main-model recovery — retry saved (unconfirmed)';
  if (scheduledCheck) return finish('unconfirmed', 'inspect',
    `Check saved for ${humanCheckTime(base.checkAt!)}; host/wake unconfirmed — reopen the session and inspect /glla status`);
  return finish('unconfirmed', 'inspect', base.workflow === 'settling' ? '/glla status · settlement/archive owed' : '/glla status to inspect execution', providerWait ? 'Retry saved; execution unconfirmed' : undefined);
}
