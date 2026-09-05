# Subagent display unification (v0.38.22, 2026-09-05)

Field: `Screenshot_20260905_105150.png` (music tab, 2 workers `ui-fixes` /
`art-batch`, pi-subagents 0.65.1, GLLA 0.38.21). Same run rendered in FIVE
places; panels swap order between refreshes ("flop").

## Surface inventory

**pi-subagents native (external, read-only — `src/` paths below are its):**

1. Rich inline `subagent` tool display (default `inlineToolDisplay: "rich"`):
   live child activity panels mid-transcript — the triplicated
   `subagent status / Status target: run 601ef390… / Press ctrl+o` blocks
   (`src/runs/foreground/subagent-executor.ts:2592` inspect view).
   Re-rendered per poll, never collapsed → duplicates + arrival-order swaps.
2. Persistent FleetView (`fleetView`, default true; `fleetViewPlacement:
   above/belowEditor`) — the `async workflow: 601ef390 — background` card.
3. Under-chatbox exec strip (`2 active agents · Async runs · tokens`).
4. Built-in escapes (no code needed): `inlineToolDisplay: "summary"` (one
   stable row per run), `fleetView: false`, `fleetViewPlacement` pin.

**GLLA (ours):**

1. Widget slot `pi-glla` (`setWidget`, no placement → default aboveEditor):
   compact agents line only (`renderAgentsWidgetLine` — detailed
   `renderAgentsWidgetLines` exists but ships `lines: []` since the v0.37.1
   jitter fix). Change-gated by widget key.
2. Status bar `pi-glla` (`setStatus`): goal/queue state, no worker content.
3. `/glla agents` + `--tail` on demand (unchanged by this slice).
4. The screenshot's "Both workers still mid-flight…" lines are main-agent
   prose, not GLLA UI — out of scope.

## Root causes

- **Triplication is upstream**: rich inline display re-renders the same run
  per update. GLLA cannot suppress, reorder, or merge into it (no ordering
  API — only `placement: above/belowEditor`; transcript components order by
  arrival, so two extensions refreshing at different cadences visibly swap).
- **Our latent flop**: `renderAgentsWidgetLines` formats RAW `silentMs`
  (per-second key churn → repaint every tick). Re-enabling rich lines
  without bucketing would reintroduce the v0.37.1 jumping. The compact
  line already buckets (`bucketSilentMs`) — the detailed renderer must too.
- **Missing unique signal**: native shows workers; only GLLA knows what
  they are FOR (active goal / list item). Nothing in our ambient UI says it.

## Chosen layout (agreed: full redesign, rich default, customizable)

- New `subagentDisplayRichness: "rich" | "compact" | "quiet"`, default
  `"rich"`. Rich = detailed worker lines (re-enabled, capped at
  `WIDGET_AGENT_ROW_CAP`, bucketed silence, width-safe) + task-linkage
  header (`→ <active goal/list objective, truncated>`). Compact = today's
  single line. Quiet = hang warnings only — **safety invariant: HUNG is
  never silent at any level**.
- Status bar gains `· ●N workers` (rich/compact; quiet only when hung).
- No placement moves: our widget stays aboveEditor, change-gated; the flop
  fix is native `summary` mode (documented) + our bucketed keys.
- README guidance: pi-subagents `inlineToolDisplay: "summary"` +
  `fleetViewPlacement` pin for users seeing triplicates.
- Upstream issue filed (triple-render + order swap); text in §Upstream.

## GLLA wiring (v0.38.22)

- `goal-settings.ts`: `SubagentDisplayRichness` + `subagentDisplayRichness`
  (default `"rich"`, hand-edited junk normalizes to rich — unknown values
  must never blank the worker display). `normalizeLoadedSettings` newly
  exported for tests.
- `settings-menu.ts`: Subagents-section row; `loops/goal-settings-ui.ts`:
  three-option select editor (rich recommended), saved global.
- `goal-agents-panel.ts`: `hasHungWorker` (hung status or abort-requested,
  ended excluded), pure `assembleAgentsExtras(rows, richness, objective,
  now)`; `renderAgentsWidgetLines` buckets silence via `bucketSilentMs`.
- `loops/goal-ui.ts`: extras assembly calls the pure helper; status-bar
  count (`buildStatusText` agent summary) follows the ladder for free.
- Fail-before accounting: the 5 tests are new-behavior pins — on pre-change
  code the file fails to load (`assembleAgentsExtras`/`hasHungWorker`
  missing), and the bucket-stability case fails substantively (raw
  `silentMs` made 31s vs 34s outputs differ).
- `tests/subagent-display-richness.test.ts` (5): default/normalization,
  ladder assembly + linkage header, bucket stability + genuine-growth
  sensitivity, hung invariant (incl. zero-workers hide-at-zero), width
  safety (every rich line ≤ 100 chars, header ≤ 64).

## Release record

- Gate: `TMPDIR=/var/tmp npm run release:check` **1934 pass, 2 skip,
  0 fail** (196 files; one interim fail was lockfile sync, fixed via
  `npm install --package-lock-only`) + `npx tsc --noEmit` clean.
- Tag `v0.38.22` pushed (`0cd197d`), release published, publish run
  `33960089043` success (push twins cancelled by the known concurrency
  race), `npm view` = `0.38.22` live.

## Upstream

Issue: nicobailon/pi-subagents#1931 — "rich inline subagent display renders
the same run 3× and swaps order with other extensions' updates"
(https://github.com/nicobailon/pi-subagents/issues/1931). Evidence: screenshot 2026-09-05 (run 601ef390, three identical
`subagent status` panels interleaved with agent prose, pi-subagents 0.65.1,
default settings). Ask: collapse same-run updates in place (or honor a
single-row mode that still shows progress), and stable ordering vs other
extensions' transcript components. GLLA-side workaround (this release):
richness setting + documented native settings; no cross-extension contracts.
