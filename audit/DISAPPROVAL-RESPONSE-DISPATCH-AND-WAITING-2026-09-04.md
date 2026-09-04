# Disapproval response: dispatch-stall root cause + waiting-state clear (2026-09-04)

Follow-up to `audit/COMPLETION-LIFECYCLE-TRILOGY-2026-09-04.md` (v0.38.18).
The detached auditor disapproved v0.38.18 as partial at 2026-09-04T17:16:28Z:
Track 1 (mechanical pipe-syntax) accepted; Tracks 2 and 3 re-scoped away from
their field defects instead of fixed. This document records the durable fix
for both, shipped as v0.38.19.

## Track 2: the dispatch stall was never the aborter's fault

### Field forensics (neonbreak, 2026-09-04)

Ledger `.../neonbreak/.pi-glla/active.jsonl` (1162 rows) around the incident:

- `goal_continuation_sent` gen 9 at **12:50** — a full 23k-char first-send.
- `send_rearm_storm` + `rearm_no_turn_started` milestones at 12:56/13:02/13:07
  (streak 35): user answered `ask_user_question` at ~12:57, no turn started.
- `zombie_auto_retry_dispatched` at 13:43/13:45/13:47, each followed by
  another full 23k `goal_continuation_sent` — three hot retries.
- `observedStreamAt` frozen at the tool-call epoch; the session claimed busy
  for ~45 minutes with zero stream.

v0.38.18's never-streamed stand-down (no hot retry + honest rearm copy) treats
the aborter as the defect. It is not. The aborter behaved correctly: a silent
turn holding the session deserves abort, and the rearm storm correctly reported
that no turn started. The defect is one level down, in `sendContinuation`'s
busy branch (`extensions/goal-continuation.ts`): `if (!ctx.isIdle() ||
ctx.hasPendingMessages())` rearmed unconditionally. A session that is busy
with nothing pending and zero stream NEVER clears that gate — so zero sends
were even attempted between 12:57 and the 13:42 abort. The stall was not "the
retry was wrong"; the stall was "no dispatch path exists for a phantom-busy
session". Any fix that keeps wait-for-idle as the only dispatch path
re-scopes the defect away.

### Fix (v0.38.19)

Busy-but-silent bypass in `sendContinuation`: when the session is busy with
nothing pending and `lastRealActivityAt` is older than `busySilentSendMs()`
(`GLLA_BUSY_SILENT_SEND_MS`, default 5m — the same wedged-silence definition
as `SEND_REARM_ESCALATE_SILENT_MS`, far below the ~45m zombie abort), the
marker is sent into pi's followUp queue instead of rearming. Ledger:
`goal_continuation_send_busy_bypass` + `busyBypass: true` on the sent event.

Fences (all preserved, all pinned by tests):

- Fresh stream (`lastRealActivityAt` recent) keeps the wait path — never fire
  into a turn that may be thinking.
- `lastRealActivityAt <= 0` (never seen this session stream) keeps the wait
  path — ignorance is not evidence of wedging.
- Loaded followUp queue (`hasPendingMessages()`) keeps the wait path — never
  stack onto work pi already holds.
- All `sendContinuation` entry gates (pause, recovery, handoff, stale, zombie,
  starvation choke, owner/generation) run before the bypass is even considered.

### Regression test

`tests/answered-question-dispatch.test.ts` (3 tests): answered
`ask_user_question` (real `tool_call` + `tool_result` events) → phantom-busy
→ 6 silent minutes → `scheduleContinuation` → the checkpoint marker is
dispatched with the bypass ledger trail; fresh-stream and loaded-queue cases
send nothing. Fail-before verified empirically (pre-fix file from git: the
dispatch test fails, the two guard tests pass throughout).

## Track 3: the wait must clear as state, not just as transcript

v0.38.18's `sendTerminalCompletionNotice` fixed what the transcript's last
word is. The auditor correctly demanded the state fix too: `auditorDisplayPhase`
(`extensions/goal-loop-display.ts`) returned `awaiting-verdict` for ANY goal
object handed a stale `phase: "complete"` progress — including closed goals —
and for any snapshot still carrying a running `pendingCompletion`. The archive
path already nulls the live projection and strips the claim; the projector now
matches that lifecycle: `awaiting-verdict` requires `g.status === "auditing"`.
Anything else with a stale complete audit falls through to the quiet gate
(true: no worker will ever speak again); a stale running claim on a
non-auditing snapshot projects quiet, never a wait.

### Regression test

`tests/closed-goal-clears-waiting.test.ts` (2 tests): the live auditing shape
still projects `awaiting-verdict` (no live-path regression); a real close via
`pi.command("goal", "cancel")` (durable `goal_archived`) followed by stale
complete progress for `complete`/`aborted` shapes and a stale running claim on
a pre-close snapshot — none project the wait, and post-archive status/widget
renders carry no verdict-wait text. Fail-before verified empirically.

## Release

`TMPDIR=/var/tmp npm run release:check` green, `npx tsc --noEmit` clean,
tag `v0.38.19`, GitHub release, publish workflow, `npm view` verification —
per the standing release contract (version bumped BEFORE the gate; this doc,
CHANGELOG, and the `docs/INDEX.md` trail in the same release).
