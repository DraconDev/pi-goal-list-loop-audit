# Recovery/lifecycle repair — 2026-10-09

Status: implementation in progress; not a completion claim.

## Baseline and broader-suite failures

Bounded `timeout 900 npm test` baseline: 3142 pass, 1 environment-gated skip, 14 fail across 360 files (3157 tests). The three known context-pressure failures were part of a larger stale-fixture cluster following the operator-directed same-model retry policy introduced on 2026-10-08.

- `tests/context-pressure-recovery.test.ts`: three non-compaction scenarios assumed first-error fallback selection despite the default ten same-model retries. Each routing scenario now runs both explicit immediate-rotation and default retry-budget configurations. Immediate-rotation assertions remain; default-policy assertions additionally require a durable future retry deadline, recovery wait, retained objective, selected primary, and counter.
- `tests/unsupervised-error-retry.test.ts`: eight fallback-handoff cases depended on an implicit immediate rotation. Their helper now explicitly selects supported `mainModelSameModelRetries: 0`; original handoff/abort/duplicate/send-failure/exhaustion assertions remain. A new default-budget test verifies paced ordinary-chat retry retains the original request without premature rotation.
- `tests/hourly-quota-probe-runtime.mjs`: rejected model-selection injection was bypassed by the newly introduced same-model phase. The fixture now explicitly carries a spent budget; failed-probe cleanup, distinct timers, opt-out, stale generation and overlap assertions remain.
- `tests/glla-table-menu.test.ts`: exact expected rows omitted the newly introduced same-model-retry setting. The exact list now includes it.
- `tests/stall-handling.test.ts`: source assertion assumed attempt accounting and synchronous scheduling were adjacent inline. It now checks phase reset and attempt increment in the cycle-reset block, verifies invocation of the extracted surface-resume helper, and verifies that helper schedules both goal and loop owners.

Verification: `timeout 180 npm test -- tests/context-pressure-recovery.test.ts tests/unsupervised-error-retry.test.ts tests/hourly-quota-probe.test.ts tests/glla-table-menu.test.ts tests/stall-handling.test.ts` — 144 pass, 0 fail.

A subsequent `timeout 1200 npm run test:all` ran 3488 tests across 374 files: 3485 pass, 1 environment-gated skip, 2 fail. Both remaining failures were slow `tests/behavioral-orchestrator.test.ts` fixtures asserting immediate generic fallback despite the default retry budget. They now explicitly configure the immediate-rotation policy while retaining their exact failover assertions. Focused `timeout 120 npm test -- tests/behavioral-orchestrator.test.ts --test-name-pattern 'generic fallback chain'` — 2 pass, 0 fail, 154 intentionally filtered by that focused command. Full `test:all` must still be rerun after the lifecycle implementation.

## Evidence limitations

Initial full-resolution image reads were stripped by the GLLA payload guard. Native inspection was retried using local Pillow-resized JPEG captures (no external vision provider, model switch, or upload). Reduced captures subsequently delivered include 080147, 080149, 080307, 080312, 080318, 080329 and 092908; original delivered captures include 080151, 080333, 080347 and 094431. The reduced images are sufficient for the recovery cards but not every small transcript detail. No application project has been modified or resumed.

## Confirmed supplied captures (implementation/disposition pending)

- `Screenshot_20261009_080151.png`: endless-td has an upstream 429 endpoint-unavailable error and compaction cancellation, then an explicit resumed-goal notice. The visible objective remains active at 41/43 tasks. This demonstrates saved work resuming, not objective loss. Provider outage is external; recovery scheduling/compaction containment is GLLA-owned.
- `Screenshot_20261009_080333.png`: hellhunter list item is paused at 18/21 with `context compaction failure: compact-first recovery exceeded its 120s budget` and manual `/list resume` guidance. Objective/progress remain visible. The timeout park is confirmed in `extensions/loops/goal-orchestrator.ts`; automatic handoff is still to implement.
- `Screenshot_20261009_080347.png`: Darklord publish is held on a real upload authorization decision. Provider 429/retry exhaustion is visible, but does not grant permission to upload a 446 MB build. This decision must remain authoritative; no model switch or recovery timer may treat it as upload consent.
- `Screenshot_20261009_094431.png`: terminal summary is excessively implementation/test-heavy and opens with a mid-flight commit incident rather than a user-facing outcome. This is a summary-quality report, not evidence of a recovery-lost objective. Rendering/content disposition remains to verify against the summary policy.
- `Screenshot_20261009_092908.png`: prior confirmed resume-guard report in `audit/RECOVERY-LIFECYCLE-RESUME-GUARD-2026-10-09.md` documents the adverb-qualified imperative classifier fix and preserved verification contract.

- `Screenshot_20261009_080147.png`: application project resumes its saved contract and then surfaces an unresolved product-policy decision. A recoverable provider outage must not discard that contract; a genuine product-policy choice must not be silently decided by model recovery. The underlying application's validator is not a GLLA implementation target.
- `Screenshot_20261009_080149.png`: application project readiness/audit hold coexists with upstream endpoint-unavailable 429 errors and compaction cancellation. The screenshot alone cannot establish objective loss; journal confirmation remains pending.
- `Screenshot_20261009_080307.png`: project drafting is held by the same compact-first 120s deadline; pending intended scope remains visible. This is not a completed project nor evidence its scope was deleted. Containment must retain the drafting state as well as any underlying goal/loop owner.
- `Screenshot_20261009_080312.png`: upstream Token Plan quota errors culminate in `Retry failed after 15 attempts`, and a paused project-audit goal still displays its objective, audit progress, and compaction-timeout hold. The provider/core retry exhaustion message is external; GLLA's ensuing scheduling/hold behavior is owned here.
- `Screenshot_20261009_080318.png`: standalone main-model recovery card says `Attempts: 0 · failing 5h 24m` and explicitly `no GLLA objective`. This is evidence of a recovery marker without a visible objective, not proof the objective was lost. The display uses durable episode counters/anchor timestamps; timers and underlying journals still require confirmation.
- `Screenshot_20261009_080329.png`: hegemon `/saves` follow-up list item retains its objective and pauses on the compact-first 120s timeout with `/list resume` guidance. Underlying contrast findings belong to the application project; only saved-work recovery is in scope.

## Ownership implementation checkpoint

`extensions/recovery-ownership.ts` distinguishes explicit chat ownership, goal identity, and loop identity, with a positive restore-completion gate. New episodes capture the owner in the durable recovery projection; sanitization retains only valid tags. Completed session restore now retires terminal/absent/replaced supervised markers and cancels recovery/hourly timers. Failed cleanup persistence restores the marker and holds dispatch instead of claiming a durable cleanup.

Coverage: `tests/recovery-ownership.test.ts` checks retained/terminal/replaced/held-loop/chat/legacy/restore-pending policy. `tests/recovery-ownership-runtime.test.ts` exercises completed restore and blank-start retention through actual activation handlers. Immediate live terminal cleanup, persistence-failure injection, and stale-callback fences remain open; this checkpoint does not claim all lifecycle ownership work is implemented.

Bounded combined gate: nine files, 177 pass, 0 fail (`recovery-ownership`, ownership runtime, context pressure, unsupervised retry, hourly probe, table menu, stall handling, main recovery, restore-after-restart). `timeout 120 npm run check`, inventory regeneration and `timeout 30 npm run check:inventory` pass.

## Open contract work

Persistent paced recovery without elapsed-time give-up; compaction-timeout handoff; manual-switch resume scoped to recovery-only holds; terminal/orphan cleanup fenced against incomplete restore and persistence failure; ordinary-chat ownership; truthful counters/timer diagnostics; dedicated goal/list/loop lifecycle matrix; remaining capture inspection and symptom mapping; recovery/settings docs; full test/type/inventory gates; fresh-context reviewer rehearsal.
