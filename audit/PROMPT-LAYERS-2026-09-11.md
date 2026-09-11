# Prompt layers: skeleton + on-demand detail (2026-09-11)

Goal `20260911150619-tfsgvv` (list item 1 of the cross-harness add-list):
layer ALL GLLA prompt files into a static skeleton plus on-demand detail.
Static layers resolve before dynamic `${...}` substitution, in file order
every turn; full assembly per phase is byte-identical to the legacy render.

## Mechanism (`extensions/prompt-layers.ts`)

- One canonical `.md` file per prompt (editors still render the whole
  prompt; the ~10 test files that read `prompts/*.md` directly are
  untouched and green).
- Detail blocks wrapped in structural markers
  (`<!-- glla-layer: detail <id> -->` … `<!-- glla-layer: end -->`).
  Markers are stripped at assembly, so full assembly equals the source
  minus marker lines, byte for byte.
- Assembly is file order regardless of request order (pinned).
- Loudness: missing file, unclosed/duplicate/stray block, and unknown
  requested id all THROW naming the file. The three legacy silent
  fallbacks are gone: `[template-not-found]` (continuation),
  the inline mini-prompt (loop), `[DRAFTING] Clarify…` (drafts).

## Per-file layers and why

| File | Details | Rationale |
|---|---|---|
| `goal-loop-continuation.md` | `auditor-disapproval`, `survey-pivot`, `session-restart` | Only file rendered per turn with situation-dependent sections |
| `goal-loop-forever.md`, `goal-loop-forever-metricless.md` | none (skeleton-only) | Target/metric/job/hard-rules are all per-iteration essential |
| `goal-loop-draft.md`, `goal-loop-forever-draft.md` | none | Render once per drafting session; file-level on-demand already exists (draft vs forever-draft vs plan) |
| `goal-loop-plan.md`, `goal-loop-plan-loop.md` | none | Loaded only in plan depth; single-purpose, no conditional sections |

Mid-turn contingencies (subagent death, provider errors, detached
commits, stalls, task workflow, hard rules) STAY in the continuation
skeleton: their trigger cannot be known at render time and there is no
mid-turn detail fetch. Deferring them would trade a behavior regression
for tokens. Conscious non-change, do not re-propose without a fetch
mechanism.

## Predicates (all render-time-known, all pre-existing signals)

- `auditor-disapproval`: `liveDisapproval(goal.auditHistory ?? [])` —
  the same call the directive builder already made.
- `survey-pivot`: `isFullAuditObjective(goal.objective)` — the same call
  the aggressive-mode arm already made.
- `session-restart`: `includeRestartDetail` opts flag, set by
  `buildContinuationContent` when a resync block rides along, or
  `goal.autoResumedAt` (recovery path).

## Measured effect (fixed scenario: clean fixture, no triggers)

- Template bytes: full 18,242 → bare 15,696 (−2,546 chars).
- Rendered `continuationPrompt`: 24,347 → 21,801 chars (−2,546, exactly
  the deferred bodies); 24,463 → 21,899 bytes; est. tokens 6,087 → 5,451
  per full continuation (~10%).
- `tests/context-growth-measurement.test.ts` re-baselined deliberately
  per its own convention: every pinned value moved by an exact multiple
  of the per-payload shrinkage (n=12: −31,236 bytes = 12 × −2,603).
- Exact-delta pins (`tests/prompt-layers.test.ts`, 19 tests): removing a
  deferred body from the armed render reproduces the unarmed render
  character-for-character (plus one joining newline).

## Couplings found (pre-existing, unchanged)

- A survey objective in aggressiveMode also arms the dynamic FULL-AUDIT
  directive alongside the static pivot section. The layer test strips
  both and expects identity, so it holds in either mode.
- v0.38.5 delta-only already sends markers on steady-state turns; layers
  shrink the FULL renders, which fire exactly when the deferred
  situations are likeliest (audit report, recovery, resync).

## Cache note

Static-first loading with fixed order keeps the stable prefix stable;
dynamic slots stay in place (moving them would break the byte-identical
render gate — recorded as a separate future item, not smuggled in here).
First turn after upgrade re-caches once.

## Pins

- `tests/prompt-layers.test.ts` (19): full-assembly render-diff for all
  7 files, declared-id lists, loud missing/unknown/defect, order
  determinism, normal-turn omission + saving floor, three exact deltas,
  autoResumedAt path.
