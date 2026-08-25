# Install & try

## Install (the usual way)

```bash
pi install npm:pi-goal-list-loop-audit
```

That's it — pi loads the extension into every session (run `/reload` in any
session that was already open).

> **Persistence note**: `pi update` can overwrite `~/.pi/agent/npm/node_modules/`.
> If the plugin disappears after an update, re-run `pi install`. For a permanent
> install, copy the package into your project's `.pi/extensions/` directory instead.

## Your first goal in 60 seconds

In any pi session, in the project you want worked on:

```
/goal "Fix the login timeout bug. Done when: `npm test` passes"
```

What happens:

1. **Draft + Confirm** — glla shows the goal contract (objective + Done-when);
   nothing activates unconfirmed.
2. **The loop drives** — after every agent turn, glla nudges the work forward;
   the widget (bottom-left) shows the goal, elapsed time, and last action.
3. **Verified completion** — when the agent calls `complete_goal`, glla
   runs deterministic mechanical pre-audit checks first (~200ms fast-fail on
   compiler/test failures) before queueing the **detached auditor worker process** (a
   fresh pi RPC session with no extensions). It re-runs your checks and
   demands raw output per contract item without holding the main pi turn.
   Done sticks only when the auditor approves with evidence.

Then the other two modes:

```
/list add "refactor the cache layer" "add tests for the parser"   # an audited queue
/loop audit                                                       # forever project-audit cadence
```

## What you should see

- **Commands**: `/goal`, `/list`, `/loop`, `/glla` (settings), `/review`.
- **Widget**: live goal/loop status — objective, elapsed time, last tool action.
- **State on disk**: `.pi-glla/` in your project — ledger `active.jsonl`,
  goal markdown in `goals/`, finished goals in `archive/`.
- **Tools for the agent** (only while a goal is active): `complete_goal`,
  `pause_goal`, `complete_task`, `update_task_status`.

## Install from source (developers)

Prerequisites: Node 22.19.0+ and bun (the test runner — `bun test`), pi-coding-agent, TypeScript 5.9+ (for `tsc --noEmit`).

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git   # or use the local dir
cd pi-goal-list-loop-audit
pi install .                                               # installs from local path
```

## Try it without installing

```bash
pi -e /home/dracon/Dev/pi-goal-list-loop-audit
```

---

## Operator notes (by release)

Everything below is reference material written as features landed — you don't
need it to get started.

## Auditor model: the built-in-provider rule

The auditor runs in a **detached fresh pi RPC process with no extensions**, so it can only use **built-in providers** (opencode, openrouter, minimax, google, anthropic, …).
You select the model in pi; the auditor uses it. The plugin never picks a
model itself. The resolution is just:

1. your explicit auditor pick — `/glla → Auditor model`, else
2. the pi session model — whatever you selected in pi.

If your session model's provider is extension-registered, the auditor's
extension-less session cannot auth it and the plugin says so at session start,
with the two fixes: switch pi's model to a built-in provider, or choose a
working auditor model in `/glla → Auditor model`.

Whatever you choose must work extension-less. Verify with:

```bash
PI_CODING_AGENT_DIR=/tmp/bare-agent pi -p "say ok" --model "provider/model-id"
```

The detached worker resolves `pi` from `PATH` and inherits the normal
`PI_CODING_AGENT_DIR`/provider environment. Set `GLLA_PI_BINARY=/absolute/path/to/pi`
when the CLI is not on the worker's PATH; credentials are never written into
`.pi-glla/audit-jobs/` or command arguments.

## Loop behavior: the multi-signal stuck gate (v0.25.1)

A `/loop` iteration is judged STUCK only when **every** progress signal is
zero — no file writes (`write`/`edit`/`multi_edit`/`write_file` tool
results), no git commits since the iteration began (HEAD advance), no
`spec_item_progress` ledger events, and no *paired* forward transition
("Next step (iter-N…)" text only counts when the same iteration also wrote
a file or committed — narration alone is the narrate-but-don't-ship loop)
— **and** the legacy same-tool-same-result check also fires.

Why it changed: the v0.24.0 single-signal detector (same tool + same
result hash 3×) killed two real user loops that were shipping work with
stable verification output — stable verification is the GOAL state of a
metricless loop, not the stuck state. See `docs/DESIGN.md` for the shipped
design overview. `/loop start toolsamerepeat=0`
disables the legacy check entirely; `/loop finish [reason]` ends a loop
cleanly with stopReason `completed: <reason>` (distinct from
stuck/plateau/stopped-by-user).

## Provider recovery + aggressive mode

**Reason-agnostic retry.** Provider wording and upstream retry hints are not
used as availability or quota checks. Any retriable auditor failure is
infrastructure, not a verdict: the goal pauses with one eager 5-second retry,
then retries at the next `:00:30` slot after each hour starts. The durable
attempt and 24-hour bounds prevent an unbounded worker storm. `/goal resume`
retries immediately; a user pause is never stomped. Main-model recovery uses
the same generic policy and an ordered backup chain when configured.

**Aggressive mode** (Settings → Aggressive mode in `/glla`) flips the
continuation DEFAULTS toward keep-going:

| Key | default | aggressive |
|---|---|---|
| autoResume | default (hold on session load) | on (GLOBAL-only since v0.29.5 — project keys inert) |
| auditCap | 5 | 10 |
| stuckMaxInterventions | 5 | 10 |
| wedgeAlertMinutes | 30 | 0 (off) |

Explicit per-key settings always win — aggressiveMode flips defaults, never
your choices. Under aggressive mode an audit-cap disapproval streak does
NOT pause: the auditor's objections become a TODO list (`pendingTasks`)
rendered into every continuation, and the goal stays ACTIVE. Every
auto-event announces itself with a one-line notify.

## Subagent stall action (v0.35.64)

The subagent watchdog warns after short no-progress windows. A top-level
tracked child that remains frozen for the longer
`subagentHangEscalationMinutes` threshold (default `30`) receives one
child-specific abort request; the parent goal is not aborted. Set the value to
`0` under `/glla` for warning/telemetry only. Unreachable, nested, or
ownership-ambiguous children remain warning-only, and partial output stays
available for inspection.

## Subagent model inheritance (v0.24.6)

If you use `@tintinweb/pi-subagents`: its default `Explore` agent pins
`anthropic/claude-haiku-4-5`, so `Explore` subagents run on a **different
provider and quota pool than your session** — a quota-capped key (e.g.
OpenRouter) 403s after a few concurrent spawns even while the parent
session is fine.

glla fixes this by default: at session start it manages
`~/.pi/agent/agents/Explore.md` (pi-subagents' native override mechanism)
without the model pin, so subagents inherit your session model. Your own
same-named files are never touched (glla only edits files carrying its
`x-managed-by` marker).

Control it via `/glla` → Settings:

- **Subagent model strategy** — `inherit-parent` (default, subagents share
  your session model + quota) or `agent-default` (upstream: Explore pins
  haiku — cheap search, separate quota).
- **Subagent Explore model pin** — e.g. `minimax/MiniMax-M3`; always wins
  over strategy.

Changes apply to NEW pi sessions (pi-subagents registers agents at its own
session start).

Release-workflow note: installing into the local extension tree
(`~/.pi/agent/npm`) requires `--legacy-peer-deps` — a pre-existing
`@pi-unipi/notify` peer pin on `@earendil-works/pi-coding-agent@^0.78.0`
conflicts with the current pi release.

## Run the tests

```bash
npm test
```

Expected output at v0.35.3: 1363 passing tests across 113 files (1 env-gated skip).
Counts change as bounded regressions are added; use the command output
as the source of truth ("N pass / 0 fail").

## Run the type-check

```bash
npm run check
```

Expected output: no TypeScript errors.

## End-to-end smoke test

After installing:

1. In a pi session, run:
   ```
   /goal start "
   Add a /healthz endpoint to src/server.ts that returns {status:'ok'} JSON.

   Done when:
   - curl -fsS localhost:3000/healthz returns 200 with body {\"status\":\"ok\"}
   - The file is committed
   "
   ```
2. The orchestrator creates `.pi-glla/goals/<id>.md`, schedules continuation, and the agent starts.
3. The agent reads the goal, makes the change, runs the verification, and calls `complete_goal`.
4. The orchestrator queues a detached auditor worker and returns control to the main turn.
5. The worker inspects files, runs `curl`, reads `git log`, and writes an identity-checked result.
6. Either `<approved/>` → goal archived; or `<disapproved/>` → loop continues.

## Reading the state

While the loop runs:

```bash
ls .pi-glla/                  # see live state
cat .pi-glla/active.jsonl | tail -5
cat .pi-glla/goals/<id>.md    # current goal markdown
ls .pi-glla/archive           # past goals
```

## v0.1.0 verification status (2026-07-20, all live-verified)

- [x] Live `agent_end` loop fires after agent returns.
- [x] `complete_goal` triggers the isolated auditor session.
- [x] Auditor session correctly isolates (no extensions — discovered the built-in-provider rule).
- [x] `<approved/>` archives the goal with clean history.
- [x] `<disapproved/>` / auditor error continues or pauses with feedback.
- [x] 5-consecutive-error auto-pause fires (verified via live 403 storm).
- [x] Stale-ctx safety after session replacement (lastCtx pattern).
- [x] `npm test` 24/24. `npm run check` clean.

Current behavior: completion audits are detached from the main pi process.
Use `/goal status` to distinguish queued/running/recovery-pending work and
`/goal cancel` to discard a pending claim; a fresh `/goal resume` starts a new
attempt after lifecycle replacement.

## Reading your glla telemetry (v0.25.2)

`/glla stats` scans `.pi-glla/active.jsonl` across every project on the
rig and prints a per-project rollup: goals created, audit verdicts
(approved / disapproved / infra errors), average turns and file writes per
goal, premature-success count, total tokens, and last activity.

**Premature success** = an approved goal with < 50 turns AND < 5 file
writes AND < 8 bash calls — the "claimed done in 12 turns with 0 file
writes" pattern an auditor should have caught. `/glla stats premature`
lists only those projects, worst ratio first. Goals archived before
v0.25.2 have no telemetry and are never flagged retroactively.

`/glla stats json` emits the same rows as JSON (pipe to `jq`);
`/glla stats project=~/Dev/xyz` scopes to one project. `total_cost` is
measured in tokens (this rig has no per-provider price table).

## Modes (v0.25.3)

The three loops are not redundant — each long-runs differently:

| Mode | Item size | Long-running by |
|---|---|---|
| `/goal` | ONE big multi-hour task | Scope |
| `/list` | N items × short (minutes each) | Queue depth |
| `/loop` | 1 metric × infinite polish | Bounds |

`/list` items should fit in a single agent run; hundreds of them in the
queue is the right framing. `/list depth` shows queue depth, oldest item
age, and average item duration. Drafting cross-recommends: multi-hour
seeds in `/list` get pointed at `/goal`, aggregate "N items, one commit
each" seeds get shaped into N short items. See **LIST-PHILOSOPHY.md**
for the full hierarchy and the wrapper-goal anti-pattern it prevents.

## Auditing the auditor (v0.25.4)

Every audit verdict is appended to `.pi-glla/audits.jsonl` (goal id,
verdict, model, full report) — the durable trail for "where are we weak"
reviews. `/glla audits` lists the last 10 verdicts, `/glla audits 30`
shows more, `/glla audits full` prints the latest report. Reports are
think-block-stripped; disapprovals end with a `## Required fixes`
actionable tail, which is also what capped executor feedback keeps.

## Reviewer (postaudit since v0.27.5) — post-completion follow-up enqueuer

When a `/goal` completes or a `/list` queue empties, the reviewer fires:
it reads the archive + audit reports, extracts findings, classifies them
by **leverage**, writes a report to `.pi-glla/reviews/<goal-id>-<ts>.md`,
and cascades:

| Finding class | Action | Confirm? |
|---|---|---|
| Bug (`TODO`, `FIXME`, `bug`, `regression`, `broken`) | `/list` items | No — fix-without-confirm |
| Refactor (`duplicated`, `could be cleaner`, `left out`) | `/list` items | No |
| Architectural (`rewrite`, `new dependency`, `schema change`) | `/goal` proposal | Yes |
| Strategic (`should we…`, `deprecate`) | notify only | — |
| Clean completion (no findings) | audit `/goal` proposal | Yes |

The leverage principle: if you'd never say no to fixing a bug, the
reviewer doesn't ask. Decisions stay with you.

**Modes** (`/glla postaudit` → Mode — `/glla reviewer` is a kept alias —
or `/review <id> <mode>` for a one-shot override):

| Mode | Problems / improvements found | Architectural | Clean completion |
|---|---|---|---|
| `off` | reviewer never fires | — | — |
| `on` (default) | `/list` items, no Confirm | `/goal` proposal (Confirm) | audit `/goal` proposal (Confirm) |
| `auto` | `/list` items, no Confirm | `/list` items, no Confirm | audit enqueued as a `/list` item, no Confirm |
| `aggressive` | `/list` items, no Confirm | `/list` items + the first finding **relaunched as the next active `/goal`** | the regression-scan audit **relaunched as `/goal`** directly |

(v0.27.9 replaced the old `default`/`report` modes with this 4-mode set:
`default` → `on`; `report` was dropped — a silent report with no cascade
was the do-nothing mode.)

`auto` is the **auto-loop**: run it once and the cascade keeps rolling
through everything it finds — problems, improvements ("consider
adding…", "could be improved", "enhancement" are extracted too), then
the regression-scan audit — until the findings run dry. `aggressive`
goes one step further: the queue is skipped for the headline item — the
first architectural finding (or the clean-completion audit) relaunches
as the next ACTIVE goal with no Confirm at all, so the unattended rig
never stops. Strategic
findings (`should we…`) stay notify-only in every mode: decisions never
auto-fire. Extraction ignores code lines, markdown tables, code spans, and the
reviewer's own report vocabulary (v0.26.3), and findings are mined only
from the archive plus DISAPPROVED/error audit reports — an approved
report is the executor's self-claims, zero finding signal (v0.26.4,
after a second live self-match on the 0.26.3 completion). Stalls are
watched three ways: refire streaks and a pending-latch watchdog (a queued
continuation whose turn trigger was dropped — seen post-compaction) both
escalate to a loud pause/stop, and busy-session wedges alert at 30m
(v0.26.5). The heartbeat never suppresses itself on "recent ship" — that
heuristic self-sustained via state-file mtime (v0.26.6, after a 9.1h
darklord stall). In `auto` the 5-minute refire window is skipped for
list-complete events (the queue emptying is the cascade's natural
rhythm); the per-day cap (`maxReviewsPerDay`, default 20) still bounds
everything.

Safety: no firing on aborts/pauses, a 5-minute refire window blocks
runaway recursion, `maxReviewsPerDay: 20` caps the day, and `/loop`
never triggers it. Configure per-project via `/glla postaudit`
(mode, triggers, cascade steps, caps) — the block lives
in `.pi-glla/settings.json` under `postaudit` (the legacy `reviewer` key
is still read). Re-review any archived goal with
`/review <goal-id>` (bypasses the trigger gates).

## Stall handling (v0.26.1) — the zombie killer

Motivating incident (hegemon, 2026-07-25/26): a metricless spec loop
stopped producing turns; the heartbeat re-fired every 60s for **23.5
hours** (619 refires, zero turns, zero tokens) while the status line
still read "active". Three gaps made it invisible: the send path was
silent, the nudge counter counts *turns* (a zombie runs none), and no
compaction hook existed.

What ships:

- **Send-path ledger instrumentation** — `loop_turn_sent` /
  `loop_turn_send_failed` (with the error text) and
  `goal_continuation_sent` / `goal_continuation_send_failed` are now in
  `.pi-glla/active.jsonl`. A stall is diagnosable from the ledger alone:
  refires without matching `*_sent` = the send is throwing; `*_sent`
  without a following turn = the turn trigger is dead.
- **Refire-streak escalation** — consecutive heartbeat refires that
  produce no real agent turn are counted (reset only by `agent_end` /
  `tool_call`, never by the refire itself). At the threshold (default 5;
  edit Stall escalation refires in `/glla`, 0 = never) the supervisor stops spinning:
  the loop stops / the goal pauses with `stalled: continuation not
  landing`, a `stall_escalated` ledger event, a TUI warning, and an
  external notify. The fix on the box: restart pi, resume.
- **Compaction hook** — `session_compact` now re-arms the continuation
  chain ~2s after compaction when the session is idle with nothing
  scheduled (`session_compact` + `compaction_refire` ledger events), so
  post-compaction recovery no longer waits for the 60s heartbeat.
- **Stall surface** — the status line and widget show `stalls:N` while
  the streak is nonzero, so a spinning supervisor is visible at a glance.
