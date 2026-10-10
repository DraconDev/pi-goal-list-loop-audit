# UI redesign implementation and evidence register

Status: in progress. No implementation or release verification is claimed.

## Designer checkpoint

Run `caf4d4f3-5c65-4ff3-914a-a73cdc7a334d` failed on provider error: `Server requested 133400s retry delay (max: 30s). 429 Subscription quota exhausted.` Status tool confirms failed; saved output contains the brief only, no findings. Repo/cwd: `/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit`, branch `main`, no managed worktree. At failure assessment there were no tracked changes; unrelated untracked `folder-auto-banner/` is left untouched. No reset time is used as a scheduling dependency. The contract explicitly authorizes an inline fallback; `docs/UI-STATUS.md` records it.

## Verified source findings

- `work-lifecycle.ts` already separates lifecycle control authority from observed activity. New UI health must be a presentation projection, not a second dispatch authority.
- `audit-lifecycle.ts` projects durable claims. Stored phase and timestamps do not independently prove surviving worker execution.
- `goal-recovery.ts` exposes runtime regular/hourly timer observations, active/queued turns, switch-in-flight and hold diagnostics. Adapter identity checks are needed before these facts are attributed to a particular work item.
- `goal-ui.ts` supplies `compactAuditCard:true` in production. Both compact and detailed render paths must be exercised.

## Milestone evidence

| Milestone | Evidence | State |
| --- | --- | --- |
| Design/source mapping | docs/UI-STATUS.md; inline checkpoint above | Initial checkpoint recorded; further integration research pending |
| Shared projection/runtime | extensions/ui-status.ts; extensions/ui-status-runtime.ts; tests/ui-status-projection.test.ts; tests/ui-status-runtime.test.ts | 15 projection/adapter tests pass; types clean. Broader mode matrix and live integration regressions pending |
| All UI surfaces | tests/ui-status-surfaces.test.ts; goal-ui.ts production adapter; goal-loop-display.ts shared card/footer; goal-commands.ts goal/glla status | Cohesive rail/model/meter style restored in response to user screenshots, with ANSI-aware narrow clipping and action-first prerequisites. Goal/glla commands now open with shared projection and distinguish saved audit phase from worker liveness. Command behavioral regressions, remaining mode surfaces, notifications and project-audit evidence integration pending |
| Fleet view | extensions/fleet-health.ts; tests/fleet-health.test.ts; /glla fleet command/completion; fleetHealthRoots setting; docs/UI-STATUS.md fleet boundary | Implemented: 10 tests pass (configured roots, bounds, malformed/latest-invalid state, permission-denied reads, explicit closure, saved retries, immutable siblings, command zero-dispatch). Combined fleet/projection/runtime/surfaces gate: 29 pass, 0 fail; npm run check exits 0. No sibling-session reload or process probes. Full release suite remains pending |
| Summaries and captures | audit/UI-CAPTURE-INSPECTION.md; audit/ui-captures/{40,120}.png; scripts/ui-status-capture.ts; scripts/capture-ui-status.py | Actual private-xterm narrow/wide renderer captures produced and inspected natively. User older/newer screenshots inspected through native cropped originals. Summary chat removes redundant Next/Unresolved bullet labels while archive formatting remains intact. Targeted surface/summary cases: 41 pass, 0 fail within the combined six-file gate (66 pass, 0 fail); types include the generator. Narrow crops were inspected natively after the ANSI clipping fix. Later integration changes require recapture; release gates still pending |
| Independent rehearsal | Fresh-context reviewer report and disposition | Pending |
| Full release gate | timeout 1800 npm run release:check | Not run |
| Publish/install | synchronized patch metadata, CI, npm and installed version | Pending |

## Residual design risks

Silence is not death; stored schedules are not armed timers; partial fleet reads are not a clean health verdict. Manual holds and persistence fail-closed behavior must survive every rendering refactor. No sibling-project mutation or forced session reload is permitted.
