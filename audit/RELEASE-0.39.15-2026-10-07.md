# Release 0.39.15 — verification in progress

Release tag: v0.39.15, commit 1b7e1cfdd0d71f2b11df4a399abbba710f490547.
GitHub: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.15
Publish gate: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37592082935

Includes request-metadata classification and ordinary fallback-exhaustion fixes.
39 focused recovery cases passed before release preparation. Corrected release
contract and auditor watchdog rerun: 24 pass, zero fail. TypeScript/inventory pass.

The v0.39.14 attempt did not publish to npm: the changelog promotion omitted the
required empty Unreleased section. Hosted gate: 3299 pass, one skip, one fail.
Local gate additionally hit a worker SIGTERM-marker startup timing assertion;
that unchanged test passed both hosted validation and the focused rerun.
The original tag is preserved and its GitHub release marked prerelease/unpublished.
0.39.15 restores the heading. No history was rewritten.

Full hosted gate and registry artifact verification are pending; no npm success
is claimed in this record yet. Evidence: release-0.39.14/ and release-0.39.15/.
