# Deterministic-400 hold + dethroned-session message (v0.38.92, 2026-09-21/22)

## Field cases (both live 2026-09-21)

1. **7.5h blind retry**: ai-auto-writer goal parked in main-model
   recovery, "retrying automatically" for 7.5h. Provider diagnostic:
   `BadRequestError: Image count 12 exceeds limit 4 per request`
   (agnes/Muse cap; Codex Luna accepts 12 — model-dependent, request
   deterministic). An identical retry can never succeed; only a changed
   request (fewer images, different model) can. Recovery scheduled it
   anyway — unbounded under aggressiveMode.
2. **False subagent claim**: doomtap session lost the state-root race
   (newer pid took over), then its tool call was refused with "you are
   running in a subagent session". It is a dethroned MAIN, not a worker
   — the WITH_STATE_ROOT_HINT variant led with the wrong diagnosis
   (follow-up to 195237, which fixed same-session-new-manager but not
   the dethroned path).

## Changes

- `isDeterministicProviderError()` (main-model-recovery.ts, next to
  isQuotaHorizonExempt): BadRequestError / invalid_request_error /
  `"code":"400"` markers. Never a bare "400" (token counts quote them).
- `setMainModelRecoveryPause` (goal-recovery.ts): deterministic holds
  for manual resume BEFORE horizon/quota logic, in every mode, with
  fix directions (switch model / trim request, then resume). Single
  choke point — all six schedule sites covered.
- Storm-recovery model switch (goal-recovery.ts): retires the old
  episode's diagnostic on switch, so a stale deterministic marker
  cannot hold the fresh model's probe.
- `DETHRONED_SESSION_TOOL_MESSAGE` (goal-session.ts): root-loss
  refusals state the root fact + cure, never claim subagent. Genuine
  foreign/worker refusals keep the original message.

## Verification

- quota-horizon-exemption.test.ts +4: classifier matrix, aggressive +
  fresh 400 holds (no timer, manual hold), 429 control schedules,
  hold-message pin.
- session-identity-refusal.test.ts +1: dethroned main gets the root
  message, never "subagent"; 195237 tests unchanged green.
- Recovery/identity batch 57/57; tsc clean.
