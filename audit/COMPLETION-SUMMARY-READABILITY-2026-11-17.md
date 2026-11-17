# End-of-objective summary readability

An operator report asked for more human, informative summaries after objectives end.
This is owned by GLLA: `complete_goal` supplies report material, the terminal
composer builds the report, and the registered message renderer selects its
collapsed projection. No provider or Pi changes are needed.

## Findings and changes

- Rich chat and archive reports applied the compact 140-character outcome
  budget before splitting a title from its explanation. This discarded useful
  second sentences. Both now use the existing bounded full-value budget;
  compact notifications retain their smaller budgets.
- The collapsed projection shared four findings across every work area. A busy
  first area could hide all later areas. Each area now gets four primary
  findings, while excess detail still has an explicit expansion pointer.
- The opening Summary prose was shortened to a 280-character notification
  preview. Its first two content lines now wrap intact; supporting content
  still collapses. Actions and limitations remain intact.
- Shared tool guidance, the completion parameter description, and the
  continuation prompt now ask for the whole objective's practical result,
  meaningful behavior changes, and explanations scaled to the work. Earlier
  delivered work belongs in the recap even when the final turn fixed an audit
  issue. Paths support explanations; generic claims do not replace them.

## Representative result

The regression fixture supplies this outcome, including its qualification:

> Overlapping saves now keep the latest confirmed edit. You can switch panels
> without losing pending changes, and reopening the project restores the last
> confirmed save even when an older background retry finishes late. The
> signed-in browser flow still needs a manual check.

The report uses the first sentence as its title and keeps the remaining text
once as the explanation in chat, transcript, and archive. Its verification
states the observed results, and its follow-up preserves the unchecked flow.
A separate multi-area fixture verifies that Packaging and Recovery results
remain visible after Persistence exceeds its collapsed allowance.

## Verification

- Seven summary/rendering suites: 90 passed, 0 failed.
- Ten completion/audit/delivery suites: 92 passed, 0 failed.
- Typecheck, generated inventory, and private-name checks passed.
- Regression fixtures cover complete outcome preservation across all rich
  surfaces, visibility of later work areas, intact opening prose, and retained
  verification, limitations, and archive pointer.
- Authoring quality still depends on the executor supplying substantive facts;
  the renderer preserves those facts and does not invent missing explanations.
