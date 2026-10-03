# Command and respec review — 2026-10-03

Scope: GLLA's command registration, root-spec selection, dedicated draft,
reconciliation prompt and goal/list revision flow. No live loop was started or
runtime journal changed. This is a review, not an implementation of new modes.

## Assessment

`/loop respec` is a useful improvement mechanism for GLLA: research and document
the actual code, preserve binding requirements under `## Rules`, then close
rule/code gaps and correct descriptive documentation. Neither `SPEC.md` nor
`spec.md` currently exists at this repository root, so using the command here
would begin with the dedicated drafting phase.

The implementation already distinguishes draft from reconciliation, persists
the phase, requires an explicit handoff plus structural completeness, handles
two root specs through selection, and tracks spec drift. Refinement is available
through `/loop refine`; goal/list contract revisions are handled by `tweak`.

## Priorities

1. **Explain respec in the main command guide.** Registration lists it, but the
   README's `/loop` examples omit respec and refine. Show the canonical sequence
   `/loop respec`, `/loop status`, `/loop refine <suggestion>`, `/loop pause`,
   `/loop resume`, `/loop stop`, with Rules versus descriptive sections explained.
2. **Make supported arguments explicit.** The respec handler does not consume
   `rest`: text after `respec` does not become a refinement or bound. Reject or
   explain unsupported arguments rather than silently losing operator intent.
   Decide the intended syntax before introducing parsing or new options.
3. **Distinguish actual review from a prompt instruction.** `respecTarget`
   asks for alternating implementation and audit, but reconciliation uses the
   generic metricless prompt. That prompt asks for one change each turn. This
   can conflict with an honest audit that finds no defect. The alternating
   review is not itself the isolated completion auditor. A future change should
   make the turn type explicit and accept evidence of a clean review without
   requiring a cosmetic edit.
4. **Show progress as spec coverage and concrete evidence.** Checkbox tracking
   is useful activity evidence, not proof of compliance. Expose which rule or
   section is being addressed, the change/evidence and the next review action;
   retain semantic colors and bold without italics. Avoid implying that all
   compliance was verified merely because the structural draft gate passed.
5. **Improve revision review.** `cmdTweak` shows current/new objectives and
   explains replace/preserve/clear contract semantics, but an omitted contract
   gets a preservation note without displaying the existing contract. Display
   the current and resulting contract so an operator can judge scope changes.

## Verification

- 89 tests passed across respec drafting, refinement parity/transactions and
  forever-loop behavior.
- 30 tests passed across contract text semantics, list tweak proposals,
  procedural-tail handling and mode-specific command guidance.
- Zero failures. Tests use temporary state fixtures; no production loop launched.

Sources: `extensions/goal-loop.ts` (respec command and draft handoff),
`extensions/goal-loop-forever.ts` (target and structural completeness),
`prompts/goal-loop-respec-draft.md`, `prompts/goal-loop-forever-metricless.md`,
`extensions/loops/goal-activation.ts` (registered command descriptions),
`extensions/goal-commands.ts` (`cmdTweak`), and `README.md`.
