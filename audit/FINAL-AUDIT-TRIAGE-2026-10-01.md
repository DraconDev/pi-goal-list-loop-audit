# Final-audit triage — 2026-10-01

Read-only field inspection at approximately 14:32–14:36 UTC, prompted by the
operator reporting projects stuck on their final audits. No project source,
runtime journals, model settings, processes, or live claims were modified.

## Observed cases

- **Clean Web** (`browser-extensions-shared/extensions/standalones/clean-web`):
  claim `audit-mupmbe25-nmolk0`, started 14:16:57 UTC. Worker PID 2795188 was
  live. Worker report bytes increased from 6063 to 6272 during inspection;
  activity timestamps advanced. Recent output contains an approval followed
  by a fresh adversarial verification brief, consistent with the worker's
  second challenge pass. No completed result existed. This is evidence of
  ongoing verification, not a proved deadlock.
- **dracon-log**: claim `audit-mupmvf91-opaawy`, started 14:32:32 UTC.
  Worker PID 3198372 was live and producing a report (5189 bytes at the later
  snapshot). Prior attempts settled as disapproved at 14:09:06 and 14:28:41;
  the latter took 1,023,436 ms. The new request already disables the challenge
  pass with `challengeSkip: rework-streak`. Repeated rework is distinct from
  an orphaned worker; convergence still needs review against actual findings.
- **Darklord** (`dracon-platform/web/games/wip/darklord`): worker PID 3177572
  was live, with advancing activity and report output. Earlier attempts
  recorded `Provider returned an empty response` at 14:12:36 and
  `Auditor attempted unsupported tool: write` at 14:15:49. The provider
  failure is external; GLLA owns tool-policy enforcement and retry presentation.
- **SEO** (`dracon-platform/seo`): durable claim `audit-muhbedy5-xzsys5` still
  says running with last activity 2026-09-25T18:51:00.277Z. Its matching job
  `audit-muhbedy5-xzsys5-muhbee0g-84839178` has a complete progress snapshot
  and a valid-looking `ok: true` result ending in disapproval. Recorded worker
  PID 1087105 no longer exists. The verdict is absent from the current audit
  history inspected. This is a confirmed orphaned projection / unapplied
  result. It does not prove that a current live host or current release failed
  recovery; the claim predates the latest release and host lifecycle evidence
  is incomplete.

## GLLA follow-up

1. Reproduce loss of the parent between detached result publication and verdict
   application, then cold reload and silent successor handoff. Existing
   recovery parks a running claim and retries; establish whether a completed
   identity-matching result can be reconciled safely without another audit.
   Preserve claim identity, contract revision, request hash, and exactly-once
   settlement. Never infer approval from an orphan's prose or bypass the gate.
2. Keep the second challenge pass visible throughout its thinking/tool/report
   phases. The worker currently publishes `challenging` only at transition,
   then normal event phases overwrite it; progress snapshots do not carry
   persistent round identity. This explains a presentation gap, independently
   of whether the worker is stalled.
3. Review repeated disapproval findings for convergence before changing retry
   limits, model selection, or verification requirements. Preserve external
   provider diagnostics without treating them as repository-owned defects.

The operator was asked for the specific currently affected projects. These
initial cases should not be assumed to exhaust that report.

## Validation

Targeted existing recovery checks: **14 passed, 0 failed** across
`audit-settlement-restart`, `audit-recovery-persistence`, and
`stuck-audit-latch`. Raw log: `final-audit-triage-evidence-2026-10-01/recovery-tests.log`.
No runtime repair has been implemented; these tests demonstrate existing
covered recovery behavior, not closure of the new field report.
