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

Tag, GitHub workflow, and npm availability verification are pending; this
report does not yet claim published registry availability. Existing Pi hosts
must load the updated plugin to use the recovery path. SEO's saved result is a
disapproval, so reconciliation exposes rework rather than declaring completion.
