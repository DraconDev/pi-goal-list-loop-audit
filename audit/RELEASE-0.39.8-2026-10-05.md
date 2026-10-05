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
npm publication. The hosted full gate passed: **3,263 passed, one
environment-gated skip, zero failures across 349 files** (498 seconds).
Its remaining typecheck, binding, extension, inventory and installed package
checks passed, followed by signed npm publication at 18:09:37 UTC. Workflow
conclusion: success at 18:09:40 UTC. npm reported that processing may take a
few minutes; registry availability and downloaded-package verification are
still pending.

The local full suite also passed the same 3,264 cases (3,263 passed, one
skipped, zero failures), approximately 941 seconds. Its remaining gate
stages are finishing.

Evidence directory: `audit/release-0.39.8-2026-10-05/`.
