# Respec builder follow-up audit

Reviewed the intended-project contract, pure transitions, production command
and tool integration, detached dispatch and recovery, feedback, terminal
archival, scope confirmation and display. All changes remain inside GLLA;
no production goal or runtime journal was edited. Version 0.39.0 is unpublished.

## Findings and disposition

1. **Medium — rejected verification could announce “Increment verified”.**
   The existing process protocol deliberately preserves semantic approval when
   its separate regression shield rejects incomplete contract evidence. Builder
   settlement correctly kept work unfinished, but its notification checked raw
   `approved`. Fixed: notification and severity use the settled history outcome.
   A detached worker returning approval without contract evidence reproduces
   this path and now produces a needs-work warning without a verified message.
2. **Medium — replanning omitted the actual missing-evidence reason.**
   Regression-shield rejection retained only the auditor's original approving
   text in history/feedback. Fixed: append an explicit incomplete-verification
   explanation and the missing contract items to durable feedback and history.
   A behavioral test checks the next plan receives the missing acceptance item.
3. **Low — audit entry lacked an immediate ownership check.**
   Existing fallback and settlement checks prevented stale approval, but model
   resolution and job lookup were reached before rejecting a stale wake.
   Added an entry ownership check; a test proves zero model resolution and
   zero dispatch when ownership has been lost.

Additional worker evidence covers exhausting the time window after actual
worker progress: automation parks, the job is cancelled and the requirement
remains open with its durable audit claim. Cancelled job cleanup is allowed;
the test verifies dispatch before cancellation and absence of a late result.

## Validation

Final affected suites: **52 passed, zero failures across six files** (builder
core, detached runtime, actual command/tool wiring, display, legacy drafting
and model settings). Current-source TypeScript and regenerated runtime
inventory pass. Evidence is in `respec-builder-2026-10-04/followup-tests.log`.
The earlier full release
gate (3,208 passed, one environment-gated skip) predates these audit fixes;
it is not represented as a fresh full-suite run for this revision.

These worker tests exercise the actual detached protocol with synthetic bounded
verdicts. They do not claim a live-model evaluation of project completeness.
