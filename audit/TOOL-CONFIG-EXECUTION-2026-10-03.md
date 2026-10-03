# Per-tool execution options — 2026-10-03

Implemented the remaining execution-options gap identified by the /glla UI
and command audit. Version: 0.38.111.

## Ownership and behavior

GLLA owns its project `toolOverrides.perToolConfig` settings and its public
`tool_call` hook. The installed Pi 0.99.1 API explicitly permits mutating
`event.input` in place. Inspection of Pi's agent-session adapter and agent-core
`runToolCall` confirms that the executor receives that same argument object;
Pi validates it before the hook and does not revalidate the hook's changes.
No Pi, provider, OS, or other-plugin implementation was changed.

GLLA now reads current project settings before a model-issued tool call,
finds the registered parameter schema through `getAllTools()`, and merges
configured optional arguments over the model's arguments. It validates the
complete candidate with the existing TypeBox peer dependency before changing
live input. Required operation arguments, unsupported/reserved keys, invalid
values, and unavailable or unsupported schemas block the call with setting
removal instructions. Tools still enforce their own semantic constraints.
Nested configured values are cloned per call; earlier calls cannot mutate
settings or subsequent calls through shared references.

The existing host/foreign-context guards plus an entry liveness/ownership
probe prevent stale hosts from applying overrides. Settings apply outside a
goal or loop as well. Unconfigured calls retain their original arguments and
do not require a tool registry lookup. Clearing an override restores the
model's argument. Running calls and direct user shell commands (`!`) are
unaffected.

Example: `/glla tooloverride set bash timeout=60` makes subsequent model-issued
bash calls receive a 60-second timeout, including when the model supplied a
different value. `/glla tooloverride unset bash timeout` removes that setting.
The `/glla` editor, CLI save confirmations, settings row, and shipped
SETTINGS.md now describe execution options and validation rather than stored
metadata. Package and both root lockfile versions, changelog, docs index, and
runtime inventory are synchronized.

## Verification

Evidence: `tool-config-execution-2026-10-03/`.

- `red.log`: the six original regressions produced five failures and one
  stale-host control pass on the previous implementation. The actual Pi bash
  pipeline observed timeout 5 where configured timeout 60 was expected.
- `tests.log`: nine new behavioral tests pass. Real Pi `runToolCall` executes
  the registered bash definition against injected operations, observes the
  configured timeout, and blocks malformed configuration before operations
  execute. Other tests cover atomic rejection, current settings, clearing,
  required arguments, stale hosts, nested isolation, valid zero, and missing
  or unsupported schemas. No fixture shell command is executed.
- `tool-regression.log`: 29 tests pass across six files, including those nine
  new tests under the repository's serialized Bun runner, tool telemetry,
  visibility, inventory, subagent tool names, and resume_goal behavior.
- `ui-regression.log`: all 309 tests across the prior 27-file UI/command audit
  selection pass with the updated execution wording and version.
- `typecheck.log`, `inventory.log`, and `jiti.log`: TypeScript, generated
  inventory, and the real Jiti state-binding check pass.
- `pack-smoke.log`: the exact 0.38.111 tarball installs and imports against its
  disposable peer tree; the packed worker RPC and delegate skill checks pass.

This closes the storage-only limitation recorded at 0.38.110. It supports
named optional tool arguments, rather than arbitrary tool internal settings.
A composite full-suite release gate was not rerun. No release tag or package
publication was performed. The sync daemon owns tracked commits; machine-local
GLLA state remains outside git.
