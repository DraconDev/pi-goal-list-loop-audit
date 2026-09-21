# Monitoring visuals: standby reasons go dim (v0.38.90, 2026-09-21)

## Field case

Screenshot_20260921_120758: a standby card (paused on background agents)
rendered its full multi-sentence status narration in warning yellow —
visually identical to an error/action-needed card. Standby is monitoring
narration, not a call to action; the card already says
"standby — waiting on a background agent" in dim.

## Change

`goalLines` paused branch (`extensions/goal-loop-display.ts`):
- Standby reasons render `dim` like waits (was `warning`). Error stays
  `error`; blocked/decision keep `warning`.
- Standby reasons cap at 2 wrapped rows like decisions/waits (was 3).

Status line needed no change (standby already dim there).

## Verification

- `tests/waiting-on-subagent-pause.test.ts` +2 (marker-theme pattern):
  reason rows carry `[dim]`, never `[warning]`; a 600-char reason caps
  at 2 rows. 6/6 with the pre-existing standby tests.
- `tsc` clean; display/status/widget/questionnaire suites 149/149.
