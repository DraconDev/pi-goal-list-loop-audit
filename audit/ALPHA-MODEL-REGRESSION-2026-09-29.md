# The alpha regression — screenshot audit, 2026-09-29 02:34

**Question**: 9 sessions stuck for sure — why? User constraint: 1–2 weeks ago
nothing was stuck, so a bad change landed since.

**Answer**: the bad change was the **auditor model flip to
`openrouter/stealth/space-bunny-alpha` ~Sep 24**, not a GLLA code change.
Alpha fails on both axes at once: it disapproves 2–3× more than the models
that worked, and it dies mid-audit 14.5% of the time (70 deaths on Sep 28
alone). Every stuck screenshot is alpha; every live auditor is not.

## Screenshot triage (9)

STUCK — auditor infra-death + retry-waiting (all alpha):

- capture-anime-girls: 5 reviews/3 disapproved, retry in 10m36s.
- freeport: 2 reviews, retry in 7m22s (errors 01:09, 01:26, both `'\x07'`).
- space-trucker (runs in `web/games`, not `wip/space-trucker`): 5 reviews,
  retry in 5m53s.

ALIVE — auditor running (all non-alpha):

- dracon-log: round 8 live (MiniMax, progress 0s), 7 reviews/5 disapproved.
- eve: just submitted after refusal + 17-task batch; auditor (spark) 1m38s in.
- football-forever: auditor (free) 1m21s in, 43 B report so far.
- darklord ×2 (dup): just submitted after refusal; auditor (spark) starting.

NORMAL — polis: round 1 disapproved 8m ago ([HIGH] trace capture), reworking.

## The regression

Auditor-model timeline from every `audits.jsonl` on the fleet:

- Sep 16–17: union-alpha + spark (269 audits on the 17th — flowing).
- Sep 18–23: spark → agnes → luna mix — flowing.
- Sep 24: alpha appears (30). Sep 25: 47. Sep 26: 107. Sep 27: 203.
  Sep 28: 219.

Zero alpha audits before Sep 24. `defaultModel` in pi settings is
`stealth/space-bunny-alpha` now; GLLA `auditorModel` is unset, so auditors
inherit the session model. Sessions moved to alpha ~Sep 24 — that is the
"bad change" window (code archaeology: detached machinery is from Aug 2,
Sep 25 v0.38.99 was a unification refactor — neither fits).

Two-phase failure, same model (Sep 24–29, mechanical checks excluded):

| model | approved | disapproved | dis rate | errors | err rate |
|---|---|---|---|---|---|
| alpha | 179 | 355 | **66%** | 92 | **14.5%** |
| agnes | 102 | 27 | 21% | 1 | 0.7% |
| spark | 19 | 10 | 34% | 1 | 3.3% |
| minimax | 13 | 0 | 0% | 0 | 0% |
| free | 6 | 10 | 62% | 0 | 0% |

- Phase 1 (Sep 24+): 66% disapprovals → rework treadmills (hellhunter 14
  rounds, junk-runner 9). Caveat: confounded by goal mix — alpha audits
  everything including the hardest goals, so the gap is suggestive, not
  clean.
- Phase 2 (Sep 28: 70 deaths; Sep 29: 9): instant mid-audit deaths
  (`error: '\x07'`, 15s–minutes in, after successful tool calls) → the
  retry-waiting parking in the screenshots. The error-rate gap (92 vs 1–2)
  is NOT confounded the same way — infra death does not depend on goal
  difficulty.

Strongest single exhibit: capture-anime-girls 23:49 + 00:19 — same goal,
free model, two substantive passing audits; 01:05 + 01:29 — alpha, two
instant deaths. Same worker machinery, different model.

## Why alpha dies (honesty-graded)

- PROVEN: endpoint alive (`PROBE_OK`, exit 0); max-thinking alive
  (`MAX_PROBE_OK`); no OOM-killer evidence in dmesg/journal; deaths occur
  mid-stream after working tool calls.
- NOT proven: the exact provider error — hidden by the `'\x07'` bug below.
- Leading hypothesis: the openrouter stealth endpoint fails under fleet
  concurrency (40+ simultaneous max-thinking alpha sessions; deaths track
  the busiest day). Alternative: an RPC-streaming edge with alpha.

## The `'\x07'` mechanism (GLLA-owned, blocks all future diagnosis)

`scripts/goal-auditor-worker.mjs` captures stderr last-chunk-wins:

```js
pi.stderr.on("data", (chunk) => {
  const text = String(chunk).trim();
  if (text) streamError = text.slice(-500);
});
```

When pi's final stderr flush is a lone BEL (OSC-notify terminator), it
overwrites the real message ("Agent stopped with error: …"). Fix: append
and keep the last 500 of the accumulation, strip OSC/BEL sequences. Then
the next death records its true cause.

## Recommended fixes (not implemented — analysis only)

1. Immediate relief: get audits off alpha — operator flips pi
   `defaultModel` back to agnes (0.7% err, 21% dis — best measured) or
   sets GLLA `auditorModel` explicitly. Sessions pick it up on reload.
2. GLLA code: fix the stderr capture above (small, testable).
3. Note: disapproval-rate gap is confounded (alpha audits the hardest
   goals); error-rate gap is conclusive.
