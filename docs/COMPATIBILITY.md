# Compatibility and execution boundaries

The declared Pi peer range is `>=0.84.2 <0.100.0` for agent-core, ai,
coding-agent, and tui. Keep the four Pi packages on the same version.
TypeBox is `>=1.3.14 <1.4.0`; Node requires 22.19 or newer.
Development dependencies pin Pi 0.99.1. Intermediate Pi releases are covered
by the range but are not individually certified.

The compatibility workflow exercises both Pi 0.84.2 and 0.99.1 on actual
Linux, macOS, and Windows runners with Node 22.19 and Bun 1.3.14. It checks
TypeScript, competing owner processes, child-tree cleanup, persisted receipts,
archive recovery, and the Node/jiti state singleton. All six lanes passed
[run 36746020362](https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/36746020362).
This is boundary coverage, not the entire release suite on every platform.
Linux SIGKILL cases explicitly skip on Windows; these skips do not establish
Windows abrupt-power-loss recovery.

POSIX children use owned process groups; Windows cleanup uses `taskkill /T`
while the leader is identifiable. Linux test cleanup additionally records
process birth ticks and session/group membership to reclaim registered detached
workers after a leader exits. That detached-worker registry is Linux-specific.
Windows descendant reclamation after an unregistered leader disappears is not
promised; it would require a Job Object or equivalent durable identity seam.
Owner publication retries bounded Windows sharing violations without deleting
the destination. Ownership requires coherent local directory reads and atomic
replacement; network filesystems are outside the contract.

The auditor is a fresh verifier, not an OS sandbox. Mirrored extensions and
bash checks can write files. Use a separate worktree/container and host file
permissions when verification requires stronger isolation. Evidence is untrusted
input; it does not grant authority to change host permissions or external plugins.

## Dependency disposition

The supported update from Pi 0.84.2 to 0.99.1 removed the installed undici and
coding-agent aggregate advisory entries. The full development audit still reports
one affected package, `brace-expansion` 5.0.9, pinned inside Pi's published
shrinkwrap. A GLLA manifest override to 5.0.12 did not replace that bundled pin
and was removed. Raw before/current/after audit responses are retained in
[audit evidence](../audit/improvement-evidence-2026-09-30/).
The production-only audit does not certify host-supplied Pi peers.

This residual is an upstream dependency report, not a demonstrated GLLA exploit.
Disposition: retained and reported; remediation belongs to Pi's dependency
publication. GLLA does not edit installed external packages or force-upgrade the
host. Recheck the raw advisory response when changing the supported Pi boundary.
