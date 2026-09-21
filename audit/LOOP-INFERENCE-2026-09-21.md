# Loop inference in the mode check (v0.38.84, 2026-09-21)

## What

`crossRecommendMode` (the seed-based interview advisory) covered
goal↔list mismatches but never suggested /loop. It now catches
open-ended/recurring seeds in both goal and list drafting:

- Cadence: every/each + time unit, daypart, or weekday.
- Oversight: monitor(ing), watch(ing), keep-an-eye-on,
  until-further-notice, until-I-say/stop/tell, continuously,
  nightly, hourly, ongoing/rolling/recurring basis.
- Steady-state: keep X under/below/above/at Y.

## Ordering (deliberate)

Aggregate (N discrete items) fires first — per-item work wins over
cadence ("check all 50 screens every hour" becomes 50 list items).
The loop check runs before the size checks: cadence changes the
loop, not just the size ("fix typo every day" is loop-shaped; the
five-minute check already excludes recurring words, leaving room).
Bounded-until ("until done/green/shipped/...") suppresses the loop
check: a finish line makes it one-shot work. The pinned metric
seed ("reduce npm test failures from 14 to 0" → no recommendation)
still holds: transitions are goals, steady-states are loops.

## Verification

- `tests/list-philosophy.test.ts` +4 (14/14): loop fires in both
  modes, bounded-until stays silent, aggregate wins, recurring
  beats five-minute.
- Drafting areas green: drafting-handoff, list-draft-handoff,
  confirm-draft, designer-drafter-policy,
  completion-communication (49/49). `tsc` clean.
