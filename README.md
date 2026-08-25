# pi-goal-list-loop-audit

> **Mission control for autonomous pi.**

Interview-drafted goals, an audited task queue, and forever-loops (metric, spec, project-audit) that run for hours. Every goal starts as a **drafted contract you confirm** — nothing activates sight-unseen. The plugin then writes a durable goal to disk, drives the agent through an `agent_end`-driven loop, and on each `complete_goal` queues a **detached auditor worker process** to verify the work without holding the main pi turn open. Stall recovery, structured decision pauses, and consent gates keep you in charge while it works.

The auditor runs in a fresh extension-less pi RPC process with no extensions, skills, prompts, themes, or context files. It has `read` / `grep` / `find` / `ls` / `bash` in intentional power mode. It cannot see the implementing conversation and receives no glla extension APIs or parent state handles, but bash is not an OS sandbox: a prompt-injected command or verifier can write repository/glla files or plant evidence. Its durable result is attempt-identity-checked and revalidated by the parent (including the regression shield) before it can archive a goal.

This is a detached process, not a nested session in the main pi process. `complete_goal` returns after writing the claim and job request; the status surface shows `auditor queued`, `auditor running`, or `audit recovery pending` while the worker runs or awaits a fresh lifecycle.

On Windows, npm installs the `pi.cmd` shim rather than a directly executable `pi` binary. The auditor launches it through an explicit `cmd.exe` boundary; arguments are quoted only when tokenization requires it (v0.35.27 — quoting a bare executable name breaks `.CMD` shim resolution on pnpm installs), and every argument passes the unsafe-character gate (`%`, CR, LF) before that decision. POSIX keeps direct shell-less execution. Protocol snapshots also tolerate transient Windows file-locks without deleting the last valid snapshot first.

**Current package version:** `v0.35.60` — use `/glla version` to see the installed version and the command for comparing it with the registry latest. This checkout may contain unreleased changes; the npm registry is authoritative for published versions.

## Why this exists

Most pi goal extensions — `pi-goal`, `pi-goal-x`, `pi-loop-mode`, `ralphi`, `tmustier-pi-ralph-wiggum` — let the same agent that did the work also be the verifier. **That's the bamboozle trap.** The agent that wrote the implementation also says "I'm done", and the loop trusts them.

`pi-goal-list-loop-audit` separates **implementation** from **verification**. Two independent processes, two independent read paths, two perspectives.

### Architectural guarantee

| Stage | Protection |
|---|---|
| Goal intake | Deep upfront grilling + Confirm/Reject dialog; nothing activates unconfirmed |
| Implementation | Zero-pause autonomous execution: `agent_end`-driven loop with autonomous pivoting & sensible defaults |
| Milestone gates | Structured task milestones with mechanical test execution before completion |
| Pre-Audit | **Deterministic Fast-Fail**: Mechanical shell checks (`npm test`, `tsc`, `cargo test`) run in ~200ms before spawning the auditor worker |
| Final Verification | Detached extension-less auditor process + **regression_shield**: raw command output required per verification-contract item, enforced orchestrator-side |
| Queue Hygiene | Anti-queue-drift: every single `/list` item receives an independent detached audit pass before queue advancement |

## Quick start

Install:
```bash
pi install npm:pi-goal-list-loop-audit
pi install npm:@juicesharp/rpiv-ask-user-question   # effectively required — see Recommended companions
```

Five top-level commands — `/goal`, `/list`, `/loop`, `/glla`, `/review`:

```
/goal                              # drafting: agent grills, you Confirm
/goal "audit the repo"             # no contract clause → agent grills you first (propose is gated on it)
/goal "Step 1. Step 2. Done when: tests pass."   # has contract → starts now
/goal start "fix the flaky login test"          # explicit skip-draft: starts now, no interview (auditor infers the contract)
/goal plan "build a greenfield crawler"         # extended draft for greenfield/megaplan work: research-first, multi-round interview, structured expanded objective — still Confirm-gated (v0.35.33)
/goal status                       # show state
/goal pause                        # pause
/goal resume                       # resume
/goal cancel                       # abort
/goal decide                       # re-open the decision picker (v0.28.23)
/goal audit "focus on payments"      # one-shot project audit; optional focus text
/goal verify                       # queue a detached auditor for the current goal — no agent turn (v0.28.27, renamed from /goal audit in v0.29.8)
/goal tweak "<new objective>"      # edit in place (Confirm dialog)
/goal archive                      # archived goals, newest first
/glla                               # settings UI table · actions include /glla version · /glla status · /glla stats · /glla audits [N|full] · /glla agents (tracked-subagent panel; --tail <id> reads a child transcript read-only) · /glla pause (freeze ALL supervisor automation — active work keeps running) · /glla cancel (cancel the active objective) · /glla postaudit · /glla wipe (idempotent all-live-state reset, Confirm-gated)
/list fix the login bug, add dark mode, write docs   # dump it — the agent shapes it into items, one Confirm
/list plan.md                      # file detected → bulk import, one Confirm (sisyphus/Ralph style)
/list <paste a checklist>          # multi-line paste → same batch flow
/list "fix the flaky test. Done when: npm test green"   # explicit contract → added directly, no interview
/list                              # show the list (add/import are optional no-op aliases — detection routes everything)
```

(Or just say it: "queue these 10 things…" — the agent manages the list too.)

**Order is the default, not the law**: auto-advance takes the head (FIFO), but
`/list next <n>` or the agent's `list_activate` tool picks any item — with
subagents, what gets worked next is a choice, not a position. Numbering always
matches `/list show`.

```
/list                              # show active + waiting items
/list next                         # skip current, activate next
/list remove <n>                   # drop item n from the list
/list clear                        # empty the list
/list cancel                       # stop the whole list: abort the active item + drop all waiting
/list plan "a greenfield blog engine"   # extended draft: deep research + multi-round interview, then ONE Confirm proposes the whole items[] batch (v0.35.33)
/loop                              # draft the loop (agent grills; measure is test-run before you confirm)
/loop plan                         # extended loop draft: deep research + multi-round metric design (v0.35.33)
/loop start "keep polishing the UI"                          # infinite metricless loop (v0.23.6): no plateau, no cap — ends at time=/tokens= or /loop stop
/loop respec                                                  # infinite metricless loop reconciling the codebase against the root SPEC.md / spec.md (v0.24.3) — 2 specs = you pick, 0 specs = drafting, 1 spec = auto-start (v0.24.4)
/loop audit                                                    # project-audit loop (v0.29.0): each iteration audits fresh, appends findings to .pi-glla/audit-loop/findings.md, fixes the top ones — the orchestrator counts open findings and the plateau stop ends it when the well is dry (one-shot version: /goal audit)
/loop start "reduce TODOs" measure="grep -c TODO src.txt | head -1" direction=min
/loop start "shrink the bundle" measure="..." direction=min time=4 tokens=500000   # arbitrary bounds
/loop start "reduce TODOs" measure="..." direction=min branch=1   # scratch-branch mode
/loop start "keep improving SPEC.md" measure=none max=20   # metricless with an explicit cap (v0.23.0)
/loop status                       # iteration, best, stall, recent values
/loop stop                         # halt with summary
/review <goal-id> [off|on|auto|aggressive]   # re-review an archived goal (bypasses the trigger gates)
```

### What the verbs mean

The same verb can mean different things on each surface — and `audit` is
deliberately three different machines:

| | **draft** (bare / text arg) | **start** | **plan** | **audit** |
|---|---|---|---|
| `/goal` | agent interviews you, one Confirm | skip the interview, start now | **extended draft**: research-first, multi-round interview, structured expanded objective — still ONE Confirm (v0.35.33) | **one-shot project audit**: a single collect-then-fix pass as an ordinary audited goal; findings are fixed in that pass, DECIDE findings come to you untouched |
| `/list` | batch-drafts your items into ONE confirmed queue | *(use drafting or direct adds)* | **extended draft for greenfield queues**: deep research + interview proposes the whole items[] batch (v0.35.33). Prose only — a file path stays bulk import (`/list plan.md` imports as-is); inside `/list plan`, files you mention become research input, never auto-imported | **collect, then drain**: queues an item that CHANGES NO CODE — it only appends findings to `.pi-glla/audit-loop/findings.md`; on completion each open finding becomes its own list item, drained fix-by-fix with its own audit (v0.31.0) |
| `/loop` | drafts the loop; your measure is test-run before Confirm | start a loop directly from args | **extended loop draft**: deep research + multi-round metric design before anything runs (v0.35.33) | **forever audit cadence** (v0.29.0): each iteration audits fresh and fixes the top findings; the plateau stop ends it when the well is dry |

Related but distinct: **`/goal verify`** audits the CURRENT goal's work right
now (detached auditor, no agent turn) — it does not survey the project.
One audit initiative per session: starting a second kind warns about
superseding the first.

**Metricless loops** (`measure=none`): for genuinely endless work — an
ever-improving spec, continuous hardening — where no number means "better".
There is **no plateau stop** (nothing to stall on): the loop ends only at
its bounds (`max` iterations — `max=0` is truly unbounded — `time` hours,
`tokens` budget) or `/loop stop`. Every iteration must make one real,
inspectable change; cosmetic churn is the known failure mode
(doorknob-polishing). The drafter offers this when you say there is no
number, and tells you the trade-off before you confirm. Work with a finish
line is still a `/goal`.

**Anti-repetition** (v0.24.0, both loop flavors): the plateau stop watches
the *number*; the stuck ladder watches the *work*. Every iteration is
classified — exact/near-duplicate replies, A-B-A-B alternation, same
tool-same-result three times, narration-only streaks, degenerate
single-reply repetition — and a stuck iteration swaps the next prompt for
a rotating intervention (different approach → different subtask →
PROGRESS.md → fix one test failure → review your own diff). Three stuck in
a row escalates to a hard reset (banned openings, tool-call-first); five
stops the loop with the reason — bounded and surfaced, like plateau.
Continuation lines also rotate: identical prompts invite identical answers.

Subcommands match **exactly** — `/goal pause the pipeline` sets an objective
about a pipeline; only bare `/goal pause` pauses. (Same rule everywhere, so
your objectives can start with any verb.)

Drafting rules: **no-args drafts, args-without-a-`Done when:`-clause get
grilled by the agent (proposing is mechanically blocked until you have
replied at least once — typed chat or an answered `ask_user_question` dialog
both count), args-with-a-clause start instantly, `/goal start` skips the
interview by explicit command, a file path is
bulk direct.** The `plan`
verb is the fourth depth on every surface: same Confirm gate, but the agent
researches BEFORE asking and interviews across multiple rounds — for
greenfield or megaplan work where the normal 5–7-question draft would be
too shallow. A
sisyphus-style plan file (checklists, bullets, numbered, plain lines) imports
as-is — headings become nothing, items become goals. And the drafter itself
batches: asking for "these 50 tasks" in a `/list` drafting session produces
ONE confirmed batch, not 50 dialogs.
Note: every list item is audited individually, so at hundreds of items the
audit cost per item is the thing to think about.

Long-running judgment is explicit: the drafter preserves the objective and
verification contract, prefers a durable root-cause fix, allows a safe,
reversible workaround when it is genuinely useful, and asks only at an actual
scope/permission/irreversible-action decision boundary. If you want a design
checkpoint before implementation, mark a goal, list item, or task-plan entry
with `Agent: Designer` (also accepted: `Role: designer` or `Designer: yes`).
The managed Designer is read-only; if it is unavailable, the main agent keeps
the same checkpoint inline.

Drafting can use a separate temporary agent configured in `/glla` under the
**Drafter** tab (`Drafter agent`, `Drafter thinking`, and `Drafter fallback
agents`).
The thinking choice is derived from the selected model, applies only while the
drafting agent is active, and restores the original session thinking level
after confirmation or interruption. A drafting failure retries the existing
interview through that agent's fallback chain. Main-agent and auditor-agent
recovery chains remain separate. Provider recovery is intentionally blind:
there is no live quota checking or reset inference; the generic retry envelope
and the optional hourly `:00:30` probe remain the policy.

**Drafting is the default for long-running things.** `/goal` and
`/loop` with no arguments — and any vague `/list` dump — all start a
grilling turn that ends in a Confirm dialog. For `/loop` specifically, the orchestrator **test-runs the proposed
measure command once** and shows the real number in the dialog — you validate
the metric before a single iteration burns tokens.

With `branch=1`, all work lands on a scratch branch (`pi-glla-loop/<ts>-<slug>`):
improvements are committed, regressions are hard-reset (scratch branch only),
and on stop you return to your original branch with merge instructions.
Requires a clean working tree.

Loop 3 is metric-driven: the **orchestrator** runs your `measure` command after
every agent turn. The agent never self-reports progress — the loop only
believes a number. There is no auditor in loop 3; the metric is the verdict.

**A loop never completes.** Goal = achievement, loop = process: there is no
`done=` (v0.15.0 removed it — "improve until X" is a `/goal`). A loop runs
until `/loop stop`, plateau (`window=5` non-improving iterations — the well is
dry, not "done"), `max=` iterations, or the arbitrary bounds `time=<hours>` /
`tokens=<budget>`. And the spec is **alive**: mid-loop the agent can call
`propose_loop_refine` to sharpen the target or swap the measure — you confirm,
the orchestrator test-runs and re-baselines, and both eras stay in history.

## Recommended companions

glla is the goal plane — it drives, verifies, and notifies. It does not
try to be the whole rig. Four plugins round it out. The first is
**effectively required** — glla's drafting interviews, DECIDE findings,
and confirm dialogs are built around structured questions (it degrades
to plain-text prompts without it, but that is the fallback path, not the
product). The other three are optional; glla works without them:

- **`@juicesharp/rpiv-ask-user-question`** — **install this one.**
  Structured questions with multi-select and markdown previews: the
  /goal drafting interview, DECIDE findings, and every confirm dialog
  render through it. Without it you get prose fallbacks — functional,
  but not the intended UX.
- **`@tintinweb/pi-subagents`** — the `Agent` tool: parallel Explore /
  Plan / general-purpose subagents. glla's prompts teach fan-out with ROI
  (parallelize real work, never ceremony spawning) and brief discipline,
  and big audit collects genuinely assume this exists. glla's subagent
  guarantees (the main session owns the goal; workers can't clobber it)
  are plugin-agnostic, but this is the provider we test against.
- **`@juicesharp/rpiv-advisor`** — a second opinion the executor model
  can request mid-flight: the whole conversation branch is forwarded to a
  stronger reviewer model, which answers with a plan, a correction, or a
  stop signal. Drive the session with a cheap/fast model and buy strong
  judgment per call. Role clarity: the advisor is *advisory*, never
  verification — glla's isolated auditor remains the only completion
  gate.
- **`@pi-unipi/notify`** — push beyond the desktop: Telegram, Gotify,
  ntfy, with per-event routing. glla's built-in pushes cover the local
  desktop case and fire only where there is something to DO; add this
  for away-from-desk alerts — route it to critical events only, or every
  glla pause/verdict pings twice.

## Which loop? (the decision rule)

(Verb semantics — what `start`, `plan`, and `audit` mean on each surface —
are tabulated above, "What the verbs mean".)

**`/goal`** — one thing, judged *semantically*. Research, features, docs,
anything where "done" needs a reader. The isolated auditor verifies against
your `Done when:` contract with quoted evidence.

**`/list`** — many things, judged the same way, in turn. Bulk-import a plan
or just say "queue these 10 things". Order is the default, not the law:
`/list next <n>` picks any item.

**`/loop`** — one thing, as a **process that never completes**. Three
flavors: **metric loops** (a shell command prints a number that honestly
tracks progress — test failures, TODO count, bundle size, coverage %; the
metric IS the auditor here, so a fake metric is worse than no loop, and the
drafting step **test-runs your measure and shows you the real number**
before you confirm), **metricless spec loops** (no honest number exists —
the loop works a spec file with checkboxes instead; no plateau stop, ends
only at your bounds or `/loop stop`), and **`/loop audit`** (a forever
project-audit cadence that finds and fixes its own work). There is no
finish line ("improve until X" is a `/goal`); a loop runs until you stop
it, the metric plateaus, or a time/token bound trips. `/loop` with no args
drafts one for you — and if a loop is the wrong shape entirely, drafting
redirects you to `/goal`.

## Three loops on one state machine

| Loop | Command | Status |
|---|---|---|
| 1. Single ordered goal | `/goal "<objective>"` | **shipped v0.1.0** |
| 2. List of goals (a pool, not a FIFO) | `/list [show\|next\|remove\|clear]` | **shipped v0.2.0** |
| 3. Process loops (metric, metricless-spec, audit) | `/loop start\|status\|stop\|audit` | **shipped v0.3.0** |

Each loop is a different policy class on the same status machine.

## What this fixes vs. pi-goal-x

| Flaw in pi-goal-x | Fix in pi-goal-list-loop-audit |
|---|---|
| `detailedSummary` is hand-concat strings | Structured JSON state + native markdown renderer |
| Stuck-counter has no ceiling — 1-hour waits happen | Bounded retry envelope: eager 5s first retry, then the hourly-aligned ladder (v0.35.0); stall ladder + heartbeat nudges cap silent waits |
| Auditor can rubber-stamp after `bash true` | **regression_shield** (shipped v0.2.0): auditor must quote raw tool output per verification-contract item; orchestrator rejects evidence-free approvals |
| `pause_goal` is fire-and-forget | Clear `pauseReason` surfaced in status + agent feedback |
| Vague objective + weak auditor = rubber-stamp | Drafting phase with Confirm dialog + isolated auditor + shield |
| Auditor holds the main turn open | Detached worker returns control immediately; `/goal cancel` discards the pending claim |
| Auditor can't compact — context exhaustion mid-audit | Compaction enabled (v0.4.0); safe because the shield is orchestrator-side |
| Agent can grow subtasks indefinitely | `propose_task_list` with 20/5 caps + Confirm dialog (v0.3.0) |

## Live TUI (always know it's on)

A persistent `glla:` status segment + an above-editor widget show the current
goal/list item/loop at all times: objective, durable state, elapsed time,
tokens, next task or loop metric, pause reason, and live auditor progress
during audits. If something is running, you can see it — no command needed.
Goal cards label their total wall-clock age explicitly; it includes time parked
for recovery or waiting on a verdict, so it should not be read as active model
compute. Recovery cards call the timestamp `last host activity` for the same
reason: a retry/error event is liveness evidence, not proof of useful work.

The status bar is the single activity HUD. It uses compact state capsules plus
an animated pulse waveform so live work is obvious at a glance without turning
the line into a progress meter. Fresh stream age is the proof of live work:

```text
glla: [▁▂▄▆█▆ LIVE · WORKING] total 1m 09s · last stream 11s ago · 3 queued
glla: [QUEUED] 44s · 18 queued
```

The waveform is evidence-gated and indeterminate: it moves only while fresh
stream/tool activity is present, and says nothing about completion percentage.
Activity is otherwise intentionally honest:

| Indicator | Meaning |
|---|---|
| `LIVE · WORKING` | Fresh stream/tool evidence is arriving; the pulse and `last stream` age make that visible. |
| `BUSY` | pi is occupied, but no fresh stream evidence justifies a live pulse. |
| `QUEUED` | A continuation is waiting to start; no work is fabricated. |
| `IDLE` | The durable item remains active, but no recent work is observed. |
| `auditor …` | A detached, extension-less verifier is queued, running, quiet, or waiting for its verdict. |
| `RECOVERING` | A bounded automatic retry is pending; the status does not guess why the provider failed. |

Detached-auditor elapsed time keeps advancing between worker events. A long
tool call or hidden reasoning interval therefore remains visibly timed; after
three minutes without worker activity the UI changes to `auditor quiet` and
names the cancellation/recovery path instead of presenting a frozen live card.

**Per-phase glyphs + activity meter (v0.35.15).** Every auditor phase carries a
distinct glyph — `⋯` queued, `▶` running, `◌` quiet, `⛔` blocked, `✓`
awaiting-verdict — beside a draining `▰▱` activity meter, with the dense text
kept as secondary detail. When a quiet stretch ends, the footer summarizes it
(`silent 8m then resumed`) so silence is reported, not just survived. A single
proactive warning fires when the detached auditor crosses the quiet threshold;
it never repeats per tick.

**Supervisor freeze (v0.35.15).** `/glla pause` silences every automatic
side-effect — heartbeat re-arms, recovery probes, auto-resume, auto-continuation
dispatch, the proactive quiet notify, and (v0.35.17) the zero-stream auto-retry
below — without touching active work or a running detached audit. The flag is
persisted and survives restarts; `/glla resume` clears it. Bare `/glla` shows
the frozen state.

**Zombie watchdog vs subagent waits (v0.35.26, issue #13).** A parent
blocked on a foreground subagent call is stream-silent by design, so the
zero-stream watchdog stands down while one is in flight. The recognized
names cover both the built-ins (`Agent`, `get_subagent_result`,
`steer_subagent`) and the pi-subagents extension's registrations
(`subagent`, `subagent_wait`), shared by the watchdog and the wedge-alert
hint so they cannot drift apart again.

## Provider failures: aggressive retry envelope, bounded (v0.35.0)

Error text is **not trusted** to pick a retry policy. The runtime does not
query or infer provider quota state, and it does not use status codes, billing
words, rate-limit words, or `Retry-After` hints to choose a branch. Those
values are retained only as bounded diagnostics. Every recoverable main-model
failure uses the same durable envelope: an eager 5-second retry, then
`base → 2×base → 4×base → 8×base → 16×base → 5h`, where `base` is the
`mainModelRetryMinutes` setting (15 minutes by default). `hourlyRetryProbe=on`
adds a blind `:00:30` retry after each hour starts, so work can be picked up
quickly after a possible provider-side change. The automatic window is 24h;
explicit `/goal resume`, `/list resume`, or `/loop resume` starts a fresh
window. With global `autoResume=on`, pending retries survive a session reload.
A loop parked by the zero-stream abort (v0.35.25, issue #14) is explicitly
resumable: `/loop resume` re-arms it with the preserved iteration count,
best value, and history — exactly as the abort message promises.

Only failures identified by positive evidence as futile avoid automatic retry:
context/output-token limits and user aborts (`non-recoverable`). Auditor
watchdog timeouts are also kept separate because rerunning a hanging local
verification command immediately would repeat the same local failure; the
stored claim remains available for explicit resume.

For continuous work, configure up to **10 ordered Main-agent fallback models**
in `/glla` using independent model references when possible. The editor is in
the **Main agent** settings tab (one role per tab, with the current agent,
thinking level, and fallback chain together). It shows the actual try order as
`current → fallback 1 → fallback 2 …`, shows each configured fallback's rank,
lets **Space** add/remove a fallback, and **Tab** enters order mode where
**↑/↓** moves the highlighted fallback (brackets `[` `]` also reorder without
leaving the list). Every recoverable provider failure uses the same ordered
chain: glla calls `setModel` for the first eligible fallback, the next
supervised turn tests it, and later failures advance left-to-right. Forbidden,
unavailable, and unauthenticated references are skipped; a successful
supervised turn on a fallback proves only that fallback is healthy. By default
(`mainModelFailback=auto`), the original primary remains durable and is probed
again every `mainModelPrimaryProbeMinutes` (15 minutes by default); a successful
supervised primary turn fails back and clears the episode. Set
`mainModelFailback=sticky` to preserve the legacy stay-on-fallback behavior.
The chain is global, durable, and its attempted cursor survives reload. After
the chain is exhausted, bounded retries continue on the active model rather
than silently abandoning work.
The Main agent tab shows the `N/10` count and numbered chain. The Drafter and
Auditor tabs likewise show each selected model together with its requested
thinking level; fallback rows show the effective/requested thinking level when
the model registry exposes the capability map. Press `d` in the settings table
to toggle the long descriptions and give the model/value column the available
width.

Provider payloads are never copied into chat cards or notifications. A bounded
diagnostic may remain in the ledger and durable state for forensics, while
user-facing surfaces use the same generic provider-error label for every
failure family. The detached auditor follows the same rule: every retriable
infrastructure failure gets one eager 5-second retry, then stored-claim
retries at `:00:30` after each hour starts. Its existing 5-attempt/24-hour
safety envelope prevents an unbounded worker storm; explicit resume starts a
fresh window.

For long-running `/list` work, the card adds a compact queue trail with the
immediate next item and its truthful wait age while `/list` remains the
canonical full queue view:

```text
● Fix the current issue · list item · active · 42m
├─ ✓ bash tests/display.test.ts (35s) · next: update docs
├─ ↳ 23 waiting · up next: refresh the release notes · waiting 12m 04s
└─ 23 queued · /list · /glla
```

The card does not duplicate the animated activity badge. This keeps the
visual surface calm while still making a long-running list feel alive and
answering the useful questions: **what is active, is it really moving, and
what is next?**

## Self-watchdog (liveness is built in)

A 15s heartbeat detects the precise stall condition — active goal/loop + idle
session + nothing scheduled + quiet for 60s — and re-fires the continuation
itself. Three consecutive zero-tool turns pause the goal / stop the loop.
No external watchdog plugin needed. It also recovers **stranded audits**
(v0.29.1): a goal stuck in `auditing` with no detached worker alive re-runs
the stored claim after 90s instead of black-holing. Storm protection: the
send→pause→notify path rearms once per cycle and loud-stops after a 6-error
brake streak, so a broken provider can't spin forever. A confirmed queued
continuation with no turn is reported by the queue-stuck probe; it does not
inject terminal input.

**Zero-stream zombie abort + one bounded auto-retry (v0.35.17).** When pi stays
BUSY with zero provider stream activity for 20 minutes, glla warns; after a
10-minute grace it aborts the zombie turn and parks the work safely. Since
v0.35.17 the FIRST such silence arms exactly ONE automatic retry ~90 seconds
later (the park becomes a waystation, not a dead end — field: turns dispatched
by accepting Confirm dialogs hung this way repeatedly). If the retry also hangs,
the second consecutive silence parks permanently for manual `/goal resume` /
`/list resume`. `/glla pause` freezes the retry like every other automatic
side-effect.

## Session replacement and stale handles

Recovery crosses pi's lifecycle boundary. On `session_shutdown`, glla records
`.pi-glla/session-handoff.json` for a supervising, non-quit replacement,
ledgering the reason and stopping every session-owned timer. On the fresh
`session_start`, the new context consumes only fresh, same-process debt and
continues the saved goal or loop. Timers resolve a fresh context when they fire;
they do not retain an old `ctx` or `pi` handle.

A user quit is not continuation consent: `reason: "quit"` is ledgered as
`session_handoff_suppressed`, leaves no handoff debt, and does not receive
same-pid rebind consent. An orphan with no fresh lifecycle event is reported
honestly because an invalidated extension cannot repair its own pi host; use
`/new` (or restart pi normally) and let the saved `.pi-glla/` state restore.
`/reload` does not clear pi's cached context, and event handlers cannot create a
replacement session through the public pi API, so glla never claims automatic
stale-session replacement. There are no automatic `/reload` keystrokes and no
mux dependency. The legacy `autoReloadOnStale` and `autoRecovery` fields remain
only as deprecated settings-file compatibility fields; they are ignored.

**A stale handle never mutates** (v0.34.51–v0.34.54): every `/list` mutation
(add/remove/next/clear/cancel) and the bare `/glla` settings surface probe at
entry and refuse with the standard recovery message on a stale extension
context — a session that cannot announce or run its writes must not make them.
Mutating `/glla` actions (wipe/cancel/reviewer/postaudit/tooloverride) leave a
`settings_mutation_refused_stale` ledger trail; read-only surfaces (`/list
show`, `/goal status`) stay usable with the warning. Once the replacement
`session_start` arrives, both surfaces render cleanly with no stale residue
(the lifecycle-recovery harness proves the two-phase contract).

**User aborts mean STOP** (v0.29.4): Esc-aborting a turn stands the chain
down with a named notify (`/goal resume` to continue) — it does NOT count
toward stall warnings, does NOT auto re-fire, and the stand-down survives
the heartbeat (v0.29.5). Five consecutive aborts still pause loudly as a
backstop. A queued steer interrupt (`length`/`toolResult` races) is not an
abort and resumes normally.

## One active thing (confirmed replacement)

At most one goal/list-item/loop owns the active slot. A new same-mode start
never silently overwrites it: the user chooses **Update current objective**,
**Replace current objective**, or **Cancel new objective**. Cross-mode starts
offer explicit replacement/cancellation rather than silently converting a goal
into a loop (or vice versa). The queued list is a backlog, not a second live
thing. In headless mode, glla fails closed and asks you to resolve the existing
objective explicitly instead of guessing.

Session loads still repair dirty legacy state: if a pre-guard project persisted
a live loop AND a live goal, the most recent artifact keeps the slot and the
loser is archived (recoverable under `.pi-glla/archive/`), never silently
wiped. Legacy `complete`/`aborted` terminal slots are also cleared once their
archive exists, while the final summary remains available in history.

### Load without autostart (v0.35.23)

On startup glla RESTORES and DISPLAYS all durable state — active/paused
goal, waiting queue, loop — but holds every automatic dispatch until you
decide. The load hold freezes the same machinery as `/glla pause`
(continuation dispatch, loop ticks, heartbeat refires, recovery timers)
through one shared gate; unlike a manual pause it keeps host-loss
supervision probing, and it is released by any explicit work command:
`/goal resume`, `/list resume`, `/list next`, `/loop resume`, `/loop start`,
or starting a new goal. Every release is ledgered (`load_hold_engaged` /
`load_hold_released`). Set global **Auto-resume = on** to restore
load-time automation for unattended rigs — the consent is the raw setting,
not the aggressive-mode default. Narrow continuity exceptions keep working
without consent: validated handoffs/rebinds, same-process session
successors, re-arming of work already in flight when a host silently died,
and the single retry a parked completion claim earns when main-model
recovery heals the provider that parked it.

**Due-wait backstop (v0.35.28, issue #16).** A time-gated wait pause
(`pauseKind: "wait"` with a `pauseResumeAt`) is no longer trusted to
in-memory timers alone — agent-authored waits armed none, error-brake
cooldowns were not re-armed on reload, and every scheduled resume died with
its session. The heartbeat now compares wall time against `pauseResumeAt`
every tick and re-fires the route once the deadline lapses by more than
~90s (main-model waits probe the provider; other waits clear the park and
dispatch one fresh continuation). `/glla pause` and the load hold still
freeze it; every fire is ledgered (`wait_pause_overdue_resume`). Auto-resumed
goals carry a RECOVERY NOTICE in their next continuation prompt — "welcome
back, YOU were recovered" — so the agent continues its own work instead of
waiting for an external recovery signal that already fired.

## Completion and destructive commands

An approved objective writes its final completion summary to the archive and
shows one final `✓ done` notification, then closes its live slot automatically.
No follow-up cancel is required. `/glla cancel` stops only the active objective:
for a list-owned objective it also drops the waiting queue; an unrelated
standalone goal does not consume an unrelated list backlog. `/glla wipe` is the
Confirm-gated, idempotent all-live-state reset: it preserves archive and ledger
history, removes RAM state plus valid or orphaned queue sidecars, persists the
clean state before optional loop-branch cleanup, and completes in one
invocation. Headless `/glla wipe` refuses before changing state because the
confirmation is intentionally not bypassed.

## Config (one global place, rarely opened)

Open `/glla` to edit these settings in the table (the rows show effective values and provenance):

- Auditor model and thinking level
- Auditor fallback agent

**Auditor selection (v0.35.24):** the **Auditor model** row opens the same
`/model`-style fuzzy picker the main agent flows use — configured-auth models
only, with a session-model row and a typed escape hatch. It is at full parity
with the main selector on policy too: your forbidden-models patterns filter
the picker list AND a typed match is refused with a named warning, so a pin
saved here is one `resolveAuditorModel` will actually honor. The pick lands
in global `auditorModel` and is followed immediately by the auditor thinking
dialog for that model. The **Auditor fallback agent** row applies the same
filtering to the failure-over pin.

- Notify command, token limit, and wedge-alert minutes
- Auto-resume, auto-accept drafts, decision popup, and carryover policy
- Main-agent current model/thinking, fallback models, recovery cadence, and preferred-primary failback policy in the Main agent tab
- Drafter agent/thinking/fallback agents in the Drafter tab
- Auditor agent/thinking/fallback agent in the Auditor tab
- Forbidden model patterns and switch policy
- Audit cap/report size, aggressive mode (ON by default), retry cadence, and
  stall brakes

The argument namespace is reserved for actions such as `/glla status`, `/glla
pause`, `/glla resume`, `/glla cancel`, `/glla stats`, `/glla audits`,
`/glla tooloverride`, `/glla fallbacks clear`, and `/glla wipe`. `fallbacks clear`
atomically removes the global main-agent fallback chain and cancels any pending
fallback switch. Pause freezes every automatic supervisor side-effect (heartbeat
re-arms, recovery probes, auto-resume, continuation dispatch, loop ticks, quiet
notifications) without touching active work, and survives session restarts;
resume unfreezes. Cancel stops the active objective; wipe clears all live state
while preserving history. There is no top-level `/glla key=value` setting syntax.

Resolution per key: **project > global > defaults** — EXCEPT `autoResume` and
agent recovery settings (`mainModelFallbacks`, `mainModelRetryMinutes`,
`mainModelFailback`, `mainModelPrimaryProbeMinutes`, `drafterModel`,
`drafterThinkingLevel`, `drafterModelFallbacks`, `hourlyRetryProbe`),
which are **global-only**: per-project opt-ins from old versions
silently overrode the global hold at launch (the junk-runner incident), so
the launch-restore gate and the reviewer-enqueue gate read only the global
file now. Main-session recovery policy is likewise one global chain/cadence
for the active session. Main-agent fallback models are global and ordered (up to 10): a provider
failure selects fallback 1, then fallback 2, and so on, one supervised turn at a
time. The Main agent tab leads with the ordered-chain editor — a multi-select
picker where Space toggles membership, Tab enters order mode (↑/↓ moves a
chain row), and clearing the selection removes the global key. Forbidden,
unavailable, and unauthenticated refs are skipped. When every candidate is
down, glla stops the current send attempt and uses the configured
`base → 2×base → 4×base → 8×base → 16×base → 5h` ladder (`base` defaults to
15m). `hourlyRetryProbe=on` adds a blind :00:30 retry after each hour starts.
With `mainModelFailback=auto` (the default), a successful fallback keeps the
original primary as the preferred model and schedules a durable health probe at
the `mainModelPrimaryProbeMinutes` cadence; the primary is selected only for a
supervised probe, and a failure returns to the serving fallback. Set
`mainModelFailback=sticky` to disable this reverse probe. No provider
availability or quota check is made before any retry; all recoverable failures
walk the ordered fallbacks and then continue on the active model through the
bounded retry policy. Automatic recovery stops at 24h,
preserves the saved work, and requires an explicit
`/goal resume`, `/list resume`, or `/loop resume` to start a fresh window. A
provider becoming available within that horizon therefore resumes saved work
without manual intervention; no blind 50ms resend loop is introduced. The
detached auditor uses an explicit cascade: primary
`auditorModel` → optional fallback pin → the pi session model. If a selected
model fails after launch, the worker retries it once and then advances through
that same cascade; every candidate is still audited in a detached,
extension-less process. There is no in-process fallback into the parent
session. If the bounded cascade is exhausted, the exact completion claim is
stored and the goal pauses for `/goal resume`; infrastructure is never treated
as a verdict.

On disapproval, the executor receives the full auditor report by default
(`auditFeedbackChars=0`, since v0.24.9 — a truncated report loses exactly the
actionable tail of multi-item `<evidence>` blocks). Set a positive
`auditFeedbackChars` to cap it. The complete report is always stored in audit
history and is available through `/goal status` regardless.

`autoaccept=on` skips BOTH the Confirm dialog and the drafting interview
floor — every `propose_*` draft (goal, list batch, loop, task list)
activates the moment the agent proposes it, and a completed `/list audit`
fan-out queues its generated finding items without a second confirmation.
Both paths notify loudly; auto-accept is never silent. The seed carries the
intent. Since v0.29.4 auto-accepted drafts **start immediately**
— the draft path is decoupled from `autoResume`, which gates ONLY
launch-time restore of persisted state ("load it but don't auto-start it").
For fully unattended rigs you typically want both on; for attended rigs,
`autoaccept=on` + `autoresume=off` is the sweet spot (new drafts go, old
state holds).

## Subagents

glla's guarantees here come from glla itself (session-handle
discrimination), not from any specific subagent plugin — any Agent-tool
provider gets them. Subagent sessions bind extensions too, so glla loads
there — by design the **main session owns the goal/loop/list; subagents
are workers** (v0.23.8):

- A subagent session never clobbers the loop's session handle, never runs
  the restore gate, and never drives continuation — so the heartbeat,
  wedge alert, and auto-resume machinery always act on the main session.
  (pi hands a fresh ctx wrapper per event; `ctx.sessionManager` identity
  is the discriminator.)
- Subagent tool activity counts as activity for the wedge clock — a long
  subagent run is work, not a hang.
- With `@tintinweb/pi-subagents` specifically (the one we test against):
  read-only agents (Explore, Plan) get no glla tools; general-purpose
  agents see them but state-mutating calls (`complete_goal`, `propose_*`,
  `list_add`, `pause_goal`, …) are refused with "report back to the main
  agent".

## Token guard

Every goal tracks real token usage; crossing the budget pauses the goal.
Off by default (opt-in) — set Token limit in the `/glla` settings table. A
high value like 10000000 is a runaway threshold, not a big-goal threshold
(real research/feature goals legitimately burn 2-4M). Loop 3 doesn't need
this cap — it has its own brakes
(max iterations + plateau).

## Wedge alert

The turn-based watchdogs can't see one failure shape: the session is busy
but silent for a long stretch because ONE unbounded command (a test suite
that never exits, a dev server) is holding the whole goal hostage. The
heartbeat watches the wall clock: busy + no activity for 30 minutes →
in-session warning + your configured notify push, once per interval while
it persists. Tune Wedge alert minutes in the `/glla` settings table (0 = off).

Every other wait is bounded too: continuation retries are milliseconds,
nudge accounting counts consecutive unproductive turns (substantive text
or tool calls reset the counter) and pauses the goal / stops the loop after
3 — provider-error and user-abort turns are exempt (v0.27.3+). Measure
commands get a 10m
hard timeout, and the detached auditor aborts after 10m with no activity while no
an auditor tool is running. A long-running verification tool is allowed to
finish, but each tool has an independent five-minute ceiling and the worker
has a 30m wall-clock safety cap. Both paths are infrastructure errors, never
verdicts; interrupted claims remain stored for a direct retry after `/goal resume`.

## Compatibility (what goes well, what conflicts)

**The Two-Driver Rule**: any plugin that drives agent turns on `agent_end`
conflicts — two supervisors scheduling continuations into one session produce
contradictory turns. One driver at a time:

- **Hard conflicts** (do not install together): `pi-codex-goal`, `pi-loop-mode`,
  `pi-goal-x`, `pi-goal*`, `ralphi`, `pi-ralph*`, `pi-autoresearch` (active).
- **Overlap**: `@badliveware/pi-compaction-continue` — our heartbeat covers
  stalls while a goal/list/loop is active; both installed may double-nudge.
- **Installed-but-don't-run-simultaneously**: `@tmustier/pi-ralph-wiggum` —
  fine to keep, never run a ralph loop while a goal/list/loop is active.

**Goes well with it**: see **Recommended companions** above. `pi-chrome` too
(the research/search path for goals — logged-in browsing with no extra
services; standalone search skills like `mmx-cli`/`pi-search-skill` are
optional conveniences for bulk queries, not requirements).

**Overlaps — pick one**: `@tintinweb/pi-tasks` is a second task list next to
`/list`, and in practice the glla list *is* the task list (queue, statuses,
per-item audit trail) while the todos end up the weaker copy. We ran both
and removed pi-tasks. If you truly need session-wide dependency DAGs beyond
one ordered queue, it exists — but installing both is not the ideal combo.

**Two footnotes**: (1) extension-registered providers work in the main session
but not the auditor's extension-less session — if audits fail auth, choose
an auditor model in `/glla` settings. (2) `pi-notify-agent` notifies on every
turn; glla pushes fire only where there is something to DO (pauses, verdicts,
storms, wedge) and work out of the box — with no notify command configured glla
auto-detects `notify-send`/`osascript`; `notify=off` silences, `notify='<cmd>'`
customizes.

## Files

Post-decomposition layout (the v0.34.x monolith is gone — `loops/goal.ts` is
a thin activation/wiring installer):

```
extensions/  (34 files — all of them, grouped by concern)
  # command + UI surface
  goal-commands.ts             # /goal + /list command surface, drafting, wipe/stats
  settings-menu.ts             # /glla settings menu sections + rows
  goal-agents-panel.ts         # tracked-subagent panel (/glla agents) + widget line
  confirm-draft.ts             # Confirm-card markdown builder
  vision-assist.ts             # mmx vision routing + model-switch gate
  glla-version.ts              # version info for /glla version (source + npm)
  # state, types, pure helpers
  goal-loop-core.ts            # types, JSONL state reader, pure helpers
  goal-state.ts                # disk writer (persistStateLine serialization)
  goal-settings.ts             # settings load/save + global/project paths
  faulty-objective-recovery.ts # suspicious-objective classification + repair derivation
  goal-objective-conflict.ts   # live-objective conflict resolution on start/tweak
  goal-loop-shield.ts          # regression_shield (pure, dependency-free)
  goal-loop-display.ts         # widget/status rendering (incl. last-outcome retention)
  # continuation + recovery
  goal-continuation.ts         # continuation scheduling/dispatch + prompt templates
  goal-loop-dispatch.ts        # generation-bound dispatch records
  length-continue.ts           # stop_reason=length auto-continue policy
  goal-heartbeat.ts            # heartbeat self-watchdog, subagent probes, due-wait backstop
  goal-recovery.ts             # main-model recovery + completion-audit recovery
  main-model-recovery.ts       # pure model-fallback/probe scheduling helpers
  quota-retry.ts               # provider diagnostics + bounded retry windows
  # loop machinery (Loop 3)
  goal-loop.ts                 # /loop tick engine, git finish
  goal-loop-forever.ts         # /loop measure/parse/plateau helpers
  goal-loop-backoff.ts         # scheduling constants + stall/wedge/pending-latch decisions
  goal-loop-repetition.ts      # anti-repetition detectors (stuck ladder, v0.24.0)
  goal-loop-stats.ts           # ledger rollups + premature-success detection
  goal-loop-subagents.ts       # subagent markers + pinned-agent knowledge
  reviewer.ts                  # archived-goal re-review config + classification
  # auditor machinery
  goal-loop-auditor.ts         # auditor prompt + legacy in-process helper
  goal-loop-auditor-process.ts # detached worker protocol + shield revalidation
  auditor-extensions.ts        # auditor-session extension discovery + allowlist
  # model pickers
  drafter-model.ts             # drafting-only model resolution + fallbacks
  model-picker.ts              # single-model picker items
  multi-model-picker.ts        # multi-model picker UI
  model-selector.ts            # scope-aware fallback selector composition
loops/
  goal.ts                      # public activation/wiring installer (thin)
  goal-activation.ts           # event wiring, command registration, session lifecycle
  goal-tools.ts                # agent tools (complete_goal, pause_goal, list_*, loop drafts)
  goal-orchestrator.ts         # goal lifecycle: create/archive/advance, reviewer
  goal-list-queue.ts           # /list queue: enqueue/advance/drain, list drafting
  goal-auditor-hooks.ts        # completion-audit claim/recovery machinery
  goal-session.ts              # session-scoped runtime globals + lifecycle state
  goal-runtime-globals.ts      # ambient declarations for those globals
  goal-settings-ui.ts          # settings editors + model pickers
  goal-ui.ts                   # shared UI helpers (drafting state reset, notify wrappers)
prompts/  (7 — one per prompt surface; edited as .md, read at runtime)
  goal-loop-continuation.md    # continuation prompt template
  goal-loop-draft.md           # /goal + /list drafting interview
  goal-loop-plan.md            # extended plan draft — goal/list (v0.35.33)
  goal-loop-plan-loop.md       # extended plan draft — loop (v0.35.33)
  goal-loop-forever.md         # /loop driver prompt
  goal-loop-forever-draft.md   # /loop drafting interview
  goal-loop-forever-metricless.md  # metricless-/loop drafting variant
scripts/
  goal-auditor-worker.mjs      # extension-less RPC auditor child process
  goal-auditor-launch.mjs      # Windows-safe spawn spec builder (gate-before-quote)
  verify-auditor-extensions-offline.mjs  # gate: auditor session loads zero extensions
  smoke.sh                     # live integration harness (tmux + real models)
tests/                         # current test count is reported by `bun test`; no live pi required for the suite
docs/DESIGN.md                 # architectural decisions
PLAN.md                        # milestones, decisions, gates
```

## Detailed design

See `docs/DESIGN.md`. Milestones and decisions live in `PLAN.md`.

## Installation from source

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git
cd pi-goal-list-loop-audit
pi install .
```

## Publishing for other users

The npm package is public, but `publishConfig.access=public` does not publish
it by itself. Maintainers should configure npm Trusted Publishing for
`.github/workflows/publish.yml`, run `npm run release:check`, push a matching
`v<version>` tag, and publish a GitHub Release. That workflow then runs the
full checks and `npm publish --provenance --access public` without a long-lived
npm token. See [`docs/RELEASING.md`](docs/RELEASING.md); verify the result with
`npm view pi-goal-list-loop-audit version dist-tags.latest` before telling
users to upgrade.

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only); see [LICENSE](LICENSE).
