# Install, update and start safely

For the product overview, see [README.md](README.md). For choosing an actual
workflow, see [WORKFLOWS.md](docs/WORKFLOWS.md).

## Requirements

- Pi with the supported peer versions in [COMPATIBILITY.md](docs/COMPATIBILITY.md).
- Node 22.19 or newer for helper scripts and detached auditing.
- An authenticated model/provider accessible to Pi.
- Bun only for repository development and tests—not ordinary GLLA operation.

## Install

```bash
pi install npm:pi-goal-list-loop-audit
```

In an already open Pi session:

```text
/reload
/glla version
```

Start Pi in the project you intend to change. The default durable state root is
that working directory's `.pi-glla/`.

## First run

```text
/goal plan Improve this project's first-run experience
```

Review the draft's scope and acceptance criteria before confirming. Use
`/glla status` to inspect work. You can pause supervision with `/glla pause`;
this does not kill an already running tool.

Already have a precise outcome? A `Done when:` clause starts directly:

```text
/goal Fix the cache invalidation bug. Done when: a regression test reproduces it; the fix passes that test and the relevant suite.
```

`/goal start ...` is an explicit no-interview path and may replace existing work.
Prefer drafting for an unfamiliar project or uncertain scope.

## Modes

Use `/goal` for one result, `/list` for several auditable results, and `/loop`
for repeated improvement. `/loop respec` builds a project against adopted
requirements. See [LIST-PHILOSOPHY.md](LIST-PHILOSOPHY.md) and
[practical workflows](docs/WORKFLOWS.md) before choosing a long-running mode.

## Optional companions

For structured questions and decisions:

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

For parallel scouts, workers and reviewers:

```bash
pi install npm:pi-subagents
```

Neither is required for a basic goal. GLLA does not install or version-pin
`pi-subagents` as a runtime dependency. Install and update companions separately.
Remote notification and browser extensions are optional too.

Do not run competing continuation drivers or overlapping subagent providers
in the same session. One supervisor should own the active work.

## Set up the auditor

GLLA verifies completion in a fresh Pi RPC process. Choose its model and thinking
level in `/glla`. The worker inherits normal provider configuration and resolves
`pi` from `PATH`; override the binary when needed:

```bash
GLLA_PI_BINARY=/absolute/path/to/pi
```

By default, the worker mirrors session extension packages, excluding GLLA itself,
so extension-provided models can be available. It does not load skills, prompt
templates, themes or context files. Turn **Auditor mirror session extensions**
off for an extension-less worker and choose a model compatible with that setup.

A fresh worker is not a filesystem sandbox. Choose a separate isolation boundary
if auditing untrusted code or commands. A different auditor model can provide
another perspective but does not guarantee correctness.

## Update

```bash
pi install npm:pi-goal-list-loop-audit@latest
```

Then run `/reload` in each open session and check `/glla version`. Installing a
new package does not replace code already loaded in a session. npm publication
supplies the Pi package catalog too; there is no separate Pi-only build.

## State and restored work

The default state tree is `<project>/.pi-glla/`. Settings offer an opt-in
`sessionDir` root, which must be admitted by the host. Changing roots does not
migrate or delete old state. Do not delete journals to clear a UI warning.

Restored work may wait for explicit consent. Inspect `/glla status`, then use
`/goal resume`, `/list resume`, `/loop resume` or broad `/glla resume`.
Enable auto-resume only if restarting saved work automatically is intentional.

Completed work is archived, not resumable. An old provider-recovery marker does
not establish that an objective remains active. See [RECOVERY.md](docs/RECOVERY.md)
for that distinction and model/compaction troubleshooting.

## Troubleshooting installation

| Symptom | Check |
|---|---|
| Commands missing | Reload; verify Pi loaded the intended installation |
| Old behavior after update | `/glla version` in the affected session, then `/reload` |
| Auditor cannot use the model | Provider authentication, worker binary and extension mirroring settings |
| Restored work is idle | Inspect status for a load hold, pause, blocker or pending audit |
| Provider still fails after reload | Check provider access; reload is not a credential or quota fix |
| Duplicate continuation or worker panels | Check for competing supervisors and companion display settings |

Use `/glla bug <what happened>` to capture diagnostics. Describe the command,
expected behavior and observed behavior; avoid posting credentials or sensitive
project content from captures.

## From source

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git
cd pi-goal-list-loop-audit
npm install
pi install .
```

To try the checkout without global installation:

```bash
pi -e /absolute/path/to/pi-goal-list-loop-audit
```

Maintainer checks:

```bash
npm test
npm run check
npm run release:check
```

See [RELEASING.md](docs/RELEASING.md) for publication, and
[INDEX.md](docs/INDEX.md) for technical references.
