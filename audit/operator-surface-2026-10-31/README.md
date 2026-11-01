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

**Root cause, second pass (2026-11-01 — the first fix was wrong).** An earlier
revision of this report said "treat `chat` as live" and then reused a synthetic
marker in the test. The auditor inspected the REAL persisted state and found:
`owner: {kind:"chat"}`, `kind:"goal"`, `goal:null`, `firstFailureAt
2026-10-31T01:39:23.410Z`, episode age 7h42m. The screenshot footer confirms
`v0.39.54` and `episode age 7h 42m`. So the marker I had to make disappear was a
`chat`-owned one, and my rule deliberately kept it visible — the fix did not fix
the observed state.

`chat` records **where the episode was raised**, not that supervised work
survives: `currentRecoveryOwner()` returns `{kind:'chat'}` whenever there is no
live goal and no active loop. Such a marker has nothing to resume — which is
exactly the state `/glla resume` already retires as "no supervised target"
(`goal-commands.ts:3069`).

**Fix.** `recoveryOwnership` now returns `absent` for a `chat`-owned marker when
there is no goal and no loop, so display and retirement share one verdict:
`retireOrphanedMainModelRecovery` retires it (`absent` is already in its retire
list) and `mainModelRecoveryHasLiveOwner()` returns false, so the card cannot
render. With a live goal or loop the marker stays `chat` and still renders — the
guard is not blanket. `settleApprovedCompletion` also runs the orphan sweep at the
terminal boundary, as the objective required.

**Alternative considered.** Hiding `chat`-owned markers in the renderer only. That
would leave the marker on disk to reappear in `/glla status` and every other
surface; retiring it from the shared verdict is the durable version.

---

## 2. Tweak-confirm wall of text

**Observed.** `Screenshot_20261029_165336.png` and `Screenshot_20261029_112819.png`
show `/goal tweak` rendering a `CURRENT:` objective and a `NEW:` objective as two
long labelled blocks — the wall note.md points at. I inspected both images
directly. The completion scope-amendment confirm had the same shape.

**Correction (2026-11-01).** An earlier revision said "the `cmdTweak` dialog was
already compact and was left alone". That was false: it was the dialog in the
screenshots, and only the `complete_goal` amendment path had been changed. Both
paths are handled now, and the test drives `cmdTweak` itself.

**Fix.** `buildAmendmentConfirmBody` (extensions/confirm-draft.ts) renders the
exact old→new objective, shows the contract only when it actually changes (and
says "Contract: unchanged" otherwise), clips a long objective to a readable length
with an explicit `…` marker while keeping the tail where acceptance clauses live,
and keeps the consequence line.

**Fix for the tweak path.** `buildTweakConfirmBody` renders `From:` / `To:`
with the exact old and new objective and a single consequence line
("Replaces the list item objective and its verification contract", "… and CLEARS
its verification contract", or "… its verification contract is kept"). The
`CURRENT:`/`NEW:` labels, the contract body and the inference caveat are gone from
the default card. `buildTweakRationaleBody` holds the full form, and the compact
card names its own expand: **`--rationale`**. `cmdTweak` accepts that flag and
renders the full form in the same consent gate.

**Consent integrity preserved, and it decided the design.** The objective asked
for both a compact card AND an exact old→new consent record, which pull against
each other for a very long objective. Exactness wins: the objective text is
**never clipped** in either view. What was removed is duplication — the two
reprinted contracts and five labelled sections. Confirm/Cancel semantics are
unchanged on both paths.

**Why `--rationale` rather than a component toggle.** Three attempts at an
in-dialog component toggle were tried and rejected: `ctx.ui.confirm` is
title+body only, and a `ctx.ui.custom` + `ConfirmDraftComponent` dialog changed
the consent primitive for every caller (25 confirm sites across 8 test files),
which risked silently weakening existing consent coverage. The flag is a real,
tested affordance that keeps one consent primitive and hides nothing.

---

## 3. `/glla wipe` latency — measured, no defect found

**Observed.** `note.md`: "tying to wipe objective freezes /glla wipe — but it is
just slow for some reason as after waiting it out everything was normal."

**CORRECTION (2026-11-01).** An earlier revision of this report claimed the
observation came from a stale build because "the banner showed v0.39.36". That
claim is **retracted**: I inspected `Screenshot_20261031_092215.png` directly and
the banner footer reads **`v0.39.54`**, matching `package.json`. The v0.39.36
figure came from the objective text, not from the evidence. Nothing in item 3
rests on it.

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

**Gap found while proving the negative direction (2026-11-01).** "Never reaches
settlement" was an assumption, not a guarantee: `settleApprovedCompletion` had no
status check, so calling it for a paused goal archived the item and the advance
hook then skipped past a decision the user still owed. A guard now refuses unless
the goal is `auditing` or holds a settling claim (the legitimate refused-archive
recovery). The negative test drives the real settlement entry for paused, blocked
**and failed** items and asserts refusal, unchanged status, an unchanged queue, and
no `list_auto_advance` ledger row — so a blanket advance cannot pass.

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

**Observed.** The *objective* records a banner reporting `v0.39.36` against a
`0.39.54` checkout. That specific figure is **not corroborated by the screenshots
I can inspect** — `Screenshot_20261029_085207.png` and
`Screenshot_20261031_092215.png` both show `v0.39.54`. The *class* of defect is
real and independently reproducible (see the tests), but the report must not
assert a version mismatch it cannot show. Recorded as: the user reported reading
behaviour that did not match the source; the screenshots available show matching
versions.

**Fix.** `detectStaleBuild(cwd)` compares the **loaded** build (this module's own
manifest, i.e. what is executing) against the checkout's manifest, and reads that
manifest **only when its `name` is this package** — an unrelated project at 1.0.0
made GLLA warn in every session opened there (`stale:true, loaded 0.39.54, repo
1.0.0`), which is noise about someone else's version. A foreign manifest is not
evidence about the GLLA source. Only a strictly
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
| 3 | `tests/glla-wipe-latency.test.ts` | yes — per-record work blows the ceiling |
| 4 | `tests/list-auto-advance.test.ts` | yes — the queue does not advance without the hook |
| 5 | `tests/auditor-model-display.test.ts` | yes — 2 cases fail with the old precedence, reproducing the note.md observation |
| 6 | `tests/stale-build-warning.test.ts` | yes — warns at session start, silent when matching/newer |

### Gate history (recorded, not hidden)

The first two full runs each failed on **load**, not on behaviour, and both were
diagnosed rather than re-run until green:

- `tests/glla-wipe-latency.test.ts` used fixed wall-clock ceilings and failed at
  load ~58 on 16 cores for a reader that was provably fine. Those are HANG
  BOUNDS, not benchmarks, so they now scale with the host via `scaledBudgetMs`.
- `busy complete_goal stages admission…` failed once inside the parallel gate
  (16 s vs a 6 s wait) and passes standalone at load 91 (11/11) — a
  parallel-contention flake, unchanged by this work.

The final clean run: **4529 pass, 1 skip, 0 fail across 482 files, exit 0**
(`verification/release-check.log`).

### Two weak assertions the controls exposed

The controls are not decoration; they caught two of my own tests being vacuous:

1. **`stale-recovery-marker` chat case.** It passed the ownership verdict *in*,
   so it never exercised `mainModelRecoveryHasLiveOwner`. Deleting the `chat`
   branch left every test green while hiding a real ordinary-chat recovery. It
   now drives the real predicate for all four ownership outcomes.
2. **`glla-wipe-latency` scaling check.** "10x the journal must not cost 10x the
   time" was a **wrong premise**: `readState` is I/O-bound and already scales
   roughly linearly (measured 2.3 ms at 50 rows → 21 ms at 2000). The assertion
   caught nothing. It is replaced by absolute ceilings on realistic and oversized
   journals, and the control now injects per-record (quadratic) work, which it
   does catch.

Both are recorded rather than quietly repaired, because a control that passes
against broken code is worse than no control.

One existing test changed meaning: `tests/display.test.ts` "standalone main-model
recovery remains visible when no goal is active" pinned the very behaviour item 1
corrected. Its intent is legitimate — a **chat-owned** standalone recovery must
stay visible — so the fixture now declares that owner and supplies the extras
verdict, keeping the intent while removing the stale-marker case it accidentally
covered.
