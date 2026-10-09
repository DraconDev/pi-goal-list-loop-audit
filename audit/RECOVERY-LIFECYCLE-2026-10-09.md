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

## Final disposition map (recovery-card disappearance vs objective loss)

Card disappearance is never treated as objective loss: terminal `complete`/`aborted` archival clears the live slot only after the archive lands (`tests/recovery-terminal-runtime.test.ts`: terminal archive retains chat recovery, lands archive on disk); supervised recovery with terminal/absent/replaced owners retires immediately with both timers cancelled (`tests/recovery-owner-fences.test.ts`, `tests/recovery-ownership-runtime.test.ts`); ordinary-chat markers are explicit and never infer an objective (`tests/recovery-ownership.test.ts`: chat/legacy/restore-pending).

- `Screenshot_20261009_080151.png`: endless-td 429 + compaction cancellation + resumed-goal notice at 41/43 — GLLA-owned scheduling, objective retained. Fixed by paced compaction-timeout handoff. Evidence: `tests/recovery-lifecycle-regression.test.ts` goal compaction-timeout → probe → exactly-one-continuation → success retains id/objective/contract; `tests/context-pressure-recovery.test.ts` timeout handoff.
- `Screenshot_20261009_080333.png`: hellhunter list 18/21, 120s compact-first park with manual resume — GLLA-owned, now automatic. Objective/progress were always retained. Evidence: `tests/context-pressure-recovery.test.ts` list timeout hands off to paced recovery; `tests/recovery-lifecycle-regression.test.ts` list compaction-timeout success.
- `Screenshot_20261009_080347.png`: Darklord 446 MB publish held on upload authorization — legitimate decision/permission hold, external 429 does not grant consent. Evidence: `tests/recovery-lifecycle-regression.test.ts` protected decision/permission holds; `tests/recovery-owner-fences.test.ts` user-hold boundary; docs/RECOVERY.md protected-holds.
- `Screenshot_20261009_094431.png`: implementation-heavy terminal summary opening with a mid-flight commit — summary-quality report, not objective loss. No lifecycle state change; disposition is reporting hygiene, out of scope for recovery state. Archive/ledger retain the durable history.
- `Screenshot_20261009_092908.png`: adverb-qualified imperative resume guard — already fixed per `audit/RECOVERY-LIFECYCLE-RESUME-GUARD-2026-10-09.md`; contract preserved, no new change here.

- `Screenshot_20261009_080147.png`: saved contract resumes, then product-policy decision surfaces — legitimate decision hold. Recoverable outage never discards the contract; recovery never silently decides policy. Evidence: protected decision holds; application validator out of scope.
- `Screenshot_20261009_080149.png`: readiness/audit hold + 429 + compaction cancel — audit hold authoritative, provider errors external. Evidence: protected audit hold (`tests/recovery-lifecycle-regression.test.ts`); compaction handoff retains the contract. Screenshot alone never proves loss; durability is journal-proven.
- `Screenshot_20261009_080307.png`: drafting held by 120s compact-first deadline, scope visible — GLLA-owned, now automatic handoff retaining drafting + owner. Evidence: `tests/context-pressure-recovery.test.ts` timeout handoff; one-shot budget stays spent.
- `Screenshot_20261009_080312.png`: Token Plan quota + external `Retry failed after 15 attempts`, paused audit goal with objective/progress visible — provider/core exhaustion external; GLLA hold now paced without elapsed give-up. Evidence: `tests/quota-horizon-exemption.test.ts` persistent retries; compaction-handoff suite.
- `Screenshot_20261009_080318.png`: `Attempts: 0 · failing 5h 24m` + `no GLLA objective` — misleading display of a marker without objective, not objective loss. Fixed: **Recovery steps 0 · episode age 5h** + `not provider requests` + `does not prove continuous failure` + `retry scheduled (unconfirmed)` / stalled-timer diagnosis. Evidence: `tests/recovery-status-format.test.ts` zero-steps + saved-deadline-vs-live-timer; `tests/recovery-runtime-status.test.ts` armed-vs-absent timer; chat ownership tests.
- `Screenshot_20261009_080329.png`: hegemon `/saves` list item retains objective, 120s timeout park — GLLA-owned, now automatic. Application contrast findings out of scope. Evidence: list-mode timeout handoff tests.

## Ownership implementation checkpoint

`extensions/recovery-ownership.ts` distinguishes explicit chat ownership, goal identity, and loop identity, with a positive restore-completion gate. New episodes capture the owner in the durable recovery projection; sanitization retains only valid tags. Completed session restore now retires terminal/absent/replaced supervised markers and cancels recovery/hourly timers. Failed cleanup persistence restores the marker and holds dispatch instead of claiming a durable cleanup.

Coverage: `tests/recovery-ownership.test.ts` checks retained/terminal/replaced/held-loop/chat/legacy/restore-pending policy. `tests/recovery-ownership-runtime.test.ts` exercises completed restore and blank-start retention through actual activation handlers. Persistence-failure injection now also passes through the real retirement function: denied ledger/directory writes retain the saved marker, surface the error, and send no continuation (`tests/recovery-ownership-runtime.test.ts`: 7 pass, 0 fail). Immediate live terminal cleanup and stale-callback fences remain open; this checkpoint does not claim all lifecycle ownership work is implemented.

Bounded combined gate: nine files, 177 pass, 0 fail (`recovery-ownership`, ownership runtime, context pressure, unsupervised retry, hourly probe, table menu, stall handling, main recovery, restore-after-restart). `timeout 120 npm run check`, inventory regeneration and `timeout 30 npm run check:inventory` pass.

## Manual-selection checkpoint

Allowed manual `set`/`cycle` events now resume goal/list/loop work held solely by model recovery on the selected model, without replacing its objective, contract, telemetry or loop history. Restore/unknown/recovery events, nested forbidden-selection reverts, internal recovery rotations, forbidden models (including observe-only policy), audit claims, supervisor/load/user/decision/permission holds, and deterministic request refusals remain non-consent. Failed resume persistence restores the episode and prevents dispatch. Repeated selection does not duplicate continuation.

`timeout 120 npm test -- tests/recovery-lifecycle-regression.test.ts`: 27 pass, 0 fail, including actual goal/list/loop activation paths. Earlier combined model-switch/manual-failback gate: 44 pass, 0 fail before the final additional internal-rotation/persistence cases.

## Persistent recovery and truthful display checkpoint

Main-model recovery no longer stops at an elapsed-time horizon in either aggressive or conservative mode. Legacy expiry metadata is discarded during normalization. Retry cadence and reset hints remain intact; explicit manual holds and deterministic refusals still stop. Failed recovery-wait persistence restores state, leaves dispatch held and does not arm a timer. Explicit manual recovery resume likewise fails closed on storage failure. Long-lived legacy **already-manually-held** horizon records now rearm only after positive restore completion and resume consent, and only for the exact old elapsed-time stop wording. Goal/list/loop identity, episode age, counter, contract and history remain intact; generic manual, decision, audit, deterministic, supervisor/load and replaced-owner holds do not migrate.

The saved `attempts` counter counts recovery/backoff steps, not provider requests or Pi's internal retry attempts. Status now labels it **Recovery steps** and the anchor **episode age**, explicitly denying that age proves continuous failure. Zero steps over five hours no longer claims five hours of observed failed probes. Durable deadlines alone show execution as unconfirmed, including overdue deadlines. Actual runtime snapshots distinguish regular timers, hourly-only timers, in-flight selections, active/queued host turns, absent timers and supervisor/load/context/stale-extension/persistence holds. Goal/list/loop status commands and widgets receive those snapshots; no model success is inferred from selection. Narrow restore widgets retain the short `retry scheduled (unconfirmed)` next-action line.

`timeout 180 npm test -- tests/display.test.ts tests/retry-bounds.test.ts tests/recovery-runtime-status.test.ts tests/recovery-status-format.test.ts tests/quota-horizon-exemption.test.ts tests/uniform-provider-retry.test.ts tests/paused-status-action-first.test.ts tests/recovery-restore-after-restart.test.ts`: 166 pass, 0 fail. `npm run check` and regenerated `npm run check:inventory`: exit zero.

Broad gates were also run, not concealed: `/tmp/glla-recovery-fast-current.log` had 3206 pass, 1 skip, 3 stale wording/policy assertion failures; those assertions were updated to the stronger truthful-display/no-expiry contract. `/tmp/glla-recovery-fast-current2.log` had 3155 pass, 1 skip, 11 fail and 16 errors: three further stale wording assertions (now passing in the 166-test gate) plus eight Bun runtime initialization errors (`EEXIST: file already exists, epoll_ctl` in native WriteStream/util/colors/assert/proper-lockfile initialization, followed by registration-after-completion errors). This is not a passing full-suite claim; the full gate must be rerun. No runtime/provider/Pi files were modified to contain those runner errors.

## Compaction timeout and legacy-hold checkpoint

The confirmed 120s manual parks (080333, 080307, 080312, 080329) now use a paced automatic model-recovery handoff instead of a manual-resume error hold. The original provider diagnostic and saved goal/list/loop contract survive; the compaction one-shot budget remains spent. Owned compaction cancellation runs before the handoff, preventing a late cancellation from aborting newly resumed work. Late compactor success/error callbacks are consumed without duplicate dispatch. A persisted automatic recovery wait is required before timers may arm; storage failure retains fail-closed dispatch. Automated surface-resume transactions also fail closed when persistence fails.

The dedicated lifecycle suite now proves goal/list/loop compaction timeout → automatic probe → exactly one continuation → healthy work, retaining identity/objective/verification contract. Existing context-pressure tests additionally cover storage denial, unavailable/throwing compactors, no interruption of healthy tools, core-compaction adoption and late/replacement callbacks. Existing terminal-hold late-success tests still pass; the one-shot compaction budget is not reset by a late success.

`timeout 180 npm test -- tests/recovery-legacy-hold.test.ts tests/recovery-lifecycle-regression.test.ts tests/context-pressure-recovery.test.ts`: 75 pass, 0 fail, exit zero (`/tmp/glla-legacy-compaction-rerun.log`). The preceding identical invocation had 75 pass but wrapper exit one for one unverified cleanup record; `/tmp/glla-test-processes-uimxg9/failure.json` retains that evidence. No arbitrary process was killed and no cleanup gate was disabled. Earlier compaction/lifecycle/stall gate: 108 pass, zero failures, exit zero. Typecheck and inventory gates pass after the implementation.

## Terminal/orphan and late-callback checkpoint

`extensions/goal-recovery.ts:recoveryStillCurrent` + `recoveryOperationStillCurrent` fence every async resume/selection against terminal/replaced targets and new episodes; `probeMainModelRecovery` refuses load holds, degraded persistence, manual holds, non-current episodes, and pre-retires orphans. `extensions/loops/goal-orchestrator.ts:archiveCurrentGoal` clears only supervised goal recovery, never chat. Late accepted/rejected selections retire confirmed terminal/absent/replaced owners immediately and never dispatch or authorize successors (`tests/recovery-owner-fences.test.ts`: 3 surfaces × 5 boundaries × accept/reject). Explicit goal/list/loop cancellation removes its recovery and cancels both timers immediately; terminal archival lands the archive and retains unrelated chat recovery (`tests/recovery-terminal-runtime.test.ts`: 4 pass).

`timeout 180 npm test -- tests/recovery-terminal-runtime.test.ts tests/recovery-owner-fences.test.ts tests/recovery-ownership-runtime.test.ts tests/unsupervised-error-retry.test.ts`: 71 pass (1 pre-fix archive-slot expectation corrected to null-slot + on-disk archive; `/tmp/glla-terminal-chat-proof.log` retained). Combined ownership/lifecycle gate: `tests/recovery-terminal-runtime + recovery-owner-fences + recovery-ownership-runtime + recovery-ownership + recovery-lifecycle-regression + recovery-legacy-hold + recovery-runtime-status` — 88 pass, 0 fail. `npm run check` clean; inventory regenerated.

## Full validation (contract item 5/6)

`npm run test:all` EXIT=0: 3562 tests across 379 files, 3561+ pass shape (`(pass)` count 3561 in log plus final jiti bins), 0 fail, 1 environment-gated skip (`commit survives the auto-committer daemon`). Log: `/tmp/glla-testall-final.log` (563s). Path: two prior full runs bracketed the fix — 3560 pass/1 fail on the isolated-rig ownership fence (`tests/main-model-recovery.test.ts` runtime fallback walk), then a stall on flaky `tests/loop-branch-ownership.test.ts` mid-tick timing (passes alone in 2s, untouched by this work), then green. `npm run check` clean; inventory regenerated (`docs/RUNTIME-INVENTORY.md`). Note: the task-8 milestone verifier cannot execute the 10-minute gate inside its own timeout, so the task remains system-pending despite the green log; no test was excluded or weakened.

## Milestone-gate budget fix (v0.39.18, task 8 unblock)

`DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS` 600s → 1500s (`extensions/goal-loop-shield.ts`). The 10-minute ceiling repeated the v0.35.16 failure mode it was created to fix: this repo's honest gates outgrew it (`test:all` ≈ 563s over 379 files, `release:check` longer), so task 8's gate died INCONCLUSIVE-timeout on any slow host — a non-verdict that strands the objective. No suite timing was touched; the slowest single test is ≈18s (bulk is breadth, not a hang). Rails unchanged: per-command budget, process-group cap, 64MB output cap, tail-kept evidence, inconclusive-never-fails, 2× load-scale ceiling. Pinned by a new test in `tests/mechanical-inconclusive.test.ts` (13 pass, 0 fail); `npm run check` clean. One observed flake (not fixed here): a `loop-branch-ownership` mid-tick run once timed out at 30s and stalled its runner file under back-to-back full-suite load; passes alone in ~2s, untouched by this work.

## v0.39.21 goal: loop-branch stall flake (task 3)

The mid-tick test hit its 30s timeout under full-suite load and the aftermath stalled the runner file ~10min (7 dangling processes reaped at the stall kill). Mechanism: an unbounded `session_shutdown` drain in `finally` wedges on a dead tick, so one timed-out test holds the file open. Fix (test-harness only, no prod change): all 9 cleanup drains in `tests/loop-branch-ownership.test.ts` now race a 5s `drainShutdown` bound; pinned by a unit test (wedged drain resolves at the bound, healthy drains complete). File green across 4 consecutive runs (11 pass each).

## v0.39.21 audit round 2 (2026-10-09 ~21:30, disapproval repair)

Auditor HIGH items: (1) music journal still holds the stale record; (2) no /glla version 0.39.21 from stuck projects. Investigation:

- Full ref↔disk reconciliation of the installed pi-coding-agent 1.1.0 bundle: all 61 referenced hashed chunks exist on disk, zero missing. Install updated Oct 8 02:13, 7 min before the 02:20 failure — the UHF3DHNG/Y22YDKSW errors are stale in-memory code from the pre-update bundle referencing old chunk hashes, not a corrupt install. No host repair needed or performed.
- `pi -p` fires NO extension session lifecycle (successful MUSIC_OK run wrote zero journal entries): headless print mode cannot exercise restore by construction. Two earlier -p hangs were transient model-plane 429 storms, not a GLLA wedge (fresh-dir probe green between them).
- Retire mechanism needs no code change: `recoveryOwnership(undefined,'goal',{goal:null},true)` returns 'absent' (recovery-ownership.ts:38), `retireOrphanedMainModelRecovery` retires it, and the existing `absent-legacy` fixture in tests/recovery-ownership-runtime.test.ts pins exactly this shape through a real session_start (retired + ledgered + nothing resumed). What remains is a real session_start in the music tab (user reload), then a journal read.
- Stuck set now: only music holds a recovery record (fleet-wide scan).
- RESOLVED 21:10Z: user opened the music tab and invoked an explicit `glla_wipe` (`recovery:true`, `listCleared:0`); journal state now reads `mainModelRecovery:null` — no un-retried record. Chosen means differs from the restore-retire route (blank-startup barrier held, as predicted), but with no live goal/list/loop nothing was lost and the present-tense contract reads clean. Remaining: /glla version evidence from the stuck tabs. eve/dracon-utilities run live goals (not stuck — must not be disturbed); ai-auto-video and browser-extensions-shared show recent 429 traces with no held record. Version evidence needs user-tab reloads.

## v0.39.19 follow-ups (field 2026-10-09, post-approval)

Two user-reported glitches fixed after the goal archived:

1. **Terminal summary showed literal `###`/`####` headings** (screenshot 161600): the Pi TUI renders bold/lists but not `#` headings. Chat/terminal surfaces now use plain section labels (`What Changed`, `1. Area`, `Remaining`, …); the archived markdown keeps its headings. Token-extraction comma husks (`· , weight…`) are trimmed at the reason join. Pinned by new tests in `tests/rich-terminal-summary.test.ts`; ~15 chat-side pins updated across 7 test files (archive pins unchanged).
2. **Retry state made obvious**: the recovery-wait chip now reads `⏳ main-model recovery — automatic retry scheduled · attempt N · next probe HH:MMZ (in Xh Ym) · no action needed` (attempt count, absolute probe time, and the no-action fact are all durable state, not promises). Pinned in `tests/display.test.ts`. Note: the label already existed in 0.39.x — stuck projects still run installed 0.38.104, so this (like all 0.39.x behavior) goes live on publish + reinstall + session restart.

Validation: `npm run check` clean; targeted suites green (10 summary/display files: 198 pass; behavioral-orchestrator: 156 pass); inventory regenerated.

## v0.39.21 goal: ai-auto-music stale record (task 2)

Journal held a `main model unknown — Cannot find module '…/pi-coding-agent/dist/bundle/chunks/openai-responses-UHF3DHNG.js'` record (attempts 0, no retryAt, no owner, no goal; dormant since Oct 8). Root cause: transient corrupted pi-coding-agent install (chunk-hash mismatch), not a GLLA defect — and correctly un-retried (a missing module never heals on a timer; it needs reinstall). Verified 2026-10-09: installed pi-coding-agent is 1.1.0, no references to the missing chunk remain, and the bundle loads clean. No journal write performed (another project's live state); the orphan record retires via the normal restore path on next session start, which now loads 0.39.20.

## Open contract work

Fresh-context reviewer rehearsal (advisory, not in the verification contract).
