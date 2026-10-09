# Recovery/lifecycle goal: resume guard false positive

## Evidence and cause

Operator screenshot `Screenshot_20261009_092908.png` shows the confirmed recovery objective repeatedly resumed then paused as `Suspicious objective detected (verification-fragment)`, with a synthetic repair task queued. The objective begins `Durably fix ...` and legitimately mentions its verification contract and test failures.

`extensions/faulty-objective-recovery.ts` recognized bare imperative verbs but not adverb-qualified imperatives. Consequently the report-vocabulary fallback treated the valid recovery objective as evaluator prose. This is a GLLA-owned dispatch-classifier bug, not provider unavailability or evidence that the objective was lost.

## Implemented

Recognize a bounded set of leading intent qualifiers (durably, safely, fully, comprehensively, systematically) before existing imperative verbs. Explicit evidence labels, reviewer narratives, verdict tags, and other fragment checks remain authoritative. No trust/provenance or dispatch shield is bypassed.

Added classifier positives/negative controls and an executable manual-resume regression verifying that a previously suspicious-paused recovery objective resumes with its objective/contract intact and no new repair item. This fixture does not yet cover removal of an already queued repair sidecar or hot-reloading the running extension.

## Verification

- `npm test -- tests/faulty-objective-recovery.test.ts tests/paused-suspicious-close.test.ts`: 44 pass, 0 fail.
- `npm run check`: pass.
- `node scripts/generate-inventory.mjs && npm run check:inventory`: pass after regenerating stale inventory.

## Remaining active scope

Persistent paced model recovery; compaction-timeout automatic handoff; manual-model-switch recovery-held continuation; terminal/orphan cleanup; truthful timers/attempts; cross-lifecycle regression coverage; three previously reported broader context-pressure test failures; full repository validation and documentation. This note is not a completion claim for that goal.
