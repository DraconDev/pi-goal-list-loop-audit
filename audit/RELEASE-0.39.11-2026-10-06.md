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

At this checkpoint the GitHub release is published and hosted validation is
running; npm publication and downloaded-artifact verification remain pending.
No running project session was changed. Existing Pi sessions need `/reload`
after updating the package; `/glla version` reports the actually loaded version.
