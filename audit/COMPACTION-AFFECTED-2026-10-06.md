# Current compaction cases — October 6, approximately 00:27 UTC

Read-only journal, rotated segment, marker and terminal survey. No project was
resumed or compacted, and no runtime state was changed.

Confirmed stale successful attempt markers with large current contexts:
Junk Runner (latest saved 1,065,193 tokens; now held), Darklord, Hegemon and
Football Forever. All have a durable session_compact timestamp after the
remaining attempt marker, and current context remains above the target.
These are the success-rearming cases addressed by prepared 0.39.11.

Studio also has a recent successful marker, but its current footer is about
9.4% of its 1M window (roughly 98k). Its 328,852 saved sample precedes that
compaction, so it must not be counted as a current high-context case. The old
half-target rule can rearm at its next safe boundary. The platform root has
a saved success marker but no active GLLA goal/loop, so it is not an active
supervised failure case.

Separate failures: Deathrun, Neonbreak, Polis and Capture Anime Girls have
summarizer output-cap errors after their markers. Hellhunter's latest attempt
failed with a summarizer-provider 404 and its project is held. Those are not
successful-rearming cases; 0.39.11 intentionally retains failed-attempt guards.

Evidence is in compaction-affected-2026-10-06/. Context footer percentages are
approximate, while journal samples are stamped historical values. No claim
that every high-context project is frozen follows from these observations.
