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
| Shared projection/runtime | tests/ui-status-projection.test.ts; tests/ui-status-runtime.test.ts | Pending |
| All UI surfaces | tests/ui-status-surfaces.test.ts | Pending |
| Fleet view | tests/fleet-health.test.ts | Pending |
| Summaries and captures | summary suites; reproducible narrow/wide captures and native inspection | Pending |
| Independent rehearsal | Fresh-context reviewer report and disposition | Pending |
| Full release gate | timeout 1800 npm run release:check | Not run |
| Publish/install | synchronized patch metadata, CI, npm and installed version | Pending |

## Residual design risks

Silence is not death; stored schedules are not armed timers; partial fleet reads are not a clean health verdict. Manual holds and persistence fail-closed behavior must survive every rendering refactor. No sibling-project mutation or forced session reload is permitted.
