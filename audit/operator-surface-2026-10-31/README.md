# GLLA operator-surface fixes (2026-10-31)

Six items recorded in `note.md`, each diagnosed against the running code before
being changed. Where a display symptom had a state cause, the state cause is what
was fixed. All six items produced a real defect; item 3's was located only after
two earlier reports of it were wrong (see the corrections in that section), and
the trail is kept rather than smoothed over.

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

**Fix — and a correction to where it lives (2026-11-01, audit round 2).** An
earlier revision of this section said `recoveryOwnership` now returns `absent` for
a chat-owned marker. It does not, and must not:
`extensions/recovery-ownership.ts:38` still returns `'chat'`, because a
chat-owned episode is legitimately **restored** across a reload. Pushing the rule
into ownership broke 19 restore/failover tests, which is how the wrong layer was
caught.

The separation is two functions instead:

- `mainModelRecoveryHasLiveOwner()` (`extensions/goal-recovery.ts`) returns false
  for `chat` when there is no goal and no loop. Ownership still says `chat`; this
  verdict answers the narrower question "does a card implying action make sense
  right now".
- `clearStaleMainModelRecovery()` is the retirement, extracted from the
  `/glla resume` "no supervised target" predicate so display and retirement cannot
  drift apart. `settleApprovedCompletion` calls it at the terminal boundary,
  alongside the existing orphan sweep.

With a live goal or loop the marker stays live and still renders — the guard is
not blanket.

**Alternative considered and rejected.** Hiding chat-owned markers in the renderer
only. That would leave the marker on disk to reappear in `/glla status` and every
other surface, and would leave a card that no longer renders still driving
recovery state. Retirement is the durable half; display is the visible half. Both
are needed, which is why the verdict is split from ownership rather than folded
into it.

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
`CURRENT:`/`NEW:` labels and the reprinted contract are gone from the default
card; the inference caveat stays, because an informed rejection needs it.
`buildTweakRationaleBody` holds the full form and **`Show the full rationale`** is
the expand — an action on the card itself (see below).

**Consent integrity preserved.** Confirm/Cancel semantics are unchanged and the
exact full text is never lost — it is always in the toggle. For a SHORT objective
(`TWEAK_VERBATIM_LIMIT` = 180 characters per side) both are printed verbatim. For
a LONG one the default card shows a **minimal prefix/suffix diff** — the changed
region with elision markers — instead of reprinting two paragraphs, and states
that the exact full text is in the expand. Leaving the paragraph in place was the
audit's third-round finding: the observed note.md objective is a long paragraph,
so "compact" measured against a short fixture was not compact for the case that
was actually reported.

**The expand is an in-dialog toggle (audit round 2).** `TweakConfirmComponent`
offers `Show the full rationale` / `Hide the full rationale`; the body expands and
collapses in place, nothing is applied, and the dialog stays open. An earlier
revision shipped only a `--rationale` flag, which is not an expand — it makes the
user cancel and retype the command. The flag still works (it opens the card
already expanded), and `confirmTweak` drives `ctx.ui.custom` with the same
factory-not-invoked / stale-API fallback `confirmDraft` uses, so RPC and headless
hosts degrade to the plain confirm instead of silently cancelling.

The call site also passes `getHeight: () => (tui.terminal?.rows ?? 24) - 4`.
Without a height `render()` uses `POSITIVE_INFINITY`, `pageSize` becomes
infinite, and the advertised `PgUp/PgDn` scroll cannot move the view — a real
defect on the long rationale, pinned by a test that documents both the working
and the height-less behaviour.

---

## 3. `/glla wipe` latency — reproduced at the real profile and fixed

**Observed.** `note.md`: "tying to wipe objective freezes /glla wipe — but it is
just slow for some reason as after waiting it out everything was normal."

**CORRECTION (2026-11-01, audit round 2).** This section previously read
"measured, no defect found" and the fix it credited was an index on the `/list
depth` path. Both statements were wrong for this item, and the auditor was right:

- `cmdGllaWipe` never calls `computeListDepthFromLedger`. Its only caller in the
  tree is `/list depth` (`extensions/goal-commands.ts:1711`).
- The wipe **was** slow, and the cost was somewhere neither earlier table
  measured.

**Measured at the real profile** (`/tmp/wipreal`: 31 ledger segments,
281,553,674 bytes of history, `active.jsonl` 7.5 MB), driving the real command
(`pi.command("glla", "wipe", ctx)`) rather than a sub-operation:

| leg | measured |
| --- | --- |
| `/glla wipe` end-to-end, before | **912 ms** (repeat runs 653 / 642 ms) |
| `scanLedgerRecords` over the full 280 MB | **749 ms** |
| `readState` | 0.2 ms |
| `ledgerFiles` | 0.1–0.2 ms |
| `readQueueFromDisk` | 0.2 ms |
| `appendLedger` (first + warm) | 0.1 / 0.0 ms |
| `/glla wipe` end-to-end, after | **71 ms** |
| full-history scans during a wipe, after | **0** |

**Root cause (traced, not inferred).** Instrumenting `scanLedgerRecords` with a
stack dump during the real wipe produced one call:

```
cmdGllaWipe (goal-commands.ts:2824)
  → archiveCurrentGoal (goal-orchestrator.ts:1652)
    → fireReviewer (goal-auditor-hooks.ts:2907)
      → scanLedgerRecords                       ← one pass over 280 MB
```

`fireReviewer` streamed the entire multi-month ledger so the reviewer could answer
two questions that are both bounded to *today*: "did a review fire in the last 5
minutes" (`REVIEWER_REFIRE_WINDOW_MS`) and "how many fired today"
(`reviewsToday`, a UTC calendar day). Reading months of history for that is
unbounded work for a bounded question, and a wipe archives the goal, so it paid
the cost every time.

**Fix.** `scanLedgerRecordsSince(cwd, sinceMs, onRecord)`
(`extensions/goal-loop-core.ts`) reads segments **newest first** and stops at the
first segment that contributes no row at or after `sinceMs`: every older segment
is older than it, so it cannot contain a qualifying row either. Segments are
timestamp-prefixed and chronologically ordered, so the early exit is sound. A row
with no parseable timestamp is delivered rather than dropped — correctness
outranks the speedup. `fireReviewer` calls it with a 24-hour lookback, which is a
provable superset of both predicates (the UTC day start is never more than 24
hours before `now`, and the 5-minute window sits inside that), so no row either
predicate can observe is skipped.

**Test.** `tests/glla-wipe-real-path.test.ts` drives the real `cmdGllaWipe` against
a >20 MB historical fixture and pins the cause deterministically — the wipe must
invoke `scanLedgerRecords` **zero** times — plus a scaled wall-clock ceiling as a
secondary check. Reverting `fireReviewer` to the full scan fails it with "the wipe
performed a full-ledger scan". A wall-clock assertion alone is too weak: a loaded
host can let a rescan slip under a millisecond ceiling, which is exactly how an
earlier version of this control silently passed.

**The `/list depth` index is a separate fix, and is not this item.** That surface
genuinely was 3.1–4.8 s on the same profile (32 segments, 287 MB) because
`computeListDepthFromLedger` scanned all history to answer a per-goal depth
question; it now uses a durable per-goal finals index with bounded backfill
(77 ms first read, 11 ms steady state, byte-identical converged answer).
`tests/wipe-ledger-scan.test.ts` pins it. It is reported here as a distinct
defect found while measuring item 3 — not as the wipe fix, which it is not.

**What also shipped on the wipe path.** A durable `glla_wipe_timing` ledger row
recording the wipe's own duration, so the next report of slowness carries a number
rather than a guess.

---

## 4. List auto-advance on clean completion

**Observed.** `note.md`: "we should be auto continuing no up next". After a list
item completed, the widget printed "N queued · up next: …" and waited for
`/list next`. The `complete_goal` flow even promises the opposite in its own text
("It activates when the current goal completes").

**CORRECTION (audit round 3).** An earlier revision claimed "only the clean
completion path did not advance". That was wrong in the other direction:
`archiveCurrentGoal` (`extensions/loops/goal-orchestrator.ts:1620`) already
advances on every archive, including the settlement archive this item is about.
The settlement path needed **no advance of its own** — the extra
`activateNextListItem` I added there advanced a second time, so the immediate
next item was activated and then replaced by the one behind it. That item never
ran and the queue drained: skipped work, caught by the auditor and now pinned by
a dedicated no-double-advance test. The delivered behaviour is the advance that
`archiveCurrentGoal` performs, and the narrow guard at the top of
`settleApprovedCompletion` is what keeps paused, blocked and failed items
holding.

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

**Rendered proof.** `verification/tweak-card-render.txt` is the real component's
`render(76)` output for a LONG objective — the shape the note actually reported.
The compact card shows the minimal diff (`[-stop there-]` / `[+file each defect…+]`)
with elision markers, the disclosure that the exact full text is in the expand,
the single consequence line, and the three actions including `Show the full
rationale`; after the in-place toggle the SAME dialog shows the exact rationale
with the new contract and `Hide the full rationale`, and nothing has been applied.
A real TUI screenshot is not available from this non-interactive environment, so
the render output is the evidence offered — it is the same `render()` the terminal
calls.

**Not stale:** a newer loaded build (a published install driving an older
checkout), equal versions, and an unreadable/missing manifest — absence of
evidence is not evidence of staleness. Version comparison is numeric, so `0.39.9`
< `0.39.10` and the note.md pair orders correctly.

---

## Verification

`npm run check` and `npm run check:inventory` both exit 0. `npm run
release:check` exits 0: **4550 passed, 1 skipped, 0 failed across 484 files**,
plus pack smoke — recorded in `verification/release-check.log`.

**A note on how this revision got here.** The first two attempts at the chat
rule were wrong in opposite directions and the gate caught both. Putting the rule
inside `recoveryOwnership` broke 19 restore/failover tests, because a chat-owned
episode is legitimately restored across a reload; the verdict belongs to display
and retirement, not to ownership. Both are now separated and both covered.

Each item ships with tests that were verified to **fail against the unfixed
code** in a disposable copy of the tree, so none of them is a passing tautology:

| item | test | proven to bite |
| --- | --- | --- |
| 1 | `tests/stale-recovery-marker.test.ts` | yes — the REAL `chat`/`goal:null`/7h42m fixture re-renders the card when the ownership rule is reverted |
| 2 | `tests/amendment-confirm-compact.test.ts` | yes — drives `cmdTweak` and `complete_goal`; the `CURRENT:`/`NEW:` wall (`tweak-wall-regression`), a no-op expand (`tweak-toggle-removed-regression`), reprinting a long objective (`tweak-long-objective-regression`) and a missing height at the real call site (`tweak-card-height-regression`) all fail it |
| 3 | `tests/glla-wipe-real-path.test.ts` | yes — drives the real `cmdGllaWipe`; restoring the reviewer's full-history scan fails it with "the wipe performed a full-ledger scan" (`wipe-full-scan-regression`) |
| 3b | `tests/wipe-ledger-scan.test.ts` | yes — `/list depth`, not wipe: a warm depth read must fold 0 bytes and must not call `scanLedgerRecords` (`ledger-full-scan-regression`) |
| 3 | `tests/glla-wipe-latency.test.ts` | yes — per-record work blows the ceiling |
| 4 | `tests/list-auto-advance.test.ts` | yes — both directions through real settlement: removing the real archive advance fails the clean case (`no-auto-advance-regression`), re-adding the settlement duplicate fails the immediate-next-item and standalone-goal cases (`double-advance-regression`), and removing the guard archives paused/blocked/failed (`settle-status-guard-regression`) |
| 5 | `tests/auditor-model-display.test.ts` | yes — 2 cases fail with the old precedence, reproducing the note.md observation |
| 6 | `tests/stale-build-warning.test.ts` | yes — dropping the package-name check makes an unrelated project warn |

## Isolated controls (15/15 as intended)

`controls.py` mutates a disposable copy of the tree once per case and runs only
the suite that should notice. The baseline and a **harmless rewording** must exit
0 — if a rewording fails, the suite is over-fitted to wording rather than
behaviour. Every regression case must exit non-zero.

| case | expects | observed |
| --- | --- | --- |
| `baseline` | pass | exit 0 |
| `harmless-rewording` | pass | exit 0 |
| `stale-recovery-card-regression` | fail | exit 1 |
| `chat-owner-orphan-regression` | fail | exit 1 |
| `chat-recovery-hidden-regression` | fail | exit 1 |
| `amendment-wall-regression` | fail | exit 1 |
| `amendment-wiring-regression` | fail | exit 1 |
| `tweak-wall-regression` | fail | exit 1 |
| `tweak-toggle-removed-regression` | fail | exit 1 |
| `wipe-full-scan-regression` | fail | exit 1 |
| `double-advance-regression` | fail | exit 1 |
| `tweak-long-objective-regression` | fail | exit 1 |
| `tweak-card-height-regression` | fail | exit 1 |
| `no-auto-advance-regression` | fail | exit 1 |
| `settle-status-guard-regression` | fail | exit 1 |
| `configured-model-wins-regression` | fail | exit 1 |
| `stale-build-silent-regression` | fail | exit 1 |
| `stale-build-foreign-name-regression` | fail | exit 1 |
| `per-record-read-regression` | fail | exit 1 |
| `ledger-full-scan-regression` | fail | exit 1 |

One control (`ledger-full-scan-regression`) initially exited 0 — the wall-clock
ceiling it relied on was marginal, so a full rescan could slip under it on a
loaded host. That is precisely the weakness a control exists to expose, so the pin
was replaced with the deterministic assertions above and the control now fails as
intended. Final run: **20/20 as intended** (`verification/controls.json`).
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

The recorded gate is **4550 pass, 1 skip, 0 fail across 484 files, exit 0**
(`verification/release-check.log`). An earlier revision of this page also quoted
4529/482 from an intermediate run; that pair is superseded and the log is the
single source of truth.

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
