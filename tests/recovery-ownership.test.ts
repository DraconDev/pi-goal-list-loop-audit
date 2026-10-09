import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentRecoveryOwner, recoveryOwnership, sanitizeRecoveryOwner } from '../extensions/recovery-ownership.js';

const goal = { id: 'saved-goal', status: 'active' };
const loop = { startedAt: '2026-10-09T07:00:00.000Z', active: true };

for (const status of ['active', 'paused', 'auditing']) {
  test(`goal/list ownership retains ${status} work and fences replacements`, () => {
    const owner = currentRecoveryOwner({ goal: { ...goal, status } });
    assert.deepEqual(owner, { kind: 'goal', id: goal.id });
    assert.equal(recoveryOwnership(owner, 'goal', { goal: { ...goal, status } }, true), 'retained');
    assert.equal(recoveryOwnership(owner, 'goal', { goal: { id: 'successor', status } }, true), 'replaced');
  });
}
for (const status of ['complete', 'aborted']) {
  test(`terminal ${status} goal cannot retain supervised recovery`, () => {
    assert.equal(recoveryOwnership({ kind: 'goal', id: goal.id }, 'goal', { goal: { ...goal, status } }, true), 'terminal');
  });
}
for (const active of [true, false]) {
  test(`loop ownership retains ${active ? 'active' : 'held'} history and fences replacements`, () => {
    const owner = { kind: 'loop' as const, startedAt: loop.startedAt };
    assert.equal(recoveryOwnership(owner, 'loop', { loop: { ...loop, active } }, true), 'retained');
    assert.equal(recoveryOwnership(owner, 'loop', { loop: { ...loop, startedAt: '2026-10-09T08:00:00.000Z' } }, true), 'replaced');
    assert.equal(recoveryOwnership(owner, 'loop', {}, true), 'absent');
  });
}
test('incomplete restore never proves absence or terminal state', () => {
  for (const kind of ['goal', 'loop'] as const) {
    assert.equal(recoveryOwnership(undefined, kind, {}, false), 'restore-pending');
    assert.equal(recoveryOwnership(undefined, kind, {}, true), 'absent');
  }
  assert.equal(recoveryOwnership({ kind: 'goal', id: goal.id }, 'goal', { goal: { ...goal, status: 'complete' } }, false), 'restore-pending');
});
test('ordinary chat ownership is explicit and never inferred from a legacy orphan', () => {
  assert.deepEqual(currentRecoveryOwner({}), { kind: 'chat' });
  assert.equal(recoveryOwnership({ kind: 'chat' }, 'goal', {}, true), 'chat');
  assert.equal(recoveryOwnership(undefined, 'goal', {}, true), 'absent');
  assert.equal(recoveryOwnership(undefined, 'goal', { goal }, true), 'retained');
});
test('untrusted ownership tags cannot manufacture a target', () => {
  for (const raw of [null, [], { kind: 'goal' }, { kind: 'goal', id: '' }, { kind: 'loop', startedAt: 'invalid' }, { kind: 'arbitrary' }]) assert.equal(sanitizeRecoveryOwner(raw), undefined);
  for (const owner of [{ kind: 'goal', id: goal.id }, { kind: 'loop', startedAt: loop.startedAt }, { kind: 'chat' }]) assert.deepEqual(sanitizeRecoveryOwner(owner), owner);
});
