# GLLA settings reference

Canonical settings reference (audit 2026-09-06 — settings truth previously
lived only in the menu/headless renderers and the changelog). The live
views remain `/glla` (headless display with provenance) and the `/glla`
settings menu; this file is the shipped, reviewable contract. A release-gate
test pins that every `SETTINGS_KEYS` entry in `extensions/goal-settings.ts`
appears here, so the table cannot silently drift.

## Files and precedence

- Global file: `~/.pi/agent/glla/settings.json` (machine/provider policy).
- Project file: `<cwd>/.pi-glla/settings.json` (project artifact).
- Effective value: project wins over global wins over built-in default.
- `/glla` shows per-key provenance (`project` / `global` / `default`).
- Hand-edited files are normalized on every load
  (`normalizeLoadedSettings`): unknown enums fall back, out-of-range
  numbers reset to unset (consumer `??` fallbacks apply), junk strings are
  dropped, and legacy keys migrate (`reviewer` → `postaudit`,
  `auditorModelFallback` → `auditorModelFallbacks`,
  `hourlyQuotaProbe` → `hourlyRetryProbe`).

## Global-only keys

These describe machine/provider policy, not a project artifact. Project
copies are ignored (the recovery runtime reads the global file):

`stateRoot`, `mainModelFallbacks`, `mainModelRetryMinutes`,
`mainModelFailback`, `mainModelPrimaryProbeMinutes`, `hourlyRetryProbe`,
`autoResume`, `drafterModel`, `drafterThinkingLevel`,
`drafterModelFallbacks`, `compactorModel`, `compactorModelFallbacks`,
`auditorModelFallbacks`, `auditorToolTimeoutMs`, `auditorStallMs`,
`auditJobRetentionMs`, `auditorInspection`.

## Keys

| Key | Default | Meaning |
| --- | ------- | ------- |
| `stateRoot` | `"workingDir"` | Where durable state lives; `"sessionDir"` is explicit opt-in. Global-only. |
| `mainModelFallbacks` | `[]` | Ordered provider/model refs on main-model failure. Global-only. |
| `drafterModel` | unset (session) | Drafting-only primary model. Global-only. |
| `drafterThinkingLevel` | unset (inherit) | Thinking level for the drafting agent. Global-only. |
| `drafterModelFallbacks` | `[]` | Ordered drafting fallbacks; session model is final. Global-only. |
| `compactorModel` | unset (plan B) | Emergency-compactor primary; never the session model. Global-only. |
| `compactorModelFallbacks` | `[]` | Ordered compactor fallbacks; no session last resort. Global-only. |
| `mainModelRetryMinutes` | `15` | Base minutes before main-session recovery; doubles per attempt, caps 5h. Global-only. |
| `mainModelFailback` | `"auto"` | `"auto"` re-probes the primary; `"sticky"` keeps the fallback. Global-only. |
| `mainModelPrimaryProbeMinutes` | `15` | Minutes between preferred-primary health probes. Global-only. |
| `forbiddenModels` | `[]` | Refs that must never be selected (case-insensitive substring). |
| `blockForbiddenModelSwitches` | `true` | Revert forbidden switches (`false` = stand but ledger). |
| `visionAssist` | `true` | Continuation prompts carry the prefer-native-vision directive. |
| `auditorModel` | unset (session) | Detached auditor primary (`"provider/id"` or bare id). |
| `auditorModelFallbacks` | `[]` | Ordered auditor fallbacks; session model is final. Global-only. |
| `auditorAllowedExtensions` | `[]` | Extension specs the detached auditor may load; resolved fail-closed, `[]` = isolated. |
| `auditorSameSessionSwap` | `true` | Walk the fallback chain when the auditor is the session model. |
| `auditorThinkingLevel` | unset (inherit) | Detached auditor reasoning level; picked with the model. |
| `auditorToolTimeoutMs` | `300000` | Base budget per auditor tool call (30s–6h). Global-only. |
| `auditorStallMs` | `600000` | Base silence budget for the detached auditor (1m–24h). Global-only. |
| `auditJobRetentionMs` | `900000` | How long proven-dead audit job dirs are kept (0–7d, 0 = reap now). Global-only. |
| `auditorInspection` | `false` | Auditor runs as a persistent session you can tail/resume. Global-only. |
| `notifyCmd` | unset | Shell command on goal complete / pause / loop stop; message is `$1`. |
| `tokenLimit` | unset (off) | Per-goal token budget; crossing it pauses. `0` = off. |
| `wedgeAlertMinutes` | unset (30, or off while aggressive mode is on — the default) | Busy-but-silent minutes before the wedge alert; `0` = off. The menu shows the effective value. |
| `autoResume` | `false` | Restored goals/loops/lists auto-resume in fresh sessions. Global-only. |
| `decisionPopup` | `true` | Decision pauses pop the picker (`false` = widget card only). |
| `carryover` | `"pause"` | Stale carryover on new activation: `"pause"` / `"clear"` / `"resume"`. |
| `autoAcceptDrafts` | `false` | Drafts activate without the Confirm dialog (unattended rigs). |
| `auditCap` | `5` (10 aggressive) | Pause after N consecutive auditor disapprovals (`0` = unlimited). |
| `auditFeedbackChars` | `0` (full) | Max auditor-report chars returned after disapproval (`0` = full). |
| `auditorSilent` | `true` | Auditor report renders final-only, no word-by-word HUD. |
| `auditorProgressSignals` | `true` | Silent audits show phase label + byte counter. |
| `hourlyRetryProbe` | `true` | Extra blind retry at :00:30 every hour while parked. Global-only. |
| `subagentModelStrategy` | `"inherit-parent"` | Default subagent model policy for new sessions. |
| `subagentModelOverrides` | unset | Per-agent-type model pin; always wins over strategy. |
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
| `contextCheckpointProjection` | `false` | Off (default): leave all goal-event payloads in the provider context and let pi's normal compaction manage them; this preserves prompt-cache continuity between goal-event ticks. On: use the legacy bounded durable-checkpoint projection. |
| `reviewer` | legacy | Deprecated alias for `postaudit`; migrated on load, `postaudit` wins. |
