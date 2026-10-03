# /glla UI and command audit — 2026-10-03

Scope: the interactive `/glla` table, its editors and model pickers, the
headless settings display, command routing and completion, and GLLA-owned
write/ownership boundaries. Started at 0.38.109; fixes are versioned 0.38.110.
No live commands were issued to a user's Pi session. Behavioral tests use
isolated state roots and a snapshotted test settings file. No external plugin,
provider, Pi implementation, or git history was modified or rewritten.

## Surface inventory and coverage

`glla-ui-command-audit-2026-10-03/menu-rows.json` records all 74 rows produced
from normalized defaults in this environment, including seven discovered
subagent roles. The role count is data-driven, not a fixed package promise.
Values in this inventory are default examples, not the user's saved settings.

| Table tab | Rows | Reviewed contract |
| --- | ---: | --- |
| Keep-going | 9 | Pause/resume defaults, carryover, draft consent, decision budgets, forbidden-model policy |
| Main agent | 6 | Live model display, ordered fallback selection, retry cadence, primary failback |
| Drafter | 2 | Primary model/thinking and ordered fallback chain |
| Compactor | 3 | Opportunistic token target, handoff-brief model, fallback chain |
| Subagents | 24 | Strategy, display, per-role model/thinking/fallback editors, effective resolution |
| Auditor | 17 | Model/thinking, fallback chain, extension loading, streaming, timeouts, retention, challenge/spot-check policy, caps |
| Stall brakes | 7 | Wedge/hang thresholds, interventions, refires, zero-stream retries, short/similar output |
| Other | 6 | State root, notifications, token budget, tool visibility/config metadata, postaudit, checkpoint projection |

Reviewed row-to-handler dispatch and readonly rows; save scope/provenance;
input validation, clear/reset and cancellation paths; configured-auth and
policy filtering; custom-UI versus typed fallback; model thinking resolution;
tab/navigation behavior; ANSI-aware line bounds; and truthful outcome copy.
The registered picker edits concrete model refs. Free-form substring-pattern
entry remains available through typed fallback/settings, rather than through
an additional interactive pattern editor.

The command router has 19 routes: `version`, `stats`, `audits`, `agents`,
`status`, `log`, `switchlog`, `fallbacks`, `wipe`, `reset`, `resume`, `pause`,
`cancel`, `owner`, `takeover`, `reviewer`, `postaudit`, `tooloverride`, `bug`.
The 17 canonical routes now have completion entries; `reset` is a no-op rename
notice and `reviewer` is the legacy postaudit alias. Bare `/glla` is the table
entry, or the headless read-only settings/provenance display. Unknown actions
are rejected explicitly. Inspected command dispatch, read/write boundaries,
confirmation paths, ownership handling, and log/telemetry output paths.

## Findings and dispositions

| Finding | Disposition |
| --- | --- |
| Editing a setting resets the table to Keep-going | Fixed: reopen the chosen row's tab, including after editor cancellation |
| Forbidden substrings such as `provider/` can disable a configured backup while exact refs are rejected | Fixed: apply the pattern to protected fallback refs in the correct direction |
| Drafter, compactor and subagent primary editors accept forbidden refs the runtime skips | Fixed: filter picker choices and refuse typed matches for all three |
| Compactor primary picker offers the current session model and labels clearing as session inheritance | Fixed: exclude that model, refuse typed selection, label clear as registry plan B |
| Role fallback edit overwrites another role saved while the picker is open | Fixed: reload the map after the awaited picker before merging the chosen role |
| Partial policy exclusions say nothing was saved while the valid subset is saved | Fixed: distinguish omitted selections from the valid saved remainder |
| Stale-host `/glla audits health cleanup` deletes audit evidence | Fixed: recognize cleanup as a mutation; plain health remains inspectable |
| Postaudit dialog can save after its originating host is invalidated | Fixed: check that context at the save boundary and report NOT saved |
| Wipe can proceed after its originating host is invalidated during Confirm | Fixed: recheck the host after confirmation before destructive actions |
| Tool allow/hide can coexist, so the newly selected allow is defeated by old hide | Fixed: either selection removes its opposing override in both UI and CLI |
| Tool config edits can overwrite concurrent settings, accept empty keys, or truncate spaced JSON | Fixed: refresh at commit, validate/trim keys, retain the command's full value |
| Tool configuration claims operational effects without a consumer | Disposed explicitly: `perToolConfig` remains stored metadata; menu, save notice and docs state it is not applied to tool execution. No Pi/provider timeout implementation was added |
| Empty Allowed extensions claims full isolation while session mirroring is on by default | Fixed: show mirrored versus isolated state and explain that both controls determine isolation |
| Soft audit cap always claims to pause; compactor model claims starvation-only use | Fixed: describe conservative/run-to-done versus aggressive cap behavior, and handoff briefs at boundaries and starvation separately from Pi transcript summarization |
| Single and multi-model pickers overflow narrow terminals in title/search/help rows | Fixed: bound all rendered lines with ANSI-aware truncation, including zero-width rendering |
| Four supported actions are missing from completion | Fixed: expose fallbacks, owner, takeover and postaudit; regression checks all canonical routes |

The per-tool metadata limitation is real and is now visible before use;
setting `timeout` there does not change Pi's or another extension's execution
budget. Visibility overrides do have a GLLA consumer at the agent tool hook.

## Verification and practical limits

Evidence directory: `glla-ui-command-audit-2026-10-03/`.

- `red.log`: all nine initial regressions fail before their fixes.
- `dialog-red.log`: both post-dialog stale-write regressions fail before fixes.
- `picker-red.log`: both narrow-picker regressions fail before line bounding.
- `focused-tests.log` and `tests.log`: intermediate checks caught two stale
  source-shape assertions. The updated guard assertion now includes audit
  cleanup; the picker call was kept simple while filtering its model list.
- `repair-tests.log`: 35 pass; `copy-completion-tests.log`: 51 pass;
  `picker-tests.log`: 61 pass. These are intermediate corrective checks.
- `final-tests.log`: 309 pass, zero failures, across 27 files on the final
  0.38.110 tree. Covers editors, cancellation, staleness, scope, model policy,
  menu completeness/navigation, narrow ANSI rendering, ordering/inheritance,
  command completion, status/resume, ownership/takeover, bug capture and stats.
- `typecheck.log` and `inventory.log`: final TypeScript and inventory gates
  pass. `jiti.log`: real jiti state-binding integration check recorded alongside.

Version metadata, both root lockfile fields, dated changelog and docs index
are synchronized at 0.38.110. The sync daemon owns source/evidence commits.

This is a source and component/behavioral audit. It does not claim a fresh
live-fleet survey, manual screenshots from every Pi UI mode, a test of all
provider credentials, or a clean composite full-suite release gate. No
release tag or package publication was performed.

## Execution-options follow-up

The storage-only limitation recorded above was subsequently implemented in
0.38.111. See [TOOL-CONFIG-EXECUTION-2026-10-03.md](TOOL-CONFIG-EXECUTION-2026-10-03.md)
for the public-hook ownership analysis, supported optional-argument contract,
and execution/validation evidence. The original 0.38.110 findings above remain
historical evidence.

## Full UI follow-up

The broader 0.38.112 UI pass includes responsive layouts, search, row continuity,
full draft review, reminders, lifecycle cards and command views. See
[FULL-UI-AUDIT-2026-10-03.md](FULL-UI-AUDIT-2026-10-03.md) for the expanded coverage
register, rendered evidence and final verification state.
