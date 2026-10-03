# Full UI audit — 2026-10-03

Objective: audit the full GLLA UI and improve it where necessary, including
layout changes. Scope covers GLLA-owned terminal UI and its public Pi hooks.
Pi core, providers, OS, and other plugins remain outside the implementation
boundary. Prior audits are pointers; current source and rendered behavior
are authoritative.

## Completion requirements

1. Inventory every GLLA custom component, widget/status state, command view,
   editor, confirmation, fallback dialog, and completion/notification surface.
2. Check settings discoverability, effective values/provenance, selected-row
   continuity, cancellation, keyboard navigation, and readability across tabs.
3. Check single and ordered/set pickers: search, selection, disabled entries,
   order, empty results, long values, and terminal width/height constraints.
4. Check draft review: full contract remains reviewable, choices stay visible,
   keyboard actions work, and acceptance/cancellation retain their semantics.
5. Check goal/loop/queue/worker/auditor cards across live, paused, held,
   recovery, completion, and empty states. State and next-action text must
   agree with durable state. Rendered rows must fit the available space.
6. Check commands, headless/RPC fallbacks, confirmations, approval summaries,
   notifications, errors, and option wording for accuracy and useful actions.
7. Produce and inspect actual rendered evidence with narrow/normal/wide and
   short-terminal cases; record fixes and consciously retained tradeoffs.
8. Verify affected behavior and broad UI regression suites, synchronize
   version/changelog/docs/inventory, and prove the packed extension still loads.

## Implemented improvements (0.38.112)

| Finding | Result |
| --- | --- |
| Narrow tables could hide values and their source | Two-line rows below 72 columns reserve room for source labels and value text |
| Later tabs disappeared behind a left-truncated tab strip | The active tab and its position remain visible when the full strip will not fit |
| Long settings sections crowded a short terminal | A window follows the cursor; counts and keyboard help remain visible |
| Selected settings values and descriptions were permanently clipped | Wrapped details with PgUp/PgDn can reveal every line; Ctrl+D opens details during search |
| Every edit reopened the section at its first row | The actual menu factory restores the edited row; tab switching remembers cursors |
| Finding one option required browsing eight tabs | `/` searches all tabs; direct matches take priority, role labels distinguish results, and Esc clears search before exiting |
| Model and fallback dialogs ignored terminal height | Live-height viewports preserve the selected model; order mode dedicates its viewport to the chain |
| Large extension selections consumed the complete dialog | A selection count and membership markers remain visible without an unbounded summary pane |
| Search backspace could leave half a surrogate pair | Deletion is code-point safe in both pickers and settings search |
| Long draft contracts could not be reviewed fully | PgUp/PgDn scroll the contract independently of the decision choices |
| Persistent acceptance exposed an implementation key and lost its scope on narrow screens | A separate project-scoped choice uses plain wording; the selected long choice wraps |
| Inner truncation resets interrupted the selected-row background | Plain truncation resets are removed before the outer highlight; source and padding keep the background |
| User/model text could issue terminal commands through settings, labels, drafts or reminders | Display projections strip terminal controls while saved refs/settings and diagnostic evidence retain their meaning |
| Zero-width display budgets were treated as unbounded | Explicit zero/small widths are bounded in status/card/reminder builders |
| A settling card still claimed to wait for a completion review | It names the approved archive owed and the real goal/list settlement action |
| Compact audit status misnamed old settlement debt as worker silence | Settling status explicitly says approved; archive owed |
| Held loop status called the preserved loop stopped and omitted its next step | Held state and its actual resume/drop commands are displayed |
| Paused goal status omitted its stored suggested action | The command includes that action, or its applicable choose/resume command |
| A decision reminder's transcript and reconstructed card disagreed | Missing supplied action remains missing in the durable reminder payload, so both ask the user to choose an option |
| Generic editor failures always pointed at global permissions, including stale refusals | The menu reports the actual error and asks the user to resolve it before retrying |

## Coverage and rendered evidence

[Coverage register](full-ui-audit-2026-10-03/coverage-register.md) maps every
surface family to its current source, behavior suites and rendered artifacts.
`surface-inventory.json` uses the TypeScript AST: four custom components, one
registered message renderer, five registered commands, five custom factories,
34 select calls, 27 inputs, eight confirms, 589 notifications and one widget/
status publisher each. This inventory includes the complete notification and
native-dialog callsites rather than only files with UI in their names.

- `rendered-frames.json` / `rendered-gallery.html`: 296 real component, card,
  status and reminder frames with installed Pi dark/light themes at 40, 60,
  80 and 120 columns. Every custom modal frame fits its declared content
  height. The PNG contact sheets are raster previews of those ANSI frames.
- `settings-and-review.png`: normal settings/search, fallbacks/order mode,
  draft beginning and persistent-consent choice.
- `narrow-and-light.png`: narrow settings with source/value visibility,
  wrapped details and draft review in both themes.
- `lifecycle-cards.png`: 16 empty, active, paused, blocked, frozen, audit,
  terminal, queued, loop/cadence/held and worker states.
- `pause-reminders.png`: blocked, decision, error, wait and standby message
  renderings in both themes, including the corrected decision instruction.
- `command-views.json`: 144 actual registered-handler outputs over those 16
  durable fixtures (goal status/timeline, list show, loop status, and glla
  status/stats/audits/agents/settings text). All views produced feedback.

The preview sheets were inspected and drove additional fixes: precise search,
role labels, settlement wording, selected background continuity, source labels,
and the reminder/transcript mismatch. They are not hand-written UI replicas.

## Verification evidence

- `red.log`: initial behavioral baseline, one control pass and nine failures.
  Two fixture assertions were refined afterward (the existing label is
  “Auditor agent”, and wrapped values are compared across line breaks).
- `settling-red.log`, `command-red.log`, `reminder-red.log`,
  `decision-reminder-red.log`, `highlight-red.log`: independently reproduced
  lifecycle, command, reminder, transcript and highlight defects before fixes.
- `final-component-tests.log`: 124 pass across seven files, including narrow/
  short layouts, all settings tabs, selected-row continuity, cross-tab search,
  Unicode, real draft rendering/choices, caps/order, and reminder behavior.
- `editor-continuity-tests.log`: 13 existing UI/command audit cases pass; its
  real custom factory now asserts both tab and row retention after an editor.
- `command-tests.log`: 27 status/lifecycle/timeline cases pass; read-only held
  status retains exactly the same durable state.
- `card-tests.log`: 155 display/activity/lifecycle cases pass.
- `decision-reminder-tests.log`: 39 reminder, decision interruption and new
  UI behavior cases pass. `consent-completion-tests.log` and
  `read-only-gate-tests.log` verify updated legacy assertions against the
  current canonical actions and the audit-cleanup mutation guard.
- `release-check-initial.log`: broad initial sweep, 3162 pass, one skip and
  five failures. Four obsolete UI assertions were corrected and replayed
  green. The unrelated compactor normal-exit descendant check passed in its
  isolated four-case replay; no compactor implementation was changed here.
- `release-check-interrupted.log` and `release-check-before-decision-fix.log`:
  owned verification runs explicitly stopped with SIGTERM when additional
  rendered UI defects required fixes. The runner completed contained cleanup;
  these runs are not claimed as passing gates.
- `release-check.log`: final frozen-source composite gate passed (exit 0):
  3175 tests passed across 342 files, one environment-gated auto-committer
  test skipped, zero failures. TypeScript checking, Jiti state binding,
  offline auditor-extension loading, generated inventory checking, package
  dry-run and installed-tarball launcher/RPC/skill checks all passed.

## Boundaries and retained choices

The grid remains the wide-terminal layout and the existing tree remains the
ambient-card style. Search is opt-in; default tabs still separate roles. Empty
idle state stays quiet. Editing from search returns to the selected setting's
role tab so the new effective value is visible. Native Pi inputs/selects/
confirms and RPC host rendering retain their public-hook semantics; no Pi core,
OS/font, provider or other-plugin repair was attempted. The custom controllers
are exercised down to eight content rows; production reserves host chrome.

The source fixtures and public-handler outputs are hermetic. This does not
claim a live provider/credential survey or a screenshot of every external host
mode. No runtime journal was forced into git, no history was rewritten, and no
package publication or release tag was performed. The sync daemon owns tracked
commits. Version metadata, changelog, docs and generated inventory are 0.38.112.

## Completion review

| Requirement | Result and evidence |
| --- | --- |
| 1. Complete surface inventory | Complete: AST callsite inventory and coverage register include custom components, ambient UI, commands, native dialogs and notifications |
| 2. Settings behavior and readability | Complete: all eight tabs exercised across width/height budgets; search, provenance, details, cancellation and actual editor row/tab continuity verified |
| 3. Single and multiple pickers | Complete: search, Unicode deletion, disabled entries, caps, selection, order and live resizing verified; actual browse/order frames inspected |
| 4. Draft review and acceptance | Complete: full long contract reachable, choices retained, keybindings and project consent verified; beginning/end/consent frames inspected |
| 5. Lifecycle cards and next actions | Complete: 16 durable states rendered; settling, held and paused actions verified; explicit zero and narrow width bounds tested |
| 6. Commands and fallback behavior | Complete: 144 public-handler views generated; canonical routes, read-only behavior, ownership/stale guards, RPC/headless and approval delivery covered by passing suites |
| 7. Actual rendered evidence | Complete: 296 dark/light frames at four widths, four inspected contact sheets, short-terminal component tests and documented retained choices |
| 8. Release verification and metadata | Complete: final composite gate passed; package and both lock versions are 0.38.112, changelog/docs/inventory synchronized, installed packed extension verified |

All eight requirements are satisfied within the GLLA scope. The final release
check ran against the completed implementation; subsequent changes only finish
this evidence record. The package is prepared and verified, without publication.
