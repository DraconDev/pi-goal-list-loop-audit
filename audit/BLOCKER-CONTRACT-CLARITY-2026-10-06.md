# Blocker contract and action clarity — 2026-10-06

The Hellhunter screenshot showed a full test report followed by generic action
text. Read-only inspection of its last durable state confirmed two blocked
requirements: REQ-BISECTION (neither required performance manifest published;
second arm unrun) and REQ-PLAYABLE (vendor modal timeout and combat positioning
failure; report explicitly says the host is not the blocker). No external
project source, state, process or operating-system configuration was changed.
The diagnostics are agent reports, not independently re-run evidence.

GLLA owns accepting blocker transitions and displaying them. Its project tool
now requires a short summary, owner, concrete nextAction, expectedResult and
whyAgentCannotProceed. Empty or oversized fields are rejected before mutation.
Tool guidance says failed tests, unrun checks, missing evidence and unfinished
implementation are ordinary work to continue; blocking must identify a dependency
outside the agent's authorized ability to resolve. This is guidance plus validation
of actionable fields, not a claim that arbitrary agent prose can be truth-checked
by a deterministic classifier.

Automatic cards and refused resumes lead with concise actionable fields. Full
measurement reports remain available in explicit /loop blockers inspection,
with action information first. The steady widget uses the short obstacle.
Older saved reports get a bounded first-sentence preview labelled Needs
clarification, and explicitly state that operator involvement is unconfirmed.
No state is silently unblocked and no missing operator instruction is invented.

This supersedes the earlier optional-input blocker tool documented in
AUTOMATIC-BLOCKER-ACTIONS-2026-10-06.md. Legacy durable states remain readable;
the new tool contract requires actionable fields for new calls.

Validation: 52 tests across six files passed; TypeScript, runtime inventory and
whitespace checks passed. Coverage includes rejection without parking, long
summary rejection, compact actions versus complete evidence, legacy uncertainty,
automatic display, deduplication, display failure, hold and stale-context guards.
Evidence: blocker-contract-clarity-2026-10-06/. Prepared for 0.39.13;
this task did not publish or reload other sessions.
