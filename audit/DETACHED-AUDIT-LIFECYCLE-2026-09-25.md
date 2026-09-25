# Detached audit lifecycle and settlement — v0.38.99

**Goal:** make detached audit lifecycle and settlement legible — represent
starting, running with last activity, settling, approved, and recovery-needed
states; never render an unresolved audit as terminal completion; preserve
durable state across restart and expose a real recovery path.

**Verdict:** shipped. The lifecycle is one pure projection
(`extensions/audit-lifecycle.ts`), the settlement is one durable transaction
with one re-drivable driver, and the state survives a real cold reload.

## The defect class this closes

The stored completion claim carried three phases — `running`,
`recovery-pending`, `retry-waiting` — and an **absent** phase where absent
silently meant "interrupted". That produced three concrete lies:

1. **The launch window was invisible.** `beginCompletionAudit` wrote
   `phase: "running"` before the detached worker existed. A claim that was
   durable but had no worker was indistinguishable from one with a live
   auditor — and, because absent meant "interrupted", indistinguishable from
   an abandoned one.
2. **"Running" had no last activity.** The worker's activity evidence
   (`lastActivityAt`) lived only in the in-process HUD. After a restart the
   in-process watchdog does not exist, so a claim left `running` by a crashed
   host read exactly like a live one.
3. **The settlement window had no representation at all.** The approval path
   cleared the claim (`updateGoal({ auditHistory, pendingCompletion: undefined })`)
   and *then* archived. A crash — or a failed write — between those two steps
   left a goal whose only durable trace was `auditing`, with the approved
   verdict surviving nowhere but the terminal chat card. On an archive
   failure the claim was dropped outright, so nothing could re-drive it.

## The lifecycle

`extensions/audit-lifecycle.ts` is a pure module (no state singleton, no
filesystem, caller-supplied `now`) that projects the whole lifecycle from the
stored claim. Every surface — widget, status line, goal markdown, restart
recovery, settlement driver — reads that one projection, so they cannot
disagree.

| State | Durable evidence | Terminal? |
| --- | --- | --- |
| `starting` | claim durable, no worker event yet (`phase: "starting"`, `startedAt`) | no |
| `running` | attempt in flight; `lastActivityAt` refreshed by the throttled progress writer | no |
| `settling` | approval applied durably (`phase: "settling"`, `verdictAt`); archive owed | no |
| `approved` | settlement complete — archive landed, summary queued | **yes** |
| `recovery-needed` | parked after interruption / no-progress / failed settlement | no |
| `retry-waiting` | one bounded automatic retry armed (`recoveryRetryAt`) | no |

Deliberate design decisions:

- **No `approved` persisted phase.** The terminal archive releases the claim,
  so an approved claim cannot outlive its own settlement. `approved` is a
  *settlement* state, reported by the settlement driver that reached it — an
  unresolved claim must not be able to look approved. `normalizeAuditPhase`
  maps a bogus `approved` phase to `recovery-pending` on read.
- **Legacy claims are interrupted claims.** An absent or unknown phase
  projects to `recovery-needed` — the truthful reading — never to a terminal
  one.
- **Evidence, not invention.** A claim with no usable timestamp reports no
  activity; a future stamp clamps to zero age; `lastActivityAt` is never
  back-filled from the claim's own age.
- **Terminality is gated once.** `settlementAllowsTerminalRender` requires a
  durable verdict **and** a landed archive before any terminal surface
  (archive card, summary outbox, external notification) may claim completion.

## The settlement transaction

`settlementStep()` fixes the ordering in one place, and
`settleApprovedCompletion()` in `extensions/loops/goal-auditor-hooks.ts` is
the single driver with exactly two callers — the live path and the restart
path — so both obey the same rules:

1. **persist-verdict** — `updateGoal({ auditHistory, pendingCompletion: { …,
   phase: "settling", verdictAt } })`, checked. A failed write parks the claim
   (`recovery-pending`, `approval-not-persisted`) and emits **no** terminal
   surface.
2. **archive** — on failure the **approved claim is kept**
   (`goal_archive_failed_after_approval`, `park-archive`), so the settlement
   stays re-drivable; the goal pauses with a real next action ("no new audit
   is needed").
3. **persist-render** / **deliver-render** — the durable summary outbox, then
   the live delivery replay (unchanged, still idempotent).

`resumeSettlingCompletionAudit()` runs at `session_start`: a durable
`settling` claim with an approval in `auditHistory` is finished **without
re-running the auditor** (`audit_settlement_resumed`,
`audit_settlement_completed`). A `settling` claim with no approval verdict is
corrupt, not a settlement, and is parked honestly.

## Restart and no-progress

A cold session finds an attempt-owning claim (`starting` / `running` /
`settling`) with no worker in the new process and parks it as
`recovery-pending` with its identity, its `lastActivityAt`, and its evidence
intact. The durable no-progress window (`AUDIT_NO_PROGRESS_MS`, 10 min) is what
makes a silent claim legible without an in-process watchdog: the widget says
`no progress 41m 00s` and names `/goal resume retries the stored claim`.

`beginCompletionAudit` writes `starting`; the first worker event carrying a
real activity stamp flips it to `running` and stamps `lastActivityAt`,
refreshed at most once per `AUDIT_ACTIVITY_PERSIST_MS` (30 s) so a chatty
auditor cannot flood the append-only ledger. The final (`complete`) progress
snapshot counts as evidence too: the parent's poll can land after the worker
finished, and gating the durable flip on an in-flight phase made it depend on
catching a transient poll — which a fast worker can skip.

## Display vocabulary

A parked claim names its own state and evidence instead of the flat
"recovery pending — previous audit was interrupted" line:

```
├─ auditor: recovery needed
└─ parked 41m 12s ago · /goal resume retries the stored claim
```

and a settling claim reads `auditor: settling` rather than "awaiting
completion review" (the review already happened). The status line keeps its
`audit recovery pending` shape; only the card detail changed.

## Files

| File | Change |
| --- | --- |
| `extensions/audit-lifecycle.ts` | **new** — pure lifecycle projection + settlement state machine |
| `extensions/goal-loop-core.ts` | phase union (`starting`/`settling`), `lastActivityAt`/`verdictAt`, sanitizer, lifecycle-aware goal markdown, re-exports |
| `extensions/loops/goal-auditor-hooks.ts` | `starting` at launch, durable activity heartbeat, settlement transaction + `settleApprovedCompletion` + `resumeSettlingCompletionAudit` |
| `extensions/loops/goal-activation.ts` | session-start settlement re-drive, before the interrupted-audit branch |
| `extensions/goal-loop-display.ts` | durable lifecycle labels, durable last-activity age, no-progress segment |
| `schemas/goal.schema.json` | phase enum + the two new timestamps |
| `tests/audit-lifecycle.test.ts` | **new** — every state, terminality gate, no-progress, sanitization |
| `tests/audit-settlement-restart.test.ts` | **new** — real cold reload: stale/no-progress, active settlement, approval-once, refused archive |

## Verification

- `bun test tests/audit-lifecycle.test.ts tests/audit-settlement-restart.test.ts` — 19 pass, 0 fail.
- `npx tsc --noEmit` — clean.
- `node scripts/run-tests.mjs` (fast suite) — 2352 pass, 0 fail (277 files).

Source-shape pins updated where the refactor intentionally moved the code they
named (`tests/retry-bounds.test.ts`, `tests/completion-summary-lines.test.ts`,
`tests/terminal-approval-render.test.ts`,
`tests/terminal-completion-notice.test.ts`); the contract each pinned is
preserved, and `tests/retry-bounds.test.ts` now pins the stronger invariant
(verdict persisted before archive) plus a negative pin on the old
clear-then-archive shape. Behavioural `phase === "running"` pins became
`auditPhaseOwnsAttempt(...)`, so they state the contract ("the claim is
attempt-owning, not parked") instead of one hardcoded phase string.
