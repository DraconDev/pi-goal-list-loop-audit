# Release 0.38.113 — 2026-10-03

Authorized by the user: “we should do a release”. Previous published version:
0.38.107. Includes the 0.38.108–0.38.113 compaction, durable-audit, tool-option
and UI changes recorded in CHANGELOG.md.

The complete local `npm run release:check` passed: 3180 tests passed across
343 files, zero failures, one environment-gated daemon test skipped. TypeScript,
Jiti state binding, offline auditor-extension loading, generated inventory,
package dry-run and installed-tarball launcher/RPC/skill checks all passed.
The suite took 652.74 seconds; the composite command exited zero.

All six Pi/platform compatibility jobs passed on the verified source commit
`59be715923d631041437832560a0fe70667674d9`:
[GitHub run](https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37146520007).
Both Pi 0.84.2 and 0.99.1 passed on Linux, macOS and Windows. Subsequent preview
updates changed only audit evidence; packaged source is identical.

Release preparation corrected the old “auditor: queued” integration assertion
to the new “Audit starting” wording and retained explicit detached-worker
attribution in the compact card. The optional subagent dev fixture is pinned
per compatibility boundary: 0.60.0 supports the older Pi boundary, whereas
0.75.0 requires a newer Pi. No upstream plugin was modified and npm peer checks
remain enabled. The current-host dispatcher test accesses its newer helper
reflectively so older-boundary typechecks can compile; the actual current-host
execution proof still asserts the helper exists and verifies argument overrides
and execution blocking. Its nine cases passed separately.

Git history was not rewritten. The sync daemon owns source/evidence commits.
The tag and GitHub release trigger the repository's trusted npm publishing
workflow, which repeats `release:check` before publishing. Publication status
will be recorded after the workflow and registry verification finish.

The published [GitHub release](https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.38.113)
points to `ffb20f10662c737f7357d60ac8089af31820776b`. Both GitHub and GitLab
accepted the annotated tag; GitLab's remote refs were read back to verify it.
GitLab emitted a storage-limit notice but accepted this tag; no external
storage cleanup or repository-history repair was attempted.
The [npm publishing run](https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37147097472)
is validating the released tag before publication.

Publishing attempt 1 stopped at the test gate: 3179 passes, one environment
skip, one failure in “stale terminal keeps a recovery probe and self-heals
without reload”. Its assertion observed no interruption after a fixed 150 ms
wait. The same test passed in the complete local gate and its isolated replay;
the complete pre-release source quality run also passed. This is consistent
with a timing-sensitive observation, not proof of a production regression.
One failed-job retry was requested against the unchanged tag. No gate was
disabled, no failed run is counted as a pass, and no release/tag was rewritten.
A future test hardening should await the acknowledged continuation and durable
interruption rather than assuming fixed sleeps observe both transitions.
