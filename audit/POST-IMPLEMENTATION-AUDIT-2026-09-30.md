# Post-implementation audit — 2026-09-30

The current v0.38.105 implementation has **three reproduced GLLA-owned defects: two HIGH and one MEDIUM**. Existing passing checks do not exercise these failure paths. This report records findings and acceptance criteria; it does not implement their repairs. Historical audit reports and implementation evidence remain unchanged.

## Baseline and scope

Audited checkout: `dad79faa` (full revision recorded in the verification evidence). The source manifest matches the successful September 30 release gate, digest `d12d84e1962cbdc9335531b35dbf1dec5e0861f0a26a9eb1d30f0f538925349c`. The previous gate reported 2,928 passing tests, one skip and zero failures, plus TypeScript, singleton, extension loading, inventory and installed-package smoke checks. This audit verifies that manifest against the current files rather than claiming a fresh full release run.

Fresh review concentrated on owner-file serialization, typed settlement and archive-to-outbox transfer, terminal receipt limits and replay, contained children, test registry and runner lifecycle, strict challenge dispatch/result handling, reliability metrics, canary integration, dependency status and audit-document consistency. It combines source review, 56 passing tests across 11 files, fresh compiler/inventory checks and independent adversarial probes. The probes call production helpers and the installed Pi extension runner; they make no provider request. Fixtures use temporary directories and an explicitly spawned child, which the probe subsequently kills and awaits.

This is a focused post-implementation audit, not exhaustive verification of every command, prompt, shield behavior or provider. Windows/macOS and paid live-host behavior were not rerun. Existing platform CI evidence remains historical. The permission-failure probes require Linux and a non-root user; run from the repository root after installing dependencies:

```sh
node audit/post-implementation-evidence-2026-09-30/boundary-probes.mjs
node audit/post-implementation-evidence-2026-09-30/outbox-probe.mjs
```

## PA-1 — HIGH: canary rejection does not prevent the provider request

**Owned locations:** `scripts/real-host-canary.mjs:38–41` and `scripts/canary-budget.mjs`. The generated extension relies on the budget guard throwing to reject unknown prices, excessive estimated spend, unsupported payloads and additional requests.

**Trigger and observed result:** The actual Pi 0.99.1 `ExtensionRunner.emitBeforeProviderRequest` catches handler exceptions, emits an extension error and returns the current payload. With the GLLA guard installed in that runner, each unknown-price, over-budget and second-request probe returns the original payload: `max_tokens: 4096` and one tool, despite recording the intended refusal. The guard's claim that no request is sent is not enforced by this hook.

The probe establishes that the rejected request remains eligible for dispatch; it deliberately stops before transport. A rejected second request also leaves the first receipt's `requests: 1` unchanged, so the harness's receipt check cannot independently establish that only one request occurred. This is a GLLA integration mistake, not a request to change Pi's documented hook behavior. The canary remains explicitly opt-in; this finding concerns its enabled spending/one-request guarantees.

**Repair:** Abort within the dedicated canary process through a mechanism that cannot be swallowed by the hook runner. A synchronous nonzero exit with a refusal receipt is one option for this disposable child; a transport-level refusal is another. Do not use an ordinary hook exception as the request barrier. Record actual request attempts and rejected attempts separately.

**Acceptance:** Test the generated extension through the real hook dispatcher and a local fake transport. Unknown price, excess estimated budget, unsupported caps, oversized input, second request and receipt-write failure must yield zero transport calls for the rejected attempt and a failing harness result. The permitted request must retain its cap and stripped tools. No paid call is necessary.

Evidence: [boundary probe](post-implementation-evidence-2026-09-30/boundary-probes.mjs), [observations](post-implementation-evidence-2026-09-30/boundary-probes.json). Primary host behavior inspected locally at `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:1060–1087`; no host files were changed.

## PA-2 — MEDIUM: a failed process registration produces false cleanup success

**Owned locations:** `scripts/test-process-registry.mjs:68–72`, `:91–114`; exit decision in `scripts/run-tests.mjs:176–186`.

**Trigger and observed result:** Create a valid registry, spawn an owned detached Node process, make the registry directory readable but unwritable, then register and reap. The record write fails silently. Reaping sees zero records and returns `{reaped: 0, unverified: 0}` while the child is still alive. The probe restores permissions and kills only its known spawned process group afterward.

The comment that the runner diagnoses missing records is incorrect: it diagnoses unreadable records that exist, but has no expectation against which to detect a record that never landed. The runner can therefore select a successful test exit despite an unfulfilled cleanup obligation. A missing/unreadable owner record similarly maps to a disabled registry. This is a GLLA test-harness accountability defect; permissions are the injected trigger, not an operating-system repair target.

**Repair:** Establish and acknowledge cleanup obligations before trusting a detached launch. Keep an independent expectation or failure channel so metadata-write failure is visible even when the registry itself cannot be written. If registration cannot be acknowledged, terminate the known child and fail the launch/test. An explicitly configured registry that becomes unreadable must fail the runner rather than look disabled. Preserve birth/group fencing; do not sweep unrelated processes by name.

**Acceptance:** Inject first-write and rename failures, loss of `owner.json`, and failed refreshes. A live owned child without acknowledged metadata must never accompany a zero cleanup-failure result or a green runner exit. Verify cleanup of the known fixture and preservation of unrelated processes. Existing successful-registration and reused-PID tests should continue to pass.

Evidence: [boundary observations](post-implementation-evidence-2026-09-30/boundary-probes.json), scenario `unwritable-registry`.

## PA-3 — HIGH: an unreadable outbox is overwritten as an empty queue

**Owned locations:** `extensions/approval-render-store.ts:43–48`, `:92–130`.

**Trigger and observed result:** Persist a pending render for `first`, make the outbox file unreadable, then persist `second`. The old read fails with `EACCES`; `readRenders` treats every read error as an empty queue. The directory still permits writing a temporary file and renaming it over the old file. Both persistence calls return true, but the resulting queue contains only `second`. The first undelivered obligation is lost.

This contradicts the durable outbox's promise that undelivered renders are never dropped. Archive intent protects transfer until persistence reports success; it does not restore an earlier obligation erased by a later enqueue after its intent has already been cleared. The probe proves queue loss, not a failure to retain the archived goal itself.

**Repair:** Distinguish a genuinely absent store (`ENOENT`) from an unreadable or invalid existing store. Refuse mutation and report persistence failure when the existing queue cannot be recovered. Preserve corrupt bytes for diagnosis/recovery instead of replacing them with an empty queue. Ensure archive finalization retains its current intent when the outbox cannot safely accept the new render.

**Acceptance:** Seed an existing pending render, inject `EACCES` or a transient read error, and assert that a second persist fails while the original bytes remain unchanged. Restore reads and retry; both obligations must then replay once. Exercise the same failure through archive finalization and verify the new goal's terminal intent remains available. Add malformed-store recovery coverage without silently erasing valid pending entries.

Evidence: [outbox probe](post-implementation-evidence-2026-09-30/outbox-probe.mjs), [observations](post-implementation-evidence-2026-09-30/outbox-probe.json). The current corrupt-store test explicitly expects zero replays; it does not check preservation/recovery of the prior obligation.

## External disposition and improvements

Fresh `npm audit --json` exits 1 with one high-severity dependency entry: Pi's bundled `brace-expansion` 5.0.9, aggregating three advisories. The exact report is retained in [dependencies.json](post-implementation-evidence-2026-09-30/dependencies.json). This remains upstream-owned under AGENTS.md; do not patch Pi's bundled files, alter unrelated plugins or claim that GLLA removed the remaining advisory. Track an upstream release and recheck compatibility when it becomes available. No exploitability claim is established by the dependency scanner alone.

The audit index simultaneously marked the implementation complete and said its full release gate remained pending. This audit corrects that stale index sentence and links this new report. The original dated reports and logs are preserved.

Prioritize PA-3 for normal-runtime summary durability, PA-1 before enabling a paid canary, and PA-2 for trustworthy release/test containment. Add integration and fault-injection checks at these boundaries: isolated helper assertions that a guard throws or a healthy file persists do not establish the caller's failure behavior. Strict challenge has both worker refusal and parent validation; this review found no additional reproduced defect there. Reliability measurements explicitly describe observed ledger events and whole-attempt elapsed time, so they should retain their current scope qualification.

## Verification and limitations

- Fresh focused run: 13 pass, zero failures across five files, 12 seconds. [Log](post-implementation-evidence-2026-09-30/focused-tests.log).
- Fresh expanded run: 43 pass, zero failures across six files, 58 seconds. [Log](post-implementation-evidence-2026-09-30/expanded-tests.log).
- Fresh TypeScript and inventory exit codes, audited revision, baseline evidence hash and current-source manifest comparison: [verification.json](post-implementation-evidence-2026-09-30/verification.json).
- Independent probes reproduce all three findings. Their JSON records are observations of defective behavior, not passing regression tests.
- The earlier complete release gate was not rerun during this audit. Its unchanged-source result is a baseline, not evidence that the new findings are closed.

Only audit documentation and evidence changed. No runtime source, package version, goal journal, upstream component, release tag or deployment was changed. Findings remain open for implementation.
