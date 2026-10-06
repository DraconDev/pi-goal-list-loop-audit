# Release 0.39.13 — 2026-10-06

Published to npm and GitHub. The npm package is also the Pi plugin.

- Tag: v0.39.13
- Tagged commit: 62c44c1706378a36124e93252a2e6a58513923b6
- Release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.13
- Publish workflow: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37522082073
- Exact-source quality gate: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37521726787

The publish workflow succeeded, including the complete release contract on the
frozen tag: 3295 passing tests, one skip, zero failures across 351 files, TypeScript,
Jiti state sharing, offline auditor checks, inventory, packaging and packed runtime
load/worker probe. npm trusted publishing generated signed provenance and published
0.39.13 at approximately 20:03 UTC. The registry briefly kept the previous version
while npm processed the upload (explicit processing notice); it then exposed
0.39.13 and latest=0.39.13. This was external processing, not a GLLA code defect.

Independent registry verification downloaded the npm tarball, checked its full
SHA-512 integrity, matched all 144 published files byte-for-byte with the Git tag,
and confirmed latest=0.39.13, pi-package metadata, the Pi extension entry at
extensions/loops/goal.ts and SLSA provenance metadata. Evidence:
release-0.39.13/registry-verification.json.

Local validation history is retained honestly. The first run stopped after an
obsolete owner-fence source assertion (it allowed only status instead of both
status and the new read-only blockers view). Corrected fence tests passed 12/12.
The fresh serialized suite finished with 3294 passes, one skip and one obsolete
menu expectation: the expected row list omitted the new Fallback thinking entry.
Only that test expectation changed afterward; corrected menu tests passed 29/29.
All product-source inputs remained unchanged. The remaining local release checks,
including types and packed runtime loading, passed. Both hosted complete gates
then passed on the exact final commit, including the corrected expectations.
No failing local run is claimed as a clean full run.

532 final committed validation inputs were checked against the tagged commit.
Source/evidence commits were left to dracon-sync; no history was rewritten.
The published tag was never moved. No live external project sessions were reloaded
or resumed; update the Pi package and /reload, then /loop recheck for old blocker
records where appropriate.

Changes: proactive repair continuation versus external holds; concise automatic
blocker actions and full evidence inspection; bounded blocker rechecks; held-project
context for ordinary questions; continuation of interrupted work after fallback;
incremental thinking prompts, individual pin editing and session-model eligibility
in the global fallback chain. See CHANGELOG.md and docs/RECOVERY.md.

Logs and workflow/registry records: release-0.39.13/.
