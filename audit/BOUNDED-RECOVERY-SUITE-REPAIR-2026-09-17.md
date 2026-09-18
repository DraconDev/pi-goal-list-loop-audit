# Bounded-recovery canonical gate repair — 2026-09-17

## Live objection

The 21:33 auditor run (`/var/tmp/union-audit-release-check.log`) failed seven tests: sampled telemetry, post-accept retry dispatch, and five behavioral-orchestrator cases. Prior green runs remain historical evidence, not proof this failure did not happen. The auditor accepted the bounded recovery and dotted-chain behavior; this repair changes test fixtures only.

## Findings and repairs

- `tests/auditor-process.test.ts`: the earlier claimed 600ms thinking delay was NOT implemented—only a comment had been inserted while the original sleep was removed. Previous completion prose claiming otherwise was inaccurate. The corrected fixture uses bounded acknowledgement files written only by the actual parent `onProgress` callback. The fake producer holds thinking/tool/report phases until observed. All phase/order/tool-trail assertions remain; no claim of lossless production event delivery is made.
- `tests/post-accept-hang-retry.test.ts`: the retry ledger entry is emitted before a second timer sends the continuation. The fixed 300ms sleep could observe between the two timers. The fixture now waits boundedly for the actual send, then retains the exactly-once assertion. A 600ms existing settle-window input deterministically exercises that separation. Counterfactual original-wait copy fails `0 !== 1`; corrected fixture passes under the same delay.
- `tests/behavioral-orchestrator.test.ts`: provider-wall fixture runner timeout was 15s, while its internal detached wait allowed 30s. Runner now allows 60s for startup, the unchanged inner bound, and cleanup. Shutdown moved into `finally` before restoring the fake binary. The other four auditor-reported cases passed unchanged in the fresh canonical baseline and the isolated three-file run; no deterministic production defect was established. Their short test durations alongside stale waitUntil errors in the auditor log are consistent with earlier abandoned asynchronous work, but that attribution is not independently proven.
- A subsequent full gate exposed another sampled fixture failure: a heartbeat older than 500ms was correctly classified as no session activity, not fresh heartbeats without progress. The heartbeat fixture now publishes serialized atomic snapshots and uses the existing injected runtime clock tied to observed worker heartbeats to isolate the fresh-heartbeat branch. Real spawn, parent polling, watchdog, SIGTERM and cleanup remain exercised; freshness/error/once-only assertions are unchanged. This is not a real-wall-clock latency test.

## Evidence inventory

| Run | Result | Log |
| --- | --- | --- |
| Fresh canonical baseline | 2299 pass, 1 fail, 2 skip; post-accept race reproduced | `/var/tmp/glla-2133-baseline.log` |
| Original fixed-wait counterfactual with delayed send | Expected failure: 0 sends versus 1 required | `/var/tmp/glla-post-accept-red.log` |
| Corrected post-accept file | 10 pass, 0 fail | `/var/tmp/glla-post-accept-green.log` |
| Canonical-flags single post-accept test | 1 pass, 0 fail | `/var/tmp/glla-post-accept-serial-proof.log` |
| Three files WITHOUT canonical isolation flags | 147 pass, 45 fail; invalid substitute for canonical gate, retained honestly | `/var/tmp/glla-2133-three-files.log` |
| Same three files WITH canonical isolation flags | 192 pass, 0 fail | `/var/tmp/glla-2133-three-files-serial.log` |
| First repaired canonical gate | 2299 pass, 1 fail, 2 skip; stale heartbeat fixture | `/var/tmp/glla-2133-repaired-gate.log` |
| Corrected heartbeat/process file | 36 pass, 0 fail | `/var/tmp/glla-heartbeat-clock.log` |
| Final canonical release gate | **2300 pass, 0 fail, 2 skip; exit 0** | `/var/tmp/glla-2133-final-gate.log` |

Final command: `TMPDIR=/var/tmp timeout 1800 npm run release:check`.
Includes TypeScript, jiti state-split check, offline auditor extension verification, package dry-run and installed-tarball import smoke. Test stage: 2302 tests across 229 files, 845.90s. Package is still 0.38.62; this is validation, not a new publication.

Two pre-existing environment-gated skips: real AgentManager child stop through root RPC; watched-repo auto-committer survival. No new skips. `git diff --check` passed. Test edits committed by the daemon, including `d2c404a3`, `4524f2f1`, `9702a52f`, `2db8d712`. No production code, model settings, history rewriting or owner note changes in this repair.

## Addendum — 22:39 audit: initial `complete_goal` path (2026-09-18)

The auditor accepted the suite repairs but showed the bounded-recovery fixes
in `goal-auditor-hooks.ts` were missing from the initial `complete_goal`
path in `goal-tools.ts`: aggressive exhaustion dropped `retryUntil`, passed
raw thinking levels to every candidate, and discarded the chain at cursor
clearing — while `tests/behavioral-orchestrator.test.ts` pinned the old
"without a horizon" behavior. All three findings were valid; fixed inline
in `281d09e0` (import `resolveAuditorThinkingLevel`, per-candidate
`auditor_thinking_selected` ledger + `effectiveThinking` worker request,
`exhaustedChain` captured before clearing with full cursor reset,
`retryUntil: plan.autoRetryUntil` in all modes, chain notice in capped and
retry-wait parked reasons, explicit `"provider-retry"` timer origin) with
the contradictory test rewritten as `bounded recovery: initial aggressive
completion preserves its horizon and exhausted chain` (`b1c8cc0a`,
`d7f0e4f6`): unsupported `max` observably falls back to `high` in real
worker argv, the real claim keeps its 24h deadline + chain, and a
post-deadline automatic dispatch launches nothing with counters untouched.

The next canonical gate then failed 6 tests (`/var/tmp/glla-initial-completion-gate.log`,
2294 pass / 6 fail): five were source-shape pins asserting the superseded
initial-path text, updated to the auditor-required contract —
`tests/model-picker.test.ts` (initial path now resolves `effectiveThinking`
per candidate), `tests/retry-bounds.test.ts` E2 + `tests/pause-informativeness.test.ts`
(capped stop carries `${exhaustedNotice}`), `tests/retry-bounds.test.ts`
v0.28.26 (timer origin explicit `"provider-retry"`, scoped to the
initial-completion file), `tests/uniform-provider-retry.test.ts`
(retry-wait reason carries `${exhaustedNotice}`). The sixth
(`auditor-process.test.ts:750`, 4 of 7 byte counts observed) was a
sampled-poll flake: the fixed 500ms sleep still let the parent overwrite
snapshots before observing them. Replaced with a bounded parent-observed
ack handshake (producer advances only after `onProgress` acknowledges each
cumulative length; 20s per-fragment bound so a real stall fails instead of
hanging) plus per-value containment assertions — strictly stronger and
faster (0.7s vs 4.8s). No behavioral assertion weakened anywhere.

Final gate `/var/tmp/glla-initial-completion-gate2.log`: **2300 pass,
0 fail, 2 env-gated skips; exit 0** (2302 tests, 229 files, 457.61s,
typecheck + jiti + offline auditor check + pack + installed-tarball smoke).
`git diff --check` clean. Test edits daemon-committed as `afaea15f`.
Diff artifact for the dead-reviewer handoff: `/var/tmp/glla-initial-repair.diff`.

A relaunched fresh-context reviewer (explicit session model after the
first run died on retired union-alpha) returned **merge verdict OK,
BLOCKERS: none**, verifying per-area attribution from the diff artifact:
fixed horizon in all modes, per-candidate thinking in real worker argv,
chain capture/preserve/display, real-claim post-deadline no-dispatch, the
five shape pins matching production text, and the bounded handshake.
Its one actionable P2 — a stale comment in `goal-auditor-hooks.ts`
claiming aggressive mode retries "until a state-based stop" while the code
persists the fixed horizon — was fixed to the shared wording; final gate
`/var/tmp/glla-initial-completion-gate3.log`: **2300 pass, 0 fail,
2 env-gated skips; exit 0** (859.20s), `git diff --check` clean.
Remaining P2s are doc-only notes (dead `aggressive` param on
`auditorRetryPlan`, dual-horizon wording on the separate timeout one-shot
branch), disclosed not hidden.
