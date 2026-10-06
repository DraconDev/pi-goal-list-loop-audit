# Release 0.39.11

The release includes failed retry-pair context hygiene, bounded durable project
dispatches, successful compaction rearming, completion wording and persistent
compaction status. The npm package is also the Pi extension distribution.

Local `npm run release:check` completed successfully: 3,274 passing tests,
one environment-gated skip, zero failures across 350 files; TypeScript, Jiti
state binding, offline auditor extension checks, inventory, package inspection
and installed packed-extension/worker probes passed. All 488 captured validation
inputs retained their hashes during the run. Logs and input hashes are retained
in `audit/release-0.39.11/`.

Release tag `v0.39.11` points to the validated commit
`80793251a0b01abfa75a84742f81447ac1154864`.
GitHub release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.11
Publication workflow: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37446338209

Hosted validation also passed: 3,274 tests passed, one expected skip and zero
failures; all remaining release gates passed. The workflow published npm at
10:05:51 UTC on October 6 and completed successfully. After a brief registry
propagation delay, `latest` resolved to 0.39.11. All 143 files downloaded from
npm matched the released tag byte for byte, including the new project-context
module. Registry SHA-512 integrity matched, provenance metadata is present,
and Pi extension metadata points to `extensions/loops/goal.ts`. The package
therefore supplies the same validated code through npm and Pi installation.
Registry verification and hosted workflow evidence are retained alongside the
local checks.

No running project session was changed. Existing Pi sessions need `/reload`
after updating the package; `/glla version` reports the actually loaded version.
