# Post-fix audit — 2026-10-01

The current v0.38.105 tree has **three reproduced remaining GLLA-owned issues:
one HIGH and two MEDIUM**. The previous fixes pass their regression tests,
but additional failure paths still violate root selection, cleanup accounting
and preservation of pending summaries. This audit records repairs to make;
it does not modify their implementations.

## Evidence and coverage

Audited revision: `81de959ccbaa75f309b9cd300494b2ac973272ed`; initially clean
worktree. The recent complete release gate exited 0 with 2,948 pass, one skip
and zero failures across 320 files, including installed-tarball checks. All
478 runtime, package, test, configuration and documentation files in its
manifest still match. Only the separate operator `note.md` changed after
that run. The exact comparison is in
[verification.json](post-fix-evidence-2026-10-01/verification.json).

Fresh checks: **102 pass, zero failures across nine files**, plus TypeScript
and inventory exit 0. Coverage includes the new canary/registration/outbox
regressions and existing state-root, shield, strict challenge and reliability
behavior. Source review included registry launch/refresh/reaping, contained
child lifecycle, outbox delivery/acknowledgement, archive-intent transfer,
root resolution and its pending-write guards, canary dispatch/settings,
compatibility workflow and dependency disposition.

The previous full gate is a verified recent baseline, not a fresh full-suite
run or proof that these newly probed paths work. Fresh observations and logs:
[focused tests](post-fix-evidence-2026-10-01/focused-tests.log),
[check statuses](post-fix-evidence-2026-10-01/checks.json).

Run the standalone probes from the repository root after installing
dependencies. Identity and permission probes require Linux/non-root; all
fixtures use temporary files and explicitly spawned children, and clean up
their own resources. No provider request is made.

```sh
node audit/post-fix-evidence-2026-10-01/state-root-probe.mjs
node audit/post-fix-evidence-2026-10-01/process-identity-probe.mjs
node audit/post-fix-evidence-2026-10-01/outbox-reentry-probe.mjs
```

## AF-1 — HIGH: unreadable settings silently change the persistence root

**Owned location:** `extensions/glla-state-root.ts:71–98`, especially the
unconditional `workingDir` fallback in `readStateRootSetting` and the
subsequent `stateRootPending` guard.

**Reproduction:** Select `sessionDir`, register a valid session directory,
persist an active goal and a pending summary there, then make the selector
file unreadable. Root resolution changes from `session/pi-glla` to
`cwd/.pi-glla`; `readState` changes from goal `root-goal` to no goal, and
`stateRootPending()` returns false. Enqueuing a second summary returns true
and creates a new cwd tree. Restore settings readability: the active goal
reappears in the session root, whose queue contains only the first summary.
The successfully enqueued second summary remains stranded in the unintended
cwd root.

This is a GLLA classification/write-boundary defect. File access failure
does not represent user consent to change the selected root. The probe does
not demonstrate deletion of the original goal; it demonstrates loss of its
visibility and successful persistence to a different authority tree.

**Repair:** Distinguish an absent configuration that legitimately uses defaults
from an existing unreadable/invalid selector. Represent unresolved selection
explicitly and defer mutations, or retain a validated last-known selection
without interpreting the read failure as a root change. Resolve the root
consistently for an operation rather than allowing successive settings reads
to authorize a fallback write.

**Acceptance:** With a known session root and existing goal/receipts, inject
`EACCES`, transient read failure and invalid selector JSON. No cwd tree or
fallback state write may be created or acknowledged. Preserve the selected
goal and old bytes; after restoration, retry must land in the selected root.
Also test cold startup with an unreadable existing selector and a genuinely
absent file using the normal default. Never delete or migrate the old root
as an error-recovery shortcut.

Evidence: [probe](post-fix-evidence-2026-10-01/state-root-probe.mjs),
[observations](post-fix-evidence-2026-10-01/state-root-probe.json).

## AF-2 — MEDIUM: identity-read failure still produces false clean cleanup

**Owned location:** `scripts/test-process-registry.mjs:5–10` and `:92–102`.
The identity helper converts every stat-read failure to null. Before a leader
has been captured, snapshot returns without registering an obligation.

**Reproduction:** Spawn a known live detached child, inject `EACCES` only for
its `/proc/<pid>/stat` during registration, then restore normal reads before
reaping. Registration returns without an error. There are zero primary
records and zero independent expectations. Reaping returns
`{reaped: 0, unverified: 0}` while the child is still live. The probe kills
and awaits that exact owned group afterward.

The earlier primary/obligation write-failure repairs are present and tested.
This is a remaining gap before either record exists: missing identity is
treated like a non-detached/already-exited child rather than an unacknowledged
live launch. Restoring the identity read does not help a reaper with no launch
expectation. A later periodic refresh may recover, but a runner finishing
before that refresh can still report success with an unfulfilled obligation.

**Repair:** Establish an expected launch before fallible identity discovery.
Distinguish proven non-detached/dead children from unknown identity. If a
known launch cannot be verified, retain an unverified obligation, refuse the
launch/registration and stop only the directly owned child or a group whose
identity is actually captured. Keep PID birth fencing and unrelated-process
protection; do not compensate with process-name sweeping or host permission
changes.

**Acceptance:** Inject first stat-read denial and malformed/unavailable
identity, restore reads before cleanup, and verify a nonzero failure result
even if the caller catches registration failure. Test that the child stops
and an unrelated child survives. Proven already-exited and suite-group
children should retain their intended behavior. Include an end-to-end parent
runner check instead of relying only on a helper throwing.

Evidence: [probe](post-fix-evidence-2026-10-01/process-identity-probe.mjs),
[observations](post-fix-evidence-2026-10-01/process-identity-probe.json).

## AF-3 — MEDIUM: replay overwrites an enqueue from its delivery callback

**Owned location:** `extensions/approval-render-store.ts:145–155` and `:187`.
Replay loads a queue snapshot, invokes the delivery callback, then writes
that old snapshot to acknowledge delivery/rotation.

**Reproduction:** Enqueue `first`. Its delivery callback successfully enqueues
`second` through `persistApprovalRender`, then returns true for `first`.
Replay reports one delivery and both enqueues reported success, but the final
file contains only delivered `first`: the undelivered `second` is erased by
the acknowledgement write. No filesystem failure or second process is needed.

The exported callback API does not forbid reentrant persistence. This probe
establishes data loss under that precondition; it does not establish a field
incident or assert that the current Pi sender routinely makes such an enqueue.
The normal GLLA sender crosses host delivery APIs, so relying on callback
purity without enforcing it leaves the outbox's preservation contract fragile.

**Repair:** Acknowledge against the current queue after delivery, merging by
stable render identity while retaining entries added during callbacks. Protect
pure queue mutations against competing/reentrant changes; avoid holding a
non-reentrant filesystem lock while invoking external delivery code. Rotation
must similarly preserve unattempted/new entries. Refusing unsupported
reentrancy is also acceptable only if enqueue cannot return success and later
lose its obligation.

**Acceptance:** Enqueue a second render inside delivery of the first and
verify both survive, only the first is acknowledged, and the second replays
once on the next contact. Cover a delivery refusal/rotation path and nested
replay so stale snapshots neither erase entries nor restore stale delivery
flags. Exercise any host callback path that can reenter persistence.

Evidence: [probe](post-fix-evidence-2026-10-01/outbox-reentry-probe.mjs),
[observations](post-fix-evidence-2026-10-01/outbox-reentry-probe.json).

## Previous findings, external reports and limits

The earlier canary hook rejection, primary registry write failure and
unreadable outbox-file triggers pass their fresh regression checks. The
canary abort, zero-retry private settings and refusal receipts remain present.
AF-2 narrows the still-open cleanup accounting branch; AF-1 and AF-3 are
additional persistence paths. Historical audit/implementation reports are
preserved rather than rewritten to hide the earlier passing evidence.

Read-only review of Pi 0.84.2's published package confirms the request hook
dispatcher exists, provider retry settings are read, and the SDK forwards
those settings. That resolves the suspected missing minimum-version hook/
retry-setting mismatch at source level. It is not a new old-host execution
or paid-provider certificate. Package/source hashes and scope are retained
in [pi-084-source-review.json](post-fix-evidence-2026-10-01/pi-084-source-review.json).
No host component was modified.

Fresh `npm audit` still reports one high-severity package entry, Pi's bundled
`brace-expansion` 5.0.9. This is upstream-owned and remains separately
disposed under AGENTS.md; no new GLLA exploit or remediation is claimed.
[Raw dependency report](post-fix-evidence-2026-10-01/dependencies.json).

Coverage limits: no paid provider calls, fresh full release run, new Windows/
macOS execution or exhaustive review of every prompt/command. Findings are
reproduced public-helper/root behaviors, with preconditions stated explicitly.
The existing green suite does not cover these adversarial scenarios. Only
audit documentation/evidence changed; **AF-1, AF-2 and AF-3 remain open**.
