// tests/stale-recovery-marker.test.ts
//
// note.md 2026-10-31 (Screenshot_20261031_092215): six hours AFTER the last goal
// was archived, the widget still rendered the standalone main-model recovery
// card — "no GLLA objective · send 'continue' to retry this chat". Nothing was
// wrong; the goal had completed. A recovery marker had outlived the goal that
// owned it, and the card asked the user to act on work that no longer existed.
//
// Two guards, both asserted in both directions here:
//   1. settlement clears the marker (clearOwnedMainModelRecovery)
//   2. the display refuses to render the standalone card without a live owner,
//      so a marker written by an older build cannot revive it either.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import activate, {
  __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags,
} from '../extensions/loops/goal.js';
import { buildWidgetLines, type DisplayTheme } from '../extensions/goal-loop-display.js';
import { clearStaleMainModelRecovery, mainModelRecoveryHasLiveOwner, retireOrphanedMainModelRecovery } from '../extensions/goal-recovery.js';
import { settleApprovedCompletion } from '../extensions/loops/goal-auditor-hooks.js';
import { readState, type State } from '../extensions/goal-loop-core.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from './harness/mock-pi.js';

afterEach(() => {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
});

const NOW = Date.parse('2026-10-31T09:22:00Z');

function recovery(kind: 'goal' | 'loop' | 'chat' = 'goal', ownerGoalId?: string): unknown {
  // Full MainModelRecovery shape: the renderer reads `attempted` and the other
  // arrays, so a partial fixture would fail for the wrong reason.
  return {
    kind,
    primary: 'openai-codex/gpt-6-luna',
    active: 'minimax/MiniMax-M3.1-Flash',
    attempted: ['openai-codex/gpt-6-luna'],
    skipped: [],
    failures: 1,
    episodes: [],
    firstFailureAt: '2026-10-31T01:40:00Z',
    lastFailureAt: '2026-10-31T01:40:00Z',
    // A chat-owned marker declares itself as such: without an owner, ownership
    // resolves 'absent', which is a DIFFERENT case (an orphaned leftover).
    ...(kind === 'chat' ? { owner: { kind: 'chat' } } : {}),
    ...(kind === 'goal' && ownerGoalId ? { owner: { kind: 'goal', id: ownerGoalId } } : {}),
  };
}

/** The banner that made the complaint concrete.
 *
 * The renderer takes the ownership verdict as ephemeral extras (it must not
 * import state machinery), so a real caller supplies it. `liveOwner` is what
 * `mainModelRecoveryHasLiveOwner()` computes in goal-ui.ts. */
function standaloneCardShown(state: State, liveOwner?: boolean): boolean {
  const extras = liveOwner === undefined ? undefined : { recoveryHasLiveOwner: liveOwner };
  const lines = buildWidgetLines(state, null, NOW, undefined, undefined, extras);
  return (lines ?? []).some((line) => /no GLLA objective/i.test(line));
}

test('a completed goal with a leftover recovery marker does NOT render the recovery card', () => {
  // The exact screenshot state: no goal at all, only a stale marker.
  const shipped = { goal: null, list: [], mainModelRecovery: recovery() } as unknown as State;
  assert.equal(standaloneCardShown(shipped, false), false,
    "the recovery card must not ask the user to retry a chat with nothing wrong; the banner is the note.md complaint");

  // And a goal that is present but terminal cannot own a marker either.
  const terminal = {
    goal: seedGoal({ status: 'complete' }),
    list: [],
    mainModelRecovery: recovery(),
  } as unknown as State;
  assert.equal(standaloneCardShown(terminal, false), false,
    'a terminal goal must not keep the recovery card alive');
});

test('a live recovery marker still renders its card — the guard is not blanket-hiding', () => {
  // The panel that produced the complaint, with a marker that DOES have work
  // waiting on it: the card must come back, otherwise this fix would hide real
  // recoveries instead of stale ones.
  const ownerless = { goal: null, list: [], mainModelRecovery: recovery() } as unknown as State;
  assert.equal(standaloneCardShown(ownerless, true), true,
    'a marker with a live owner still renders its recovery card');

  // A loop parked by the wall keeps its dedicated card regardless.
  const loopOwned = {
    goal: null,
    list: [],
    loop: { active: false, target: 'improve latency', iteration: 3, startedAt: '2026-10-31T00:00:00Z' },
    mainModelRecovery: recovery('loop'),
  } as unknown as State;
  const loopLines = buildWidgetLines(loopOwned, null, NOW, undefined, undefined);
  assert.ok(loopLines && loopLines.length > 0, 'a parked loop still explains its recovery');
});

test('the REAL observed marker (owner:chat, kind:goal, goal:null, 7h old) does not render the card', async () => {
  // This is the exact persisted state from the screenshot project, not a
  // synthetic marker: `owner` is {kind:"chat"}, the marker's legacy kind is
  // "goal", the goal is gone, and the episode was raised 7h42m before the card
  // was captured. An earlier revision of this file treated plain `chat` as a
  // live owner and so re-rendered the complaint verbatim; that is the defect.
  const firstFailureAt = new Date(Date.parse('2026-10-31T01:39:23.410Z')).toISOString();
  const observedMarker = {
    kind: 'goal',
    owner: { kind: 'chat' },
    primary: 'minimax/MiniMax-M3.1-Flash',
    active: 'minimax/MiniMax-M3.1-Flash',
    attempted: ['minimax/MiniMax-M3.1-Flash'],
    firstFailureAt,
    counts: { steps: 0 },
  } as unknown as State['mainModelRecovery'];
  const observed = { goal: null, list: [], loop: null, mainModelRecovery: observedMarker } as unknown as State;
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `observed-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  seedState(cwd, observed);
  __testOnlyLoadState(cwd);
  const liveVerdict = mainModelRecoveryHasLiveOwner();
  // The live-owner verdict is what the widget is given; it must be FALSE for
  // this state, and the render must not contain the complaint text.
  assert.equal(mainModelRecoveryHasLiveOwner(), false,
    'a chat-owned marker with no supervised target has no live owner');
  // Feed the renderer the verdict the REAL widget feeds it (goal-ui.ts:930
  // computes mainModelRecoveryHasLiveOwner() there). Passing no flag would be
  // vacuous: the renderer is fail-closed and renders nothing either way.
  assert.equal(standaloneCardShown(observed, liveVerdict), false,
    'the real observed marker must not render the standalone card');
  const lines = (buildWidgetLines(observed, null, NOW, undefined, undefined, { recoveryHasLiveOwner: liveVerdict }) ?? []).join('\n');
  assert.equal(/send 'continue' to retry this chat/.test(lines), false,
    'the exact complaint text must be gone');
});

test('the same real marker is retired, not merely hidden — display and retirement agree', async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `real-marker-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  seedState(cwd, {
    goal: null,
    list: [],
    mainModelRecovery: {
      kind: 'goal',
      owner: { kind: 'chat' },
      primary: 'minimax/MiniMax-M3.1-Flash',
      active: 'minimax/MiniMax-M3.1-Flash',
      attempted: ['minimax/MiniMax-M3.1-Flash'],
      firstFailureAt: '2026-10-31T01:39:23.410Z',
      counts: { steps: 0 },
    },
    flags: {},
  } as unknown as State);
  __testOnlyLoadState(cwd);
  assert.equal(clearStaleMainModelRecovery(ctx as never, 'test'), true,
    'the shared /glla-resume predicate retires the real observed marker');
  assert.equal(readState(cwd).mainModelRecovery ?? null, null, 'the marker is gone from persisted state');
});

test('a chat-owned marker WITH a live goal still renders — retirement is not blanket', async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `chat-live-goal-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  const liveGoal = seedGoal({ status: 'active', objective: 'Verify the feature' });
  const chatOwnedLive = { goal: liveGoal, list: [], mainModelRecovery: recovery('chat') } as unknown as State;
  seedState(cwd, chatOwnedLive);
  __testOnlyLoadState(cwd);
  assert.equal(mainModelRecoveryHasLiveOwner(), true,
    'with supervised work in flight the chat-owned marker still describes current work');
  // The STANDALONE card is correctly absent here for a different reason: there
  // is an objective, so the goal card owns the recovery and the "no GLLA
  // objective" wording would be false. What must hold is that the verdict stays
  // live, so retirement is not a blanket clear.
  assert.equal(standaloneCardShown(chatOwnedLive, true), false,
    'with a live objective the standalone banner must not claim there is none');
});

test('a terminal goal retires the main-model recovery marker durably', async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `stale-recovery-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  // The owner goal is TERMINAL, exactly as after an archive: the marker has
  // nothing left to act on.
  const terminalGoal = seedGoal({ status: 'complete', objective: 'Verify the feature' });
  seedState(cwd, {
    goal: terminalGoal,
    list: [],
    mainModelRecovery: recovery('goal', String(terminalGoal.id)),
  });
  __testOnlyLoadState(cwd);
  await tick(50);
  assert.ok(readState(cwd).mainModelRecovery, 'the seeded marker is live before retirement');

  // The production transition the settlement path now calls.
  const outcome = retireOrphanedMainModelRecovery(ctx as never, true);
  await tick(50);
  assert.equal(outcome, 'retired', 'a terminal goal retires the marker rather than retaining it');
  assert.equal(readState(cwd).mainModelRecovery, undefined,
    'the retirement is DURABLE — a stale marker on disk is the note.md bug');
});

test('a live owner retains its marker — retirement is not blanket-clearing', async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `retain-recovery-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  const liveGoal = seedGoal({ status: 'paused', pauseKind: 'wait', objective: 'Verify the feature' });
  seedState(cwd, {
    // A paused goal is still live work: the wall parked it, it did not finish.
    goal: liveGoal,
    list: [],
    mainModelRecovery: recovery('goal', String(liveGoal.id)),
  });
  __testOnlyLoadState(cwd);
  await tick(50);
  const before = readState(cwd).mainModelRecovery;
  assert.ok(before, 'the seeded marker is live');

  const outcome = retireOrphanedMainModelRecovery(ctx as never, true);
  await tick(50);
  assert.equal(outcome, 'retained', 'live work keeps its recovery marker');
  assert.ok(readState(cwd).mainModelRecovery, 'retention is durable, not just in memory');
});

/**
 * The guard above is only half: settlement must CLEAR the marker, and a test
 * that calls the retirement helper directly would still pass if the call site
 * inside settlement were deleted. This drives the real settlement function.
 */
test('the real settlement path retires the recovery marker when it archives', async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `settle-recovery-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  const settlingGoal = seedGoal({
    status: 'auditing',
    objective: 'Verify the feature',
    verificationContract: 'Inspect the behavior',
  });
  seedState(cwd, {
    goal: settlingGoal,
    list: [],
    mainModelRecovery: recovery('goal', String(settlingGoal.id)),
  });
  __testOnlyLoadState(cwd);
  await tick(50);
  assert.ok(readState(cwd).mainModelRecovery, 'the marker is live before settlement');

  // A minimal approved verdict so settlement has something real to archive.
  const claim = {
    at: new Date().toISOString(),
    attemptId: 'audit-settle-recovery',
    claimLineageId: 'claim-settle-recovery',
    completionSummary: 'Outcome: verified. Changed: behavior. Evidence: tests. Tests: pass. Unresolved: none. Next: none.',
    verificationSummary: 'Fixture only',
    phase: 'starting',
  } as never;
  // No try/catch escape hatch: settlement works against this harness (verified),
  // so an exception here is a real failure and must surface rather than quietly
  // turning this test into a no-op.
  const settled = settleApprovedCompletion(ctx as never, {
    goalId: String(settlingGoal.id),
    generation: 0,
    claim,
    model: 'test/auditor-model',
    origin: 'provider-retry',
  });
  await tick(150);
  assert.equal(settled, true, 'the fixture must actually reach the archive');
  assert.equal(readState(cwd).mainModelRecovery, undefined,
    'settlement must not leave a recovery marker for the archived goal');
  assert.equal(readState(cwd).goal, null, 'the goal really was archived');
});

/**
 * The test above passes the verdict in, so it does NOT exercise the predicate
 * that computes it. A control proved the gap: deleting the `chat` case from
 * mainModelRecoveryHasLiveOwner left every test green, because nothing drove the
 * real predicate for a chat-owned marker — and treating chat as dead would hide
 * a legitimate ordinary-chat recovery.
 *
 * This drives the REAL function for each ownership outcome.
 */
test('the live-owner predicate requires a supervised target for chat-owned markers', async () => {
  const { mainModelRecoveryHasLiveOwner } = await import('../extensions/goal-recovery.js');
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `owner-predicate-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);

  // chat-owned with NO supervised target: NOT live. This is the state
  // `/glla resume` already retires as "no supervised target", and the real
  // screenshot marker (owner:chat, kind:goal, goal:null, 7h42m old). Treating it
  // as live re-renders the exact note.md complaint.
  seedState(cwd, { goal: null, list: [], mainModelRecovery: recovery('chat') });
  __testOnlyLoadState(cwd);
  await tick(30);
  assert.equal(mainModelRecoveryHasLiveOwner(), false,
    'a chat-owned marker with no goal or loop has nothing to resume');

  // goal-owned but the goal is terminal: NOT live — this is the note.md bug.
  const terminal = seedGoal({ status: 'complete', objective: 'Verify the feature' });
  seedState(cwd, { goal: terminal, list: [], mainModelRecovery: recovery('goal', String(terminal.id)) });
  __testOnlyLoadState(cwd);
  await tick(30);
  assert.equal(mainModelRecoveryHasLiveOwner(), false,
    'a marker whose owning goal is terminal has nothing left to act on');

  // goal-owned and the goal is live: LIVE.
  const live = seedGoal({ status: 'paused', pauseKind: 'wait', objective: 'Verify the feature' });
  seedState(cwd, { goal: live, list: [], mainModelRecovery: recovery('goal', String(live.id)) });
  __testOnlyLoadState(cwd);
  await tick(30);
  assert.equal(mainModelRecoveryHasLiveOwner(), true,
    'a paused goal is still saved work and keeps its recovery marker');

  // no marker at all: NOT live.
  seedState(cwd, { goal: null, list: [] });
  __testOnlyLoadState(cwd);
  await tick(30);
  assert.equal(mainModelRecoveryHasLiveOwner(), false, 'no marker means nothing to show');
});
