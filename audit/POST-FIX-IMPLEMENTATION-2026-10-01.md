# Follow-up repairs — 2026-10-01

This implementation addresses AF-1, AF-2 and AF-3 from
[POST-FIX-AUDIT-2026-10-01.md](POST-FIX-AUDIT-2026-10-01.md).
The historical audit and its evidence remain unchanged. All repairs are owned
by GLLA; no host, provider, operating-system or external-plugin code changed.

## AF-1: retain authority during selector failure

`glla-state-root.ts` validates the settings object and selector. Only ENOENT
uses the normal working-directory default. Other read failures and invalid
selectors leave selection unresolved, retain a last validated selector for
reads, and defer writes. Cold unresolved selection raises an explicit error
instead of presenting an empty fallback goal. `runPersistStep` pins the
selector and session directory for each synchronous persistence operation;
nested operations share that view. Recovery re-reads settings without moving
or deleting the old authority tree.

`state-root-failure.test.ts` exercises real EACCES (Linux/non-root), malformed
JSON, invalid selector values, restoration/retry, cold uncertainty, absent
settings, and a settings change during an operation. The selected goal and
queue bytes remain available, failed enqueues return false, no cwd tree is
created, and retry lands in the selected session root.

## AF-2: acknowledge launches before discovering identity

The test registry publishes an independent declaration before the first
process-stat read. Live unknown identity is refused rather than classified as
non-detached/dead. Failed declarations remain visible to the parent reaper,
even when a caller catches the launch error and exits zero. Without captured
group identity, refusal signals only the owned ChildProcess. Existing PID
birth fencing and unrelated-process protection remain in place. A proven
already-exited or non-detached child can retire its declaration. Transport
mocks that never launched a ChildProcess do not create process obligations.

Registration regressions inject EACCES, malformed stat and ENOENT, restore
reads before cleanup, and verify nonzero unverified accounting, stopped owned
children and surviving unrelated children. An end-to-end nested runner catches
the registration error and exits zero; its parent still exits one and retains
failure evidence. Separate tests confirm already-exited, independently absent (ESRCH), and suite-group
behavior, and the existing stale/reused-PID test remains in the focused run.

## AF-3: merge replay acknowledgements into the current queue

Enqueue, acknowledgement and rotation use the existing owner mutation
protocol, reading the current queue inside each mutation. Replay matches
stable render identity and preserves new entries and nested acknowledgements.
External delivery callbacks execute outside that lock. An in-flight set
prevents nested replay from delivering the same entry recursively; fresh
reads prevent an outer replay from resending an entry acknowledged inside it.

Tests cover callback enqueue followed by exactly one next-contact delivery,
nested replay, refused-delivery rotation with a new entry, and the actual
GLLA terminal sender crossing a fake Pi `sendMessage` boundary that enqueues
reentrantly and persists session receipts. Existing unreadable/invalid-store,
acknowledgement failure, receipt matching and fair-rotation tests also pass.

## Verification

Focused checks: **63 pass, zero failures across five files** and TypeScript
exit zero. The final registration run adds three retirement cases:
**14 pass, zero failures**. Exit-race checks pass **51 tests across three files**. Logs and command statuses are retained in
[the evidence directory](post-fix-implementation-evidence-2026-10-01/).

The first full attempt was stopped after a normal-exit proc/status race
produced a false registration refusal. Its log and unchanged-source manifest
are preserved as `release-check-exit-race.*`. The corrected code independently
requires ESRCH before retiring a disappeared PID when exit status is pending;
live injected ENOENT still refuses registration.

Full `npm run release:check` is in progress. Closure remains unproven until
that gate completes and its source manifest is checked.

Limits: this verification is local Linux, Node 22.22.2 and Bun 1.3.14.
No paid provider calls or new Windows/macOS execution are claimed. The earlier
upstream Pi bundled dependency report remains externally owned and is not a
GLLA repair target. Runtime journals and goals were not edited.
