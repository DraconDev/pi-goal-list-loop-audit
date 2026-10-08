# Manual resume, targetless recovery and Designer opt-in — 2026-10-08

## Reports and boundary

Native inspection of screenshots `Screenshot_20261008_113848.png` and `Screenshot_20261008_111737.png` established two different cases:

1. Hegemon is paused on a user decision about benchmark acceptance, but `/goal resume` announces a preferred-primary probe and does not reactivate work. Read-only journal inspection confirmed paused/decision state plus `primaryProbeInFlight: true`, primary already selected, no retryAt or manual recovery hold. Its choices are real pending user choices, not permission for this GLLA repair to amend a performance contract.
2. The parent `web/games` screenshot shows ordinary conversation (three of fifteen games finished), no supervised goal/loop, and a standalone pending supervised-primary probe. `/glla resume` correctly finds no objective, while the recovery card incorrectly promises saved-work recovery through that command.

User also explicitly requested Designer default-off, considered only after selection. Existing GLLA sync always created/repaired its managed Designer definition at startup even without a role or model/thinking selection.

No game source, goal contract, runtime journal, live owner marker or game process was edited or restarted. Historical quota errors are not a current health verdict. No provider quota/health request was made.

## Changes

- Optional preferred-primary probing in `cmdResume` requires an ACTIVE supervised target. It cannot consume a paused goal's normal reactivation or a selected decision's resume. Genuine bounded provider-recovery holds retain their existing earlier paths.
- Decisions with options name `/goal decide` as their next action. The existing picker still delivers the chosen text, fences changed/stale decisions, resumes after delivery, and keeps work paused on Escape. The mechanism never silently rewrites acceptance.
- `/glla resume` with no goal, loop or waiting queue retires the obsolete recovery marker and explains ordinary-chat continuation. Persistence failure restores the marker in memory. Retirement is expressly not a provider-health success. No goal or continuation is invented.
- Standalone recovery guidance says to send `continue` for ordinary chat, instead of claiming GLLA work is saved/resumable when no objective exists.
- Managed Designer definition defaults absent. Explicit role selection (`Agent: Designer`/task role), explicit Designer model pin or thinking pin can enable its definition. Clearing the last opt-in removes only GLLA-marked content; user-owned agent files are preserved.
- Startup checks explicit goal/pending-task roles; an admitted live dispatch can materialize an explicitly selected Designer definition on demand. Prompt rendering alone does not write files. Designer directives remain conditional on explicit roles.

## Tests

`tests/manual-resume-failback.test.ts` uses registered runtime commands and isolated agent directories. It verifies: decision selection reaches durable ACTIVE state and real continuation dispatch while retaining the unchanged benchmark contract; cancelled picker preserves pause/contract; plain startup does not create Designer while an explicitly selected live goal creates its definition and receives the design directive; targetless resume clears obsolete metadata without dispatching/creating a goal/claiming provider health.

Existing subagent tests now assert the requested opt-in policy: default absence, explicit enablement, idempotent selected repair, removal on deselection, user-file ownership protection and pin inheritance. Display tests now require the actual decision picker command instead of the misleading resume path.

- Focused initial runs exposed legacy expectations that Designer was unconditional and decision next-action meant `/goal resume`. Those assertions were replaced with stronger tests of the explicitly requested new behavior.
- Static checking caught the commands dependency declaring the boolean runtime persistence result as `void`. Its signature now allows `boolean | void` (retaining embedding compatibility) and the retirement path checks explicit false.
- `timeout 240 bun test --timeout=60000 tests/manual-resume-failback.test.ts tests/subagent-model-override.test.ts tests/subagent-polish.test.ts tests/compaction-hold-resume.test.ts tests/main-model-recovery.test.ts tests/paused-status-action-first.test.ts tests/display.test.ts`: 165 pass, 0 fail. `/tmp/glla-resume-designer-focused3.log`.
- `timeout 120 npm run check`: exit zero. `/tmp/glla-resume-designer-types2.log`.
- Runtime inventory regenerated; `git diff --check` clean.
- First full release gate: 3396 pass, 1 skip, 1 fail. The sole failing test still required unconditional Designer creation (`designer-drafter-policy.test.ts`). Updated it to assert default absence and explicit role selection without a model pin; its read-only/no-model-pin assertions remain intact. Focused replay then passed 17 tests across two files.
- Second `timeout 1200 npm run release:check` reached the outer 1200s bound and exited 124 while still making progress; runner reported SIGTERM cleanup. This is NOT a passing full gate. `/tmp/glla-resume-designer-release2.log`. No timing threshold was weakened to turn that run green.
- Final expanded focused checks: 197 pass, 0 fail across 10 files, including actual resume/decision routing, Designer policy, stale-context admission, draft confirmation, provider recovery and display. `/tmp/glla-resume-designer-final-focused.log`.
- Final `npm run check`, `npm run check:inventory`, `node tests/repro-jiti-state-split.test.mjs` and `node scripts/release-pack-smoke.mjs`, each bounded: exit zero. Types, runtime inventory, shared-module identity, packed launcher/RPC challenge, skill loading and package import pass. Logs `/tmp/glla-resume-designer-final-{types,inventory,jiti,pack}.log`.
- Full-gate completion remains unverified after the timed-out run; no release publication/tag is authorized or performed.

## Operator guidance

After loading the local checkout fixes with `/reload`: Hegemon's pending choice is reopened by `/goal decide`. Choose the desired acceptance path; this repair has not approved the proposed replacement ceiling of 30,000 ms as equivalent to 16.7 ms / 60 FPS. In the parent games chat, send `Continue with the remaining 12 games`; `/glla resume` only clears obsolete recovery metadata when no GLLA objective exists. No live recovery success is claimed by this source-level repair.
