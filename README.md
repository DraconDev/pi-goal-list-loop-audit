# pi-goal-list-loop-audit

<p align="center">
  <img src="media/glla2.png" alt="GLLA mission control" width="960">
</p>

> **Long-running, high-leverage autonomy for pi.**
>
> Give pi a meaningful outcome. GLLA helps it research, plan, execute,
> recover, and prove the result over hours or days instead of treating one
> chat turn as the whole job.

`pi-goal-list-loop-audit` (GLLA) is mission control for autonomous work in
[pi](https://github.com/badlogic/pi-mono). It is for the work that is too broad,
too long, or too important to leave to a single uninterrupted prompt:
repo-wide changes, migrations, audits, research, documentation overhauls,
large refactors, and continuous improvement.

GLLA does not promise that an agent can never make a mistake. It makes the
agent's work **more effective, durable, recoverable, and difficult to declare
finished without evidence**:

- You state the outcome and what “done” means.
- The agent researches, decomposes, and executes across many turns.
- GLLA keeps durable state, checks lifecycle/progress signals continuously, and
  recovers failures with bounded per-attempt backoff plus policy-driven stop rules.
- Every terminal objective leaves a useful six-label recap; missing evidence is
  shown as `not recorded`, never guessed.
- Optional subagents can do parallel research and focused implementation work.
- A separate detached auditor checks the saved completion claim before GLLA
  accepts it.

The aim is not “run forever.” The aim is **more useful work per unit of
attention, with event-driven progress instead of guessed-duration waiting, and
better evidence at the end**. See `docs/DESIGN-long-running-supervision.md` for
the long-running policy.

Use `/glla version` to inspect the installed version and compare it with the
registry. This checkout may contain unreleased changes; npm is authoritative
for published versions. The npm/Pi package listing displays this README from
the published tarball, so release the package after updating it when store
readers need the latest guidance.

## Is GLLA the right tool?

Use GLLA when the work benefits from an autonomous operator that can keep
context, make progress without a prompt after every step, and return with an
evidence-backed result:

- a feature that spans several files or subsystems;
- a migration, security review, or repository audit;
- research followed by implementation;
- a documentation or test-quality overhaul;
- a backlog of independently verifiable changes;
- an improvement process that should run until a metric, specification, or
  audit cadence says to stop.

Use ordinary pi for a one-line edit, a quick question, or work where you want
to supervise every action manually. GLLA is a **supervisor for high-level
outcomes**, not a replacement for judgment or a reason to remove a human from
important decisions.

## Install

Install GLLA into pi:

```bash
pi install npm:pi-goal-list-loop-audit
```

For the intended interview and confirmation experience, also install the
structured-question companion:

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

If pi was already open, run `/reload` in that session. GLLA works without the
question companion through plain-text fallbacks, but structured questions are
the recommended experience.

## Your first goal

Start pi in the project you want it to work on, then give it an outcome with a
verifiable finish line:

```text
/goal "Improve the login flow.

Done when:
- failed logins return a useful, safe error;
- the relevant tests cover the new behavior and pass;
- the change is documented and committed."
```

The contract is the important part. Replace the example with the result you
actually want and checks that another person—or another agent—could inspect.

For an objective that needs shaping, start with bare `/goal` and answer the
interview. GLLA will research the ambiguity, ask focused questions, and show a
Confirm dialog before activation. A complete `Done when:` clause starts
immediately. `/goal start "..."` is the explicit shortcut when skipping the
interview is intentional.

### What happens next

1. **Intake:** GLLA preserves the objective and its verification contract.
2. **Research and planning:** the agent can inspect the repository, ask for
   decisions that materially change scope, and propose bounded tasks.
3. **Execution:** the main pi session keeps working after each agent turn;
   optional subagents can handle parallel, focused work.
4. **Durability:** goals, queue items, progress, pauses, retries, and audit
   claims are written to inspectable state on disk.
5. **Recovery:** provider failures, silent turns, session replacement, and
   frozen workers are handled through bounded, visible recovery paths.
6. **Verification:** `complete_goal` saves a claim, runs mechanical checks, and
   queues a detached auditor. The goal archives only after the auditor accepts
   evidence for the contract.

The status widget and `/glla status` show whether work is active, queued,
paused, recovering, auditing, or waiting for an explicit decision. Silence is
not presented as progress.

## Choose the work surface

GLLA has three work shapes. Pick the one that matches the outcome rather than
forcing every problem into a loop.

| Surface | Use it for | Completion model |
|---|---|---|
| `/goal` | One meaningful outcome: feature, fix, audit, migration, research, or docs | The saved `Done when:` contract is independently audited |
| `/list` | Several outcomes or a backlog of independently verifiable items | Each item is worked and audited separately; the queue advances safely |
| `/loop` | Ongoing improvement with no single final item | A metric, specification, audit cadence, bound, or `/loop stop` ends the process |

### `/goal` — one outcome

```text
/goal                                      # interview + Confirm
/goal "... Done when: ..."                 # direct contract start
/goal start "..."                          # explicit no-interview start
/goal start                                  # use one clear recent request, or draft safely
/goal plan "..."                           # research-first extended plan
/goal status                               # inspect the current goal
/goal pause                                # pause automatic continuation
/goal resume                               # explicitly resume
/goal verify                               # audit the current claim now
/goal tweak "..."                          # revise the objective with Confirm
/goal cancel                               # cancel the active goal
```

A goal is the best default for work with a finish line. If the agent discovers
that the objective is too large, it can propose a bounded task plan instead of
quietly inventing an unbounded backlog.

### `/list` — a durable work pool

```text
/list "fix the cache. Done when: tests pass"
/list plan.md                              # import a checklist or plan file
/list                                     # show active and waiting items
/list start                                # activate the queued head, or draft one clear recent request
/list next                                 # explicitly skip/activate the next item
/list next <n>                             # explicitly choose a specific item
/list resume                               # explicitly retry/resume the list
/list remove <n>
/list clear
/list cancel                               # stop the active item and drop waiting items
```

Order is the default, not the law. Automatic advance normally uses the head of
the queue, while `/list next <n>` or the agent's `list_activate` tool can choose
another item. Numbering always matches `/list` output. After a list item is
approved and archived, the next queued item starts automatically; no manual
`/list next` is needed between items.

If a saved item is malformed or needs a repair, the repair card preserves the
full original target, explains the concrete recovery action, and permits one
bounded bootstrap turn containing `propose_task_list`. Confirm the redraft;
automatic repeats are fenced. Use `/list resume` or `/glla resume` for an
intentional retry of a waiting/restored queue, and `/list next` when you
intentionally want to skip or choose another queued item. `/list start` is
also explicit: it activates the queued head, or—when the queue is empty—uses
one clear recent user request as a seed for the normal Confirm-gated list
drafting flow. Ambiguous context is never queued automatically.

### `/loop` — an improvement process

```text
/loop                                     # interview + Confirm
/loop start                                # use one clear recent target as an explicit metricless start
/loop plan                                # research-first loop design
/loop start "reduce flaky tests" measure="..." direction=min
/loop start "keep improving the spec" measure=none max=20 cadence=900
/loop audit                               # recurring project-audit cadence
/loop status
/loop stop
```

Bare `/loop start` infers only one clear recent target. It does not invent a
measure, direction, bound, cadence, or branch setting; the command uses the
existing explicit metricless-start path. If the context is ambiguous, GLLA
returns to loop drafting so the target and any numeric metric/consent gates
remain visible.

There are three loop styles:

- **Metric:** a bounded command prints one number that honestly represents
  progress, such as test failures or bundle size. GLLA test-runs the measure
  before you confirm it and stops on plateau or a configured bound.
- **Metricless specification:** no honest number exists, so the loop advances
  a specification or checklist. It ends at its time/token/iteration bound or
  `/loop stop`; it has no fake plateau metric. Add optional
  `cadence=<seconds>` to put a minimum gap between successful automatic
  iterations; explicit starts/resumes remain urgent and `/loop status` shows
  the armed cadence.
- **Project audit:** each iteration looks for the next important finding,
  appends evidence to the audit ledger, and works through the findings.

If the work has a finish line, use `/goal`, not an endless loop.

## The autonomy model

GLLA is designed for **high-level autonomy with low-level accountability**.
You provide direction and acceptance criteria; the agent owns the ordinary
research and implementation decisions; GLLA owns continuity, state, recovery,
and verification.

### What produces better results

1. **Name the outcome, not a list of keystrokes.** Say what should be true
   when the work is finished.
2. **Make “done” inspectable.** Include tests, files, behavior, or user-visible
   checks in the contract.
3. **Give broad work room to research.** `/goal plan` is useful for greenfield
   or ambiguous work; it researches before asking its deeper interview.
4. **Let the agent decompose, but keep bounds.** Task plans have confirmation
   and bounded task/subtask counts. A list item remains one auditable unit.
5. **Use subagents for parallel leverage, not ceremony.** Spawn workers when
   independent research or implementation can happen concurrently.
6. **Treat the auditor as a gate, not as decoration.** A completion message is
   a claim; acceptance requires evidence tied to the contract.

Autonomy is intentionally not blind: Confirm dialogs, decision pauses,
explicit resume paths, bounded retries, and durable status keep important
control points visible.

### What GLLA verifies

When the agent calls `complete_goal`, GLLA:

1. runs the contract's mechanical checks when a release or command check is
   specified;
2. writes an identity-bound completion claim;
3. starts a detached, fresh pi RPC worker for the audit;
4. asks the worker to inspect the repository and run bounded checks;
5. requires raw evidence for each verification-contract item through the
   orchestrator-side regression shield;
6. keeps the goal open on infrastructure failure, missing evidence, or
   disapproval instead of silently archiving it.

The auditor is intentionally isolated from the implementing conversation and
GLLA extension state. By default it runs without extensions, skills, prompt
templates, themes, or context files, so its model must be usable in a plain pi
session. It is independent verification, not an OS sandbox: the auditor's
`bash` tool can still change files if a prompt or verifier tells it to. Keep
verification commands bounded and treat repository permissions accordingly.
On Linux, both direct contract checks and the detached auditor enforce a
256-process process-group ceiling to contain recursive helper/test launches;
cross-platform timeout and process-tree cleanup remain in place as well.

## Recommended pi extensions

GLLA is the supervisor. These companions add capabilities around it:

### Recommended for almost everyone

- **`@juicesharp/rpiv-ask-user-question`** — structured questions, multi-select,
  previews, and Confirm dialogs for drafting and decisions. GLLA has a prose
  fallback, but this is the intended UX.

### Recommended for power — parallel orchestration (`pi-subagents`)

- **`pi-subagents` 0.62.0 (pinned) — the power-max choice for GLLA.** Use it
  when you want the best automation and quality: `runs.all` parallel fan-out,
  `runs.lanes` worker→review→fix chains, `outputSchema` + `acceptance` structured
  verification, `runs.host` gated shell, worktree isolation, model routing
  (`subagents.defaultModel` / `subagentModelOverrides` / `modelScope`), durable
  missions/schedules/recovery, and versioned control RPC. Built-ins are `scout`,
  `researcher`, `worker`, `reviewer`, `oracle`, `delegate` plus external-CLI
  writers (`claude-code-writer` etc.); all inherit the parent model by default
  so there is no hidden Explore/Plan quota pool. This is the companion GLLA
  supervises via `subagent:*` lifecycle events + durable `status.json` + versioned
  stop RPC (ownership/generation-checked). GLLA's `subagentModelOverrides`
  can still pin an individual role.

  The main pi session remains the owner of the goal/list/loop; subagents are
  workers and cannot silently replace the parent's objective. A short or mostly
  sequential goal can still run cleanly without workers — install when
  parallelism will pay for its coordination and model usage.

  Display coexistence: pi-subagents renders its own inline run panels +
  FleetView, GLLA renders one compact widget line + the status-bar worker
  count + `/glla agents`. If you see the same run stacked 3× or panels
  swapping order, set pi-subagents `inlineToolDisplay: "summary"` (one
  stable row per run) and pin `fleetViewPlacement`; GLLA's own richness is
  the `subagentDisplayRichness` setting (`/glla` → Subagents): `rich`
  (default — worker rows + task linkage), `compact` (count line), `quiet`
  (hung/aborting workers only). Upstream triple-render report:
  nicobailon/pi-subagents#1931.

Install (or keep pinned):

```bash
pi install npm:pi-subagents@0.62.0
```

Do not install the older `@tintinweb/pi-subagents` provider alongside this
recommendation in the same session. Existing Tintin-era agent files are
cleaned only when GLLA's management marker proves that GLLA owns them; old
settings are not silently remapped to a different role. Do not stack
`@quintinshaw/pi-dynamic-workflows` as a competing orchestrator alongside
GLLA + `pi-subagents` in the same session — duplicate tools and competing
orchestration events create ambiguous ownership. Use its quality helpers
(`verify`/`judgePanel`/`loopUntilDry`) only as isolated complements if needed.

### Useful, but optional

- **`@pi-unipi/notify`** — Telegram, Gotify, or ntfy delivery when you need
  alerts away from the desktop. GLLA's local notifications work without it;
  when no command is configured, it auto-detects `notify-send`/`osascript`;
  `notify=off` silences notifications.
- **`pi-chrome`** — logged-in browser research and interaction when a goal needs
  a real web session. It is not required for repository-only work.

### What not to combine with GLLA

These are coexistence rules, not a ranking of other projects:

- Do **not** run a second extension that also drives agent turns on
  `agent_end` while GLLA owns the session. Two supervisors can schedule
  contradictory continuations. Choose one driver for a session.
- Do not run a second task/queue extension for the same work. GLLA's `/list`
  already provides durable queue state, statuses, auto-advance, and an audit
  trail. Keep a separate task manager only when you specifically need a
  dependency DAG or another workflow outside GLLA.
- Avoid overlapping compaction, retry, or watchdog supervisors while a GLLA
  goal/list/loop is active; duplicate nudges make liveness harder to reason
  about.
- A ralph-style loop can remain installed, but do not run it simultaneously
  with a GLLA-driven loop or goal in the same pi session.

## State, recovery, and user control

### State roots

By default, GLLA stores state in:

```text
<working-directory>/.pi-glla/
```

`/glla` offers an opt-in **State root → sessionDir** setting that uses pi's
canonical top-level session directory. The session root must be admitted by
the host lifecycle first. If it is unresolved, GLLA fails closed rather than
recreating ambiguous state under whichever directory happens to be current.
Changing the root does not silently migrate or delete the old working-directory
tree.

The state is inspectable: active JSONL, goal markdown, queue state, audit jobs,
ledger history, and archived goals are kept under `.pi-glla/` (or the selected
session root). Repository audit findings remain repository-only; the npm package
ships the user-facing docs, not local audit history. The list-audit findings
file and its fan-out follow the same selected state root, including the
opt-in `sessionDir` root.

### Recovery behavior

Long-running work encounters provider outages, context compaction, process
replacement, slow tools, and workers that stop making progress. GLLA records
these as state transitions and uses bounded recovery rather than pretending
that silence means success. Error text is **not trusted** to pick a retry policy;
failure wording is retained as bounded diagnostics, not interpreted as
proof of a quota or billing state.

- automatic retries are bounded and visible; a BUSY/no-stream turn is parked
  and re-dispatched within the configurable **Zero-stream retries** budget
  (default 3, range 0–10), then requires explicit resume;
- `/goal resume`, `/list resume`, and `/loop resume` are explicit recovery
  paths;
- a user abort means stop, not “try again behind my back”;
- a loaded objective can be displayed without injecting stale auditor context
  until continuation consent exists;
- frozen tracked subagents receive warning telemetry first and, after the
  configured long threshold, at most one child-specific abort; the parent goal
  is not aborted;
- interrupted completion claims remain available for retry and inspection.

Use `/glla pause` to freeze supervisor automation without killing active work,
`/glla resume` to release it, `/glla bug [message]` to capture failure context to `bugs/` without touching durable goal state, and `/glla status` or `/goal status` to inspect
what happened.

### Settings worth knowing

Open `/glla` for the settings table. The most important choices are:

- **Auditor model / thinking level:** the verifier's model and depth; when
  unset, auditor thinking inherits the parent session dial (including `max`);
- **Main-agent and auditor fallback models:** both roles use the same ordered,
  deselectable, bounded fallback-chain picker for provider failures; the
  auditor's session model remains the final last resort;
- **Auto-resume:** whether persisted work may restart automatically after a
  session loads; explicit resume commands are always available;
- **State root:** `workingDir` by default, opt-in `sessionDir`;
- **Aggressive mode:** long-running keep-going defaults; explicit per-setting
  choices win;
- **Subagent hang escalation:** warning-only at `0`, or one child-specific
  action after a confirmed frozen interval;
- **Zero-stream retries:** automatic GLLA recovery attempts after a busy,
  stream-silent Pi turn; `0` keeps recovery manual and `1–10` bounds repeats;
- **Audit cap and retry cadence:** bounds for repeated objections and
  infrastructure recovery.

For an attended first run, keep the default confirmation and inspect the
status surfaces. For an unattended machine, configure auto-resume and notify
behavior deliberately rather than assuming a terminal left open is a
supervisor.

## Model and auditor requirements

The main agent may use the model/provider you normally use in pi. The detached
auditor starts a fresh extension-less pi process by default, so its selected
model must authenticate and work without an extension-registered provider.
Choose an auditor model in `/glla` if the session model depends on a provider
extension.

The worker inherits normal pi provider configuration and resolves `pi` from
`PATH`. If needed, set:

```bash
GLLA_PI_BINARY=/absolute/path/to/pi
```

Credentials are not written into `.pi-glla/audit-jobs/` or command arguments.
The isolated worker is an evidence checker, not a second implementation agent.

## From source and maintainer checks

Prerequisites: Node `22.19.0+`, [Bun](https://bun.sh/) for the test runner,
pi-coding-agent, and TypeScript `5.9+`.

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git
cd pi-goal-list-loop-audit
pi install .
```

Try the local extension without installing it globally:

```bash
pi -e /absolute/path/to/pi-goal-list-loop-audit
```

Run the checks used for a release:

```bash
npm test
npm run check
npm run release:check
```

`npm run release:check` runs the serialized Bun suite, TypeScript, the jiti
reproduction, offline auditor-extension validation, and npm pack. The test
count changes as regressions are added; the useful result is `0 fail`.

For design rationale, see [`docs/DESIGN.md`](docs/DESIGN.md). For the shipped
document index, see [`docs/INDEX.md`](docs/INDEX.md). For publishing, see
[`docs/RELEASING.md`](docs/RELEASING.md).

### Maintainer source map

The implementation is intentionally split by lifecycle concern. Start here
when tracing behavior:

| Area | Entry points |
|---|---|
| Commands and UI | `extensions/goal-commands.ts`, `extensions/goal-loop-display.ts` |
| State and roots | `extensions/goal-state.ts`, `extensions/glla-state-root.ts` |
| Continuation and recovery | `extensions/goal-continuation.ts`, `extensions/goal-heartbeat.ts`, `extensions/goal-recovery.ts` |
| Queue and lifecycle | `extensions/loops/goal-list-queue.ts`, `extensions/loops/goal-orchestrator.ts` |
| Completion audit | `extensions/goal-loop-auditor-process.ts`, `extensions/loops/goal-auditor-hooks.ts`, `extensions/loops/goal-auditor-surface.ts` |
| Auditor launcher | `scripts/goal-auditor-worker.mjs`, `scripts/goal-auditor-launch.d.mts` |
| Safety boundaries | `extensions/payload-guard.ts`, `extensions/context-hygiene.ts` |
| Tests and design | `tests/`, `docs/DESIGN.md`, `PLAN.md` |

The package contains the extension entry point
`extensions/loops/goal.ts`, prompt templates, schemas, scripts, docs, examples,
and the user-facing README/install/changelog files. The full test suite remains
repository material for maintainers and is exercised by `npm run test:all`; it is
not included in the published tarball. `audit/` and `.research/` are also
repository material, not first-use package content.

## License

GNU Affero General Public License v3.0-only — see [LICENSE](LICENSE).
