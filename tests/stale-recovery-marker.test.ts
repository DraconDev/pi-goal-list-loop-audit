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
import { clearOwnedMainModelRecovery } from '../extensions/goal-recovery.js';
import { readState, type State } from '../extensions/goal-loop-core.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from './harness/mock-pi.js';

afterEach(() => {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
});

const NOW = Date.parse('2026-10-31T09:22:00Z');

function recovery(kind: 'goal' | 'loop' | 'chat' = 'goal'): unknown {
  return {
    kind,
    primary: 'openai-codex/gpt-6-luna',
    active: 'minimax/MiniMax-M3.1-Flash',
    firstFailureAt: '2026-10-31T01:40:00Z',
    lastFailureAt: '2026-10-31T01:40:00Z',
  };
}

/** The banner that made the complaint concrete. */
function standaloneCardShown(state: State): boolean {
  const lines = buildWidgetLines(state, null, NOW, undefined, undefined);
  return (lines ?? []).some((line) => /no GLLA objective/i.test(line));
}

test('a completed goal with a leftover recovery marker does NOT render the recovery card', () => {
  // The exact screenshot state: no goal at all, only a stale marker.
  const shipped = { goal: null, list: [], mainModelRecovery: recovery() } as unknown as State;
  assert.equal(standaloneCardShown(shipped), false,
    "the recovery card must not ask the user to retry a chat with nothing wrong; the banner is the note.md complaint");

  // And a goal that is present but terminal cannot own a marker either.
  const terminal = {
    goal: seedGoal({ status: 'complete' }),
    list: [],
    mainModelRecovery: recovery(),
  } as unknown as State;
  assert.equal(standaloneCardShown(terminal), false,
    'a terminal goal must not keep the recovery card alive');
});

test('a live recovery marker still renders its card — the guard is not blanket-hiding', () => {
  // A non-terminal goal that hit the main-model wall is a REAL recovery.
  const live = {
    goal: seedGoal({ status: 'paused', pauseKind: 'wait' }),
    list: [],
    mainModelRecovery: recovery(),
  } as unknown as State;
  const lines = buildWidgetLines(live, null, NOW, undefined, undefined);
  assert.ok(lines && lines.length > 0, 'a genuine recovery still paints a card');

  // A loop parked by the wall keeps its dedicated card.
  const loopOwned = {
    goal: null,
    list: [],
    loop: { active: false, target: 'improve latency', iteration: 3, startedAt: '2026-10-31T00:00:00Z' },
    mainModelRecovery: recovery('loop'),
  } as unknown as State;
  const loopLines = buildWidgetLines(loopOwned, null, NOW, undefined, undefined);
  assert.ok(loopLines && loopLines.length > 0, 'a parked loop still explains its recovery');
});

test('settling a terminal goal clears the main-model recovery marker', async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `stale-recovery-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  seedState(cwd, {
    goal: seedGoal({ status: 'paused', pauseKind: 'wait', objective: 'Verify the feature' }),
    list: [],
    mainModelRecovery: recovery(),
  });
  __testOnlyLoadState(cwd);
  await tick(50);
  assert.ok(readState(cwd).mainModelRecovery, 'the seeded marker is visible to the runtime before the clear');

  // The production clear used by the settlement path.
  clearOwnedMainModelRecovery();
  await tick(50);
  assert.equal(readState(cwd).mainModelRecovery, undefined,
    'a terminal goal must not leave a recovery marker in the durable state');

  // Reaching it through the real settle path is covered by the audit-settlement
  // suites; this pins the state transition itself.
});
