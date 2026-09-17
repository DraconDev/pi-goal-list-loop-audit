# Deathrun screenshot-derived renderer fixture

Historical example adapted from Screenshot_20260916_224746, Screenshot_20260916_224749.png. These are renderer inputs, not newly executed external-project checks.

## Chat projection

## Done — Bonus orbs are collectible again, aiming accounts for camera dip, and UI and test assertions reflect the real game behavior.

— 1 audit

### Key Findings & Remediation
#### 1. Engine
- **Bonus orbs** — Platform bonus orbs were erased by the hazard clear and never pickup-checked — now rendered on the terrain layer and collected via the shared collectOrbAt path.
- **Aiming** — Landing camera dip displaced worldLayer but the pointer-to-world inverse ignored it — rendered dip is now captured and subtracted in the aim inverse.
#### 2. UI routes
- **Reduced motion** — Settings toggles leaked self-rescheduling parallax RAF chains — cleanup now cancels the pending frame.
- **Distance units** — The hub rendered raw pixels as metres, inflating the personal best 100× — now converted using the canonical /100 form.
- **Keyboard access** — Reset-dialog handlers returned early on Shift, disabling reverse Tab wrap — Tab now routes to trapConfirmFocus before the modifier guard.
#### 3. E2E tooling
- **Booster assertions** — The reader hardcoded /3 and fell back to 3 for every four-charge value — strict capacity-agnostic parsing now tests the real 4→3 contract.
- **Audio telemetry** — Voices were decremented on scheduled stop rather than ended, undercounting polyphony — the ended-event counter now measures the real peak 17.
#### 4. Docs and contracts
- **Specification** — Dash documentation said 3 charges/260px/1200ms versus the shipped 4/285/1000; rope timing and velocity were also reconciled to the implementation.

### Verification Summary
| Quality Gate | Scope | Status | Notes |
| --- | --- | --- | --- |
| Unit sweep | Historical 357 files, 4288 tests | PASS | 4082 passed / 206 skipped / 0 failed; 327 files passed / 30 skipped |
| Engine | Historical engine and route smoke | PASS | 14 passed, 0 failed |
| Playwright | Historical tier1–4 and helper contracts | REPORTED | Tier1 90/90; Tier2 45/45; Tier3 44/45 (carried 8.1 frame-pacing exception); Tier4 20/20; one browser-closed launch flake, suite green on rerun |

### Next
- **Unresolved** — Carried Tier 3 Pairwise 8.1 frame-pacing determinism exception remains; a green rerun does not erase the earlier launch flake.
- **Left out** — The fixed-timestep accumulator was deliberately not attempted inside the historical audit; it remains a separate root-cause change.

• auditor approved (1 verdict).
• record: archive/Deathrun.md

## Durable archive projection

## Done — auditor approved (1 verdict)

## Done: Historical Deathrun completion example — Bonus orbs are collectible again, aiming accounts for camera dip, and UI and test assertions reflect the real game behavior.

— 1 audit

### Key Findings & Remediation
| Area | Finding | Evidence |
| --- | --- | --- |
| Engine | **Bonus orbs** — Platform bonus orbs were erased by the hazard clear and never pickup-checked — now rendered on the terrain layer and collected via the shared collectOrbAt path. | src/lib/game/phaser/run-scene.ts:672,2760 |
| Engine | **Aiming** — Landing camera dip displaced worldLayer but the pointer-to-world inverse ignored it — rendered dip is now captured and subtracted in the aim inverse. | src/lib/game/phaser/run-scene.ts:750,1968 |
| UI routes | **Reduced motion** — Settings toggles leaked self-rescheduling parallax RAF chains — cleanup now cancels the pending frame. | src/routes/settings/+page.svelte:100 |
| UI routes | **Distance units** — The hub rendered raw pixels as metres, inflating the personal best 100× — now converted using the canonical /100 form. | src/routes/+page.svelte:180 |
| UI routes | **Keyboard access** — Reset-dialog handlers returned early on Shift, disabling reverse Tab wrap — Tab now routes to trapConfirmFocus before the modifier guard. | src/routes/settings/+page.svelte:282 |
| E2E tooling | **Booster assertions** — The reader hardcoded /3 and fell back to 3 for every four-charge value — strict capacity-agnostic parsing now tests the real 4→3 contract. | tests/e2e/test-helpers.ts:400 |
| E2E tooling | **Audio telemetry** — Voices were decremented on scheduled stop rather than ended, undercounting polyphony — the ended-event counter now measures the real peak 17. | tests/e2e/tier4-scenarios.e2e.ts:479 |
| Docs and contracts | **Specification** — Dash documentation said 3 charges/260px/1200ms versus the shipped 4/285/1000; rope timing and velocity were also reconciled to the implementation. | SPEC.md:67,74 |

### Verification Summary
| Quality Gate | Command | Scope | Status | Notes |
| --- | --- | --- | --- | --- |
| Unit sweep | bun run test:sweep | Historical 357 files, 4288 tests | PASS | 4082 passed / 206 skipped / 0 failed; 327 files passed / 30 skipped |
| Engine | — | Historical engine and route smoke | PASS | 14 passed, 0 failed |
| Playwright | bunx playwright test tests/e2e --workers=2 | Historical tier1–4 and helper contracts | REPORTED | Tier1 90/90; Tier2 45/45; Tier3 44/45 (carried 8.1 frame-pacing exception); Tier4 20/20; one browser-closed launch flake, suite green on rerun |
| Audit | — | auditor verdict | APPROVED ×1 | audit: auditor approved (1 verdict) |

### Next
- **Unresolved** — Carried Tier 3 Pairwise 8.1 frame-pacing determinism exception remains; a green rerun does not erase the earlier launch flake.

• auditor approved.
• audit: auditor approved (1 verdict).
• record: archive/Deathrun.md
