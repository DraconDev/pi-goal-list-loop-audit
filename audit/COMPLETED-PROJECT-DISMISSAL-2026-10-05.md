# Dismiss completed project UI

Prepared 0.39.7; not published. Operator clarified that completion must dismiss
both live UI surfaces rather than retain the 0.39.6 compact archived receipt.

Completed project records now fall through the ordinary widget/footer routing.
With no unfinished work, both projections are undefined and refreshUI clears
`pi-glla` via setWidget/setStatus. A waiting queue still renders its own card
and footer. The journal, archive, completion summary and `/loop status` remain
available; no live project data was edited by this change.

Terminal-only/empty blank startup no longer advertises an auto-resume wait.
Actual unfinished work still receives the transcript-load barrier and hint.

39 focused tests passed across four files, including dismissal, queued work,
blank terminal startup, normal load holds and real audit completion. TypeScript,
inventory and whitespace checks passed. Full release gate remains due before
publication.
