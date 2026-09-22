# Long tasks: ZCode/teamwork research + GLLA options (2026-09-22)

Goal `2026092…longer`: research carefully how the long-running
workflow tools work; longer tasks are a pro if reachable.

## What is going on (externals)

**ZCode workflows** (Z.ai, GLM-backed, agent-first IDE): the central
structure for long work is the **Goal** (`/goal`) — user states an
outcome, the agent plans, executes, verifies across steps. The
ecosystem's hard-won pattern is NOT "one big autonomous run":

- **zcode-supervisor**: planner (strong model) plans + scopes allowed
  files + audits; worker gets a NARROW packet; planner keeps final
  acceptance. Measured: Codex worker 20/20 at 1.9M tokens vs ZCode
  18/20 at 9.7M on identical packets. Narrow packets + strong reviewer
  beats autonomy on cost AND correctness.
- **ZOdyssey**: pipeline prime→triage→consult→plan→review→execute→
  verify→final-wave with **code-enforced gates** (hooks, not prompts):
  plan-review gate, executor scope isolation (declared file list),
  parallel dispatch caps. "Don't trust the model at the load-bearing
  invariant." Portable to any hook harness.
- **Antigravity `/teamwork-preview`** (prior note 2026-09-04):
  milestone decomposition, per-milestone Critic/Challenger/Auditor
  gates, artifact (not context) handoffs, self-succession between
  milestones, exclusive file ownership. Costs $900+/task at API prices
  — correct for Google's vertically integrated billing, доказано wrong
  for user-metered pi sessions.

Common shape: **phase → gate → phase → gate**, reviewers stronger than
workers, coordination through files, gates enforced by code.

## GLLA as-is (verified)

- Length bounds: recovery auto-retries to a 24h horizon; loops default
  50 iters (0 = unbounded); goals have NO time bound — they end at
  claim→audit→archive.
- The true length limiter is structural, not temporal: ONE contract
  audited ONCE at the end. No mid-course verification, no milestones,
  no phase gates. Long goals degrade (context) with no checkpoint that
  says "phase 2 of 5 verified".
- The phased machinery already exists in pieces: list items activate as
  individually-audited goals (per-phase audit!), compactor brief +
  resync is self-succession-lite, zombie watchdog is the stuck cron,
  detached auditor is the code-enforced gate, sidecars are bounded
  packets.

## Options, ranked (longer tasks = pro)

1. **Phase-gated lists (parent goal over audited phases)** — keep the
   one-contract-per-phase audit exactly as-is; add the parent narrative
   (plan artifact: phases, gates, position) and phase-position
   monitoring. No auditor redesign. This is the ZCode-Goal shape with
   GLLA's cheap-brief economics. RECOMMENDED.
2. **Code-enforced phase gates** (ZOdyssey delta) — plan-review gate +
   scope isolation per phase via hooks. GLLA's auditor is already a
   code gate at the END; the new bit is gates BETWEEN phases. Smallest
   version: a phase cannot start while the previous phase's audit is
   open. Follows naturally from (1).
3. **Pitfall registry** (deferred since 2026-09-04) — still the cheapest
   cross-goal compounding; orthogonal to length.
4. **NOT recommended**: multi-agent armies, tournament re-synthesis,
   full-state handoff dumps — import Teamwork's spend, not its shape.

## Disposition

Research only, no code. Owner verdict 2026-09-22: do NOT cargo-cult
the phase shape — GLLA's rigor-over-dynamism is the product, and more
gates mean more stops, the opposite of the dynamism admired in ZCode.
Longer goals already work when the provider does. The dynamism gap
worth closing instead: assisted re-planning at park points (concrete
alternative routes in the pause, no auto-spend). Not commissioned.
