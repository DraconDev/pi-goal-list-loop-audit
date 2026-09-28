# Operator-visible surfaces (status line, head, panels, menus, settings pickers, notifications, summaries) — 2026-09-28

Scope: extensions/goal-loop-display.ts, goal-commands.ts, settings-menu.ts, goal-settings.ts,
loops/goal-settings-ui.ts, loops/goal-ui.ts, model-picker.ts, multi-model-picker.ts,
model-selector.ts, goal-agents-panel.ts, completion-summary.ts, finding-lead.ts,
terminal-summary-delivery.ts, approval-render-store.ts, action-reminder.ts, vision-assist.ts,
drafter-model.ts, confirm-draft.ts, drafting-interview.ts.
Dedupe: every candidate checked against `.pi-glla/audit-loop/findings.md` (637 lines, 364 findings);
anything already recorded there was dropped without re-reporting.

## Findings

### F1 [MEDIUM] `mainModelRetryMinutes` and `auditFeedbackChars` are the only numeric policy knobs with no guard in `normalizeLoadedSettings`, so every operator surface renders a hand-edited value the runtime silently ignores
- Where: `extensions/goal-settings.ts:448-643` (`normalizeLoadedSettings` — validates `mainModelPrimaryProbeMinutes` at 527-532, `auditCap`/`auditCapHard` at 587-592, `auditSpotCheckRate` at 585-590, `stuckMaxInterventions`/`stallEscalationRefires`/`stallShortWords` at 605-615, `auditJobRetentionMs` at 566-576 — and never mentions `mainModelRetryMinutes` or `auditFeedbackChars`); tracked for display at `extensions/goal-settings.ts:713` and `:741` (both in `SETTINGS_KEYS`, so provenance + `/glla` + the menu all print them); menu row `extensions/settings-menu.ts:290-295`; editor `extensions/loops/goal-settings-ui.ts:1449-1457` and `:1685-1693` (both reject anything the file can legally contain).
- What breaks: hand-edit `settings.json` to `"mainModelRetryMinutes": "30"` (a quoted number — the single most likely human error, and one the editor can never produce). `loadSettings` returns it verbatim, so `settingsProvenance` labels it `project`, the interactive menu prints `30 [project]`, and the headless `/glla` row prints `30`. The runtime calls `mainModelRetryDelayMs(attempts, "30")`, whose guard `Number.isFinite(baseMinutes) && baseMinutes > 0` fails for a string, so the base silently falls back to 15 (`extensions/main-model-recovery.ts:271`). The operator sets a 30-minute recovery base, watches a 15-minute ladder run, and has no indication the value is dead. Same shape for `auditFeedbackChars`, where the runtime guard (`Number.isInteger(...) && >= 0`, `extensions/loops/goal-tools.ts:2141-2143`) silently substitutes the default while the menu shows the junk.
- Fix: add the two missing guards next to their siblings — `mainModelRetryMinutes`: `typeof !== "number" || !Number.isFinite(…) || < 1 → delete`; `auditFeedbackChars`: `typeof !== "number" || !Number.isInteger(…) || < 0 → delete` — so a bad file value disappears from every surface at once instead of being displayed and ignored.
- Confidence: high on the absence (I read `normalizeLoadedSettings` end to end, 448-643) and on the runtime fallback (`main-model-recovery.ts:271`, read); medium on the exact rendered string, since I read the menu row but not the `/glla` headless row for this key.

### F2 [LOW] `objectiveExcerpt` / `stopReasonExcerpt` still cut UTF-16 code units on untrusted goal text, while the sibling `clipSummaryValue` in the same module was converted to code-point-safe cutting
- Where: `extensions/completion-summary.ts:1276-1278` (`clean.slice(0, 217)`) and `:1281-1283` (`clean.slice(0, 257)`); consumed at `:1334`, `:1430` (`Objective "…"` / `terminal reason: …`) and `:1327`. The code-point-safe cutter lives in the leaf module at `extensions/finding-lead.ts:150-180` (builds a `units` array, slices the array, joins) and is what `clipSummaryValue` now uses.
- What breaks: a goal objective `ship the 🚀 release …` where the emoji's two code units straddle index 217. `safeFact` (`:1272-1274`) only collapses whitespace — it does not touch surrogates — so the slice emits a lone `0xD83D`, and the durable archive line plus the terminal echo render a replacement glyph inside a quoted objective. Same for a `stopReason` straddling index 257. The 2026-09-26 ledger fix (`00c721da`) converted `clipSummaryValue` only; these two wrappers were left on the old `.slice` path.
- Fix: delete the local slicing and route both through `clipSummaryValue`/the shared clause-bound cutter in `finding-lead.ts` so one implementation owns all code-point arithmetic in this module.
- Confidence: high — I read both functions and their three call sites, and the shared cutter.

### F3 [LOW] `summarizeToolArg` truncates a tool argument by code units before painting the live widget card
- Where: `extensions/loops/goal-ui.ts:637` — `return base.length <= 24 ? base : base.slice(0, 23) + "…";`
- What breaks: the argument is `file_path ?? path ?? command ?? pattern ?? query ?? url ?? title` — provider/child-controlled text. The function already strips `\x00-\x1f` and `\x7f-\x9f` at `:634-635` precisely because unescaped bytes corrupt the card, but the length cut is still UTF-16. A `bash` call whose command puts a multi-code-unit glyph at index 23 paints a broken surrogate into the WORKING card for the rest of the turn. The sibling panel solved exactly this by routing through the shared helper (`extensions/goal-agents-panel.ts:97-100` → `truncateCells`).
- Fix: `return base.length <= 24 ? base : truncateCells(base, 24);` (or `[...base].slice(0, 23).join("") + "…"`), keeping the control-byte strip that is already there.
- Confidence: high on the code (read at `:628-637`); medium that the card is user-visible in the affected state — I did not trace the render call site.

### F4 [LOW] `drafterThinkingLevel` / `auditorThinkingLevel` are enum-typed but unvalidated, unlike the sibling per-agent thinking pins
- Where: `extensions/goal-settings.ts:448-643` (no guard for either key, while `subagentThinkingOverrides` is pruned against the same ladder at `:465-472`); displayed at `extensions/settings-menu.ts:172` and `:180` (`settings.drafterThinkingLevel ?? sessionThinking`); consumed as a string at `extensions/loops/goal-list-queue.ts:451` (`String(settings.drafterThinkingLevel ?? originalThinkingLevel)`).
- What breaks: hand-edit `"drafterThinkingLevel": "turbo"` into `settings.json`. It survives `loadSettings`, the Drafter row prints `turbo` as the current level, and `goal-list-queue.ts:451` stringifies it into the drafter's agent-file `thinking:` key — a level the ladder does not define. The menu's own picker can only produce the seven real values, so the surface is showing a state the editor cannot express and the runtime cannot honor.
- Fix: validate both against `["off","minimal","low","medium","high","xhigh","max"]` — reuse the exact `levels` array already built for `subagentThinkingOverrides` at `goal-settings.ts:465` — and `delete` any non-member before precedence.
- Confidence: medium — the absence and the display line are read; `goal-list-queue.ts:451` is a grep-read line whose surrounding spawn code I did not re-read, so the exact hand-off shape is inferred.

## Checked and clean

- `SETTINGS_KEYS` vs the `Settings` interface (`goal-settings.ts:52`, `705-761`): the only keys in the interface but absent from the list are `auditorModelFallback` (a legacy alias, migrated at `:646-653` and deleted), and `autoReloadOnStale` / `autoRecovery` — which `docs/DESIGN.md:111` and `README.md:353` both document as deprecated deserialization-only fields that "do not select a transport". Their absence from provenance is intentional, not a gap.
- Headless/menu/docs coverage of the settings key list is machine-pinned: `tests/settings-editors.test.ts:658-666` requires every `SETTINGS_KEYS` entry except the `reviewer` alias to appear in the `/glla` output, and `:579-582` requires every entry in `docs/SETTINGS.md`. The `decisionPauseBudget` invisibility that used to violate this is recorded fixed (`ce8b5660`) and the key is now in `SETTINGS_KEYS` (`:732`), in the menu (`settings-menu.ts:220`), and has an editor (`goal-settings-ui.ts:1678-1684`).
- Array-shaped policy keys the renderers assume are genuinely defended now: `forbiddenModels` is `Array.isArray`-checked, string-filtered, trimmed and bounded to 50 (`goal-settings.ts:479-487`); `subagentFallbacks` / `subagentThinkingOverrides` prune emptied objects; the vision-assist shell interpolation was moved to single-quote encoding (ledger `ee50dd3`).
- `extensions/approval-render-store.ts` bounds both dimensions and is code-point-safe: 20 entries (`MAX_STORED_RENDERS`), 150 chat lines, 2000 chars each (`:20-27`), applied via `[...line].slice(0, MAX_RENDER_LINE_CHARS)` at `:96-97`; dedup at `:104-112` compares the *already-clipped* lines against the stored entry, so a long re-persist cannot bypass the bound; the cap trims delivered history only and never drops an undelivered render (`:117-121`).
- The unpicked UI-surface ledger items I re-checked are all genuinely closed, not re-openable: the archive banner's false "completion review recorded" claim (`0f46c0b2`), the vanished `Verdict:`-prefixed findings in the durable archive (`f63e7054`), and the agents-panel transcript `.slice(0, 40)` surrogate split (`9228af52`).

## BLOCKERS

- none. Tests were not run (per the hard rule against invoking the project runner); every finding above was
  re-read in source and cites a line I opened in this pass. The report was written to the runtime's
  authoritative artifact path rather than `audit/FRESH-AUDIT-2026-09-28/ui.md` (no tracked file was touched).
