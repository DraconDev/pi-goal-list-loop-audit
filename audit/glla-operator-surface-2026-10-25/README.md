# `/glla` operator-surface audit — reachability and contract

Reviewed implementation revision: **`ad1ea932a`** (v0.39.52, the published tag).
This is a scoped audit of the `/glla` command surface — the command dispatcher,
the interactive settings table, the settings editors, the headless fallback and
the promises the shipped documentation makes about that surface. It is **not**
a whole-repository approval, not a release re-validation, not a live-provider
health check, and it makes no claim about any running project, session or goal.
No product file was changed by this audit: the product tree was returned to the
reviewed revision after the negative control below.

## Scope and method

The `/glla` surface was mapped end to end:

- command registration and the advertised verb list —
  `extensions/loops/goal-activation.ts:1233` (19 completion verbs), handler at
  `extensions/loops/goal-activation.ts:1223`;
- the dispatcher — `cmdSettings` at `extensions/goal-commands.ts:3408`;
- the settings table — `buildSettingsRows` at `extensions/settings-menu.ts:203`
  (77 rows across 9 sections);
- the settings editors — `handleSettingChoice` at
  `extensions/loops/goal-settings-ui.ts:1182` (60 editor cases plus three
  dynamic prefix branches), whose only caller is the table's choice handler at
  `extensions/loops/goal-settings-ui.ts:798`;
- the headless fallback — `extensions/goal-commands.ts:3569` (one line per
  `SETTINGS_KEYS` entry);
- the shipped operator contract — `docs/SETTINGS.md`, `CHANGELOG.md`, `note.md`.

Every editor, every row and every `SETTINGS_KEYS` entry was swept
mechanically against the others, and every candidate was checked against the
existing test suite before being kept or cleared as a finding.

## Dispositions

| Finding | Severity | Disposition | Evidence |
| --- | --- | --- | --- |
| 1 — the "Version indicator" editor is unreachable from the settings table | P2 | **Open** — the feature is live, documented and shipped; the operator path is missing | [repro](#finding-1--the-version-indicator-editor-is-unreachable) · `repro.log` |
| 2 — the postaudit editor re-reads a key that load-migration deletes, so every edit discards the previous one | P1 | **Open** — a saved "off" silently reverts to the default "on" | [repro](#finding-2--the-postaudit-editor-discards-the-options-an-earlier-edit-saved) · `repro.log` |

Two candidate classes were investigated and **cleared**, and are recorded here
so a later audit does not re-open them:

- **Settings deliberately edited together** — `auditorThinkingLevel`,
  `drafterThinkingLevel` and `designerThinkingLevel` have no standalone row
  because the thinking level is chosen *with* the model in one editor
  transaction (`extensions/loops/goal-settings-ui.ts:1805`). Not a finding.
- **Settings documented as hidden legacy** — `auditorSameSessionSwap` is
  documented as "No longer shown in the menu" (`docs/SETTINGS.md:136`) and
  `reviewer` is a documented legacy alias (`docs/SETTINGS.md:175`). Not a
  finding.
- **Verb coverage** — all 19 advertised verbs are implemented in `cmdSettings`.
  `reset` and `reviewer` are implemented but deliberately unadvertised aliases.
  Not a finding.
- **`takeover` is not in the stale-refusal set** — by design: the refusal
  message itself points the operator at `/glla takeover` as the recovery path
  (`extensions/loops/goal-session.ts:1322`). Not a finding.

## Findings

### 1. P2 — The "Version indicator" editor is unreachable from the settings table

**Locations:** `extensions/loops/goal-settings-ui.ts:1278`,
`extensions/settings-menu.ts:203` (no matching row),
`extensions/goal-commands.ts:3632`,
`docs/SETTINGS.md:97`, `CHANGELOG.md:207`, `note.md:10`.

`versionDisplay` is a live, global-only setting with a complete editor at
`extensions/loops/goal-settings-ui.ts:1278` — it opens a three-way select
(`card` / `status` / `off`) and saves to global scope. But **no row in the
interactive settings table has the id `versionDisplay`**, so the editor can
never be opened: `handleSettingChoice` is only ever reached from the table's
choice handler (`extensions/loops/goal-settings-ui.ts:798`).

The gap is invisible from the outside because the two adjacent surfaces are
complete:

- the **headless** `/glla` list prints the value with its provenance
  (`extensions/goal-commands.ts:3632`, `versionDisplay (card/status/off)`) and
  then tells the operator "Edit settings by opening /glla in an interactive
  session" (`extensions/goal-commands.ts:3677`) — a path that does not exist
  for this key;
- the **documentation** promises the row: `docs/SETTINGS.md:97` says "Set it
  with **Version indicator** in `/glla` settings", and the v0.39.49 changelog
  entry says "with a **Version indicator** row in `/glla` settings"
  (`CHANGELOG.md:207`);
- the **operator's own working note** records the same promise
  (`note.md:10`): "`versionDisplay` setting: `card` (default) / `status` /
  `off`, with a "Version indicator" row in `/glla` settings — exactly one
  surface, never two."

A mechanical sweep of all 60 editor cases against all 77 rows shows
`versionDisplay` is the **only** settings editor in the product with no
reachable row. The consequence is that the setting can only be changed by
hand-editing the global settings JSON — the one path the docs explicitly do
not offer, since the key is global-only and a project-scope write is rejected
(`extensions/goal-settings.ts:1264`).

**Observed:** the sweep reports exactly one unreachable editor —

```
rows: 77  editors: 60
exact-unreachable editors: ["versionDisplay"]
```

and the interactive table renders 77 rows in nine sections, none of them
`versionDisplay` (the "Other" section holds `stateRoot`, `notifyCmd`,
`tokenLimit`, `toolOverrides`, `postaudit` and
`contextCheckpointProjection`).

**Why it survived:** the repository already carries two completeness gates for
the settings surface — `docs/SETTINGS.md` must cover every `SETTINGS_KEYS`
entry (`tests/settings-editors.test.ts:913`) and the headless `/glla` list
must cover every `SETTINGS_KEYS` entry
(`tests/settings-editors.test.ts:991`). `versionDisplay` passes both, because
it *is* in the docs and *is* in the headless list. **No gate checks the
interactive table.** Per-key row checks exist but are written one key at a
time (e.g. `decisionPauseBudget` at `tests/settings-editors.test.ts:935`), so
a key added later without a row is invisible.

**Durable direction:** add the missing "Version indicator" row (the "Other"
section is its natural home — it is a display preference like
`contextCheckpointProjection`), and add a **completeness gate** that mirrors
the existing doc/headless gates: every editor case in `handleSettingChoice`
must be reachable from a row id in `buildSettingsRows`, and every key the
reference promises to be settable in the menu must have one. The gate fails on
the next omission instead of the next field report.

---

### 2. P1 — The postaudit editor discards the options an earlier edit saved

**Locations:** `extensions/goal-commands.ts:2334`,
`extensions/goal-commands.ts:2340`,
`extensions/goal-commands.ts:2345`,
`extensions/goal-settings.ts:851`,
`extensions/goal-settings.ts:1281`,
`extensions/reviewer.ts:39`.

`cmdReviewerSettings` (the editor behind `/glla postaudit`, `/glla reviewer`
and the interactive "Postaudit" row) chooses the key it reads and writes
**once**, at entry:

```ts
const settingsKey: "postaudit" | "reviewer" =
  settings.postaudit !== undefined ? "postaudit" : "reviewer";   // goal-commands.ts:2334
const load = () =>
  resolveReviewerConfig(loadSettings(ctx.cwd)[settingsKey] as ...); // goal-commands.ts:2340
```

`loadSettings` migrates the legacy `reviewer` block into `postaudit` and
**deletes the legacy key** (`extensions/goal-settings.ts:849` and `:851`).
The repository already pins that behaviour as a contract:
`tests/settings-menu-complete.test.ts:751` asserts "legacy key does not
survive load".

So the two halves of the editor disagree:

- **read**: `load()` reads `loadSettings(cwd)["reviewer"]` — a key the
  migration has already deleted, so it is **always `undefined`**. The editor
  therefore merges every patch over `DEFAULT_REVIEWER_CONFIG`, never over the
  saved block;
- **write**: `saveSettings` migrates the patch it is handed
  (`extensions/goal-settings.ts:1281`), so the value lands on the canonical
  `postaudit` key.

The net effect: the editor's "current configuration" is always the defaults,
and each save overwrites the whole block with *defaults + the one field just
changed*. Every option the operator set earlier is reset.

The default for `enabled` is `true` (`extensions/reviewer.ts:39`), so the
failure is not cosmetic: an operator who turns the post-completion audit
**off** and then changes any other option — the mode, a cap, a cascade step —
silently turns it back **on**. The same applies in reverse to `mode: "off"`
(the silenced state), which reverts to `"on"` (the Confirm-gated cascade).
The sub-menu is affected too: it renders the config it reads, so it shows
"Enabled — ON" while the operator believes it is off.

**Observed:** driving the real editor through the exported dispatch — toggle
"Enabled" off, then change "Mode" — leaves:

```
saved.mode    = "auto"   (the second edit landed)
saved.enabled = true     (the first edit was discarded; expected false)
```

and the sub-menu's second render shows `Enabled — ON` where the operator
turned it OFF. The same block on disk reads `postaudit.enabled === true`.

**Why it survived:** the existing tests cover the *pieces* but never the
round trip. `tests/postaudit-surface.test.ts:53` pins that `/glla postaudit`
and `/glla reviewer` reach the same menu; `tests/reviewer-modes.test.ts:145`
tests `reviewerMenuOptions` with a *synthetic* config;
`tests/settings-menu-complete.test.ts:478` pins the menu row's value text as
the literal "open sub-menu", so the row never displays the config either. No
test writes a postaudit block and then reads it back through the editor, and
the pinned "legacy key does not survive load" contract is exactly the fact
the editor depends on.

**Durable direction:** read and write the **canonical** `postaudit` key — the
legacy block is already surfaced as `postaudit` by load-migration, so
`settings.postaudit ?? settings.reviewer` needs no special case. The editor
must merge over the *saved* block, never over the defaults, and the sub-menu
must render the saved block so the operator can see what is actually in
effect. Add a regression test that edits two options in one session and
asserts both survive, plus one that asserts the sub-menu shows the saved
state.

## Reproduction and checks

From the repository root:

```sh
bun test --parallel=1 --max-concurrency=1 --timeout=120000 \
  audit/glla-operator-surface-2026-10-25/repro.test.ts
```

The four tests assert the intended contract and intentionally **fail on the
reviewed implementation** (`ad1ea932a`). They use temporary settings, the
mock host API and the real GLLA editors and dispatchers; they make no
model/provider requests. `repro.log` records the run on the reviewed tree:

```
 0 pass
 4 fail
```

| Test | Asserts | Result on `ad1ea932a` |
| --- | --- | --- |
| every settings editor is reachable from a row | no editor case lacks a row | fail — `versionDisplay` |
| the documented "Version indicator" row exists | a `versionDisplay` row labelled "Version indicator" | fail — no such row |
| the postaudit sub-menu shows the saved configuration | after turning Enabled off, the menu shows `Enabled — OFF` | fail — shows `Enabled — ON` |
| a postaudit edit does not discard an earlier edit | `postaudit.enabled` stays `false` after a second edit | fail — `true !== false` |

Additional checks:

- **Existing focused suite, reviewed tree** — seven files
  (`tests/settings-menu-complete.test.ts`, `tests/settings-editors.test.ts`,
  `tests/postaudit-surface.test.ts`, `tests/reviewer-modes.test.ts`,
  `tests/glla-stale-context.test.ts`, `tests/doc-parity.test.ts`,
  `tests/footer-fold.test.ts`): **155 passed, 0 failed**,
  `focused-existing.log`. This is the "why it survived" evidence: the suite
  that covers the settings surface is green on the tree that carries both
  defects.
- **Negative control** — the candidate repairs were applied temporarily (a
  `versionDisplay` row in the "Other" section, and the editor reading and
  writing the canonical `postaudit` key). The reproducer then passed **4/4**,
  and the same seven focused files still passed **155/0** — the repairs
  satisfy the asserted contract and break no pinned contract. They were then
  **reverted**; `git diff ad1ea932a -- extensions/` is empty, so the product
  tree matches the reviewed revision exactly. The negative control is
  evidence that the durable directions are implementable, not a change that
  was kept.
- `npm run check` (**typecheck**) — see `typecheck.log`.
- `node scripts/generate-inventory.mjs --check` — see `inventory.log`.

The original review was **not clean**. Both findings are real defects on the
reviewed tree, not external blockers and not permission to weaken the
settings contract: the version indicator is a shipped, documented feature with
no operator path, and the postaudit editor discards saved configuration. No
live project, session or goal was changed, recovered or claimed.
