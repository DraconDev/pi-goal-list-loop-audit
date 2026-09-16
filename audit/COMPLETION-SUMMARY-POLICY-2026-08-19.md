# Completion-summary policy — 2026-08-19

> **Status as of v0.36.0 (2026-08-28):** the original free-form-input gap
> described below is now closed at the central terminal archive boundary.
> `docs/DESIGN-long-running-supervision.md` is the current long-running policy;
> this file preserves the original rationale and trade-offs.

## Current v0.36.0 behavior

Every archived terminal goal is resolved through the six-label recap contract.
Valid supplied recaps are preserved. Missing, generic, or incomplete claims
receive a recorded-facts-only fallback, and `completion_summary_fallback` is
ledgered. Metric-loop terminal stops use the same recap in durable loop state
and `/loop status`. The fallback writes `not recorded` when state does not
contain a changed-file manifest or test result; it never infers evidence.

The caller fields remain strings so the executor claim and independent auditor
report do not become one verdict object. The full recap is durable in the
archive/history surfaces; terminal notifications use a compact projection.

## Original baseline behavior

`complete_goal` currently accepts two independent free-form strings:

- `completionSummary` is a one-paragraph executor claim. glla persists it on
  `Goal.completionSummary`, passes it to the detached auditor, includes it in
  the archived goal markdown, and uses a width-limited version in the terminal
  completion line/notification.
- `verificationSummary` is the executor's per-contract evidence claim. It is
  persisted in `PendingCompletion` while the detached audit is running and is
  supplied to the auditor for cross-checking. The durable proof is the
  auditor's report/verdict and regression-shield evidence, not this claim.

The surfaces intentionally stay separate. `renderGoalMarkdown()` has a
`## Completion summary` section and a separate `## Audit history` section.
The terminal status/widget says `done` plus duration/recap, while the verdict
and any disapproval details remain in the archive, audit history, and status
surfaces. Existing tests pin that a completed widget uses the recap rather than
repeating the objective and does not fabricate an auditor verdict.

The current gap is not missing storage or an incorrect terminal lifecycle: it
is that `completionSummary` has no required internal shape. A caller can send a
vague sentence such as “done” and the archive remains technically valid but
not very useful to a person asking what changed, what was checked, or what
should happen next. The existing validator only handles narrow claim-integrity
cases (for example, impossible pass/total counts); it is not a summary schema.

## Recommendation: a compact labeled recap, not a new verdict object

Adopt this six-field format for the value supplied as `completionSummary`:

```text
Outcome: <what was delivered or learned, in one sentence>
Changed: <files, behavior, decision, or durable artifact; say “none” for research-only work>
Evidence: <key commit/report/contract result; keep raw command output in verificationSummary/audit report>
Tests: <exact bounded commands and concise pass/fail results, or “not run — <reason>”>
Unresolved: <explicit remaining risk/blocker, or “none”>
Next: <one useful follow-up, queued item, or “none”>
```

Rules for the format:

- Every label is present, even when its value is `none`. This prevents a
  polished “done” sentence from silently omitting unresolved work.
- Describe the outcome in terms of the user's objective, not merely files
  changed. For a documentation/research item, `Changed` can name the report
  and its recommendation; for a code item, it can name behavior and tests.
- Put short pointers and exact command names in the recap, not large logs. The
  verification summary remains the contract-by-contract claim and the
  independent auditor report remains the authoritative evidence record.
- `Unresolved` must state known limitations and provider/audit gaps rather
  than implying that an approved audit proves more than it did.
- `Next` is a human-facing hand-off hint. It must not silently enqueue or
  mutate a goal/list item; queue state remains owned by the existing commands.
- The card answers two questions (field 2026-09-16): **what happened, and
  what the good next move is** — informative over long. `Outcome` may be a
  section-structured working document (`##`/`###` headers, tables); it
  renders in full as the Summary section and may carry the horizon
  (slices 2–3). `Next` still names only the single immediate move
  (slice 1): length is permitted wherever clarity needs the room, never
  as a goal in itself.
- Do not write “auditor approved” in the executor recap. The orchestrator adds
  the independent verdict on its own surface, preserving the distinction
  between an executor claim and an auditor decision.

This is a presentation/input contract, not a claim that the executor is
trusted. The detached auditor must continue to inspect artifacts and reject
summaries that are unsupported or contradict the verification contract.

## Trade-offs

| Shape | Benefit | Cost/risk |
| --- | --- | --- |
| Current unconstrained paragraph | Backward-compatible and low friction | Omits fields unpredictably; poor hand-off quality |
| Labeled recap in the existing string (recommended) | Human-readable, archive-compatible, easy to adopt, no migration | Still user/agent-authored; labels are not independently typed fields |
| New typed `completionRecap` object | Machine-readable filtering and future analytics | Requires tool/schema/state migration, legacy handling, archive/display changes, and a policy for conflicting free-form text |
| Auditor-generated recap only | Stronger evidence grounding | Delays the useful summary until audit completion and conflates executor narrative with independent verdict |

The labeled string is the smallest safe boundary: it improves usefulness now
without treating a summary as evidence or creating a second durable verdict
model. A typed object should be considered only after a consumer actually needs
field-level queries or automation.

## Implementation boundary

- **glla completion tool/state owns capture:** the `complete_goal` tool schema,
  the prompt/example guidance for the six labels, `Goal.completionSummary`,
  `PendingCompletion.verificationSummary`, and the existing archive/notification
  projections.
- **glla's detached auditor owns independent proof:** it receives both claims,
  reads the repository, runs bounded checks, and persists the audit report,
  verdict, and regression-shield outcome. It must not be replaced by parsing
  the labels or by copying `verificationSummary` into the recap.
- **Display owns projection only:** the status bar/widget may show a compact
  `Outcome`/recap excerpt and duration; it should not show the full evidence or
  infer approval from the presence of a summary.
- **The queue/list state machine owns follow-up work:** the `Next` line is not a
  queue mutation, and the terminal recap must not be used to auto-create work.

The v0.36.0 implementation keeps the string boundary but adds the durable
terminal resolver in `extensions/completion-summary.ts`, central archive
finalization in `extensions/loops/goal-orchestrator.ts`, loop-stop summaries,
and event-driven recovery policy in `extensions/goal-heartbeat.ts` and
`extensions/goal-recovery.ts`. The existing independent auditor and persistence
fences remain authoritative. Arbitrary prose is not parsed into evidence;
missing facts remain explicitly `not recorded`.

## Evidence reviewed

- `extensions/loops/goal-tools.ts` — `complete_goal` parameters, persistence of
  the claim, auditor hand-off, and approved notification.
- `extensions/goal-loop-core.ts` — `Goal.completionSummary`,
  `PendingCompletion`, and archive markdown rendering.
- `extensions/loops/goal-orchestrator.ts` — durable terminal archive ordering.
- `extensions/goal-loop-display.ts` — compact terminal recap/duration projection
  and deliberate separation from verdict text.
- `extensions/goal-loop-auditor.ts` and
  `extensions/goal-loop-auditor-process.ts` — independent auditor prompt and
  report lifecycle.
- `tests/goal-loop-core.test.ts`, `tests/display.test.ts`,
  `tests/revision-bound-audit.test.ts` — persistence, display, and audit-claim
  regressions.
