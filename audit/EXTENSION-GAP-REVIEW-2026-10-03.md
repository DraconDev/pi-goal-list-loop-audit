# Extension audit gap review — 2026-10-03

Follow-up to `EXTENSION-AUDIT-2026-10-02-PM.md` and the exported
`conversation-2026-10-03-063308.txt`. Scope: fix the stale completion-summary
assertion and directly inspect the bodies that the prior audit omitted.
Starting tree: `364e706e`, package 0.38.108. All implementation changes are
GLLA-owned. No external plugins, live Pi sessions, or git history were changed.
The sync daemon checkpoints the tracked changes normally.

## Findings and dispositions

- **Fixed, P1 — overlapping settings editors can admit a stale write.**
  `extensions/loops/goal-settings-ui.ts` stored the editor context in one
  module-global slot. A second editor, including one cancelled immediately,
  replaced that slot while the first awaited input. The old editor then
  checked the new editor's identity and could write settings. Every save now
  carries its own context explicitly. The interleaving regression fails with
  "Missing expected rejection" before the fix and passes afterward.
- **Fixed, P1 — narrow settings renders exceed Pi's line-width contract.**
  `extensions/settings-menu.ts` bounded individual cells, but fixed columns,
  minimum description width, title/tab floors, and help could still exceed
  the terminal. Bound every complete painted line at the renderer boundary.
  A regression checks widths 1/20/40/80/150 with descriptions on and off;
  it fails before the fix and passes afterward.
- **Fixed, P2 — empty similarity input saves zero.**
  The editor converted empty input with `Number("")` before checking for a
  reset. Check empty input first; explicit zero still saves zero. Regression
  fails on `0 !== undefined` before the fix and passes afterward.
- **Fixed, P2 — nested auditor model IDs lose their thinking picker.**
  The primary auditor editor split a ref on every slash, unlike the runtime
  resolver and other editors. A ref such as `openrouter/vendor/reasoner`
  was treated as unresolved/non-reasoning. Reuse `resolvePickedModel`, which
  splits at the first slash. The nested-ref regression observes no thinking
  prompt before the fix and one prompt plus a persisted max level afterward.
- **Fixed, P2 — approved summaries still show "await audit".**
  `withoutStaleNext` recognized "awaiting" but missed "await" and "waiting
  for". The pre-existing end-to-end communication tests reproduced stale
  audit-wait text after approval in both idle and busy host contexts. Extend
  the process-state verb match; concrete audit/review/settle actions retain
  their existing negative coverage.
- **Fixed — stale tests and release metadata.**
  The original done-notice pin now expects `sanitizeDisplayText`. Test mocks
  cross the production context boundary explicitly; held-loop tests use the
  actual loop type rather than incompatible dictionary casts. The stale-save
  fixture restores the configurable runtime-global descriptor rather than
  assigning to its read-only getter, and checks the normalized false default.
  The S9 test proves the recovery stamp was durable before dispatch and was
  consumed after one notice delivery. Other old assertions now check semantic
  no-tool disapproval in output (with no infrastructure error), the complete
  disk-first function body, and text retained past a short clause boundary.
  The list-conflict integration test now pins the shipped C7 rule: decline
  ends the update, leaves the queue intact, and opens no retry editor. Lockfile
  root metadata and the documentation index now match package 0.38.108.

## Coverage of the previously omitted bodies

- `goal-loop-core.ts` 500–1110: gate sanitization and bounds, pending-claim and
  goal contracts, telemetry extraction/recording, goal routing, list imports,
  user-seed normalization, drafting mutation gates, and list text routing.
- `goal-loop-core.ts` 3380–4440: display sanitization, timestamp freshness,
  queue ordering/visible positions, revision tokens, task helpers, restore
  consent, durable/defer normalization and policy, contract/declaration
  parsers, session ownership, tool visibility, aggressive defaults,
  objection/severity extraction, sentinels, and mode recommendations.
- `goal-loop-core.ts` 4530–4965: think-block stripping, streamed audit logs,
  retry classification/guards, eviction filtering, identical-failure tracking,
  fresh-cycle clearing, retry-once lifecycle checks, and lifesign projections.
  Inspected persisted identical-streak validation and runtime park consumers
  as well as `trackAuditorIdenticalFailure` itself.
- `goal-settings-ui.ts`: directly read the save wrapper, menu admission loop,
  model/thinking resolvers, multi-picker normalization, and every setting
  dispatcher. `settings-menu.ts`: directly read row construction and the
  renderer/navigation/caching bodies.
- Watchdog thresholds: directly read auditor timeout escalation, effective
  tool grants, tool-cancel grace, fresh-heartbeat/no-progress, stale-heartbeat,
  and first-event budgets; inspected the actual parent cancellation branches.
  Read heartbeat overdue-wait, stranded-claim, pending-latch, zombie and wedge
  branches, plus child hang classification, ownership, action revalidation,
  and escalation settings. Open tools retain their independently granted
  budgets; human-input waits retain their exemption.
- `main-model-recovery.ts` 258–456: directly read capped exponential and
  transient ladders, first retry, quota-reset precedence, probe delay routing,
  and horizon exemption. Also read adjacent classifiers and timer consumers.
- The old `s9-probe.mjs` is absent from the repository and `/tmp`. Its behavior
  was revalidated through the tracked overdue-backstop tests: real heartbeat
  invocation, durable continuation-route resume, and no-op probe settlement
  releasing its latch for a second heartbeat. The original ephemeral script
  was not recovered or claimed as rerun.

This closes the named omissions through direct body review and behavioral
checks. It is a bounded follow-up audit, not a claim of exhaustive coverage
of the entire repository or a fresh live-fleet survey.

## Verification evidence

Evidence directory: `extension-gap-review-2026-10-03/`.

- `settings-red.log`: two controls pass, three new settings regressions fail
  before implementation. `menu-red.log`: 31 pass, new width regression fails.
- `settings-tests.log`: 101 pass, 0 fail across editors, picker, menu,
  objective-conflict and held-loop tests.
- `final-focused.log`: 46 pass, 0 fail including the corrected S9 and settings
  admission assertions, current narrow renderer and settings regressions.
- `repair-verification.log`: 224 pass, 0 fail across summary, communication,
  version, disk-first, auditor-process, and display suites.
- `contract-repairs.log`: both targeted docs-version and list-decline checks
  pass; unrelated tests are filtered intentionally in this targeted run.
- `baseline-failures.log`: read-only archive of starting commit 364e706e
  reproduces all six summary/metadata/pin failures in five files (196 pass,
  6 fail). Dependencies were shared; the working checkout was not rewound.
- `gap-tests.log`: initial serialized gap verification reports 177 pass and
  one stale S9 assertion, subsequently corrected and verified above. The
  initial un-serialized attempt hit Bun's nested-test limitation; it is not
  accepted as behavioral evidence. No Bun/provider fix was attempted.
- `test-all.log`: diagnostic full-suite run caught stale assertions and was
  stopped through its own runner before starting the final full-suite run;
  it is not a green gate. Final complete-run result is recorded below.

Final full-suite and gate results: verification in progress.
