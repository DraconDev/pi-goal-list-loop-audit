# Results audit: what actually limits outcomes (2026-09-22)

Goal `2026092…results`: audit the project under the plan-then-grind
strategy (not ZCode's shape); find improvements for better results.
Method: ledger forensics across 9+ projects (wip games + strategy).

## Numbers

Terminal success by creation path (open goals excluded):
- user/goal (directed, no draft): 18/20 — 90%
- list-cascade/list: 29/36 — 81%
- draft-autoaccepted/goal: 5/7 — 71% (n=7; drafted goals are the
  hardest grinds — selection bias, not evidence drafts hurt)

Audit rounds: list 50% disapproved (31/62, 1.8 rounds/goal),
drafted 50% (5/10), user/goal 34% (10/29). Every second claim needs a
repair cycle.

Top grind-killers (pause events, 7d window):
1. `auditor retry: no auditor model` — 330x, 6 projects, last Sep 18
2. `Exhausted auditor chain: agnes-3.0-flash. pi exited before
   agent_settled` — 216x, 13 projects, last Sep 20
3. main-model recovery retrying (provider transients) — ~200x combined
4. `auditor disapproved` — 47x + 12x provider-retry

## Reading

The shape is fine; the VERIFIER is the bottleneck. 546 pause events —
more than all other causes combined — are the auditor failing to RUN
(model unresolvable or worker spawn dying), not the auditor judging.
Half of all audit rounds then disapprove. Under plan-then-grind, the
grind is only as good as the verification at its end, and ours is
flaky at the infrastructure layer.

Confound: fleet projects run mixed plugin versions (npm was 0.38.71
until Sep 21; one global install at 0.36.1). Attributing all 546 to
current code would overclaim — but Sep 18–20 recency means current
code is implicated too.

## Ranked improvements

1. **Auditor spawn reliability** (biggest lever): diagnose "pi exited
   before agent_settled" in the detached worker + harden "no auditor
   model" resolution (surfacing WHICH check failed: unset ref vs
   registry miss vs no auth — the resolver knows, the pause doesn't
   say).
2. **50% disapproval rate**: sample disapproved rounds + objections;
   decide strictness-vs-sloppy-claims. If claims are sloppy,
   pre-claim self-check guidance; if strict, recalibrate.
3. **Nothing structural**: no phases, no armies, no longer-goal
   machinery needed. Draft-first + grind is vindicated by the data
   (90%/81% terminal success where the verifier runs).

## Disposition

Audit only, no code. Item (1) is the commissioned-shaped follow-up.
