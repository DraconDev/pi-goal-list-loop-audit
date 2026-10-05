# Model selection made Football Forever's objective disappear from UI

Prepared 0.39.8; not published. Read-only journal inspection confirms the
Football Forever objective was retained before and after the manual selection
at 2026-10-05T16:36:25.294Z from openrouter/stealth/space-bunny-alpha to
opencode-go/space-bunny-free. Its loop remained inactive with the same objective
and old main-model recovery reason. The selection cleared mainModelRecovery,
removing the only UI branch that displayed that inactive loop. The old recovery
reason was also absent from RESUMABLE_STOP. This is a GLLA recovery/UI defect.
The provider's preceding 404 is external behavior; no provider was modified.

Manual selection now changes a recovery-held loop to a visible provider-error
hold, preserving its target, history and iteration. Cancellation is announced
only after persistence succeeds, and the notice names the actual resume command.
Saved older orphan recovery stops are also visible and resumable through the
ordinary loop command and broad resume command. Actual model-recovery dispatch
still runs before ordinary resume admission when a recovery record is present.

The regression failed before fixing admission. Tests drive the actual model
selection handler and `/glla resume` for both a current recovery episode and an
older orphan reason, asserting objective and iteration preservation, visibility
and reactivation. 39 tests passed across five files. An additional current-source display/model-selection run passed 137 tests
across three files. TypeScript, inventory and whitespace checks passed.

No live Football Forever journal, terminal or worker was edited or resumed by
this investigation. Load the updated extension and use `/glla resume` (or
`/loop resume`) to recover the retained objective through public commands.
