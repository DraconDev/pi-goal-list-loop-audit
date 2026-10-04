# Respec builder verification

The intended project, rather than the current implementation, now governs
`/loop respec [project direction]`. Version 0.39.0 is prepared; this implementation
does not publish a release or start a production project loop.

## Requirement review

| Contract | Implementation and evidence |
| --- | --- |
| 1. Research and confirm intended scope | `goal-loop-respec-builder.md` requires research, desired-versus-observed capabilities and preservation of binding Rules. `propose_project_requirements` validates capabilities and observable acceptance before using the existing Confirm UI and explicit configured auto-accept policy. Actual installer tests cover adoption and refusal. |
| 2. Durable register and coherent increments | Copy transitions in `respec-builder.ts` retain requirements, acceptance, statuses, tasks and evidence. The production adapter journals each adopted transition, and rejects tasks that do not map to open requirements. Core and wiring tests inspect durable state. |
| 3. Independent auditing | Agent tools can submit claims, but cannot supply verdicts. The adapter builds the existing isolated auditor contract, including prior capabilities as regressions. Detached-process and actual installer/agent-end tests exercise submission through terminal settlement. |
| 4. Carry unfinished work forward | Failed audits retain findings and reopen prior verified capabilities conservatively. Blockers retain reasons; abandoned batches retain history. Full-register scope changes require confirmation, record removals and invalidate previous proof. Core and wiring tests cover these transitions and refusal. |
| 5. Recovery and lifecycle ownership | Durable logical claim, timestamp, revision and retry cursor fence detached evidence. Finished exact-claim results recover without spawning; cancellation and object/session guards prevent late settlement. Detached tests cover reload, pause, concurrent wakes, archive failure and configured fallback retry. |
| 6. Honest completion | Only an independent approving verdict can verify requirements. Every adopted requirement must be verified before completion; archival precedes terminal settlement and queue announcement. `/loop finish` refuses unfinished projects. Bound tests preserve unfinished state without spawning, and existing supervised bounds are retained. |
| 7. Semantic UI | Project card/status expose phase, increment, coverage, blockers, evidence and action. Display tests cover widths 1/20/40/80/120 and prohibit italics. Reviewed 36 actual themed frames at 40/80/120 columns; selected preview is `respec-builder-2026-10-04/respec-builder.png`. |
| 8. Documentation and validation | README, command guidance, changelog and generated runtime inventory describe the builder and its seven tools. Package and lockfile versions are 0.39.0. Final release-gate results are recorded below once terminal. |

Worker tests launch real detached processes with bounded synthetic protocol
results. They prove dispatch, persistence and settlement behavior; they do not
claim that a live model independently evaluated this implementation. UI evidence
comes from the actual display code and themes. Tests use temporary project dirs.

## Validation

- Final focused tests: 48 passed across six files, zero failures.
- Full release gate: pending terminal result; do not treat this report as release approval yet.
- Oldest supported Pi boundary: pending final TypeScript result (0.84.2).

The full suite exposed a fixed-delay race in an existing stale-session recovery
test. Its assertions are preserved, while bounded waits now observe the new
continuation and durable recovery state. The isolated recovery test passes.
Earlier scope-refusal tests were corrected to explicitly disable draft
auto-accept in their fixtures, and an auditor call-site count was updated for
the new respec integration. These prior failed runs are not passing release evidence.
