# Neonbreak screenshot-derived renderer fixture

Historical example adapted from Screenshot_20260916_224738.png, Screenshot_20260916_224741.png. Renderer inputs only, not newly executed external-project checks.

## Chat projection

## Done — Save revisions survive overlapping requests, reduced motion no longer accelerates the backdrop, and browser tests honor the chosen port.

— 1 audit

### Key Findings & Remediation
#### 1. Persistence
- **Save ordering** — Overlapping saves discarded successful revisions — same-account success now updates revision and confirmed snapshot before optimistic supersession, keeping account-generation isolation.
  - Test Results: Before fix: 1 pass / 2 fail. After fix: 3 pass / 0 fail.
- **Regression coverage** — Revisions 1/2/3 cover newest-state preservation, latest-snapshot rollback and late-response isolation.
#### 2. Routes and motion
- **Reduced motion** — A 4s override accelerated the 38s menu backdrop 9.5× — one near-zero iteration now preserves transitions instead of overriding them.
- **Meaningful browser assertion** — The geoscape animation test had no save or real target — it now waits for the settings PUT and Saved acknowledgment and checks the real threat-sweep pseudo-element across a new document.
#### 3. Test harness
- **Port configuration** — Eleven specs defaulted their own BASE to port 1453 and ignored NEONBREAK_PORT — shared resolution now preserves override precedence.
  - Test Results: Previously 39 connection failures; afterward 135 passed / 0 failed on port 1463 and standard 1453, no retries.

### Verification Summary
| Quality Gate | Scope | Status | Notes |
| --- | --- | --- | --- |
| Before-fix save probe | Historical overlapping saves | FAIL | 1 pass / 2 fail |
| After-fix save probe | Historical same regression | PASS | 3 pass / 0 fail |
| Unit tests | Historical 298 files | REPORTED | 2689 passed, 4 skipped (NB_URL-gated), 0 failed |
| Browser standard port | Historical 119 e2e + 16 pixel baselines | PASS | 135 passed / 0 failed |
| Browser alternate port | Historical same 135 tests, port 1463 | PASS | 135 passed / 0 failed |
| Spec audit | Historical spec checks | REPORTED | 350 pass / 10 partial / 0 fail |

### Next
- **Unresolved** — Four NB_URL-gated live-DOM tests remain skipped by design; 10 spec checks are partial.
- **Left out** — Deep-untouched card outcome, initiative, cover, squad-XP and renderer/debug areas were not re-surveyed and were not filed as findings.

• auditor approved (1 verdict).
• record: archive/Neonbreak.md

## Durable archive projection

## Done — auditor approved (1 verdict)

## Done: Historical Neonbreak completion example — Save revisions survive overlapping requests, reduced motion no longer accelerates the backdrop, and browser tests honor the chosen port.

— 1 audit

### Key Findings & Remediation
| Area | Finding | Evidence |
| --- | --- | --- |
| Persistence | **Save ordering** — Overlapping saves discarded successful revisions — same-account success now updates revision and confirmed snapshot before optimistic supersession, keeping account-generation isolation. | src/lib/game/persistence/neonbreakAccount.ts:425 · Tests: Before fix: 1 pass / 2 fail (/tmp/nb-race-before.log). After fix: 3 pass / 0 fail (/tmp/nb-race-after.log). |
| Persistence | **Regression coverage** — Revisions 1/2/3 cover newest-state preservation, latest-snapshot rollback and late-response isolation. | src/lib/game/persistence/neonbreakAccount.test.ts:65-105 |
| Routes and motion | **Reduced motion** — A 4s override accelerated the 38s menu backdrop 9.5× — one near-zero iteration now preserves transitions instead of overriding them. | src/routes/+layout.svelte:476 |
| Routes and motion | **Meaningful browser assertion** — The geoscape animation test had no save or real target — it now waits for the settings PUT and Saved acknowledgment and checks the real threat-sweep pseudo-element across a new document. | tests/e2e/animations-policy-app-wide.e2e.ts:5 |
| Test harness | **Port configuration** — Eleven specs defaulted their own BASE to port 1453 and ignored NEONBREAK_PORT — shared resolution now preserves override precedence (, commit d923419e). | tests/e2e/support/base-url.ts:1 · Tests: Previously 39 connection failures; afterward 135 passed / 0 failed on port 1463 and standard 1453, no retries. |
| Process | **Ledger** — Four fix entries were checked; the append-only guard preserved the original record while adding the verified findings (docs/audits/2026-09-16-project-audit.md). | — |

### Verification Summary
| Quality Gate | Command | Scope | Status | Notes |
| --- | --- | --- | --- | --- |
| Before-fix save probe | bun test src/lib/game/persistence/neonbreakAccount.test.ts | Historical overlapping saves | FAIL | 1 pass / 2 fail |
| After-fix save probe | — | Historical same regression | PASS | 3 pass / 0 fail |
| Unit tests | timeout 180 bun run test | Historical 298 files | REPORTED | 2689 passed, 4 skipped (NB_URL-gated), 0 failed |
| Browser standard port | — | Historical 119 e2e + 16 pixel baselines | PASS | 135 passed / 0 failed |
| Browser alternate port | — | Historical same 135 tests, port 1463 | PASS | 135 passed / 0 failed |
| Spec audit | — | Historical spec checks | REPORTED | 350 pass / 10 partial / 0 fail |
| Audit | — | auditor verdict | APPROVED ×1 | audit: auditor approved (1 verdict) |

### Next
- **Unresolved** — Four NB_URL-gated live-DOM tests remain skipped by design; 10 spec checks are partial.

• auditor approved.
• audit: auditor approved (1 verdict).
• record: archive/Neonbreak.md
