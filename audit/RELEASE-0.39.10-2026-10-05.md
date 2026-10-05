# Release 0.39.10 — October 5, 2026

Previous npm latest: 0.39.8. Version 0.39.9's workflow was cancelled before
npm publication when an older project status test was found to expect the
previous clock label. The red reproduction is retained under the 0.39.9
evidence directory. Its tag was preserved and release marked prerelease with
withdrawal notes. History was not rewritten.

0.39.10 includes the corrected assertion, project-audit tool wait and separate
attempt/total clocks, and the clearer README/package descriptions and discovery
keywords. GitHub's stale auditor description was corrected, and relevant topics
were added. Visibility ideas and an unsent announcement draft are retained in
VISIBILITY-2026-10-05.md.

- Tag: `v0.39.10`, normally pushed.
- Tagged commit: `f55dcf7de0d7642675ec891bd4ced904c90d45a2`.
- Release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.10
- 511 package/workflow/test fingerprints matched the committed source;
  dry-run package includes 142 files.
- Focused project runtime/display/summary coverage: 30 passed, zero failed.

Hosted publish workflow:
https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37372534223
It completed successfully at 21:44:54 UTC. The full hosted gate passed:
**3,265 passed, one environment-gated skip, zero failures across 349 files**
(about 575 seconds for the suite). The remaining typecheck, binding, extension,
inventory, package and installed launcher/worker/skill checks passed before
signed npm publication.

GitHub had reported hosted-runner assignment delays during this release's
queue window: https://www.githubstatus.com/ (October 5 Actions incident,
19:11–21:54 UTC updates). This is external CI availability, not a GLLA change.

The local full run reported 3,264 passed, one skip and one failure in the
existing auditor-retry-callback test (about 1,332 seconds). Its second retry
count was still one when the test's 25-second polling deadline expired. The
same test passed on GitHub and on a separate local rerun (about 24 seconds).
Local load sensitivity is a plausible explanation, not established proof of
the failure's cause. No runtime code or test timeout was changed to hide it.
The failure, rerun and separate remaining local gate checks are retained in
the evidence directory; a single green local full-gate rerun is not claimed. The separate remaining
local TypeScript, jiti binding, offline extension, inventory, packing and
installed launcher/worker/skill checks all passed.

**Registry verification complete:** npm version and latest dist-tag are
0.39.10. The downloaded npm tarball's SHA-512 integrity matches the registry,
and all 142 packaged files match the tag byte for byte. All 511 tested input
fingerprints still match both worktree and tag. The npm/Pi plugin package
includes the new description, keywords and README presentation.

Public package: https://www.npmjs.com/package/pi-goal-list-loop-audit/v/0.39.10

The release is published and registry-verified. Live project sessions and
installed packages were not modified. Update the npm/Pi installation and run
`/reload` in existing sessions, then check `/glla version`.

Evidence directory: `audit/release-0.39.10-2026-10-05/`.
