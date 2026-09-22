# Continuation spam: delta-only never fired (v0.38.94, 2026-09-22)

## Field case

`pi-session-2026-09-22T16-27-49` (web/chat): 57MB transcript, 909
identical 28KB `goal-event` continuation prompts over ~8h for one goal.
Project ledger: 212 `goal_continuation_sent` since 16:00 — 202 `full`,
10 `full+resync`, ZERO `marker`.

## Root cause

v0.38.5 built delta-only sends (45-char marker on steady-state turns)
but computed `firstSend` as `lastContinuationSentAt === 0`. That latch
tracks the IN-FLIGHT dispatch: it is zeroed on every ack
(`dispatchStartAcknowledged`), failure, timeout, and watchdog clear —
i.e. before every fresh send (`sendContinuation` refuses to run while
a dispatch is pending). So `firstSend` was true on EVERY send and the
builder path never fired. The delta-only tests called the builder with
explicit `firstSend:` and source-pinned the wiring — nobody tested what
the caller actually passes. The bug lived exactly in the untested seam
(mutation-verified: old expression fails both new tests).

## Fix

- `continuationInitialFullSentFor: goalId | null` — flips only when a
  full payload actually dispatches (failed sends don't burn the one
  brief); keyed by goal so a new goal re-teaches once.
- `resetContinuationInitialSend()` called from the session-start rebind
  block (fresh host context never saw the brief). NOT in the generic
  dispatch-state reset (same-session abort/resume keeps history; a
  wasteful-but-safe full there would reintroduce churn).
- Result for the field case: 1 × 28KB + 908 × 45 chars (~69KB total
  instead of ~25MB).

## Verification

- delta-only-continuation.test.ts +2 behavioral (direct sends through
  MockPi): full-then-marker across consecutive sends; rebind re-arms.
  6/6; tsc clean; continuation batch 64/64.
