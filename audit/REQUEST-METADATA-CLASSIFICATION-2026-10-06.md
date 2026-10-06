# Request metadata is not provider-failure evidence

GLLA owns classifyMainModelFailure and its fallback admission. The earlier
LIVE-PROJECTS-2026-10-06.md finding remains reproducible on current source:
opaque request IDs containing 401/403/503 alter failure classification. Metadata
containing context, credential, user-interrupt or the explicit policy-event marker
can also alter admission, making this more than inconsistent UI color.

Controlled public-policy tests failed before correction. Classification now selects
actual error/message/status/code fields from valid JSON envelopes, excludes request
metadata, and admits numeric codes only from HTTP/status context. Textual request-id
annotations are removed from classification input. Raw diagnostics are retained
unchanged. Explicit policy detection uses the same evidence projection; real
errorMessage policy events remain terminal. Actual HTTP and statusCode fields
remain meaningful. Generic recovery policy is not replaced with quota escalation.

Validation: 36 tests across main-model recovery, context-overflow recovery and
unsupervised retry passed; TypeScript, inventory and whitespace checks passed.
Evidence: request-metadata-classification-2026-10-06/. Changes are Unreleased,
subsequent to the published 0.39.13 tag. No external project or provider was changed.
