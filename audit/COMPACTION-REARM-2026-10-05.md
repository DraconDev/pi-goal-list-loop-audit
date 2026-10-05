# Compaction after successful attempts and Junk Runner's large context

Read-only survey around 22:38–22:40 UTC on October 5 confirms automatic
compaction completed in Football Forever (19:26), Hegemon (19:44), Hellhunter
(19:12) and Eve (17:45). Deathrun and Capture Anime Girls also have output-cap
failures; these external summarizer failures do not imply successful shrink.

Junk Runner compacted successfully at 17:53:49 UTC after firing at 259,650
tokens. Subsequent recorded usage rose through 224,399, 348,900, 459,011 and
554,121 to 685,727. Its original attempt marker remained. The latest audit was
increment 6, with a live detached worker, recent tool completions and an
in-budget bash call. The main transcript size is separate from the fresh
detached auditor's context. No external project or live session was changed.

## GLLA-owned scheduling defect

The boundary marker treated success like a failed or unresolved attempt. It
only rearmed below half the configured target: 100k with the default 200k.
Successful summaries can remain above that level, or the host can expose its
next usage count only after work grows again. The marker then suppresses all
future opportunistic attempts, despite successful earlier compaction.

Prepared 0.39.11 records successful callback completion and rearms confirmed
success after a three-minute recovery grace. The rearming boundary yields to
ordinary work before another attempt. Older markers recover from the durable
lastCompactionAt stamp when completion occurred after that marker. Failures
and unknown outcomes retain their one-shot half-threshold rule. A late success
callback after failure cannot fabricate success or release its guard. Existing
idle, supervision, pause, pending-message and audit-ownership checks remain.

The native completion notification already existed, but incorrectly said
"session compacting" after completion and promised a widget chip that project
cards bypass. It now says "transcript compacted". `/glla status` persistently
shows the configured target and last recorded completion timestamp.

The successful-large-context regression failed before the change. Coverage
includes successful and legacy rearming, cooldown, failed attempt containment,
late callback ordering, configured targets, idle/settled dispatch and public
completion/status wording. Verification logs are retained alongside the live
observations. Full release validation has not been run for this prepared
version; it is not published. No live audit was interrupted or compact forced.
