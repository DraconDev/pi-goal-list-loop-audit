# Audit: dynamic basic draft + paused-owner honesty (2026-10-01)

> Scope: the 2026-10-01 change set — `seedPlusContextSufficient` gate
> (extensions/start-context.ts), `cmdSet` wiring (extensions/goal-commands.ts),
> dynamic-length grill bullet (extensions/goal-loop-core.ts), honest paused
> owner (extensions/goal-loop-display.ts), respec doc
> (audit/TASK-AUDIT-CYCLE-RESPEC-2026-10-01.md), and tests
> (tests/seed-sufficiency.test.ts, tests/paused-owner-honesty.test.ts).
> Method: adversarial re-review + targeted probes + re-run of every affected
> suite. Verdict: SHIP — two findings, both fixed in this audit.

## F1 (fixed): path anchor fired on prose connectors — FIXED

`countDetailAnchors` counted "before/after" as a file path (single slash +
4-char tail). One noise class alone cannot activate, but combined with a
second class + length (or related context) it could tip a borderline seed
into direct activation.

Fix: negative lookahead refusing connector prefixes
(before/after/either/neither/up/down/left/right/and/or/on/off/per/versus/vs,
case-insensitive). Strictly fail-safer: fewer false anchors can only route
more seeds to the interview (today's behavior). Pinned by a new durable
assertion in tests/seed-sufficiency.test.ts.

## F2 (fixed): respec ignored existing audit/spec loops — FIXED

The respec positioned `task-audit` only against metric loops, omitting
`/loop audit` (v0.29.0 findings-count loop), `/loop respec` + metricless
spec loops (verdict-free iteration), and the existing `/loop plan` forced
draft. Added §2.1 prior-art positioning. Also verified the proposed
`task-audit` verb collides with no existing `/loop` subcommand and today's
unknown-verb fallthrough (natural-language draft) makes the new branch
purely additive.

## Accepted (no change)

- **A1 — 1-reply interview floor retained.** "Dynamic length" varies the
  interview with missing info, but `draftProposalBlock` still requires one
  user reply before propose. Deliberate: the floor is the anti-contract-dump
  trust mechanism, not a length quota. Bypassing it was never requested;
  rich seeds skip the interview via the gate instead.
- **A2 — heuristic misses fail toward drafting.** Comma-list compounds
  ("Fix A, fix B"), anchor-poor declarative seeds, and synonym-mismatched
  context (timeout vs time) all draft. Safe direction: worst case is one
  short interview, identical to today's behavior.
- **A3 — owner gate duplicates liveness logic.** `hasLiveMainModelRecovery`
  mirrors `mainModelRecoveryActive()` (retryAt || pendingModelSwitch) plus
  `manualResumeRequired`. Reuse would couple display to goal-recovery; the
  local predicate is display-only (unexported, zero behavioral coupling —
  verified: `blocked-pause-autoclear` uses its own state check, and
  `pausedRecoveryOwner` is not exported). The manual-hold disjunct pairs
  exactly with the card's manual-hold banner.
- **A4 — cmdSet wiring pin is source-order-based.** Brittle to refactors by
  nature, but repo-precedented (draft-staging pins) and no test currently
  drives slash handlers behaviorally; building that harness for one branch
  is disproportionate.

## Liveness completeness (highest-risk check)

Enumerated every durable `mainModelRecovery` shape against the owner gate:

| State | Signals | Gate | Agrees with codebase predicate? |
|---|---|---|---|
| Parked retry wait | retryAt | live | yes (`mainModelRecoveryActive`) |
| Switch in flight | pendingModelSwitch (+retryAt) | live | yes |
| Manual hold (`holdMainModelRecovery`) | manualResumeRequired, timers cleared | live | n/a — pairs with manual-hold banner, goal paused blocked |
| Failback serving (`primaryProbeAt` only) | none of the three | remnant | yes — predicate also false; goal active ("work may continue normally"), owner line not rendered; if user-paused, "manual resume" is the honest owner |
| Post-setModel test turn | both cleared transiently | remnant | yes — goal active, owner not rendered |
| Exhausted refs (fail closed) | none | remnant | yes — no automatic action remains; pause-kind owner correct |
| Corrupt retryAt (unparseable) | NaN | remnant | yes — `pausedNextTransition` also requires finite retryAt, so transition + owner degrade together |

No live state is mislabeled; no opposite-direction mislabel introduced.

## Blast-radius proof

- `seedPlusContextSufficient` has exactly one production caller: the
  `cmdSet` drafting branch. `/list` routing (`routeListText`) untouched;
  bare `/goal`, `/goal plan`, `/goal start` paths untouched.
- Grill change is append-only; all pre-existing pinned phrasing intact.
- Display change is confined to `pausedRecoveryOwner` (paused cards +
  status line); no state, prompt, or ledger writes.

## Verification evidence (this session)

- 7-case adversarial probe (`/tmp/seed-gate-probe.ts`, throwaway):
  before/after noise, comma compounds, anchor-poor declarative seed,
  anchored variant, thin+related context, explanation request, bare ack —
  all pass (re-ran mentally post-F1: before/after now 0 anchors, still
  drafts; durable assertion covers it).
- Affected suites re-run after F1: 216 pass / 0 fail across
  seed-sufficiency, paused-owner-honesty, start-context, goal-route,
  display, release-contract, settings-menu-complete.
- `tsc --noEmit`: clean (exit 0).
- Full fast suite on the pre-F1 tree: 2696 pass / 0 fail / 1 env-gated
  skip (exit 0). F1 touched one regex + one test line inside the
  single-caller gate; the 216-test re-run covers its full blast radius,
  so the full suite was not re-run for F1.
