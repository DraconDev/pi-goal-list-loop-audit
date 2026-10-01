# Completed final-audit recovery — 2026-10-01

## Problem and ownership

The field triage in `FINAL-AUDIT-TRIAGE-2026-10-01.md` found an SEO claim
persisted as running after its detached worker had written a disapproval and
exited. GLLA's fresh-session code unconditionally parked such a claim and
required a new audit. This lost-result recovery behavior belongs to GLLA.
The provider failures and substantive rework cycles observed in other
projects remain separate; this change does not claim to resolve them.

## Change

A loaded fresh session, validated file-backed host successor, manual resume,
or agent resume now checks the newest physical job for its exact logical
completion claim before retrying. A completed semantic result passes the same
live transport validator and the same ordinary verdict application path.
Approvals use the durable archive settlement; disapprovals reach normal
history and rework. Cold restore records a disapproval but holds executor
work for consent. A second restore cannot replay an already-consumed claim.

New hashed requests bind the logical attempt, immutable claim/evidence payload,
revision, and tier metadata. Legacy requests require matching revision and
exact escaped objective, contract, completion, and verification blocks.
Request and result hashes/identities must match; an older candidate cannot
supersede a newer unfinished job. Invalid or infrastructure-only results
stay on the existing recovery path. Strict challenge, audit-tool floor,
unsupported-tool refusal, incomplete-verification refusal, and regression
shield checks remain in force.

Worker progress now carries persistent round identity through thinking, tool,
and report phases; both status and widget surfaces name the second audit pass.
No new ambient runtime bridge slots or settings were added.

## Verification contract

- Real detached workers publish approval/disapproval while parent application
  is deliberately omitted; a fresh mock-host lifecycle consumes each verdict
  once without a new auditor, and an approval archives normally.
- A manual command, an agent tool, and a silent file-backed successor each
  exercise the actual recovery entrypoint.
- Changed revision/claim/structured residual, tampered request, mismatched
  result/progress, incomplete verification, strict-challenge failure, and
  unsupported tool refuse unsafe recovery. Tool floor and shield still bind.
- Legacy completed jobs remain readable. A newer unfinished candidate blocks
  recovery of an older result. Second-pass labels survive ordinary phases,
  and real worker snapshots carry round identity through the transport.
- The same real-worker restart cases fail against baseline `010911aa` in an
  isolated `/tmp` extraction (the new-reader-only preconditions were removed;
  the verdict/application assertions were unchanged). Raw failure log is
  `final-audit-recovery-evidence-2026-10-01/baseline-regression.log`.
- A read-only run of the new reader against the actual SEO job returns
  disapproved for `audit-muhbedy5-xzsys5-muhbee0g-84839178`, duration 482132 ms.
  No live project's goal state, source, model, or owning host was changed.

The pre-fix cases fail on the old source; the current focused checks pass:
36 tests across the recovery regression and the two existing source pins.
The original broad run found two source-pin assumptions invalidated by the
refactor. The retry-provenance assertion is now scoped to automatic verdict
handling; the revision-refusal pin follows the continuation wrapper and checks
its cold-consent gate. No protected runtime behavior or verdict gate was removed.
Full validation is running. This report will be completed with its result
before implementation closure is claimed. Existing running hosts must load
these updated main-session modules to use the recovery path.
