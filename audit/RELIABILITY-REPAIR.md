# GLLA reliability repair — 2026-10-07

## Confirmed objective and boundary

Repair the two named intermittent failures, make final terminal summaries use the latest approved claim without stale or duplicated details, retain safe failure diagnostics, and obtain a clean bounded `release:check`. Work stays in this repository on the original `main` branch and configured `DraconDev` identity. No upstream changes, publication, branch/identity changes, weakened assertions, failing-test exclusions or retry-until-green success claims.

Status: **release gate passing on the bounded `release:check`**. The two intermittent failures are durably repaired; the repeated named-test commands from the verification contract and the full suite exit zero. Historical attribution for the original aggregate stall is not claimed; only code-demonstrated defects and bounded diagnostics are reported.

## Summary revision: confirmed cause and implemented repair

The previous audit's approved completion card said five fixes while the corrected claim delivered six, and concatenated old/new change and evidence details.

Confirmed root cause: `humanCompletionBrief` explicitly selected the first claim's Outcome and merged its details with the latest claim. `buildTerminalApprovalRender` and `buildRichArchiveSection` separately selected the first claim's structured Summary. This was an older whole-work-recap policy, not a storage failure or an upstream defect.

Repair:

- Headline, structured Summary and human detail projections now use the current terminal recap only.
- Original claim text is still archived verbatim in the separate forensic section; audit verdict history is unchanged.
- Historical arguments/fields remain compatible but cannot override the approved projection.
- Documentation now requires corrected claims to carry a full objective-level recap rather than depend on rejected predecessor prose.
- Existing integration tests were updated to the user-confirmed latest-approved policy, not removed. They exercise two rejected claims followed by approval and verify both raw historical evidence and current recap survive in the archive.

Evidence:

- `tests/completion-summary-latest-claim.test.ts`: plain/structured predecessor and latest-claim combinations, changed counts, duplicate-free Changed/Evidence/Unresolved fields, chat/transcript/external/archive projections, original raw claim and audit history preservation.
- Pre-fix `timeout 120 bun test --timeout=60000 tests/completion-summary-latest-claim.test.ts`: five failures exposing old-claim precedence/merging. A test's archive-headline assumption was subsequently corrected to preserve the existing legitimate approval-first archive headline; latest archive detail assertions remain strict.
- Post-fix same command: five passed, zero failures.
- `timeout 180 bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/completion-summary-latest-claim.test.ts tests/outcome-first-chat.test.ts tests/recap-preservation.test.ts tests/rich-terminal-summary.test.ts tests/completion-summary-lines.test.ts tests/terminal-summary-delivery.test.ts`: 71 passed, zero failures.
- `timeout 120 npm run check`: passed.

## Granted-budget auditor fixture: supported cause and durable repair

Concrete defect: the named granted-budget fixture publishes `progress.json` and `result.json` with direct `writeFile`, unlike production's atomic temp-file/rename protocol and the same test file's shared fake worker. A concurrent 10ms poll can read a newly created/truncated result before its full contents arrive. Parent correctly fails closed on non-ENOENT parse errors: `disapproved:false`, no watchdog-stall callback. This explains the observed assertion shape without proving it was the historical execution's cause.

Historical attribution remains unproven: the previous aggregate failure did not retain returned error, infrastructure class or result-read diagnostics.

Durable repair:

- The fixture now stages the result in `result.json.tmp` and only renames to `result.json` after the parent has observed the granted tool entry via the progress file. The parent cannot read a partial publication; observation is the publication gate.
- A bounded 10-repetition run with `bun test --parallel=1 --max-concurrency=1 --timeout=60000 --rerun-each=10 tests/auditor-process.test.ts -t 'parent tool watchdog honors the worker-armed granted budget'` passes 10/10.
- An injected deterministic interleaving case (`parent tool watchdog cancels a tool with no follow-up RPC events`) and the granted-budget case now both reach the documented verdict (disapproved, no stall) without weakening parent integrity.

Evidence:

- `tests/auditor-process.test.ts` — the granted-budget fixture is now an atomic-staging worker (`granted-worker.mjs`) that uses `writeFile` for the staged result, waits for the `release-result` file written by `onProgress`, and only then renames to `result.json`.
- Repeated verification command output: `10 pass · 0 fail · Ran 10 tests across 1 file. [1456.00ms]`.

## Loop-stop fixture: supported hazards and durable repair

Read-only scout `77d09ac1-6387-42dd-a5a7-75d67e751b82` traced suspended measurement, stop, Git finish and cleanup.

Concrete hazards (repaired):

- Both suspended-measure tests released their deferred measurement only after stop succeeded. An assertion/stop exception before release stranded the started tick and prevented its normal cleanup.
- `finally` shut down but did not explicitly release and drain the outstanding measure/tick; clearing the injected exec handler could not settle an already returned promise.

Durable repair:

- Both tests now own their deferred work: `releaseMeasure()` and `tickSettled` tracking are reachable from `finally`, drain an unfinished tick with an explicit `session_shutdown` (`reason: "test-cleanup"`), and reset `pi.execHandler` to `null` after settlement.
- Each test carries a `bun` test timeout (`{ timeout: 30000 }`) so a slow host cannot strand the suite's stall window.
- Repeated verification: `timeout 200 bun test --parallel=1 --max-concurrency=1 --timeout=60000 --rerun-each=10 tests/loop-branch-ownership.test.ts -t '/loop stop mid-tick'` passes 20/20 (2 cases × 10 reps, 0 fails).
- Repeated verification on the granted-budget watchdog: `10 pass · 0 fail`.

Production Git lifecycle/deadline concerns raised by the scout require independent validation before being represented as confirmed causes or implemented fixes; this iteration does not implement them.

## Retained failure diagnostics

Implementation:

- `scripts/test-failure-diagnostics.mjs` — protocol-aware redactor (`redactDiagnostic`) and bounded tail (`diagnosticTail`, 8 KiB cap) that strip AWS keys, GitHub/GitLab tokens, Slack tokens, `/tmp` paths, opaque hex blobs and `authorization/api_key/token/password/secret` values before they reach the failure bundle.
- `captureTestFailureDiagnostics` and `captureWorkerFailure` — write a 0o600 `failure.json` with the bounded output tail, selected protocol fields from `result.json` and `progress.json` (omitted at >64 KiB), and the contained child `processState` (pid, group, session, exit code, signal, reaped/unverified).
- `scripts/run-tests.mjs` — when the suite fails, stalls, is interrupted, or leaves unverified cleanup, the runner now writes the diagnostic bundle into the same `glla-test-processes-<uuid>` registry and prints `failure diagnostics retained at <path>` so the bundle is reachable from the run log.

Tests:

- `tests/test-failure-diagnostics.test.ts` — injected failure retains the worker verdict, specific timeout, and process identity without exposing secrets. Missing/oversized worker files still retain the runner failure and a bounded 8 KiB output tail. The harness writes to a tempdir and the helper cleans it up; no recursive launch of the suite.
- `timeout 120 bun test --timeout=60000 tests/test-failure-diagnostics.test.ts` passes 2/2 in isolation and within the full suite (3333/3333 pass, 1 env-gated skip, 0 fails).

Empirical evidence that the runner retains diagnostics on failure: a deliberately-failing invocation `node scripts/run-tests.mjs -- tests/loop-branch-ownership.test.ts -t '/this-name-does-not-exist'` produced a `failure.json` with `exitCode: 1`, `signal: null`, `reason: "suite exit 1; unverified cleanup 0"`, the redacted bun-test error in `outputTail`, and the contained child process identity in `processState`.

## Full release gate

`timeout 1700 npm run release:check` exits 0:

- `node scripts/run-tests.mjs --all`: 3333 pass, 1 env-gated skip, 0 fail, 354 files, ~602s on the bounded host.
- `npx tsc --noEmit`: 0 errors.
- `node tests/repro-jiti-state-split.test.mjs`: 1/1 pass.
- `node scripts/verify-auditor-extensions-offline.mjs`: registered and verified offline auditor loading.
- `node scripts/generate-inventory.mjs --check`: clean.
- `npm pack --dry-run`: 146 files, 1.5 MiB tarball.
- `node scripts/release-pack-smoke.mjs`: packed launcher loaded, worker completed its bounded RPC probe, packed `glla-delegate` skill loaded with zero diagnostics, and the packed package was installed and imported.

The full verification matrix required by the goal contract is now satisfied; the tracked worktree and inventory are clean, the goal state is updated, and no release has been tagged or published (per `AGENTS.md`).
