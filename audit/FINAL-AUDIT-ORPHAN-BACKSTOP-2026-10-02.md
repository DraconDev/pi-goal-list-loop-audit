# Final-audit orphan backstop — 2026-10-02

## Report and ownership

The operator reports that some final audits are still stuck after the
conversation exported in `conversation-2026-10-01-225516.txt`. Watching one
dracon-platform audit settle proves that attempt worked, not that all other
claims are healthy. The previous report's blanket closure was unsupported.

Read-only survey around 22:57–23:03 UTC on October 1:

- SEO (`dracon-platform/seo`), goal `20260924180311-jok0tk`, still durably
  says auditing/running with last activity September 25. Its physical job
  `audit-muhbedy5-xzsys5-muhbee0g-84839178` has a completed result. Both the
  recorded worker and recorded main-session owner PIDs are dead. There is
  no current owner to execute recovery. This is unresolved runtime debt;
  updating this checkout alone cannot execute code in a dead session.
  The current read-only `readCompletedCompletionAudit` validator accepts
  that exact job as disapproved (482132 ms); it requires rework, not an
  invented approval or another audit of the unchanged claim.
- Strategy, Endless TD, and Doomtap have live resultless workers with recent
  activity. Doomtap is in its second pass. These snapshots do not prove
  those attempts will finish; they do distinguish them from SEO's orphan.
- Chat and dracon-log have no current goal in their inspected journal
  projections; Clean Web and Darklord have active goals with no completion
  claim in those projections.

No external project source, runtime journal, settings, process, or owner
marker was changed. Further affected project names were requested. The
provider and main-host lifecycle are external; GLLA's own claim backstop is
within this repository's scope.

## Confirmed implementation gap

The healthy-host stranded-audit heartbeat required BOTH no in-flight audit
and either no claim or `completionAuditRecoveryArmed`. A first attempt that
loses its application path can leave a stored claim and an unset armed flag.
That exact state never enters the backstop, even after the 90-second grace.
The backstop also called a completed on-disk verdict "no verdict" rather
than using the validated result reader introduced in 0.38.107.

This is a reproduced GLLA failure, not a claim that SEO's historical process
followed this exact path. SEO independently shows that unresolved claims
remain in the field.

## Change and verification

An auditing goal with no process-local audit owner enters the backstop after
the existing grace, regardless of the retry-armed flag. It first reconciles
the exact saved verdict through the existing identity/hash/revision/tool/
challenge/evidence validator and ordinary application path. An applied
approval still finishes through durable settlement; an interrupted settling
claim finishes settlement without another auditor. If no valid saved verdict
exists, the claim is durably parked and the successful park is then ledgered.
No new auditor launches from this backstop.

The heartbeat dependency carries reconciliation explicitly; no ambient slots
were added. Existing live audit ownership, supervisor pause, cold-load
consent, and launch grace remain binding.

- Before implementation: all three new healthy-host cases fail (approval,
  disapproval, and absent result remain auditing); existing cases pass.
  `final-audit-orphan-backstop-evidence-2026-10-02/baseline-regression.log`.
- Focused verification: 39 passed, 0 failed across completed-result recovery,
  stale-latch recovery, settlement restart, and audit standstill. Includes
  exactly-once recovery, live ownership, launch grace, supervisor freeze,
  and cold-held disapproval with no executor dispatch.
  `final-audit-orphan-backstop-evidence-2026-10-02/focused-tests.log`.
- TypeScript check passed. Full release contract is running; its result will
  be recorded here before completion.

Existing hosts must load the updated modules. SEO requires a normal Pi
session in its project so the existing startup reconciliation can consume
its saved verdict; there is no live owner to recover it automatically today.
