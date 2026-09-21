# The promotion contract: list item → goal → archive

The one seam every GLLA user must understand. A queue item is inert
text; a goal is a live audited objective; an archive is an immutable
record. Promotion moves exactly one way, and every edge below is
grounded in `activateNextListItem` (`extensions/loops/goal-list-queue.ts`)
and `archiveCurrentGoal` (`extensions/loops/goal-orchestrator.ts`).

```
QUEUED (.pi-glla queue + sidecar)          LIVE (state.goal, policy="list")          ARCHIVED (.pi-glla/archive/<id>.md)
───────────────────────────────          ──────────────────────────────────          ──────────────────────────────────
inert: objective + contract               audited: turns, claims, verdicts            immutable: markdown + machine record
  │                                                │                                            ▲
  │  /list next · cascade · list_activate          │ complete (auditor approves)                │
  │  ─────────────────────────────────────────▶    ├────────────────────────────────────────────┤
  │  guards: loop must not own surface;            │ cascade: parent group closes if last       │
  │  suspicious items get a repair card;           │ subtask done, then next item activates;    │
  │  sidecar deleted BEFORE the item leaves        │ empty queue → "List complete"              │
  │                                                │                                            │
  │  activation FAILS (setGoal refused)            │ abort (/goal cancel, /list next, …)        │
  │  ◀─────────────────────────────────────────   ├────────────────────────────────────────────┤
  │  item + sidecar RESTORED to the queue          │ NO cascade (aborts pick their own step);   │
  │                                                │ item NEVER returns to the queue            │
  │  disapproval                                   │                                            │
  │  ─ ─ ─ (queue untouched) ─ ─ ─ ▶               │ rework in place; queue waits               │
```

## The rules

1. **Activation takes the item out of the queue.** `takeAt` removes
   it from RAM and the disk sidecar is deleted first — a half-moved
   item cannot reappear as pending work after reload. What activates
   is a real `Goal` with `policy: "list"`, carrying the item's
   contract, agent role, subtask binding, and repair target.
2. **Guards refuse loudly, except the head-group skip.** A live loop,
   a suspicious objective, or an undeletable sidecar refuses with a
   banner and a ledger event. The one silent step is skipping a head
   *group* to its first open child (groups are containers, not work)
   — ledgered as `list_group_auto_skipped`, never bannered.
3. **Completion cascades; abort does not.** An approved list goal
   archives, closes its parent group when it was the last open
   subtask, and auto-activates the next item. An aborted goal
   archives as aborted and stops — auto-advancing on abort once
   double-activated (v0.2.0), so aborts pick their own next step.
4. **Nothing returns to the queue.** There is no requeue path: once
   activated, the item's queue position is gone. Abort archives it
   as aborted; to retry it, re-add it. The sole exception is a
   *failed* activation (the prior live objective could not archive),
   which restores item + sidecar to the queue.
5. **Disapproval never touches the queue.** Rework happens in place
   on the live goal; the queue waits behind it.
6. **Standalone goals hand off, then stop.** A completed `/goal`
   with a waiting list activates the head item; an aborted one
   does not. The archive (`.pi-glla/archive/<id>.md`, exclusive
   create, intent-journaled) is the durable record either way.

## Where to look

- Activation: `activateNextListItem` in
  `extensions/loops/goal-list-queue.ts` (one-active-thing gate,
  group scan, suspicious-objective repair, sidecar discipline,
  setGoal-failure restore).
- Terminal: `archiveCurrentGoal` + the cascade in
  `extensions/loops/goal-orchestrator.ts` (archive fence, intent
  journal, parent close, advance, list-complete notice).
- The trail: `/goal timeline` narrates any live goal's journey
  through these states.
