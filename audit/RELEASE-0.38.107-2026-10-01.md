# Release 0.38.107 — 2026-10-01

## Contract

Ship completed final-audit recovery through the ordinary verdict and settlement
gates, keep the second verification pass visible, and ship the landscape store
thumbnail. Preserve the repository boundary, cold-load consent, immutable git
history, and ignored machine-local journals.

Implementation and field evidence: `FINAL-AUDIT-RECOVERY-2026-10-01.md` and
`final-audit-recovery-evidence-2026-10-01/`. The baseline real-worker restart
cases fail on `010911aa`; the fixed paths cover fresh load, file-backed host
replacement, manual resume, and agent resume. No live project state was rewritten.

## Local verification

`npm run release:check` passed on version **0.38.107**: **2984 passed, 1 skipped,
0 failed**, 322 test files. It also passed TypeScript, singleton-state import,
offline auditor extensions, inventory, npm pack inspection (133 shipped files),
and actual packed RPC/challenge, skill-loading, and import checks.

All **482** source/metadata files in the recorded manifest match both the
working tree and its committed projection. Evidence lives in
`release-0.38.107-evidence-2026-10-01/`.

## Publication

Tag `v0.38.107` points at `b2503325805eed76784ef524470873c7786be721`.
All 482 tested source/metadata files match that tag. GitHub Release:
https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.38.107 .
Publishing workflow `36887869040` completed successfully, including the tagged
release contract: **2984 passed, 1 skipped, 0 failed**, plus the remaining checks.
npm accepted trusted publishing with signed provenance and reports asynchronous
package processing. At 16:18:23 UTC (15 minutes after acceptance), the exact
version endpoint still returned 404 and latest remained 0.38.106. Registry
availability and published-tarball verification remain pending; the successful
publish workflow is not evidence of public availability. Existing Pi hosts
must load the updated plugin to use the recovery path. SEO's saved result is a
disapproval, so reconciliation exposes rework rather than declaring completion.
