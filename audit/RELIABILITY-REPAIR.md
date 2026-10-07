# GLLA reliability repair — 2026-10-07

## Confirmed objective and boundary

Repair the two named intermittent failures, make final terminal summaries use the latest approved claim without stale or duplicated details, retain safe failure diagnostics, and obtain a clean bounded `release:check`. Work stays in this repository on the original `main` branch and configured `DraconDev` identity. No upstream changes, publication, branch/identity changes, weakened assertions, failing-test exclusions or retry-until-green success claims.

Status: **implementation in progress**. This document does not claim the full goal or release gate has passed.

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

## Granted-budget auditor fixture: supported cause, repair pending

Read-only scout `ac586f82-6ffc-473c-b5a3-91e237728b3f` traced the parent protocol and fixture in parallel with the loop scout (workflow `89deea17-6881-4680-aaf4-09f759ee1946`; both completed).

Concrete defect: the named granted-budget fixture publishes `progress.json` and `result.json` with direct `writeFile`, unlike production's atomic temp-file/rename protocol and the same test file's shared fake worker. A concurrent 10ms poll can read a newly created/truncated result before its full contents arrive. Parent correctly fails closed on non-ENOENT parse errors: `disapproved:false`, no watchdog-stall callback. This explains the observed assertion shape without proving it was the historical execution's cause.

Historical attribution remains unproven: the previous aggregate failure did not retain returned error, infrastructure class or result-read diagnostics. Longer pre-write sleeps cannot remove the publication window. Planned durable repair is shared atomic fixture publication plus deterministic interleaving coverage and retained failure evidence, not relaxed parent integrity checks.

## Loop-stop fixture: supported hazards, repair pending

Read-only scout `77d09ac1-6387-42dd-a5a7-75d67e751b82` traced suspended measurement, stop, Git finish and cleanup.

Concrete hazards:

- Both suspended-measure tests release their deferred measurement only after stop succeeds. An assertion/stop exception before release strands the started tick and prevents its normal cleanup.
- `finally` shuts down but does not explicitly release and drain the outstanding measure/tick; clearing the injected exec handler cannot settle an already returned promise.
- Both synchronous Git fixture helpers are unbounded, so a blocked child also blocks JavaScript deadline/cleanup execution.

These hazards are code-visible, but the historical aggregate timeout's blocked command/phase was not captured. Planned repair: explicit entry handshake, exception-safe gate release and bounded work drainage, bounded Git adapters, deterministic fault injection and phase/process diagnostics. Do not make stop wait on unresolved measurement; that would deadlock the intentionally tested ordering.

Production Git lifecycle/deadline concerns raised by the scout require independent validation before being represented as confirmed causes or implemented fixes.

## Remaining verification

Atomic publication repair, loop-stop repair, safe retained diagnostics, repeated named tests, inventory refresh and the full bounded release gate remain pending. No intermittent failure is claimed historically diagnosed merely because an isolated rerun passed.
