# pause_goal redirect: park-and-continue for user interruptions (2026-09-23)

Field: dracon-platform, goal `20260923040904-ktu1yw` (project audit pass).
The user interrupted with a new task ("can we get to this first" + two
Gmail links). The agent parked via pause_goal — whose v0.35.15 contract
aborts the turn and orders "do NOT continue working" — so the turn died
(`pause_goal_aborted_turn`, kind blocked, 11:19:30Z) and the redirect never
started until the user nudged ("go"). Screenshot_20260923_121949.

## Root cause

A user redirect is not pause-shaped: pause_goal means "I cannot proceed",
but a redirect means "park this, do THAT now". The tool had no
park-and-continue primitive, so the model reached for pause_goal and the
abort + stop-order stranded the new task.

## Fix (v0.38.97)

- New optional `redirect` param on pause_goal: quote/summarize the
  interrupting request. The goal still parks (paused + reason + action),
  but the turn is NOT aborted and the result orders the redirect worked
  NOW in the same turn, goal resumed after.
- Redirect parks ledger as `pause_goal_redirect` (distinct from
  `pause_goal_aborted_turn`) so abort forensics stay clean.
- Deliberately unchanged: plain pauses still abort (v0.35.15 control
  pinned); the armed-recovery refusal still refuses redirect+blocked
  while the envelope owns the turn; decision-budget/run-to-done early
  returns untouched; an impossible-drop still wins the result copy.
- Regression: tests/pause-redirect.test.ts (redirect keeps the turn
  alive + echoes the task; control pins the plain-pause abort). Red
  before, green after.

## Open design: better mid-goal injection

Typing a new task mid-goal works but leaves the side task untracked (no
goal/ledger for it) and resume is manual. Options, lightest first:

1. Status quo + redirect (this fix): zero new UX; side work untracked.
2. Redirect auto-resumes: after the redirect turn ends, nudge the agent
   back (`/goal resume` suggestion or auto re-park-reminder). Needs a
   "redirect pending" marker so the reminder fires once.
3. Tracked side tasks: a lightweight stack (park goal, push side task
   with its own ledger slice, pop back). Most machinery; most
   visibility.
