# Release 0.39.8 — October 5, 2026

Previous npm latest: 0.39.4. The unpublished 0.39.5–0.39.8 milestones were
consolidated into the actual 0.39.8 changelog entry. The release adds a shipped
recovery guide, a shorter docs index and README/INSTALL links alongside the
command, completed-project and model-switch fixes.

- Tag: `v0.39.8`, normally pushed; no history rewritten.
- Tagged commit: `f56bfbdfce284e1884875a9bd90f46df480e436a`.
- GitHub release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.8
- Release published at 2026-10-05T18:00:02Z.
- Publish workflow: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/37352643357
- All 511 fingerprinted package/workflow/test inputs matched the committed
  source before tagging; the dry-run package contains 142 files.
- Relative links in README, INSTALL, docs/INDEX and docs/RECOVERY passed.

The earlier fleet gate found one outdated command-description assertion;
its corrected file and all remaining release checks passed separately. This
release repeats the entire local gate on the final documentation/package
inputs. The hosted release workflow independently validates the tag before
npm publication. Both gates are currently running. npm publication and
downloaded-package verification are pending; a GitHub release alone is not
registry availability.

Evidence directory: `audit/release-0.39.8-2026-10-05/`.
