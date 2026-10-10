import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRichTerminalParts, composeRichTerminalLines, partitionRichDetails } from '../extensions/completion-summary.js';

function render(details: string[], chat = true) {
  return composeRichTerminalLines(buildRichTerminalParts({ outcome: 'Readable summaries', countsLine: '', details, chat })).join('\n');
}
test('chat removes repeated Remaining narration but retains the distinct next action and archive text', () => {
  const details = ['Left out: The narrow-window check is not wired into smoke.',
    'Unresolved: Provider results are still unknown.',
    'Next: The narrow-window check is not wired into smoke. Wire the 390px case into the browser gate.'];
  const chat = render(details), archive = render(details, false);
  assert.equal(chat.split('The narrow-window check is not wired into smoke.').length - 1, 1);
  assert.ok(chat.includes('Wire the 390px case into the browser gate.'));
  assert.ok(chat.includes('Provider results are still unknown.'));
  assert.ok(chat.includes('**Left out**'), 'deliberate omission stays distinct from risk');
  for (const detail of details) assert.ok(archive.includes(detail.split(': ')[1]!), 'archive retains all original clauses');
});
test('exact redundant next sentence adds no second copy; differing qualifiers stay intact', () => {
  const duplicate = ['Unresolved: Provider results are unknown.', 'Next: Provider results are unknown.'];
  assert.equal(render(duplicate).split('Provider results are unknown.').length - 1, 1);
  const distinct = ['Unresolved: The narrow-window check is not wired into smoke.',
    'Next: The narrow-window check is not wired into CI. Run the standalone probe.'];
  for (const detail of distinct) assert.ok(render(distinct).includes(detail.split(': ')[1]!));
});
test('case-sensitive evidence is never treated as a verbatim repetition', () => {
  const details = ['Unresolved: Endpoint ABC is unavailable.', 'Next: Endpoint abc is unavailable. Inspect endpoint abc.'];
  const chat = render(details);
  assert.ok(chat.includes('Endpoint ABC is unavailable.'));
  assert.ok(chat.includes('Endpoint abc is unavailable.'));
  assert.ok(chat.includes('Inspect endpoint abc.'));
});

test('similar same-label heads cannot erase distinct trailing facts or negations', () => {
  const details = ['Unresolved: The provider test needs a runtime check before deployment. Credentials are missing.',
    'Unresolved: The provider test needs a runtime check before deployment. The network is offline.',
    'Next: Enable the provider test after deployment.', 'Next: Do not enable the provider test after deployment.'];
  assert.deepEqual(partitionRichDetails(details).next, details);
});
test('plain finding prose and bold area hierarchy preserve complete claims and archive styling', () => {
  const finding = 'The narrow-window layout stays readable without document overflow';
  const chat = composeRichTerminalLines(buildRichTerminalParts({ outcome: 'Readable', countsLine: '', chat: true,
    details: [], groups: [{ title: 'Layout', findings: [finding + ' — browser probe at 390px'] }] })).join('\n');
  assert.ok(chat.includes('**1. Layout**'));
  assert.ok(chat.includes('- ' + finding));
  assert.ok(!chat.includes('**' + finding + '**'));
  const flat = render(['Changed: ' + finding]);
  assert.ok(flat.includes('1. ' + finding));
  assert.ok(!flat.includes('**' + finding + '**'));
  assert.ok(render(['Changed: ' + finding], false).includes('**' + finding + '**'));
  assert.doesNotMatch(chat + flat, /\x1b/);
});
