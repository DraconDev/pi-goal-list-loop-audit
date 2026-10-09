# Recovery/lifecycle repair — 2026-10-09

Status: implementation in progress; not a completion claim.

## Baseline and broader-suite failures

Bounded `timeout 900 npm test` baseline: 3142 pass, 1 environment-gated skip, 14 fail across 360 files (3157 tests). The three known context-pressure failures were part of a larger stale-fixture cluster following the operator-directed same-model retry policy introduced on 2026-10-08.

- `tests/context-pressure-recovery.test.ts`: three non-compaction scenarios assumed first-error fallback selection despite the default ten same-model retries. Each routing scenario now runs both explicit immediate-rotation and default retry-budget configurations. Immediate-rotation assertions remain; default-policy assertions additionally require a durable future retry deadline, recovery wait, retained objective, selected primary, and counter.
- `tests/unsupervised-error-retry.test.ts`: eight fallback-handoff cases depended on an implicit immediate rotation. Their helper now explicitly selects supported `mainModelSameModelRetries: 0`; original handoff/abort/duplicate/send-failure/exhaustion assertions remain. A new default-budget test verifies paced ordinary-chat retry retains the original request without premature rotation.
- `tests/hourly-quota-probe-runtime.mjs`: rejected model-selection injection was bypassed by the newly introduced same-model phase. The fixture now explicitly carries a spent budget; failed-probe cleanup, distinct timers, opt-out, stale generation and overlap assertions remain.
- `tests/glla-table-menu.test.ts`: exact expected rows omitted the newly introduced same-model-retry setting. The exact list now includes it.
- `tests/stall-handling.test.ts`: source assertion assumed attempt accounting and synchronous scheduling were adjacent inline. It now checks phase reset and attempt increment in the cycle-reset block, verifies invocation of the extracted surface-resume helper, and verifies that helper schedules both goal and loop owners.

Verification: `timeout 180 npm test -- tests/context-pressure-recovery.test.ts tests/unsupervised-error-retry.test.ts tests/hourly-quota-probe.test.ts tests/glla-table-menu.test.ts tests/stall-handling.test.ts` — 144 pass, 0 fail. This is a focused gate, not full `test:all` evidence.

## Evidence limitations

Several requested native image reads were stripped by the GLLA payload guard before delivery. Those stripped captures are not direct visual evidence; earlier chat descriptions of their pixels require independent confirmation. Images actually delivered in this continuation include 080151, 080333, 080347 and 094431. No application project has been modified or resumed.

## Confirmed supplied captures (implementation/disposition pending)

- `Screenshot_20261009_080151.png`: endless-td has an upstream 429 endpoint-unavailable error and compaction cancellation, then an explicit resumed-goal notice. The visible objective remains active at 41/43 tasks. This demonstrates saved work resuming, not objective loss. Provider outage is external; recovery scheduling/compaction containment is GLLA-owned.
- `Screenshot_20261009_080333.png`: hellhunter list item is paused at 18/21 with `context compaction failure: compact-first recovery exceeded its 120s budget` and manual `/list resume` guidance. Objective/progress remain visible. The timeout park is confirmed in `extensions/loops/goal-orchestrator.ts`; automatic handoff is still to implement.
- `Screenshot_20261009_080347.png`: Darklord publish is held on a real upload authorization decision. Provider 429/retry exhaustion is visible, but does not grant permission to upload a 446 MB build. This decision must remain authoritative; no model switch or recovery timer may treat it as upload consent.
- `Screenshot_20261009_094431.png`: terminal summary is excessively implementation/test-heavy and opens with a mid-flight commit incident rather than a user-facing outcome. This is a summary-quality report, not evidence of a recovery-lost objective. Rendering/content disposition remains to verify against the summary policy.
- `Screenshot_20261009_092908.png`: prior confirmed resume-guard report in `audit/RECOVERY-LIFECYCLE-RESUME-GUARD-2026-10-09.md` documents the adverb-qualified imperative classifier fix and preserved verification contract.

## Open contract work

Persistent paced recovery without elapsed-time give-up; compaction-timeout handoff; manual-switch resume scoped to recovery-only holds; terminal/orphan cleanup fenced against incomplete restore and persistence failure; ordinary-chat ownership; truthful counters/timer diagnostics; dedicated goal/list/loop lifecycle matrix; remaining capture inspection and symptom mapping; recovery/settings docs; full test/type/inventory gates; fresh-context reviewer rehearsal.
