# Release 0.39.4 — 2026-10-05

- Previous npm latest: 0.38.113.
- Tagged commit: `ad3ec7a38c04afe6983a97cb224cbb9ee03d41ca`.
- Tag: `v0.39.4`, pushed normally to GitHub; no history rewritten.
- GitHub release published at 2026-10-05T10:17:00Z:
  https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.4
- Publish workflow:
  https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37295588317

The full local release gate passed: **3,232 passed, 1 environment-gated skip,
0 failures across 349 files**; approximately 595 seconds for the suite. Remaining
TypeScript, Jiti binding, offline auditor extension loading, inventory, packing
and installed tarball/RPC stages passed. Current/minimum host TypeScript also
passed during the preceding audit.

All 510 fingerprinted package, workflow and test files matched both the checked
worktree and the tagged commit. Dracon-sync checkpointed the evidence before
the tag was created. Untagged development milestones were consolidated under
the actual 0.39.4 changelog entry, leaving an empty Unreleased section.

Evidence: `audit/release-0.39.4-2026-10-05/`.

The hosted release gate passed the same 3,233 cases (3,232 passed, one skipped,
zero failures), then the publish step completed successfully at
2026-10-05T10:28:04Z with signed npm provenance. The workflow finished successfully
at 10:28:06Z. npm reported: "Your package is being processed and may take a few
minutes to become available."

At this checkpoint registry availability has **not yet** been verified; its
latest query still reports 0.38.113. Live sessions and global package installs
were not restarted or changed as part of publishing. The hosted workflow log
is retained beside the local gate evidence.
