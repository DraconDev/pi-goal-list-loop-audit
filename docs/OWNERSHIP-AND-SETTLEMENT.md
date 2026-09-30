# Owner mutations and terminal settlement

The working-directory owner record is published as a complete JSON file by
atomic replacement. Acquisition, heartbeat refresh, shutdown, and takeover
share `owner-file-protocol.ts`. Each contender publishes a unique participant
record, chooses a bakery ticket, and waits for earlier live tickets before
mutating `owner.json`. A two-second wait expires the contender's own request;
it never expires a live holder. Synchronous actions release only their own
participant. Dead participants can be ignored and removed because their unique
names are never reused by successors. On Linux, process start ticks distinguish
PID reuse, and zombies have stopped executing. On other platforms, an ambiguous
live PID blocks conservatively.

This protocol requires a local filesystem with coherent directory reads and
atomic rename. Network/shared mounts are not covered. An older GLLA process
that writes the record outside this protocol cannot participate in its mutual
exclusion; close older hosts before upgrading a shared working directory.
Malformed owner or participant records require explicit repair. GLLA preserves
them and refuses acquisition rather than interpreting them as a dead owner.

Last-wins main-session policy remains a separate authorization decision.
Replacement compares the complete observed record inside the mutation interval.
A refresh or successor that changes it first makes the replacement fail.
Consented takeover compares the owner again in the same interval as signalling.
The process identity checks still apply before a foreign process is signalled.

The archive intent now owns the terminal chat summary before archive
publication. After publication and terminal state persistence, finalization
transfers that summary to the durable outbox before removing active markdown
and clearing the intent. Outbox failure retains the intent. Startup repeats
the transfer using the journal, even if the live goal slot has been cleared.
Prepared intents without a published archive cannot transfer a summary. Outbox
deduplication and persisted session receipts make transfer and delivery retries
idempotent.

These are process-crash guarantees. Atomic file publication does not promise
survival of power loss or storage-controller failure: the current writes do
not fsync files and parent directories. Storage-loss semantics remain a
separate implementation item in the improvement register.

Executable checks cover competing Node processes, live-holder timeout,
SIGKILL recovery, stale takeover observations, archive/outbox boundaries,
cold-process recovery, and existing takeover and last-wins behavior. Linux
execution does not establish macOS or Windows correctness; platform validation
remains in the compatibility plan.
