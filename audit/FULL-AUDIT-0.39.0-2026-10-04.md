# Full GLLA audit — 0.39.0 — 2026-10-04

Scope: GLLA commands/tools, durable state and ownership, goal/list/loop/respec
supervision, independent auditor dispatch/retry/settlement, provider and
compaction containment, UI/settings/receipts, and packaging/compatibility.
The chat session is an observed live case, not an authorization to modify chat
or external providers/plugins. No live project journal is edited by this audit.

Completion requires a current-source review and evidence for every surface
family, reproduction and disposition of concrete findings, affected behavioral
checks, current/oldest-supported host TypeScript checks, reviewed UI evidence,
fresh full release gate, and an explicit list of external/deferred limitations.
Earlier reports are pointers, not proof that current source is correct.

## Coverage register

| Surface family | Source and audit obligations | Disposition |
| --- | --- | --- |
| Commands and agent tools | Activation, goal-commands, goal-tools, loop command; contract adoption, consent, pause/stop/resume and truthful completion | Reviewed; current full gate passed |
| Durable state and ownership | goal-state/core, glla-state-root, state-root-owner, owner-file-protocol, goal-session; journal projection, archive, stale/foreign fencing | Reviewed; current full gate passed |
| Goal/list supervision | goal-orchestrator/list-queue, goal-heartbeat/continuation/recovery, dispatch, continuous-supervision; one active objective, queue loss, bounded recovery | Reviewed; current full gate passed |
| Loop/respec | goal-loop/forever/repetition, respec-builder/audit/runtime/ui; unfinished work, bounds, blockers, concurrent lifecycle and audit identity | Reviewed; current full gate passed |
| Independent auditor | auditor process/worker, hooks/surface, audit-lifecycle, reviewer, shield, auditor thinking/extensions; verdict integrity, retries, timeout/cancellation, stale settlement | Reviewed; current full gate passed |
| Provider/compaction containment | main-model-recovery, quota-retry, model selection, compactor, context/length/hygiene, compaction failure/input; finite recovery, external ownership and durable continuity | Reviewed; current full gate passed |
| UI/settings/receipts | display/ui/settings, components/pickers, drafts, summary renderer/outbox; readable state/actions, semantic truth, narrow widths, cancellation and delivery | Reviewed; current full gate passed |
| Distribution | manifests, schemas, prompts/skills, docs/inventory and scripts; boundary versions, installed package and worker RPC | Reviewed; current full gate passed |

## Findings

| # | Severity | Finding and repair | Evidence |
| --- | --- | --- | --- |
| 1 | High | A respec journal-write failure could clear live state: rollback retained an alias of the mutable singleton. All four rollback paths now snapshot the previous top-level projection. | Forced persistence failure preserves byte-identical RAM and the durable claim. |
| 2 | Medium | Respec could dispatch or retry while `/glla pause` froze supervision. Dispatch and retry policy now honor the freeze. Existing workers can still settle, consistent with global pause semantics. | Frozen entry launches zero workers; freeze between attempts launches no retry/fallback. |
| 3 | Medium | Rapid `/loop pause` and resume raced cancelled-worker cleanup, parking resumed work or losing its wake. Cancelled results cannot settle; releasing the latch rearms only the same project/era/claim. | A real worker is cancelled, its claim remains active, then a second worker completes it. |
| 4 | Medium | Continuous supervision omitted respec audit planes and same-iteration phase/revision changes. Builder identity and coverage now participate in its durable signature. | Building→auditing and scope refinement produce durable signals; auditing exposes the auditor plane. |
| 5 | Medium | `/loop resume` could reactivate a project whose remaining requirements were all blocked. Resume now refuses until a blocker is cleared. | Actual registered command remains paused; unblock preserves pause and enables explicit resume. |
| 6 | Medium | An undelivered project summary lost automatic replay when a new project replaced its loop. Project receipts now use the shared durable terminal outbox. | Failed delivery, loop replacement, successful single replay; corrupt outbox preserves approved job evidence for recovery. |
| 7 | Medium | Generic terminal-loop summary materialization overwrote independently verified project summaries. Verified project summaries are retained. | Production installation/commands/tools/agent_end integration verifies receipt and persisted summary parity. |
| 8 | Low | Large project summaries exceeded the shared outbox/receipt transport limits. Display now bounds requirements/reports/line lengths and explicitly names omissions; complete records remain in archive and status. | 100 requirements with long Unicode text and 100 reports remain ≤150 lines/2000 code points per line, with omission counts. |

The first five findings were reproduced together: **23 passed, 5 failed** before
repairs. The outbox replacement regression separately failed with **16 passed,
1 failed**. Moving receipts to the shared outbox exposed the generic-summary
overwrite in the production integration check. Summary bounds were checked
against the actual shared transport constants and then exercised with a large
Unicode project. These are distinct forms of evidence, not eight identical
red/green test runs.

Current focused lifecycle/receipt/UI verification: **53 passed, 0 failed** across
five files. Current and oldest supported host TypeScript checks passed. The
fresh full release gate passed with **3,224 passed, 1 skipped, 0 failed**
across 349 files (629.84 seconds for the test suite).

## Reviewed invariants and retained boundaries

- Registered project actions draft and confirm requirements and refinements;
  only isolated auditor settlement verifies requirements. Bounds, blockers,
  task claims, and infrastructure failures retain unfinished work.
- Durable state has one in-place singleton, full journal projections, explicit
  recovery clears, archive-before-terminal settlement and saved job recovery.
  Ownership covers stale sessions, state-root selection, process reuse and
  cross-process mutation; no live foreign state was changed by this audit.
- Queue activation hydrates sidecars, refuses an active loop, validates work
  objectives, refuses failed sidecar deletion and restores failed activation.
  Goal replacement commits successor intent before predecessor archival.
- Auditor recovery binds goal/revision/claim payload identity and worker request
  hashes. Approval requires tool evidence and contract regression coverage.
  Retry candidates/cursors and cancellation stay within the existing policy.
- Optional transcript compaction respects the configured threshold, idle task
  boundaries and episode hysteresis. Summary-cap failure keeps work usable
  rather than parking it. GLLA invokes public hooks; Pi owns summarization.
- Provider error classification, bounded retry ladders, quota-reset sleeps and
  context hygiene contain upstream failures. They do not repair providers or
  guarantee that a provider eventually returns usable output. Aggressive mode
  and quota recovery deliberately keep probing without an episode expiry;
  each attempt/delay remains bounded, and explicit user stops still win.
- Settings retain per-key project/global/default precedence, global-only keys,
  legacy migration, validation and explicit invalid-setting reporting. Public
  read-only command views all produced feedback.
- Package smoke installs the actual tarball and loads through Jiti with its own
  peer tree, then exercises the shipped worker RPC. Publishing remains owned
  by the tagged release workflow; an audit does not itself publish 0.39.0.

## Current UI and live case

Fresh production-renderer evidence includes **296** settings/picker/draft/card
frames, **144** registered command views and **54** project frames. Both themes
and narrow/normal/wide terminals are covered; all 350 rendered frames fit their
specified width. Representative settings, project lifecycle, live retry/activity
and semantic completion frames were inspected as terminal text. Behavioral UI
regressions additionally cover editing, cancellation, Unicode and stale saves;
frame generation alone is not a claim of live visual inspection.

At 20:53 London time the observed chat session was actively issuing tools for
the later icon-size request. Its prior detached audit had finished at 19:21,
with a successful result. A browser evaluation timeout was followed by successful
calls; no restart was needed. Earlier empty provider responses and the isolated
browser timeout are external behavior, not GLLA implementation targets. No chat
source, processes or runtime journals were altered.

## Final verification and disposition

`npm run release:check` completed with exit 0 on the repaired source:

- Full suite: **3,224 passed, 1 skipped, 0 failed**, 349 files. The skip is the
  environment-gated test of an actual watched auto-committer repository; this
  audit did not modify the daemon or claim a live daemon integration run.
- Current host 0.99.1 and oldest supported host 0.84.2: TypeScript passed.
- Jiti mutable-state split reproduction, hermetic auditor extension isolation,
  generated inventory consistency and npm dry-run packing: passed.
- Actual installed **0.39.0** tarball: extension imported, packed launcher
  loaded, shipped worker completed its bounded RPC challenge, and packaged
  delegate skill loaded without diagnostics.
- Focused lifecycle/receipt/UI checks: **53 passed, 0 failed**. All 350 fresh
  rendered UI frames fit their widths; all 144 command views gave feedback.
- Evidence is under `audit/full-audit-2026-10-04/`, including red/green logs,
  host checks, fresh frames, gate output and source provenance.

The eight concrete GLLA findings above are fixed and verified. No unresolved
implementation finding remains from this audit. This is a bounded source and
regression audit, not a guarantee that all possible bugs or provider behaviors
have been eliminated. Strict mechanical pre-checks remain deliberate: unusual
commands can fall through to the independent auditor rather than receive a
false mechanical pass. Provider recovery under aggressive/quota policy can
continue indefinitely, and host summarization remains upstream-owned.

The chat session subsequently posted its final successful icon-change result;
it did not require intervention. **0.39.0 is prepared and verified, not published
by this audit.** Publishing requires the repository's tagged release workflow.
