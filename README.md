# pi-goal-list-loop-audit

<p align="center">
  <img src="media/glla2.png" alt="GLLA work supervision in Pi" width="960">
</p>

> **Give Pi an outcome—not another prompt to stop halfway through.**

GLLA turns substantial work into a durable, supervised process: agree on the
finish line, keep working across turns, recover interruptions, and check the
result before calling it complete.

```bash
pi install npm:pi-goal-list-loop-audit
```

Then, in Pi:

```text
/goal plan Make this project's first-run experience ready for new users
```

Review the proposed objective and acceptance criteria, confirm them, and let
Pi work. Use `/glla status` to see what it is doing and what needs your attention.
**Waiting** yields to named background work while supervision remains active;
**paused** freezes automatic continuation. See [waiting and recovery](docs/RECOVERY.md#waiting-is-not-paused).

[Install and update](INSTALL.md) · [Practical workflows](docs/WORKFLOWS.md) ·
[Recovery](docs/RECOVERY.md) · [Settings](docs/SETTINGS.md) ·
[Pi package catalog](https://pi.dev/packages/pi-goal-list-loop-audit)

## About GLLA

Coding agents are good at taking the next step. Substantial projects need
something more: a remembered commitment, a reason to keep going, a way to
recover, and a finish line that does not depend on the agent sounding confident.

GLLA supplies that supervision inside [Pi](https://github.com/badlogic/pi-mono).
The main agent researches and implements; GLLA keeps the objective, progress,
pauses and completion claims on disk. A separate auditor inspects the result
against the agreed contract. Rejected claims return to work rather than becoming
successful-looking endings.

This is useful for features spanning several subsystems, migrations, repository
audits, documentation overhauls, backlogs and projects built from a specification.
It is not a new model, a hosted coding service, or a promise of hands-off correctness.
It works with your Pi session, tools and authenticated providers.

**The ambition is less babysitting, not less accountability.** You choose the
outcome and permissions; the agent handles ordinary implementation decisions;
important scope changes and decisions remain visible. Durable state and evidence
make it easier to inspect what happened—even after a long run or interruption.

## Pick the right work shape

| You want… | Use | What counts as finished |
|---|---|---|
| One result: a fix, feature, migration, research report or audit | `/goal` | An accepted completion audit against the objective and contract |
| Several independently verifiable results | `/list` | Each item is audited separately; the queue advances after settlement |
| Repeated improvement | `/loop` | A configured bound, metric plateau or explicit stop—not a claim that everything is solved |
| A project built toward an evolving specification | `/loop respec` | Every adopted requirement independently verified and the project archived |

For a quick question or tiny edit, ordinary Pi chat is usually enough. Use GLLA
when continuity and verification are worth the extra model calls and coordination.

## Start with one goal

A rough request can become a confirmed plan:

```text
/goal logins are broken, sort it out
```

GLLA drafts the outcome, asks questions when needed and offers confirmation.
Bare `/goal` opens the interview; `/goal plan ...` requests research-first drafting.
You do not need to arrive with a perfect specification.

If you already know the finish line, a `Done when:` contract starts directly:

```text
/goal Fix login error handling. Done when: failed logins return safe, useful errors; regression tests pass; the change is documented.
```

`/goal start ...` explicitly skips drafting. Be deliberate: an explicit start
can replace existing work. Drafting and direct starts are different consent paths.

### The work cycle

1. **Agree:** preserve the objective and observable acceptance criteria.
2. **Build:** the agent researches, plans and implements across supervised turns.
3. **Recover:** retain work and use bounded recovery when providers, sessions or workers fail.
4. **Claim:** the agent submits evidence; saying “done” in chat does not close the goal.
5. **Audit:** a detached verifier checks the saved claim. Missing evidence or rejection keeps work open.
6. **Archive:** accepted, durably settled work leaves a result and evidence record.

The agent can propose a task plan with `propose_task_list`; confirming the plan
makes its tasks tracked milestones, not proof of correctness. Completion claims
with unfinished tasks are refused unless an explicit deferral was recorded.

### Controls you will actually use

| Command | Purpose |
|---|---|
| `/glla status` | Inspect supervision, recovery and current work |
| `/goal status` | Inspect the saved goal |
| `/glla pause` | Freeze automatic supervision without killing an already running tool |
| `/goal pause` / `/goal resume` | Hold or resume the goal |
| `/goal tweak ...` | Propose a changed objective with confirmation |
| `/goal verify` | Request verification of the current goal now |
| `/goal audit [focus]` | Start a new one-pass repository audit; this is not `/goal verify` |
| `/goal cancel` | Cancel the current goal, not certify it as complete |
| `/goal archive` | Inspect archived goals |
| `/glla bug [description]` | Capture diagnostic context without changing the objective |

## Work through a backlog

```text
/list import plan.md
/list show
/list resume
```

A list is a durable **work pool**, not a dependency graph. Imported batches get
confirmation; pasted checklist items retain their wording and boundaries.
`/list add ...` queues work, `/list start` activates the head, and `/list next <n>`
chooses a particular item using the numbering in `/list show`.

After an item is approved and archived, the next queued item normally starts
automatically. `/list resume` retries eligible saved work. `/list remove <n>`
removes a waiting item; `/list cancel` cancels the active item and drops waiting
items. Use these deliberately.

Normal-chat requests such as “queue these fixes” can use the packaged
[delegation skill](skills/glla-delegate/SKILL.md). Discovered follow-ups should
be offered before they are queued—not silently turned into extra scope.

## Improve repeatedly—or build from a spec

For a measurable process, use `/loop` to draft a target, measure and bounds.
The measure must print one honest number; GLLA test-runs it before confirmation.
Metric loops can stop on plateau. Metricless loops have no invented plateau
signal and need iteration/time/token bounds or an explicit stop.

```text
/loop
/loop start "keep improving the spec" measure=none max=20 cadence=900
/loop audit
```

`/loop audit` repeats project-audit passes. For one pass, use `/goal audit`.
`/loop stop` stops the process without declaring unfinished work complete.

For a project rather than a repeated metric:

```text
/loop respec Build the missing capabilities in SPEC.md and prove the result
```

The builder researches the repository and root `SPEC.md` (or `spec.md`), drafts
requirements with acceptance criteria, and asks you to adopt that scope.
It plans build batches, submits claims to an isolated auditor and replans unmet
requirements. Previously verified capabilities are checked again for regressions.
Marking a task implemented does not verify its requirement.

Use `/loop status` for requirements and evidence, `/loop blockers` for recorded
obstacles, and `/loop refine ...` for new direction. Changes to adopted scope
need confirmation. Failed tests and incomplete implementation are work to do,
not excuses to park the project as an external dependency.

## Know what you are trusting

**Verification is a separate review, not a guarantee.** The auditor runs in a
fresh Pi process, outside the implementing conversation and GLLA's live state.
It can inspect files and run bounded checks. Its value depends on the contract,
the evidence and the model; an accepted audit is not a proof that no bug exists.

**Isolation is not an OS sandbox.** The auditor can run shell commands, and
mirrored extensions can have side effects. Use host permissions, a container
or another isolation boundary when the repository or checks are untrusted.

**Autonomy consumes resources.** Research, continuation, retries, subagents and
audits use model calls. Set loop bounds, choose models and configure recovery
before leaving a run unattended. GLLA cannot repair provider credentials, billing
or service availability, and a reload does not fix those problems.

**Keep one continuation owner.** Do not run competing turn drivers, task queues
for the same work, or overlapping retry/compaction supervisors in the same session.

## State and recovery

State root selection defaults to `workingDir` (`<project>/.pi-glla/`); an opt-in
`sessionDir` setting uses Pi's admitted session directory. Changing roots does
not migrate old state. Journals, goals, queue state, audit claims and archives
are inspectable; keep them if you want recovery and history.

A restored objective may be **loaded without starting**. That is a hold, not
proof of loss. Inspect status and use `/goal resume`, `/list resume`,
`/loop resume` or broad `/glla resume` as appropriate. Enable auto-resume only
when restarting saved automation is intentional.

A **completed objective is different from a recovery marker**. Provider recovery
can outlive the work it once accompanied, including ordinary chat. If `/glla resume`
says no objective is paused and clears an old marker, it does not reopen archived
work or erase the conversation. Check the archive; send `continue` for ordinary
chat, or start a new tracked objective for new work.

Compaction and provider recovery are bounded, not magic. High context can defer
compaction at unsafe boundaries; a failed summarizer is not proof that the task
is complete. [Recovery](docs/RECOVERY.md) explains the states and next actions.

### How GLLA survives long work

GLLA supervises several failure classes differently, because "keep going" is
wrong for most of them:

- **Interrupted turns and stale handles** are recorded, not guessed at. A goal
  that was mid-turn when the session died keeps its objective, task list and
  evidence, and says so plainly (`⚠ interrupted — stale handle`) instead of
  pretending work is still flowing.
- **Provider failures** pause with a durable deadline and let recovery walk a
  configured fallback chain at a bounded cadence. GLLA does not invent success:
  a saved `retryAt` is a historical fact, not proof a timer is armed.
- **Loop supervisors and heartbeat watches** park work they can no longer drive,
  rather than re-sending prompts into an ownerless session.
- **Explicit holds** — your pause, a supervisor freeze, a load hold, or a
  degraded-write condition — always outrank automatic resumption.

## Context, compaction and the auto-compactor

Long-running goals outgrow a single context window, so GLLA treats compaction as
part of the supervision loop rather than an accident of the host:

- The **auto-compactor** watches admitted context usage for the active work.
  When usage crosses the configured threshold it asks for a summary at a safe
  boundary instead of forcing one mid-tool.
- **Unsafe boundaries defer, not force.** Compaction is not triggered while a
  turn is mid-flight, a tool result is pending, or a dispatch has not been
  acknowledged yet; the attempt is retried or clearly reported instead.
- A **failed summarizer is not completion.** If the summary cannot be produced,
  work stays held with the failure visible, so a lost summary cannot silently
  end a goal.
- **Post-compaction continuation** rebuilds the same objective, task list and
  verification contract from durable state. Trusted user seeding keeps an
  objective from being rewritten into report-shaped debris, and report-like
  fragments are paused for repair instead of dispatched.
- Related pressures — token budget, wall-clock horizon and repeated compaction
  inside one dispatch — each have their own bounded behavior and are listed in
  [SETTINGS.md](docs/SETTINGS.md).

See [RECOVERY.md](docs/RECOVERY.md) for the state machine and
[SETTINGS.md](docs/SETTINGS.md) for thresholds.

## Configure only what you need

Open `/glla` for an interactive settings table, or use actions directly. Start
with:

- **Auditor model and thinking level:** choose a verifier that can handle the contract.
- **Fallback models:** choose providers you can actually authenticate and afford.
- **Auto-resume:** decide whether loaded work may restart automatically.
- **State root:** choose where durable work belongs.
- **Retry and audit limits:** keep failure recovery bounded.
- **Notifications:** decide how you want to hear about decisions and results.

### What the settings table controls

Bare `/glla` opens a tabbed table: switch between the eight sections with
left/right and edit a row with up/down. Each row shows **KEY · VALUE · SOURCE**,
so an unset key visibly reports the value the runtime actually uses instead of a
different default. Sections:

| Section | Example rows |
|---|---|
| Keep-going | auto-resume, decision popup, carryover policy, decision-pause budget, auto-accept drafts, aggressive mode, vision assist |
| Main agent | main-agent model, fallback models, fallback thinking levels, retry minutes, same-model retry budget, primary-probe minutes |
| Drafter | drafting model used to interview an objective before it activates |
| Compactor | compaction token target, compactor agent and its fallback models |
| Auditor | auditor model and fallbacks, silent mode, progress signals, tool timeout, stall threshold, audit job retention, spot-check rate, audit caps |
| Subagents | model strategy, per-agent models and thinking, per-agent fallback chains |
| Stall brakes | wedge alert minutes, stuck-intervention cap, escalation refires, zombie retry cap |
| Other | state root, notify command, token limit, tool overrides, post-audit policy, context checkpoint projection |

Aggressive mode is a single switch that tightens supervision defaults; the table
shows what each unset key resolves to, so an unset value never claims a
different default than the runtime uses.

[SETTINGS.md](docs/SETTINGS.md) is the detailed reference. `/glla version` shows
the loaded version and registry comparison; unpublished checkout changes are not
necessarily available to npm or Pi catalog users.

## The /glla surface

`/glla` is the operational namespace for supervision itself — separate from the
work commands (`/goal`, `/list`, `/loop`, `/review`). Common actions:

| Command | Purpose |
|---|---|
| `/glla status` | Supervision, recovery and current-work summary |
| `/glla log` | Supervision event history |
| `/glla audits` | Completion-audit outcomes |
| `/glla pause` | Freeze automatic supervision without killing a running tool |
| `/glla resume` | Broad resume for whatever is held: goal, list item, loop or recovery |
| `/glla decide` | Show a pending decision instead of guessing an answer |
| `/glla progress [json]` | Outcome-evidence digest for the current work |
| `/glla agents [--tail <id>]` | Tracked subagent state, with transcript tailing |
| `/glla fleet` | Bounded, read-only health observations across configured roots |
| `/glla version` | Loaded version versus the registry |
| `/glla bug [description]` | Capture diagnostics without changing the objective |
| `/glla wipe` | Explicitly discard durable GLLA state |

Actions are verbs, not key=value arguments: settings live in the `/glla` table or
the project settings file. `/glla fleet` inspects only GLLA runtime artifacts under
roots you configure, with bounded depth, time and bytes; it reports partial,
unreadable and skipped observations instead of declaring a fleet healthy, and it
never dispatches work or mutates sibling state.

## Optional companions

GLLA can supervise goals and run its detached auditor without a subagent extension.
Install companions for capabilities you need, not to satisfy a hidden dependency:

- **`@juicesharp/rpiv-ask-user-question`:** recommended structured questions and
  decision UX; GLLA also has plain-text fallbacks.
- **`pi-subagents`:** parallel research, workers and independent reviews.
  Particularly useful for separable work; coordination and extra calls still cost.
- **`@pi-unipi/notify`:** remote notifications.
- **`pi-chrome`:** browser work in a real signed-in session; grant access deliberately.

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:pi-subagents
```

Companions are separately installed and updated. GLLA does not pin a runtime
`pi-subagents` version. Do not load another subagent provider with overlapping
tools or a second orchestrator for the same session. See
[compatibility boundaries](docs/COMPATIBILITY.md).

## Contributing and release checks

Development needs Node 22.19+, Bun and the declared development dependencies:

```bash
npm install
npm test
npm run check
npm run release:check
```

`npm test` runs the fast set, `npm run test:slow` the slow set,
`npm run test:changed` git-affected tests through the hardened runner, and
`npm run test:all` the full suite plus supporting checks. The release gate also
checks generated inventory, dry-run packing and the installed tarball.

The package ships extensions, skills, prompts, schemas, scripts, docs, examples,
media and top-level user documentation. The full test suite remains
repository material, as do local audit history and research. A published package
and a live session are separate: update the package and reload existing sessions.

[Architecture](docs/ARCHITECTURE.md) · [Design](docs/DESIGN.md) ·
[Documentation index](docs/INDEX.md) · [Release process](docs/RELEASING.md) ·
[Changelog](CHANGELOG.md)

## License

GNU Affero General Public License v3.0-only; see [LICENSE](LICENSE).
