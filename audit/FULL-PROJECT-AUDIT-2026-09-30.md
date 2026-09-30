# Full project audit — 2026-09-30

GLLA has substantial recovery and verification machinery, but its strongest
claims are ahead of a few implementation boundaries. Prioritize pipeline
crash containment, ownership, process cleanup, and truthful release results before adding more autonomous
behavior. Then simplify the runtime and improve the quality of lifecycle tests.

This is an audit and improvement plan. Runtime fixes, dependency upgrades,
releases, and changes to external plugins are not part of this change.

## Baseline and method

- Reviewed source baseline: `d959206a8cf4dd978405c1195206e4ce8120b357`,
  package `0.38.105`; Node `22.22.2`, Bun `1.3.14`, Linux.
- Initial working tree was clean. The sync daemon committed audit artifacts
  during the review. Source changes must be checked separately from HEAD:
  `git diff d959206a -- extensions scripts tests package.json package-lock.json`.
- Inventory: 70 extension TypeScript files; 61,675 lines across extension
  TypeScript and script JavaScript; 310 test files (`*.test.ts` / `*.test.mjs`).
- Reviewed architecture and user contracts, lifecycle and persistence seams,
  auditor dispatch/settlement, continuation/watchdogs, process launch/teardown,
  command/tool registration, settings, context projection, UI delivery,
  packaging, release workflow, dependency advisories, and prior audit evidence.
- Executed the full release command, independent downstream gates, an offline
  context measurement, package inventory, and disposable subprocess probes.
  No provider calls, live user sessions, upstream edits, history rewrites,
  publishing, or operating-system repairs were performed.
- Reproducer: [project-audit-2026-09-30-probes.mjs](project-audit-2026-09-30-probes.mjs).
  Run with `node audit/project-audit-2026-09-30-probes.mjs` from this checkout.
  It creates temporary files and stub processes, then cleans up its own resources.

This is a project-wide assessment, not a line-by-line certification. Large
command/tool modules were examined at registration, validation, persistence,
and lifecycle boundaries. A mock or stub success does not establish real-host
or provider correctness. Findings below distinguish executed reproductions,
source-proven gaps, and design recommendations.

## Coverage and existing strengths

| Area | Evidence reviewed | Assessment |
|---|---|---|
| Entry/lifecycle | `loops/goal.ts`, activation/session/orchestrator, registered events | A real lifecycle spine exists; ambient dependencies still make ownership and teardown difficult to reason about. |
| Goal/list/metric loops | tools, command routing, queue promotion, loop bounds, promotion contract | Explicit separation and durable activation contracts are useful; preserve them during refactoring. |
| Persistence/recovery | state singleton, ledger rotation, transaction and archive journals, sidecars, ownership | Revision and archive fences are strong; exclusive ownership acquisition has a reproducible publication gap. |
| Auditing | parent process, RPC worker, hashes, tool floor, regression shield, tiers, settlement | Request identity and revision validation meaningfully reject stale results; completion delivery is not yet one recoverable transaction. |
| Continuation/supervision | continuation, heartbeat, quota/model recovery, compaction | Many failure classes have explicit policy; an old-generation child probe can still delay current watchdog action. |
| Context/input | payload guard, context hygiene/checkpoint, compactor | Projection preserves transcripts and tool-result pairings; byte/count floors are deliberately best effort. |
| UI/settings | display, completion renderer/outbox, pickers, settings provenance/ranges | Durable receipts and provenance are good foundations; receipt size and stored-card bounds disagree. |
| Tests | runner, harness, behavioral/source tests, release gates | Broad coverage, with real subprocess and state-sharing tests; source pins currently overstate teardown guarantees. |
| Distribution | manifest, npm inventory, packed import/worker/skill smoke, GitHub workflow | Testing the actual installed tarball is a significant strength; compatibility and release evidence should be version-bound. |
| Documentation | README, INSTALL, architecture/settings/release/promotion docs, audit index | Useful operator material, but contradictory defaults and stale audit summaries undermine it. |

Other protections worth keeping: safe persisted-ID checks, a single state
owner, explicit global-only resume consent, archive-before-success delivery,
bounded auditor tool execution, sanitized display diagnostics, and OIDC
publishing without a long-lived npm token.

## Prioritized findings

P1 means fix before relying on the affected guarantee. P2 means schedule
promptly. These priorities describe GLLA consequences, not advisory CVSS scores.

### F1 — P1: exclusive owner acquisition can replace an in-progress claimant

**Executed reproduction.** In `extensions/loops/goal-session.ts`,
`claimProcessOwner` creates `owner.json` with `openSync(file, "wx")`, then
writes its JSON. Another process observing the file between those calls sees
`readOwnerFile` return null. The `!owner` branch unlinks it immediately and
successfully creates its own record. The comment promises that a malformed,
recent record blocks acquisition, but there is no age check in that branch.

The probe holds the first exclusive descriptor open, calls the real claim
function in a second process, then finishes writing the first descriptor.
The contender reports `claimed: true`; the first descriptor's inode no longer
names `owner.json`. The first claimant's write/close path can therefore finish
successfully after its published lock was replaced.

This establishes a race in the primitive, not observed simultaneous goal
corruption. Later ownership checks and deliberate main-host supersession may
contain it; they do not make this acquisition atomic. Preserve the intended
last-wins host policy while preventing accidental claims through partial JSON.

**Improve:** separate exclusive acquisition from owner metadata publication;
refuse fresh unreadable records, and validate identity when reclaiming stale
ones. Use one protocol for acquisition, refresh, shutdown, and takeover.
**Acceptance:** two real competing processes at the create/write and stale
reclaim boundaries cannot both obtain unrevoked ownership.

### F2 — P1: interruption can produce a successful test-runner exit

**Executed reproduction.** `scripts/run-tests.mjs` handles SIGTERM/SIGINT by
terminating the child, but does not retain an interrupted state. `done`
propagates the child's exit code unless a stall fired. A cooperative child
that exits zero on SIGTERM makes the interrupted wrapper exit zero.

The probe signals the real wrapper after its stub runner is ready and gets
`code: 0`, even though no suite completed. This is a false-success path in
the test wrapper; no actual GitHub cancellation was reproduced.

**Improve:** record interruption independently of child status and return
a nonzero exit after cleanup. **Acceptance:** real signal tests cover
SIGINT/SIGTERM with children that exit zero, fail, and ignore TERM.

### F3 — P2: the runner cannot deliver its documented orphan-free guarantee

**Executed reproduction plus production-source trace.** Killing the Bun
process group does not reach a descendant that creates another group.
`extensions/goal-loop-auditor-process.ts` intentionally starts workers with
`detached: true`. In addition, `takeDown` stops escalating after the direct
child exits, even if a descendant in the original group survives.

The probe's detached descendant remains alive after wrapper teardown while
the wrapper announces “no orphan.” Current runner tests mostly assert that
signal hooks, negative-PID kills, and the detached spawn text exist. Those
assertions pass without proving descendant cleanup.

**Improve:** give test-created workers an explicit lifecycle registry and
teardown responsibility, including groups whose leader exits. Do not remove
production detachment merely to satisfy the test runner.
**Acceptance:** launch a real detached worker and a TERM-ignoring descendant,
interrupt the suite, and prove all owned descendants stop without touching
unrelated processes.

### F4 — P2: terminating the emergency compactor worker leaves Pi alive

**Executed reproduction.** `scripts/goal-compactor-worker.mjs` has no parent
termination handler forwarding cleanup to its Pi child. The parent timeout
in `extensions/goal-compactor.ts` kills the worker PID. If that fallback is
needed while Pi survives, stopping the wrapper does not stop Pi or descendants.

The probe starts the real worker with a stub Pi process, SIGTERMs the worker,
and observes the Pi child still alive. The auditor worker has considerably
stronger process-tree termination machinery than the compactor.

**Improve:** share a contained subprocess lifecycle implementation across
auditor and compactor workers, retaining their different execution policies.
**Acceptance:** cover parent timeout, signal interruption, ignored TERM,
inherited pipes, and result-write failure with real subprocesses.

### F5 — P2: supported outbox summaries can exceed the receipt reader's limit

**Executed reproduction.** `approval-render-store.ts` accepts 150 lines of
2,000 code points each. `terminal-summary-delivery.ts` reads only the final
256 KiB of session JSONL and discards the first partial record. A summary
whose single JSONL record exceeds that limit cannot be confirmed, even when
its exact receipt is the final complete record on disk.

The probe persists a supported 140 × 2,000-character card in the real outbox.
Its 280,427-byte receipt is not confirmed; a small receipt is confirmed.
Same-session branch matching prevents immediate resends, but the pending
outbox can remain unresolved and replay in a fresh session. Typical-card
incidence was not measured.

**Improve:** bound serialized receipt bytes consistently, or use a bounded
reverse-record reader with an explicit maximum record size large enough for
every supported card. Account for UTF-8 and JSON escaping, not just characters.
**Acceptance:** supported maximum ASCII, Unicode, and escaped cards acknowledge
their exact durable receipt without accepting partial or unrelated records.

### F6 — P2: approval archive and terminal-summary outbox have a crash gap

**Source-proven ordering; no crash injection in this audit.**
`settleApprovedCompletion` in `loops/goal-auditor-hooks.ts` calls
`archiveCurrentGoal` before `persistApprovalRender`. Archiving clears the
live goal. A process death between those operations leaves an archived
completion without a queued summary; the settling-claim recovery entry no
longer has a live goal to re-drive. The archive survives; the notification
obligation may not.

This was left open in the previous audit and remains open here.
**Improve:** journal the render obligation as part of settlement and only
permit delivery after the archive is durable. Simply delivering earlier
would violate the existing success gate.
**Acceptance:** terminate/restart at each settlement boundary; preserve
both truthful terminal state and eventual deduplicated summary delivery.

### F7 — P2: stale-generation child probes can stand down a new watchdog

**Source-proven condition; no live-host incidence measured.**
`hasHealthySubagentHangProbe` in `goal-heartbeat.ts` does not check
`probe.ownerGeneration`. Action dispatch does check generation. The registry
is not cleared by production session rebinding; its explicit clear helper
is test-only. An old event-only probe can remain “healthy” for the longer
event-evidence window and suppress the current parent's zombie watchdog.

**Improve:** use the same generation eligibility rule for health, stale
classification, display, and action, and retire superseded probes during
rebinding. **Acceptance:** an old probe cannot stand down a new generation;
fresh same-generation progress still prevents inappropriate aborts.

### F8 — P2: README contradicts itself about the auditor's default isolation

**Direct documentation/code comparison.** README's audit explanation says
the auditor defaults to no extensions and needs a plain-Pi model. Its
“Model and auditor requirements” section correctly says it mirrors session
extension packages by default. `effectiveAuditorAllowedExtensions` uses
`mirrorSetting !== false`, so the latter matches implementation.

This matters when choosing provider-extension models and deciding what code
the auditor loads. **Improve:** describe fresh-session independence,
extension mirroring, opt-out, and OS permissions consistently across README,
INSTALL, settings UI, and architecture docs. **Acceptance:** one executable
default-behavior fixture supports all operator-facing descriptions.

### F9 — P1 verification issue: the current release gate is not green

The full `npm run release:check` run has recorded failures. Retain its first
result, distinguish isolated reruns from whole-suite evidence, and diagnose
timing/shared-state failures rather than relabeling a later pass as proof
that the original gate passed. Final totals and isolated dispositions are
recorded in the verification section below.

**Improve:** real event/receipt synchronization for worker tests, explicit
process-state reset per behavioral fixture, and actionable failure artifacts.
Several failing worker assertions use fixed two-second observation deadlines.
Host load was observed at 97.34 during this audit; it is context, not proof
that every failure is caused by scheduling.

### F10 — P2 evidence quality: prior audit summaries are not dependable baselines

The current manifest says `0.38.105`, while `FULL-AUDIT-2026-09-29.md`
describes `0.38.109 → 0.38.110`. The audit index says all 12 findings were
fixed and that heartbeat was unread, while that report describes open
findings and a subsequent heartbeat review. These documents should not be
used as current-state release proof.

**Improve:** a short current findings register with stable IDs, explicit
open/fixed/deferred/external dispositions, source SHA/tree digest, command
exit codes, evidence paths, and verified scope. Keep historical reports
immutable and label their applicability instead of rewriting old evidence.
**Acceptance:** every “fixed” entry points to a current regression or durable
verification result; the index agrees with the report it summarizes.

### F11 — P2: the test isolation composite omits a newly added retry reset

**Full-suite failure and direct source confirmation.**
`goal-activation.ts` exports `__testOnlyResetUnsupervisedErrorRetry`, which
clears its unsupervised retry timer, streak, and delay override. The per-file
reset composite in `loops/goal.ts` neither imports nor invokes it, although
the harness relies on that composite to restore process-local state.
`process-state-reset.test.ts` catches the missing member.

This is a deterministic membership defect, not merely a slow-host timeout.
It establishes incomplete fixture isolation; it does not establish that
this omitted reset caused the other failures in this run.
**Improve:** include the reset and a behavioral poison/reset proof; make new
runtime latches register their reset obligation at the owning boundary.
**Acceptance:** the membership gate and a poisoned unsupervised retry fixture
both pass in isolation and in the full serialized suite.

### F12 — P1: a permitted mechanical pipeline can crash its hosting process

**Executed reproduction.** `runMechanicalFilterStage` in
`goal-loop-shield.ts` writes the head's buffered output into a child stdin
without an `error` listener on that writable stream. Its synchronous
try/catch does not catch asynchronous stream errors. A permitted filter such
as `head -n 0` exits without consuming input; a noisy head then raises an
unhandled `EPIPE`, terminating the process running the mechanical check.

The probe invokes the real `runMechanicalPreAuditChecks` in a disposable
Node process with a 65,536-character output fixture and `| head -n 0`.
That process exits 1 with an unhandled `write EPIPE` at the filter's stdin
write. No Pi process or provider was needed. Any Pi-host-specific global
error handler was not tested; the helper itself fails to contain the error.

**Improve:** handle filter-stdin errors before writing and settle the stage
once; treat expected early pipe closure consistently with head-exit semantics.
Preserve actual head failures, cancellation, and diagnostic containment.
**Acceptance:** noisy checks through early-closing `head`/`grep` filters cannot
terminate the caller; failing heads remain failures and cancellation stays bounded.

## Further improvements, separated from defects

### Runtime architecture

The six largest extension files contain 21,292 lines, about a third of the
extension/script total. The compatibility registry still has 183 ambient
names and a broad `(...args: any[]) => any` callable type. File extraction
has improved navigation, but much of the call graph still depends on global
initialization order and shared singleton lifetime.

Retire the bridge by subsystem: inject a typed runtime context into
settlement, ownership, continuation, and supervision first. Define transitions
and their durable obligations explicitly. Keep the one state owner; avoid
splitting it into independently mutable module copies. Target a measurable
reduction in globals and lifecycle-reset responsibilities per extraction.

### Tests and compatibility

Keep source pins for genuinely load-bearing wiring, but pair ownership,
teardown, delivery, and restart pins with behavioral proofs. Existing source
assertions on runner cleanup missed F2/F3. Of 310 test files, 207 read files;
this is a review signal, not a claim that all 207 are source-only tests.

Add deterministic event-sequence coverage for pause/resume, rebind, takeover,
completion, compaction, and delayed verdict races. Fault-inject persistence
operations and process exits at transaction boundaries. Prefer invariants
(one admitted writer, immutable terminal archive, no stale verdict application,
no success before archive, eventual queued receipt) over implementation text.

Manifest peers are `*`, while development Pi packages use `^0.84.2`.
The installed-tarball smoke resolves a separate peer tree, which is valuable,
but is not a supported-version matrix. Declare the tested compatibility
range and exercise its lower boundary and intended current release, plus
actual Windows/macOS process semantics when support is claimed. Do not
patch Pi or pi-subagents to create missing integration seams.

The release workflow has no live-model smoke stage. The tmux harness and
live-compaction verifier are separate facilities. Schedule opt-in real-host
canaries with recorded versions and bounded spend; keep release validation
hermetic. Stub RPC and MockPi coverage must remain labeled as such.

### Dependency and execution boundary

`npm audit --omit=dev --json` reported zero advisories in its audited subset.
The full installed dependency audit reported three affected package entries:
`@earendil-works/pi-coding-agent` (moderate aggregate), `brace-expansion`
(high), and `undici` (high). These are upstream dependency findings, not
demonstrated GLLA exploits; the production-only result does not certify
externally supplied Pi peers. Retain the raw advisory response with evidence.

GLLA owns its manifest/lockfile and compatibility validation: evaluate a
supported dependency update in a separate change with the full gate.
Upstream remediation belongs upstream. Do not run a blind force upgrade or
modify external packages in this repository.

The auditor is a fresh verifier, not an OS sandbox. Extension mirroring and
its bash tool mean loaded code and verification commands may write files.
For users requiring stronger isolation, document a separate filesystem and
permission boundary. Keep evidence text separate from trusted instructions.

Challenge failure currently preserves a round-one approval and records a
skip; that is documented policy, not a newly discovered defect. Consider an
explicit stricter option for high-risk contracts and make skipped challenges
visible in completion evidence. Measure challenge flip/skip rates before
changing the default or removing convergence safeguards.

### Persistence, performance, and operator experience

Clarify process-crash recovery versus power-loss durability. Most journals
and outbox writes use rename without file/directory fsync; atomic replacement
alone does not establish survival of sudden storage loss. Choose the needed
durability level, then test and document it.

Measure cold load, ledger rotation, heartbeat work, audit retry/challenge
cost, and outbox growth with large fixtures. Do not infer performance from
file size. The offline context-growth script ran successfully and uses
synthetic usage; it does not measure paid provider token savings.

Keep a concise status surface explaining current work, last real progress,
why it is paused/retrying, and the available action. Add failure-age and
retry/challenge outcome metrics derived from the ledger rather than extra
polling. The context-starvation notification latch also remains an open
low-priority concern: it resets only after the heartbeat reaches its refire
path, so another busy-window episode can lose its warning.

Local README/INSTALL/docs Markdown links checked in this audit resolved.
The architecture's approximate test counts and audit index are stale.
Generate small inventories from code and establish one authoritative settings
and compatibility description instead of duplicating prose defaults.

There is also a repository-policy conflict: AGENTS asks for commits after
goal-state changes, while `.gitignore` explicitly excludes runtime
`.pi-glla/` state. Resolve the intended policy with the repository owner;
do not force-add runtime state or edit the daemon-managed ignore block as an
audit side effect.

## Recommended sequence

1. **Establish trustworthy ownership and validation:** F12, F1, F2, F11, diagnose F9.
   Completion criterion: competing-process and cancellation regressions pass,
   with a clean full gate on a recorded source tree.
2. **Close lifecycle leaks and delivery gaps:** F3–F7, then F8.
   Completion criterion: real teardown and crash-restart tests prove the
   lifecycle obligations, and supported cards acknowledge durable receipts.
3. **Reduce future regressions:** retire globals subsystem by subsystem,
   strengthen event/transaction tests, publish a compatibility matrix, and
   refresh dependency validation and evidence provenance (F10).
4. **Tune from measurements:** context/audit costs, recovery latency, long-run
   canaries, and clearer operator surfaces. Preserve the existing consent and
   ownership policies while tuning autonomy.

## Verification

Independent gates completed:

| Command/check | Result |
|---|---|
| `npm run check` | Exit 0; strict TypeScript check passed. |
| `node tests/repro-jiti-state-split.test.mjs` | Exit 0; one behavioral state-sharing test passed. |
| `node scripts/verify-auditor-extensions-offline.mjs` | Exit 0; resolved extension registered its fixture model without a temporary install. |
| `node scripts/release-pack-smoke.mjs` | Exit 0; installed tarball imports, launcher/RPC worker challenge, and Pi skill loading passed. |
| `npm pack --dry-run --json` | Exit 0; 115 entries, 1,533,517 packed bytes / 4,305,098 unpacked bytes. |
| `bun scripts/measure-context-growth.mjs` | Exit 0; synthetic measurement completed. |
| Disposable audit probes | Wrapper exit 0; F1–F5 and F12 reproduced, including the small-card receipt control. The contained F12 child exits 1 with unhandled EPIPE. |
| Dependency advisory checks | Production subset clean; full installed tree has 3 affected package entries. |

Full-suite totals and focused reruns are pending the existing live release
process. This report must not be treated as finished release evidence until
that process is terminal and its result is recorded here.

No live-provider, real-Pi interactive session, Windows/macOS runtime,
power-loss, published registry/remote-history reconciliation, or fleet
incidence checks were performed. Those limits do not retract the local
reproductions and are not claims of external defects.
