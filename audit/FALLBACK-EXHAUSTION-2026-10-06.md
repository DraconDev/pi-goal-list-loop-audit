# Ordinary fallback exhaustion — 2026-10-06

GLLA-owned defect reproduced: after an ordinary request switched to its only
backup, failure of that backup left a passive recovery record. Settlement treated
that record as a fresh model switch and sent immediately again (two handoffs
instead of one). The ordinary retry timer also rejected passive records.

Recovery ownership now requires an actual switch or supervised recovery.
Passive ordinary episodes fall through to retry backoff; genuine probe/manual
waits remain guarded. Delayed retries retain the original request and respect
supervisor freezes. Credential failures do not produce a blind handoff.

Verification: 39 passing cases across ordinary retry, main model recovery and
context overflow; TypeScript and inventory passed. Before/after and check logs:
fallback-exhaustion-2026-10-06/. Release 0.39.14 includes this correction.
