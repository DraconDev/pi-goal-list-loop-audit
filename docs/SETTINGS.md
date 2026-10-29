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
`mainModelSameModelRetries`, `mainModelFailback`, `mainModelPrimaryProbeMinutes`, `hourlyRetryProbe`,
`autoResume`, `drafterModel`, `drafterThinkingLevel`,
`drafterModelFallbacks`, `designerEnabled`, `designerModel`,
`designerThinkingLevel`, `designerModelFallbacks`,
`compactorModel`, `compactorModelFallbacks`,
`compactionTokenThreshold`,
`auditorModelFallbacks`, `auditorToolTimeoutMs`, `auditorStallMs`,
`auditJobRetentionMs`, `auditSpotCheckRate`, `auditorStrictChallenge`, `auditorInspection`,
`autoAcceptDrafts`, `versionDisplay`.

This list is `GLOBAL_ONLY_KEYS` in `extensions/goal-settings.ts`, and a
project-scope write to any of them is stripped on read. Every other key —
including `auditCapHard` and `mechanicalLoadScale` — is project-settable and
a project file wins over the global one.

Because a project copy cannot take effect, a project-scope write that names a
global-only key throws rather than being silently discarded — a save that
cannot land is never reported as one that did.

`autoAcceptDrafts` is global-only because it is system-wide: one switch skips
draft confirms in every project. The draft dialog's third choice turns it on,
and **Auto-accept drafts** in `/glla` settings turns it off again.

`versionDisplay` is global-only because it is a preference about your display,
not a property of one repository. It picks the ONE surface that shows the
running GLLA version:

| Value | Where the version appears |
| --- | --- |
| `card` (default) | a row on the active card |
| `status` | the bottom status line, which is kept even when a card renders |
| `off` | nowhere; `/glla version` still reports it |

Set it with **Version indicator** in `/glla` settings. Exactly one surface is
chosen, never two — the duplicated bottom strip was removed in v0.39.46 and
this setting does not bring it back.

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
| `drafterModel` | unset (session) | Drafting-only primary model. Default inherits the session model AND thinking; selecting session clears both role overrides without a second thinking prompt. Global-only. |
| `drafterThinkingLevel` | unset (inherit) | Thinking level for explicitly configured drafting models only; the implicit session route keeps the session dial. Global-only. |
| `drafterModelFallbacks` | `[]` | Ordered drafting fallbacks; the final session route uses its original thinking. Exhaustion restores the original session pair; rejected restoration remains retryable. Cancellation and manual model changes stop pending retry work. Global-only. |
| `designerEnabled` | unset (on-demand) | Explicit Designer enablement: `true` keeps the managed read-only Designer registered, `false` never registers it (model picks are kept), unset registers on demand when a goal/list item/task asks for Designer or a Designer model is set. Global-only. |
| `designerModel` | unset (session) | Primary model for the Designer design-checkpoint role. Default inherits the session model AND thinking; selecting session clears both overrides without a second thinking prompt. Explicit models are selected first. Global-only. |
| `designerThinkingLevel` | unset (inherit) | Thinking level for explicitly configured Designer models; picked with the model. When registration returns to the session route, it uses the current session thinking, not this override. Global-only. |
| `designerModelFallbacks` | `[]` | Ordered Designer fallbacks, resolved at registration time: the first eligible ref is written into `Designer.md`, then session inherit. Global-only. |
| `compactorModel` | unset (plan B) | Emergency-compactor primary; never the session model. Global-only. |
| `compactorModelFallbacks` | `[]` | Ordered compactor fallbacks; no session last resort. Global-only. |
| `compactionTokenThreshold` | `200000` | Positive context-token target for opportunistic transcript compaction at the next idle boundary, between work turns or list items. Waits while tools, audits, or queued messages own the host; respects pause and abort. Global-only. |
| `mainModelRetryMinutes` | `15` | Base backoff for non-quota failures; doubles per attempt, caps 5h. A quota-class wall (rate-limit / plan-quota) instead tries permitted alternatives promptly, then retries every five minutes without an attempt/elapsed cutoff. Billing, auth and transient failures keep this ladder. Global-only. |
| `mainModelSameModelRetries` | `10` | Same-model retry budget before fallback, with a two-minute phase limit when a permitted backup remains. A quota-class wall cannot heal by repeating the same account, so it skips this budget and tries untried permitted alternatives promptly; billing, auth and transient failures respect it. In-flight calls retain the host timeout. 0 = immediate rotation. Clamped to 0..100. Global-only. |
| `mainModelFailback` | `"auto"` | `"auto"` re-probes the primary; `"sticky"` keeps the fallback. Global-only. |
| `mainModelPrimaryProbeMinutes` | `15` | Minutes between preferred-primary health probes. Global-only. |
| `forbiddenModels` | `[]` | Refs that must never be selected (case-insensitive substring). |
| `blockForbiddenModelSwitches` | `true` | Revert forbidden switches (`false` = stand but ledger). |
| `visionAssist` | `true` | Continuation prompts carry the prefer-native-vision directive. |
| `auditorModel` | unset (fallbacks, then session) | Detached auditor primary (`"provider/id"` or bare id); default is the session model AND thinking. Selecting session saves project-local `null`: explicitly inherit the live model+thinking pair without exposing lower-layer pins or changing global settings. Explicit fallback lists remain available after that session primary. Deleting the project key instead resumes ordinary global inheritance; no second thinking prompt is shown. A selected model runs first, including when it matches the session. If unavailable, walk explicit fallbacks then the session model at the session's thinking level. With no pin, configured fallbacks precede the session last resort; with no chain, inherit session directly. |
| `auditorModelFallbacks` | `[]` | Ordered auditor fallbacks; session model is final. Saving a non-empty chain offers the thinking pick. Global-only. |
| `auditorAllowedExtensions` | `[]` | Extension specs the detached auditor may load; resolved fail-closed, `[]` = isolated. |
| `auditorMirrorSessionExtensions` | `true` | Also load the session's own packages in the worker (GLLA itself never mirrored); `false` = curated allow-list only. |
| `auditorSameSessionSwap` | ignored (legacy) | Compatibility-only; explicit auditor selection always wins, even when it matches the session model. No longer shown in the menu. |
| `auditorThinkingLevel` | unset (inherit) | Detached auditor reasoning level; picked with the model. Applies to the CONFIGURED auditor models. The session model — the auditor's default and its last resort — always runs at the session's own thinking level, so a configured override never turns down the route that has to carry the final decision. |
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
| `decisionPauseBudget` | unset (unlimited) | Budget for unattended decline of promoted suggestions: after N admitted decisions, proceed without executing the suggestion and record the declined command in `autoDefaultLog` and `decision_budget_auto_default` (or `run_to_done_auto_default` for run-to-done). `0` permits that safe decline immediately. It never supplies consent or waives criteria: classified material exceptions remain paused; unclassified human decisions require local classification; known authorized mechanical/reversible work continues without a decision. Run-to-done follows the same consent boundary. |
| `carryover` | `"pause"` | Stale carryover on new activation: `"pause"` / `"clear"` / `"resume"`. |
| `autoAcceptDrafts` | `false` | Drafts activate without the Confirm dialog (unattended rigs). |
| `versionDisplay` | `card` | Where the running version shows: `card`, `status`, or `off`. |
| `auditCap` | `5` (10 aggressive) | Pause after N consecutive auditor disapprovals (`0` = unlimited). |
| `auditCapHard` | `8` | Hard ceiling on consecutive disapprovals — pauses with a decision even in aggressive mode (`0` = unlimited). Project-settable. |
| `mechanicalLoadScale` | `true` | Scale mechanical gate budgets with host load up to 2× (`false` = fixed budgets). Project-settable. |
| `auditFeedbackChars` | `0` (full) | Max auditor-report chars returned after disapproval (`0` = full). |
| `auditorSilent` | `true` | Auditor report renders final-only, no word-by-word HUD. |
| `auditorProgressSignals` | `true` | Silent audits show phase label + byte counter. |
| `hourlyRetryProbe` | `true` | Extra blind retry at :00:30 for eligible legacy recovery waits. A quota-class wait uses its durable five-minute cadence instead, without an extra hourly queue-jump. Global-only. |
| `subagentModelStrategy` | `"inherit-parent"` | Default subagent model policy for new sessions. |
| `subagentModelOverrides` | unset | Per-agent-type model pin; always wins over strategy. |
| `subagentThinkingOverrides` | unset | Per-agent-type thinking pin (`off`–`max`); unset per type = session inherit. |
| `subagentFallbacks` | unset | Per-role fallback chains (first eligible ref wins). |
| `subagentDisplayRichness` | `"quiet"` | Ambient worker UI: `"quiet"` (default, troubled workers + count line) / `"compact"` / `"rich"`. |
| `aggressiveMode` | `true` | Keep-going defaults (`false` = pause-first policy). |
| `stuckMaxInterventions` | `5` (10 aggressive) | Consecutive stuck interventions before a loop stops (`0` = stop after the first tick). |
| `subagentHangEscalationMinutes` | `30` | Confirmed no-progress minutes before child-specific abort (`0` = warn only). |
| `stallEscalationRefires` | `5` | Heartbeat refires before pause/stop (`0` = never). |
| `zombieRetryMaxAttempts` | `3` | Re-dispatches per busy/no-stream episode (`0` = manual; max 10). |
| `stallShortWords` | `15` | Tool-less turn under this many words is a nudge. |
| `stallSimilarityThreshold` | `0.6` | Trigram similarity above this (tool-less) is a nudge. |
| `postaudit` | unset | Post-completion audit config (same shape as legacy `reviewer`). |
| `toolOverrides` | unset | Per-tool allow/hide/per-tool-config overrides. |
| `contextCheckpointProjection` | `false` (off) | Per-turn `context`-hook splice of a bounded continuation checkpoint. Off (default) leaves the transcript append-only so the provider prefix-cache holds; the fresh continuation prompt still carries live state. On restores the legacy projection (busts the cache). |
| `reviewer` | legacy | Deprecated alias for `postaudit`; migrated on load, `postaudit` wins. |
| `fleetHealthRoots` | unset (current project) | Roots `/glla fleet` scans for project health (`["/home/dracon/Dev"]`). Relative paths resolve from the invoking project. Project-settable; not a menu row, so it is edited in the settings JSON. |

The post-completion audit config is edited from the **Postaudit** row in
`/glla` settings, or with `/glla postaudit` / `/glla reviewer` (both open the
same menu). It is project-scoped and persists under the canonical `postaudit`
key. A hand-written legacy `reviewer` block still reaches the menu, because
load-migration consolidates `reviewer` into `postaudit` before it is read.
Each edit is merged over the **effective** block (global, then project), so an
option set in one edit is still in effect after the next one.

## Auditor backup selection

Explicit quota, rate-limit and billing errors end the worker's internal retry
loop and advance immediately to the next eligible auditor. Provider failures
may skip configured backups on that provider, but the permitted session model
still gets a final attempt, including when it shares the provider. Host reloads
preserve exhausted candidates, the current fallback and its retry budget.
Every fallback runs in an isolated audit session. If all candidates fail, the
completion claim remains stored for infrastructure recovery; no verdict is
inferred from availability. Configured model preferences remain unchanged.

Auditors try an explicit primary, ordered configured fallbacks, then the session
model as last resort. With no explicit primary but a non-empty fallback list,
the first eligible fallback is tried **before** the session, even with same-model
swap off; the menu labels this `fallback chain (first eligible)`, not session
inheritance. This is selection order, not a live health check. Headless thinking
output leaves the effective level pending in that case, since support is checked
on the selected model at dispatch rather than inferred from the session.

Forbidden refs are excluded both as configured names and as resolved canonical
provider/model identities, including the implicit session tail. No eligible
candidate means refusal, not permission to resurrect a forbidden session model.
Duplicate resolved refs do not add backup capacity. A backup equal to the current
session may leave only one eligible model; different provider wrappers can also
share the same upstream account/quota. Configured counts are not a guarantee of
independent capacity, authentication or provider availability.

Capability-aware thinking displays use the same downward resolution as dispatch:
unsupported requests never select a higher supported level (for example, unsupported
`xhigh` becomes `high`, not `max`, even if the model supports `max`). Non-reasoning
models display `off`. Configured role thinking remains separate from inherited
session thinking. Headless auditor output keeps the effective level pending when
capabilities are unknown.

Designer and Drafter each allow ten fallback models **in addition to** the optional
primary. The fallback setting is bounded before combining it with the primary;
explicit order is retained, duplicate model identities do not create independent
attempts, and a permitted session model remains available as the final route. An
explicit fallback naming the session model keeps its configured position. Forbidden
refs and their resolved model identities remain excluded.

## Designer

The read-only Designer role (goal/list items and tasks marked `Agent: Designer`) is configured on its own `/glla` **Designer** tab — enablement, the Designer agent (model + thinking, picked together like the Drafter), ordered fallback models, the effective resolution, and whether the managed `Designer.md` is currently registered in the pi agent dir. The generic Designer pins that used to live on the Subagents tab (`subagentModelOverrides.Designer`, `subagentThinkingOverrides.Designer`, `subagentFallbacks.Designer`) are migrated into the dedicated `designer*` keys on load: dedicated values win (an explicit `designerModelFallbacks: []` beats a legacy chain), the legacy entries are removed, and other roles' pins are untouched. Because `Designer.md` lives in the global agent dir, the dedicated keys are global-only; a legacy project-scoped Designer pin no longer applies.

Enablement is tri-state: on keeps Designer registered, off never registers it (your model picks are preserved, and a marked item falls back to the inline design checkpoint with a warning), and on-demand (unset) registers it when work asks for it or a Designer model/thinking/fallback is configured. Registration resolves the model at write time — primary → fallbacks → session inherit — and if no configured ref is eligible and the session model itself is forbidden, Designer is not registered and the operator is warned rather than silently inheriting a forbidden model. A user-owned `Designer.md` (no glla marker) is never overwritten or removed.

The managed `Designer.md` is a **launch projection, not a saved pin**: the companion resolves the child from that file when the child starts, so GLLA rewrites it from the live session before a Designer launch — after a model switch, a thinking-level change, a new turn, and on an ordinary Designer request that is not part of a Designer-marked goal. Session inheritance therefore never becomes a stale static pin: the resolved pair is not written into the settings, and the file itself records that it is a projection. An explicitly selected Designer model and thinking stay independent of the session dial and are preserved unchanged.

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
