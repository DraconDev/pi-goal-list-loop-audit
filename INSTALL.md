# Install and first run

GLLA is a pi extension for long-running, high-leverage autonomous work. It
keeps a high-level objective moving across turns, preserves state, recovers
bounded failures, and requires an independent evidence check before accepting
completion.

For the product overview and the decision between `/goal`, `/list`, and
`/loop`, start with [`README.md`](README.md). This file is the practical
installation path.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) with extension support;
- Node `22.19.0+` for the detached auditor and helper scripts;
- a model/provider that pi can authenticate normally;
- optionally, [Bun](https://bun.sh/) if you are developing GLLA or running its
  test suite.

## Install from npm

```bash
pi install npm:pi-goal-list-loop-audit
```

GLLA loads into new pi sessions. If pi is already open, reload that session:

```text
/reload
```

## Updating

The status line always shows the running version (`glla: … · v0.38.48`).
When the npm registry is ahead, it also nudges:

```text
glla: … · v0.38.47 · update v0.38.48 available
```

The nudge comes from a daily sidecar check (`.pi-glla/update-check.json`),
refreshed on command contact and never blocking a turn. To update:

```bash
pi install npm:pi-goal-list-loop-audit@latest
```

Then `/reload` every open pi session: a session keeps running the
version it loaded with until reloaded. `/glla version` says whether the
current session is stale and repeats the update command.

### Recommended companions

The structured-question companion is recommended for the intended drafting
and confirmation UX:

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

For best automation and quality, add the **pinned parallel-orchestration companion** (`pi-subagents` 0.62.0): GLLA's power-max choice for `runs.all` fan-out, `runs.lanes` worker→review→fix chains, structured verification, worktree isolation, and durable recovery:

```bash
pi install npm:pi-subagents@0.62.0
```

GLLA's main continuation, queue, recovery, and detached auditor work without
it, but parallelism pays for its coordination when a goal has independent
research or implementation. Other companions are optional: `@pi-unipi/notify`
sends remote notifications, and `pi-chrome` enables logged-in browser research.
For a deeper completion check, choose a stronger auditor model in `/glla`;
a separate advisor extension is not required. Do not run `@tintinweb/pi-subagents`
or `@quintinshaw/pi-dynamic-workflows` as a second orchestrator alongside GLLA +
`pi-subagents` in the same session.

None of these companions is required for a basic GLLA goal.

Do not run another extension that drives agent turns at the same time as GLLA.
Likewise, avoid a second task queue or overlapping retry/compaction supervisor
for the same active work. One supervisor should own continuation scheduling.

## First goal in 60 seconds

Start pi in the project directory where the work belongs:

```text
/goal "Improve the login flow.

Done when:
- failed logins return a safe, useful error;
- regression tests cover the behavior and pass;
- the change is documented and committed."
```

A complete `Done when:` clause starts directly. For a new or ambiguous
objective, use bare `/goal` instead: GLLA interviews you, helps shape the
contract, and waits for Confirm. `/goal start "..."` skips that interview only
when you explicitly want it skipped. Bare `/goal start` uses one clear recent
user request when possible and otherwise returns to the normal drafting flow;
it never guesses across ambiguous requests.

The first run proceeds like this:

1. GLLA records the objective and its acceptance contract.
2. pi researches and implements the work across supervised turns.
3. Optional subagents can handle independent research or implementation.
4. GLLA persists progress and recovers bounded provider/session stalls.
5. `complete_goal` saves the claim and queues a detached auditor.
6. The goal archives only after the auditor accepts evidence for the contract.

Inspect the status widget, `/glla status`, or `/goal status` whenever you want
to know whether the work is active, queued, paused, recovering, auditing, or
waiting for a decision.

## Other work shapes

```text
/list "refactor the cache. Done when: tests pass"
/list plan.md
/list
/list start
/list next
/list resume

/loop
/loop start                                  # one clear recent target, metricless
/loop start "reduce flaky tests" measure="..." direction=min
/loop start "keep improving the spec" measure=none max=20 cadence=900
/loop audit
```

Use `/goal` for one outcome, `/list` for several independently auditable
outcomes, and `/loop` for an improvement process without one final item. Bare
`/list start` activates the queued head, or seeds the normal Confirm-gated list
draft when the queue is empty. Bare `/loop start` infers only the target; it
does not invent metric, direction, bounds, cadence, or branch settings. For
metricless loops that intentionally mature between checks, add optional
`cadence=<seconds>`; the interval is visible in `/loop status`, while explicit
starts/resumes remain urgent. See the README for the full command semantics.

## Modes

The three surfaces are intentionally different policies on one durable state
machine. Read [`LIST-PHILOSOPHY.md`](LIST-PHILOSOPHY.md) for the short decision
table and guidance on choosing a goal, list, or loop.

## State and recovery

Default state is stored in the project:

```text
<working-directory>/.pi-glla/
```

`/glla` offers an opt-in `sessionDir` state root using pi's canonical session
directory. The host must admit that root first; unresolved session roots fail
closed rather than writing into an ambiguous cwd. Changing the root does not
silently migrate or delete the old working-directory state.

GLLA records goals, queue items, pauses, retries, audit claims, and archived
results as inspectable state. If a saved list item needs repair, its repair
card preserves the original target and gives one bounded
`propose_task_list` bootstrap turn. Confirm the redraft; use `/list resume` for
an intentional retry and `/list next` to choose another item. Automatic repeat
refires are fenced.

Useful controls:

```text
/glla status
/glla pause
/glla resume
/goal status
/goal resume
/list resume
/loop resume
```

`/glla pause` freezes supervisor automation without killing active work.
`/glla resume` releases it. A BUSY/no-stream Pi turn is aborted and parked by
GLLA, then automatically re-dispatched within the **Zero-stream retries**
budget (default 3, configurable from 0–10); exhaustion requires an explicit
mode-correct resume. A user abort means stop; recovery is not silently
re-fired behind your back.

## Auditor model requirement

The completion auditor runs in a detached fresh pi RPC process with no
extensions, skills, prompt templates, themes, or context files by default. Its
model therefore needs to work with a built-in pi provider in an extension-less
session. If your normal session model comes from an extension provider, select
a compatible model in `/glla` under the Auditor settings.

The worker resolves `pi` from `PATH` and inherits normal provider configuration.
If required, point it at a specific binary:

```bash
GLLA_PI_BINARY=/absolute/path/to/pi
```

Credentials are not written into `.pi-glla/audit-jobs/` or command arguments.
The auditor checks evidence; it does not implement the goal.

## Install from source

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git
cd pi-goal-list-loop-audit
pi install .
```

To try a local checkout without installing it globally:

```bash
pi -e /absolute/path/to/pi-goal-list-loop-audit
```

## Development checks

Install development dependencies, then run:

```bash
npm test
npm run check
npm run release:check
```

The release gate runs the serialized Bun tests, TypeScript, the jiti state
reproduction, offline auditor-extension validation, and npm pack. Require
`0 fail`; test counts change as regressions are added.

## Troubleshooting

### GLLA is not visible after installation

Run `/reload`, then start a new goal. Confirm that pi is using the project or
user installation you intended.

### The auditor cannot authenticate

The detached auditor does not inherit extension-registered providers. Choose a
built-in-provider model in `/glla` under Auditor settings and verify it in a
clean directory if necessary:

```bash
PI_CODING_AGENT_DIR=/tmp/bare-agent pi -p "say ok" --model "provider/model-id"
```

### Work restored but not running

That is a consent/supervision state, not proof of loss. Inspect `/glla status`
and use `/goal resume`, `/list resume`, `/list next`, or `/loop resume` as
appropriate. Keep `Auto-resume` enabled only when automatic restart after
session load is intentional.

### Another loop is also active

Do not run two continuation drivers in one session. Stop or pause the other
supervisor, or let it own the session instead of GLLA.

## Further reading

- [`README.md`](README.md): product overview, first-use guide, commands,
  companion policy, autonomy model, recovery, and maintainer map;
- [`docs/DESIGN.md`](docs/DESIGN.md): architecture and design decisions;
- [`docs/INDEX.md`](docs/INDEX.md): shipped and repository-only documentation;
- [`docs/RELEASING.md`](docs/RELEASING.md): release process;
- [`CHANGELOG.md`](CHANGELOG.md): version history.
