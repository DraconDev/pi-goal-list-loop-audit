# GLLA operator-surface fixes (2026-10-31)

Six items recorded in `note.md`, each diagnosed against the running code before
being changed. Where a display symptom had a state cause, the state cause is what
was fixed. One item (wipe latency) produced **no reproducible defect** — that is
recorded as measured rather than papered over with an invented fix.

Observed vs inferred is marked per item.

---

## 1. Stale recovery marker after a terminal goal

**Observed.** `Screenshot_20261031_092215` shows the standalone recovery card —
"no GLLA objective · send 'continue' to retry this chat; /glla resume clears the
stale marker" — at 09:22. The journal shows the last goal archived at
**03:16:25Z** (`audit_settlement_completed`), with only two unrelated rows in the
six hours between. So there was genuinely no goal, the list was empty, and
nothing was wrong. The card asked the user to act on finished work.

**Root cause (observed).** `recoveryOwnership` already returns `terminal` for a
goal-owned marker whose goal completed, but the renderer's standalone branch
rendered on `!state.goal && state.mainModelRecovery` alone — it never consulted
ownership. A marker had simply outlived its owner.

**Inferred, not established.** That the marker was written by the last audit
rather than an earlier episode: the recovery record's `firstFailureAt` is the
only evidence and it is not tied to a goal id in the retained rows.

**Fix.** The renderer takes the ownership verdict as ephemeral extras
(`recoveryHasLiveOwner`, supplied by `goal-ui.ts` from
`mainModelRecoveryHasLiveOwner()`), so it never imports state machinery. The
verdict treats `retained`, `restore-pending` **and `chat`** as live — `chat` is an
ordinary-chat recovery with no goal by definition, and treating it as dead would
hide a real recovery, the opposite defect.

**Not done, deliberately.** I first added a settlement-side clear and then
removed it: `archiveCurrentGoal` already clears a goal-owned marker
(`goal-orchestrator.ts:1469-1474`), and removing my call left the probe result
unchanged. Shipping it would have been a duplicate. The renderer-side gate also
covers state files written by older builds, which a settlement-only fix cannot.

---

## 2. Tweak-confirm wall of text

**Observed.** The completion scope-amendment confirm body printed five labelled
sections and reprinted **both** full contracts, including the contract when it had
not changed at all. With a long objective that is a wall above the decision.

**Fix.** `buildAmendmentConfirmBody` (extensions/confirm-draft.ts) renders the
exact old→new objective, shows the contract only when it actually changes (and
says "Contract: unchanged" otherwise), clips a long objective to a readable length
with an explicit `…` marker while keeping the tail where acceptance clauses live,
and keeps the consequence line.

**Consent integrity preserved.** The confirm still shows the exact old and new
objective — the user approves a specific pair — and Confirm/Cancel semantics are
unchanged. The `cmdTweak` dialog was already compact and was left alone.

---

## 3. `/glla wipe` latency — measured, no defect found

**Observed.** `note.md`: "tying to wipe objective freezes /glla wipe — but it is
just slow for some reason as after waiting it out everything was normal." The
banner in the same session showed **v0.39.36** while the repo is **0.39.54**, i.e.
the observation was made against a stale loaded build (item 6).

**Measured, at the real profile.** Every candidate cost, because the contract
required measuring before assuming:

| leg | measured |
| --- | --- |
| `readState` (live 4.1 MB / 109-row journal) | 3.5 ms |
| `readState` (artificial 8.9 MB / 1000 rows) | 14.5 ms |
| `appendLedger` | 0.4 ms |
| `readQueueFromDisk` | 0.70 ms |
| `queueItemSidecarCount` | 0.09 ms |
| `refreshOwnershipStanding(force)` | 0.36 ms |
| `loadSettings` | 0.01 ms |
| `renderGoalMarkdown` | 0.20 ms |
| archive render + write (120 audits) | 0.3 ms |

There is no lock, sleep, retry loop, or network call in the wipe path after
`warnIfStaleAtEntry`'s ownership recheck.

**Conclusion (observed).** The journal-size hypothesis — the one I was about to
assume — is **wrong**: reading 10× the journal costs ~3×, and even 1000 rows is
milliseconds. There is no reproducible latency in the current code to fix.

**What shipped instead.** A durable `glla_wipe_timing` ledger row recording the
real duration of the wipe's own work, plus
`tests/glla-wipe-latency.test.ts`, which pins a per-leg budget and a scaling
sanity check. The next report of slowness will carry a number rather than a guess,
and a genuine regression becomes visible. No behaviour was changed on an unproven
cause.

---

## 4. List auto-advance on clean completion

**Observed.** `note.md`: "we should be auto continuing no up next". After a list
item completed, the widget printed "N queued · up next: …" and waited for
`/list next`. The `complete_goal` flow even promises the opposite in its own text
("It activates when the current goal completes"). Auto-advance already existed on
the impossible-drop and draft-activation paths — only the **clean completion**
path did not advance.

**Fix.** `settleApprovedCompletion` advances the queue after the archive, and
ledgers `list_auto_advance` with `via: "completion-settlement"`. This runs only on
the settlement path — an **approved** audit archiving a completed goal.

**Deliberately narrow.** A paused, blocked, failed, or infrastructure-parked goal
never reaches settlement, so the hold-for-a-decision gate is untouched for exactly
the cases that need it. A parked loop keeps supervision and is not replaced. Both
directions are asserted so a blanket advance cannot pass.

---

## 5. Auditor model display

**Observed.** `note.md`: "I often see the auditor as openai luna max even though I
use session."

**Root cause (observed).** `auditorCardModelRef` preferred the retry/configured
candidate ref **before** the model that actually ran:

```ts
const ref = audit?.model
  ?? claim?.auditorRetryCandidateRef   // configured pin won over executed model
  ?? claim?.auditorCandidateRef
  ?? claim?.auditorCandidateRefs?.[0];
```

**Fix.** Precedence is now "what ran, then what was recorded, then what was
configured": `audit.model` → `claim.auditorSourceModel` → configured refs. When the
executed model is not among the claim's configured candidates it is labelled
`· session model`, so a session audit says so instead of naming a pin that was
never dispatched. Derived from recorded refs, never guessed.

---

## 6. Stale-build detection

**Observed.** A banner reported `v0.39.36` while `package.json` is `0.39.54`, so
behaviour being discussed was not in the source under review — and item 3's
"wipe is slow" observation came from that session.

**Fix.** `detectStaleBuild(cwd)` compares the **loaded** build (this module's own
manifest, i.e. what is executing) against the checkout's manifest. Only a strictly
older loaded build warns; `session_start` emits one advisory warning naming the
reload/reinstall action and ledgers `glla_stale_build`. It never returns early,
never pauses the goal, and never touches goal state, so a stale build can still be
driven during development.

**Not stale:** a newer loaded build (a published install driving an older
checkout), equal versions, and an unreadable/missing manifest — absence of
evidence is not evidence of staleness. Version comparison is numeric, so `0.39.9`
< `0.39.10` and the note.md pair orders correctly.

---

## Verification

`npm run check` and `npm run check:inventory` both exit 0. The full
`npm run release:check` result is recorded in `verification/release-check.log`.

Each item ships with tests that were verified to **fail against the unfixed
code** in a disposable copy of the tree, so none of them is a passing tautology:

| item | test | proven to bite |
| --- | --- | --- |
| 1 | `tests/stale-recovery-marker.test.ts` | yes — card re-renders when the ownership gate is removed |
| 2 | `tests/amendment-confirm-compact.test.ts` | yes — old five-section body is not the default |
| 3 | `tests/glla-wipe-latency.test.ts` | budget + scaling pins |
| 4 | `tests/list-auto-advance.test.ts` | yes — the queue does not advance without the hook |
| 5 | `tests/auditor-model-display.test.ts` | yes — 2 cases fail with the old precedence, reproducing the note.md observation |
| 6 | `tests/stale-build-warning.test.ts` | yes — warns at session start, silent when matching/newer |

One existing test changed meaning: `tests/display.test.ts` "standalone main-model
recovery remains visible when no goal is active" pinned the very behaviour item 1
corrected. Its intent is legitimate — a **chat-owned** standalone recovery must
stay visible — so the fixture now declares that owner and supplies the extras
verdict, keeping the intent while removing the stale-marker case it accidentally
covered.
