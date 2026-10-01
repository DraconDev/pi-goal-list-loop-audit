# Audit actionables implementation — 2026-10-01

This implements all three GLLA-owned findings from the immutable
[post-implementation audit](POST-IMPLEMENTATION-AUDIT-2026-09-30.md).
The package remains v0.38.105. No release tag, publication or paid provider
request is part of this change. Pi, the operating system and other plugins
were not modified. The sync daemon owns the source and evidence commits.

## Repairs and completion criteria

| Finding | Implemented behavior | Authoritative regression coverage |
|---|---|---|
| PA-3: pending-summary loss | Only `ENOENT` means an empty queue. Other read errors, malformed JSON and partially invalid arrays refuse enqueue/replay and preserve original bytes. Archive intent remains pending until the existing queue can safely accept the new summary. | `terminal-approval-render.test.ts` verifies unreadable-file byte preservation, retry, two summaries delivered once, partially invalid data preservation and explicit recovery. `settlement-boundary-faults.test.ts` exercises unreadable old queue through actual settlement/finalization and proves new intent retention. |
| PA-1: canary rejection | The generated request hook catches guard and receipt-write errors and synchronously exits its disposable child with code 78. It records attempts, permitted requests and refusals separately. Parent success requires a zero exit, exactly one permitted/attempted request, no refusal and the expected reply. Private Pi settings disable agent/provider retries, compaction and cache warming. | `real-host-canary.test.ts` runs the generated hook through the installed Pi 0.99.1 extension dispatcher followed by a local fake transport. Unknown prices, excessive estimates, unsupported caps, oversized payload, a second request and receipt-write failure exit before the rejected dispatch. Accepted payload has cap 32 and no tools. Parent harness pass/fail is checked with the local dispatcher fixture. Actual Pi SettingsManager and provider retry helper verify zero provider retries and disabled background work. |
| PA-2: false cleanup success | A sibling obligation record precedes the primary process record. Refusals are retained in either writable channel and in launcher memory, kill the known child/group with birth fencing, and propagate an error. The reaper diagnoses missing records, explicit failures and unreadable configured owners; it can recover a missing primary record from its independent captured anchor. Runner failures retain evidence; successful cleanup removes both directories. | `process-registration-faults.test.ts` covers first write, rename, initial/later owner loss, refresh, missing primary record, obligation-write failure and obligation-owner loss. Each checks nonzero cleanup failure accounting, stopped owned child and a surviving unrelated child. `test-runner-lifecycle.test.ts` proves the parent returns 1 even when a fixture swallows either channel's registration refusal and exits 0, and retains existing normal/signal/reused-PID checks. |

Relevant implementations are `extensions/approval-render-store.ts`,
`scripts/canary-extension.mjs`, `scripts/real-host-canary.mjs`,
`scripts/test-process-registry.mjs` and `scripts/run-tests.mjs`.
Operator documentation describes preserved outbox recovery, canary refusal
exit semantics and independent registry obligations. The generated inventory
includes the new helper and test file.

## Verification register

- Focused corrected run: **41 pass, zero fail** across five files,
  [focused-node.log](actionables-evidence-2026-10-01/focused-node.log).
- Expanded canary dispatcher plus parent harness: **9 pass, zero fail**,
  [canary-final.log](actionables-evidence-2026-10-01/canary-final.log).
- Final registry tests including both parent refusal paths: **19 pass, zero
  fail** across two files,
  [registry-verified.log](actionables-evidence-2026-10-01/registry-verified.log).
- Updated legacy outbox and retention checks: **35 pass, zero fail** across
  three files, [outbox-legacy.log](actionables-evidence-2026-10-01/outbox-legacy.log).
- The initial TypeScript run passed. The final release gate reruns TypeScript,
  all serialized tests, singleton checks, offline extension loading, inventory,
  package dry-run and installed-tarball loader/RPC/skill smoke.
- **Final full release gate: running.** Its exact source manifest, exit status,
  elapsed time and log hash will be recorded in
  [release-check-final.json](actionables-evidence-2026-10-01/release-check-final.json),
  with raw [output](actionables-evidence-2026-10-01/release-check-final.log).
  Completion requires exit 0 and unchanged source across that run.

Counts above overlap; they are independent runs, not an additive test total.
Permission and detached-registry faults run on Linux as a non-root user.
No new Windows/macOS CI or paid-provider success is claimed. The dispatcher
tests certify rejection and payload transformation, not provider billing or a
live completion-audit/compaction workload.

## Preserved unsuccessful attempts

The first focused attempt used Bun's `process.execPath` for a fixture intended
to exercise Node's builtin-module fault injection. Its rename patch did not
affect the imported filesystem binding; it failed that assertion and then
stalled observing a fixture exit. The owned runner was interrupted with TERM;
the log records failure exit 143. The fixtures now explicitly invoke Node.
Raw evidence is retained in
[focused-fixture-initial.log](actionables-evidence-2026-10-01/focused-fixture-initial.log).

The first complete-gate attempt found an old test expecting a corrupt outbox
to be replaced with an empty array. That destructive expectation was updated
to require preserved bytes and refused mutation. The run was deliberately
stopped with TERM, exit 143, before source was changed. Its manifest/log are
[release-check.json](actionables-evidence-2026-10-01/release-check.json) and
[release-check.log](actionables-evidence-2026-10-01/release-check.log).
That attempt also reported Bun-internal `epoll_ctl EEXIST` and a subsequent
test-registration error; the focused retention/outbox rerun passed. These
runtime observations do not authorize changes to Bun or the operating system.

Three later gate attempts were deliberately stopped for source-review fixes:
capture the child's group identity before reading a potentially lost owner,
retain refusal evidence in the primary channel when the independent
channel is unwritable; and disable SDK retries/background requests in the
private canary settings. They each exited 143 with unchanged source during
the run. Their distinct `release-check-review.*` and
`release-check-channel-review.*` and `release-check-provider-review.*` artifacts are preserved. None is a pass.

## External disposition

The residual advisory concerns Pi's bundled `brace-expansion` 5.0.9. It remains
upstream-owned, outside these three repairs. The fresh dependency scan and
its status are saved as
[dependencies-current.json](actionables-evidence-2026-10-01/dependencies-current.json)
and [dependency-check.json](actionables-evidence-2026-10-01/dependency-check.json).
Track the upstream dependency publication and rerun compatibility on a future
supported Pi update; do not edit Pi's installed bundled dependency or infer a
demonstrated GLLA exploit from the scanner alone.

Historical findings and implementation reports remain unchanged. This
register is the disposition for these three follow-up findings.
