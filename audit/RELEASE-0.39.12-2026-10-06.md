# Release 0.39.12

This release adds per-model thinking configuration to the main-agent fallback
picker and makes saved compaction-failure holds reachable through both resume
commands. Model thinking choices come from Pi's official capability helper;
runtime switches use its matching clamp. Single-level models use their actual
level, unsupported selections cannot overwrite valid pins, and failback restores
the primary session dial retained in durable state.

The first release gate was stopped at the operator's request to tighten model
capabilities. The fresh full local suite then completed with 3,282 passes, one
environment-gated skip and one failure: headless settings omitted the new
thinking map. That display line was corrected during the run. The focused
settings rerun passed all 44 tests; the model-capability pass passed 65 tests.
Only `extensions/goal-commands.ts` changed during the full suite. All 490 final
validation input hashes remained stable afterward.

TypeScript, Jiti state binding, offline auditor extension loading and the final
regenerated inventory passed. The packed extension installed and imported,
its launcher/worker probe completed, and its bundled skill had zero diagnostics.
The final dry run includes 144 package files. Local validation evidence is in
`audit/release-0.39.12/`; the failed full local run is not reported as a clean
pass. Hosted publication runs the complete release contract again against the
exact release tag, and cannot publish unless that gate passes.

Release tag `v0.39.12` targets commit
`0470180dd31ed3cd836e17c68e0f15d6447fb428`.
GitHub release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.12
Publish workflow: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37476269752

Hosted publication completed successfully. The exact-tag full suite passed:
3,283 passing tests, one expected skip, zero failures across 351 files. Every
remaining release gate passed, and npm reported publication at 14:18:46 UTC.
After registry propagation and metadata-cache revalidation, the dist-tags and
latest-version endpoints identify 0.39.12; `npm view --prefer-online` agrees.
The downloaded tarball's SHA-512 integrity matches registry metadata, and all
144 published files match the released tag byte for byte. Pi plugin metadata
and the new fallback-thinking module are present. Hosted logs, workflow state
and registry evidence are retained in `audit/release-0.39.12/`.
No live project session or external provider configuration was changed.
