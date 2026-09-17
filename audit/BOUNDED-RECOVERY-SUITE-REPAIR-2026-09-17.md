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
