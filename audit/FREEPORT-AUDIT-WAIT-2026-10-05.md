# Freeport: repeated audit attempts looked stuck

Read-only inspection at approximately 18:21–18:27 UTC on October 5. Correct
terminal mapping was refreshed by cwd before interpreting Freeport's UI.
The saved project remained active and auditing increment 5; its live worker
was present, with recent tool completions. It completed additional commands
while this investigation ran. No live session, worker or external project
was changed or resumed.

Earlier physical jobs for the same logical claim ended on user abort,
provider empty responses and a challenge-round bash timeout. The previous
65-minute attempt failed; the replacement began around 17:45 UTC and was
about 36 minutes into its first pass when checked. The terminal's 1h42m clock
included earlier attempt time. The current worker was issuing bounded waits
while checking verification output. This is costly repeated verification,
not evidence that the current process is frozen. Provider failures and
Freeport's test implementation remain outside GLLA's implementation boundary.

## GLLA-owned display gap

The project audit progress adapter reduced structured tool telemetry to
`tool: bash`. Unlike ordinary goal audits, it discarded the tool start,
effective timeout and pass, and exposed only the overall clock. That made a
healthy tool wait and repeated attempts difficult to distinguish from a stall.

Prepared 0.39.9 retains those fields. Project cards and footers show the
current tool's ticking elapsed/timeout clock and second-pass identity, with
separate current-attempt and total clocks. Attempt startup clears obsolete
tool fields. Waiting text is admitted only for live running/tool-executing
telemetry with valid clocks inside the granted watchdog budget; cancelled,
retrying, overdue and invalid records cannot claim a healthy tool wait.

The regression drives the actual detached worker/progress bridge with a
granted 20-minute tool budget over the default five minutes. It failed before
the adapter change. Display coverage checks advancing clocks, attempt/total
distinction, cancellation, invalid/future clocks, expired budgets and tool
completion. Verification: 26 tests passed across two files; TypeScript, inventory and
whitespace checks passed. Results are retained alongside the observation.
The full release gate was not run for this prepared version.

0.39.9 is prepared, not published. The loaded Freeport session showed 0.39.8.
Its current worker was left running; no repeated resume or restart is needed
while it continues producing tool completions.
