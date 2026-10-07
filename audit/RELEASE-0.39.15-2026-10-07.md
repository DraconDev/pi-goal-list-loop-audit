# Release 0.39.15 — published and verified

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

The full hosted release gate passed: 3300 pass, one skip, zero failures across
351 files, followed by TypeScript, Jiti state sharing, offline auditor probes,
inventory, pack inspection and packed-runtime smoke checks. Trusted publishing
accepted the upload with signed provenance. npm processing briefly returned 404;
the registry then exposed version 0.39.15 and latest=0.39.15.

Independent verification downloaded the npm tarball, validated SHA-512 integrity,
and matched all 144 files byte-for-byte against the immutable tag. Pi metadata
includes extensions/loops/goal.ts and pi-package; this is also the Pi plugin
release. Evidence: release-0.39.15/registry-verification.json and hosted-publish.log.
No external project session was reloaded or resumed. Broader audit work remains
separate from this completed publication. Failed-attempt evidence: release-0.39.14/.
