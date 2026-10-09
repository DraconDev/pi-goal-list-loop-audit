import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMainModelFailure } from '../extensions/main-model-recovery.js';
import { compactFirstEligible, shouldRecoverContextPressure } from '../extensions/context-pressure-recovery.js';

const highUsage = { tokens: 265000, contextWindow: 272000 };
for (const raw of [
  '429: Upstream request failed: Rate limit exceeded. Please try again later.',
  '429: The Token Plan usage limit has been reached. Please upgrade your plan or buy credits.',
  '429: Token Plan rate limit reached: Upgrade your Token Plan or switch to pay-as-you-go API usage.',
]) {
  test(`provider quota bypasses compact-first even at high context: ${raw}`, () => {
    const failure = classifyMainModelFailure(raw);
    assert.ok(failure.quotaSignal);
    assert.equal(compactFirstEligible(failure), false);
    assert.equal(shouldRecoverContextPressure(failure, highUsage), false);
  });
}
test('explicit prompt overflow remains eligible even when tagged 429', () => {
  const failure = classifyMainModelFailure('429: maximum context length exceeded');
  assert.equal(compactFirstEligible(failure), true);
  assert.equal(shouldRecoverContextPressure(failure, highUsage), true);
});
test('generic high-context provider error still admits pressure recovery', () => {
  const failure = classifyMainModelFailure('An error occurred while processing your request.');
  assert.equal(compactFirstEligible(failure), true);
  assert.equal(shouldRecoverContextPressure(failure, highUsage), true);
});
