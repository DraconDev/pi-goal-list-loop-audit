# GLLA settings reference

Canonical settings reference (audit 2026-09-06 — settings truth previously
lived only in the menu/headless renderers and the changelog). The live
views remain `/glla` (headless display with provenance) and the `/glla`
settings menu; this file is the shipped, reviewable contract. A release-gate
test pins that every `SETTINGS_KEYS` entry in `extensions/goal-settings.ts`
appears here, so the table cannot silently drift.

## Navigating the settings menu

`/glla` opens the settings menu. Left/right arrows or Tab/Shift+Tab switch
sections; up/down arrows choose a setting, and Enter opens its editor.
The menu remembers the selected row after an edit and when revisiting a tab.
Press `/` to search across all tabs. Direct text matches take priority;
results identify their section. Ctrl+D opens details while searching. Esc
clears search first, then exits the menu.

Press `d` to read the focused setting's complete value and explanation.
PgUp/PgDn scroll the details while they are open; otherwise they move through
the settings list. Narrow terminals use two lines per setting so both its
source and value remain visible. Short terminals show a window around the
selection. Values tagged `default` save to global settings when edited;
existing project overrides save back to that project. Tool overrides always
use project scope. The source column describes the effective value.

Model pickers support typing to filter and arrow navigation. In fallback
pickers, Space toggles membership and Tab opens order mode; up/down then move
the selected backup through the try order. Enter saves; Esc cancels.
Draft confirmation keeps its choices visible while PgUp/PgDn scroll the full
contract. The “always auto-accept” choice applies to future drafts in this
project; it remains a separate, explicit choice.

## Files and precedence

- Global file: `~/.pi/agent/pi-goal-list-loop-audit.settings.json` (machine/provider policy).
- Project file: `<selected-state-root>/settings.json` (defaults to
  `<cwd>/.pi-glla/settings.json`).
- Effective value: project wins over global wins over built-in default.
- `/glla` shows per-key provenance (`project` / `global` / `default`).
- Hand-edited files are normalized on every load
  (`normalizeLoadedSettings`): unknown enums fall back, out-of-range
  numbers reset to unset (consumer `??` fallbacks apply), junk strings are
  dropped, and legacy keys migrate (`reviewer` → `postaudit`,
  `auditorModelFallback` → `auditorModelFallbacks`,
  `hourlyQuotaProbe` → `hourlyRetryProbe`).

## Global-only keys

For opportunistic transcript compaction, open `/glla` → **Compactor** →
**Compaction token target**. Enter a positive count such as `300000`,
`300,000`, or `300k` (or `1m` for one million). Empty restores 200,000.
Saving the target does not compact immediately: crossing it makes compaction
due at the next safe idle boundary between work turns or queued list items.
The configured target also controls rearming once usage drops below half.
This target is opportunistic: if that compaction fails, work continues with
its current transcript. The attempt stays suppressed until usage drops below
half the target, so a failing summarizer is not retried every turn.

These describe machine/provider/session policy, not a project artifact. Project
copies are ignored (GLLA reads the global file for these policies):

`stateRoot`, `mainModelFallbacks`, `mainModelFallbackThinkingLevels`, `mainModelRetryMinutes`,
`mainModelFailback`, `mainModelPrimaryProbeMinutes`, `hourlyRetryProbe`,
`autoResume`, `drafterModel`, `drafterThinkingLevel`,
`drafterModelFallbacks`, `compactorModel`, `compactorModelFallbacks`,
`compactionTokenThreshold`,
`auditorModelFallbacks`, `auditorToolTimeoutMs`, `auditorStallMs`,
`auditJobRetentionMs`, `auditSpotCheckRate`, `auditorStrictChallenge`, `auditorInspection`.

This list is `GLOBAL_ONLY_KEYS` in `extensions/goal-settings.ts`, and a
project-scope write to any of them is stripped on read. Every other key —
including `auditCapHard` and `mechanicalLoadScale` — is project-settable and
a project file wins over the global one.

The root selector distinguishes a missing settings file (normal defaults) from
an unreadable or invalid existing file. The latter defers mutations and keeps
reads on the last validated root; without one, selection is explicitly
unresolved. Restoring valid settings permits retry. A persistence operation
uses one root snapshot, and root changes never migrate or delete old state.
This authority boundary applies before settings-value normalization.

## Keys

| Key | Default | Meaning |
| --- | ------- | ------- |
| `stateRoot` | `"workingDir"` | Where durable state lives; `"sessionDir"` is explicit opt-in. Global-only. |
| `mainModelFallbacks` | `[]` | Ordered provider/model refs on main-model failure. Can include the current session model: the saved global chain is independent of the editing session. Runtime skips active and already-tried candidates. Global-only. |
| `mainModelFallbackThinkingLevels` | unset (inherit primary) | Per-model thinking pins for main fallbacks, keyed by lowercase provider/model. Adding a model asks only for its supported level. Use Main agent → Fallback thinking to edit one saved model; existing choices survive chain edits. Inheritance restores the primary session dial. Global-only. |
| `drafterModel` | unset (session) | Drafting-only primary model. Global-only. |
| `drafterThinkingLevel` | unset (inherit) | Thinking level for the drafting agent. Global-only. |
| `drafterModelFallbacks` | `[]` | Ordered drafting fallbacks; session model is final. Global-only. |
| `compactorModel` | unset (plan B) | Emergency-compactor primary; never the session model. Global-only. |
| `compactorModelFallbacks` | `[]` | Ordered compactor fallbacks; no session last resort. Global-only. |
| `compactionTokenThreshold` | `200000` | Positive context-token target for opportunistic transcript compaction at the next idle boundary, between work turns or list items. Waits while tools, audits, or queued messages own the host; respects pause and abort. Global-only. |
| `mainModelRetryMinutes` | `15` | Base minutes before main-session recovery; doubles per attempt, caps 5h. Global-only. |
| `mainModelSameModelRetries` | `10` | Consecutive retries the CURRENT main model gets before the configured fallback chain is touched. 0 = legacy immediate rotation. Clamped to 0..100. Global-only. |
| `mainModelFailback` | `"auto"` | `"auto"` re-probes the primary; `"sticky"` keeps the fallback. Global-only. |
| `mainModelPrimaryProbeMinutes` | `15` | Minutes between preferred-primary health probes. Global-only. |
| `forbiddenModels` | `[]` | Refs that must never be selected (case-insensitive substring). |
| `blockForbiddenModelSwitches` | `true` | Revert forbidden switches (`false` = stand but ledger). |
| `visionAssist` | `true` | Continuation prompts carry the prefer-native-vision directive. |
| `auditorModel` | unset (session) | Detached auditor primary (`"provider/id"` or bare id). |
| `auditorModelFallbacks` | `[]` | Ordered auditor fallbacks; session model is final. Saving a non-empty chain offers the thinking pick. Global-only. |
| `auditorAllowedExtensions` | `[]` | Extension specs the detached auditor may load; resolved fail-closed, `[]` = isolated. |
| `auditorMirrorSessionExtensions` | `true` | Also load the session's own packages in the worker (GLLA itself never mirrored); `false` = curated allow-list only. |
| `auditorSameSessionSwap` | `true` | Walk the fallback chain when the auditor is the session model. |
| `auditorThinkingLevel` | unset (inherit) | Detached auditor reasoning level; picked with the model. |
| `auditorToolTimeoutMs` | `300000` | Base budget per auditor tool call (30s–6h). Global-only. |
| `auditorStallMs` | `600000` | Base silence budget for the detached auditor (1m–24h). Global-only. |
| `auditJobRetentionMs` | `900000` | How long proven-dead audit job dirs are kept (0–7d, 0 = reap now). Global-only. |
| `auditSpotCheckRate` | `0.1` | Fraction of light-tier audits silently escalated to full (0 = off, 1 = calibrate). Global-only. |
| `auditorStrictChallenge` | `false` | Require successful falsification on full-tier approvals, including rework rounds. Challenge failure leaves infrastructure/no-verdict rather than accepting round one. Opt-in for high-risk work; light-tier policy is unchanged. Global-only. |
| `auditorInspection` | `false` | Auditor runs as a persistent session you can tail/resume. Global-only. |
| `notifyCmd` | unset | Shell command on goal complete / pause / loop stop; message is `$1`. |
| `tokenLimit` | unset (off) | Per-goal token budget; crossing it pauses. `0` = off. |
| `wedgeAlertMinutes` | unset (30, or off while aggressive mode is on — the default) | Busy-but-silent minutes before the wedge alert; `0` = off. The menu shows the effective value. |
| `autoResume` | `false` | Restored goals/loops/lists auto-resume in fresh sessions. Global-only. |
| `decisionPopup` | `true` | Decision pauses pop the picker (`false` = widget card only). |
| `decisionPauseBudget` | unset (unlimited) | Max agent-authored decision pauses per goal before auto-default: the (N+1)-th adopts the recommended option as a logged assumption without pausing. `0` = relentless from the first decision. |
| `carryover` | `"pause"` | Stale carryover on new activation: `"pause"` / `"clear"` / `"resume"`. |
| `autoAcceptDrafts` | `false` | Drafts activate without the Confirm dialog (unattended rigs). |
| `auditCap` | `5` (10 aggressive) | Pause after N consecutive auditor disapprovals (`0` = unlimited). |
| `auditCapHard` | `8` | Hard ceiling on consecutive disapprovals — pauses with a decision even in aggressive mode (`0` = unlimited). Project-settable. |
| `mechanicalLoadScale` | `true` | Scale mechanical gate budgets with host load up to 2× (`false` = fixed budgets). Project-settable. |
| `auditFeedbackChars` | `0` (full) | Max auditor-report chars returned after disapproval (`0` = full). |
| `auditorSilent` | `true` | Auditor report renders final-only, no word-by-word HUD. |
| `auditorProgressSignals` | `true` | Silent audits show phase label + byte counter. |
| `hourlyRetryProbe` | `true` | Extra blind retry at :00:30 every hour while parked. Global-only. |
| `subagentModelStrategy` | `"inherit-parent"` | Default subagent model policy for new sessions. |
| `subagentModelOverrides` | unset | Per-agent-type model pin; always wins over strategy. |
| `subagentThinkingOverrides` | unset | Per-agent-type thinking pin (`off`–`max`); unset per type = session inherit. |
| `subagentFallbacks` | unset | Per-role fallback chains (first eligible ref wins). |
| `subagentDisplayRichness` | `"quiet"` | Ambient worker UI: `"quiet"` (default, troubled workers + count line) / `"compact"` / `"rich"`. |
| `aggressiveMode` | `true` | Keep-going defaults (`false` = pause-first policy). |
| `stuckMaxInterventions` | `5` (10 aggressive) | Consecutive stuck interventions before a loop stops. |
| `subagentHangEscalationMinutes` | `30` | Confirmed no-progress minutes before child-specific abort (`0` = warn only). |
| `stallEscalationRefires` | `5` | Heartbeat refires before pause/stop (`0` = never). |
| `zombieRetryMaxAttempts` | `3` | Re-dispatches per busy/no-stream episode (`0` = manual; max 10). |
| `stallShortWords` | `15` | Tool-less turn under this many words is a nudge. |
| `stallSimilarityThreshold` | `0.6` | Trigram similarity above this (tool-less) is a nudge. |
| `postaudit` | unset | Post-completion audit config (same shape as legacy `reviewer`). |
| `toolOverrides` | unset | Per-tool allow/hide/per-tool-config overrides. |
| `contextCheckpointProjection` | `false` (off) | Per-turn `context`-hook splice of a bounded continuation checkpoint. Off (default) leaves the transcript append-only so the provider prefix-cache holds; the fresh continuation prompt still carries live state. On restores the legacy projection (busts the cache). |
| `reviewer` | legacy | Deprecated alias for `postaudit`; migrated on load, `postaudit` wins. |

## Tool visibility and execution options

`/glla tooloverride allow <tool>` and `hide <tool>` change project tool
visibility. Choosing either removes the opposing override for that tool.
`set <tool> <key>=<value>` overrides an optional argument on subsequent
model-issued tool calls, including calls outside a goal or loop. For example,
`/glla tooloverride set bash timeout=60` sets bash's timeout to 60 seconds,
even if the model supplies another timeout. JSON values are supported.
`/glla tooloverride unset bash timeout` restores the model's argument.
The same editor is available under `/glla` → Tool overrides.

Only named optional arguments in the registered tool's parameter schema are
supported. Required operation inputs such as bash's `command` cannot be
changed this way. GLLA validates the complete merged arguments before changing
any input; unsupported keys, invalid values, or unavailable schemas block the
call with an error explaining how to remove the setting. Nested values are
copied for each call. Changes do not affect calls already running or direct
user shell commands (`!`). These options do not configure tool internals or
other extensions' settings.
