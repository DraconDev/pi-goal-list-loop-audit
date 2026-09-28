# Stuck at the last part — cross-project research, 2026-09-28

**Question**: why are many GLLA projects unfinished but stuck at the last part?
**Method**: inspected live `.pi-glla` state in all 35 GLLA-enabled projects
(18 top-level under `/home/dracon/Dev`, 17 game projects under
`dracon-platform/web/games/{wip,released}`), plus audit ledgers, worker
progress files, and process state. All parents and workers were alive at
observation time; nothing here is a dead-session artifact.

## TL;DR

"Stuck at the last part" = stuck in the **completion-audit phase**. Work is
done; the audit gate never opens. Four independent causes stack, all
GLLA-owned:

1. **The v0.38.103 hard cap is wired only into the inline settlement path,
   which the field never takes.** Every real audit settles through the
   detached driver (`retryStoredCompletionAudit`), which has no hard cap —
   so aggressive mode (the default) converts every soft-cap hit into TODOs
   and grinds forever (hellhunter 12, junk-runner 9 comparable rounds,
   zero cap pauses). Fixed in v0.38.107 (this repo).
2. **The deterministic pre-audit runs dev servers as pass/fail checks**
   (`bun run dev`, `npm run e2e`) with 1200 s timeouts that can never pass.
   junk-runner burned ~9 × 20 min on this alone.
3. **The host is at load ~125**, which slows every check, stalls heartbeats,
   and appears to trigger worker restarts (worker age ≪ attempt age).
4. **Infrastructure failures are recorded as `'\x07'`** (one BEL char) —
   the real error is lost, so crashes look like instant auditor gives-ups.

Plus two durability defects found along the way: malformed `audits.jsonl`
lines in 2 projects, and an orphaned `bun test` burning CPU for 25 h.

## Current stuck inventory (2026-09-28 ~18:10 UTC)

In `auditing` with a live worker (wall time 1–2 h, still running):

| project | attempt started | worker age | note |
|---|---|---|---|
| endless-td | 16:13 | 53 min | worker restarted after ~1 h |
| pi-goal-list-loop-audit | 16:18 | 49 min | prior attempt errored ("Agent stopped") |
| monster-minecraft | 16:38 | 21 min | 3 pre-audit `e2e`/`perf` failures first |
| freeport | 16:38 | 10 min | fresh worker |
| eve | 16:52 | 14 min | worker verifying, close to verdict |
| come-get-me | 17:02 | 4 min | fresh; see §6 |
| polis | 16:17 | 3 min | prior attempt errored (`'\x07'`) |

In `active` but blocked on audit rework (completion claimed, disapproved):

| project | audits on goal | last verdict | idle since |
|---|---|---|---|
| hellhunter | 14 (round 13) | disapproved 17:03 | reworking |
| junk-runner | 18 (round 9) | disapproved 11:08 | reworking (goal file touched 17:00) |
| dracon-log | 5 | disapproved 14:24 | reworking (state fresh 18:10) |
| capture-anime-girls | 1 | disapproved 14:49 | reworking |

Everything else (24 projects) has no active goal — completed and archived.

## 1. The hard cap never fires on the detached path (primary cause — FIXED v0.38.107)

`audit/ENDLESS-AUDIT-CONVERGENCE-2026-09-27.md` diagnosed the non-terminating
auditor and shipped CHANGE SCOPE + WHAT APPROVED MEANS + REWORK ROUND, and
v0.38.103 added the hard ceiling (`auditCapHard`, default 8, binds every
mode). The field test ("a goal that was 8/8 should stop climbing") **failed**
anyway: hellhunter climbed to round 13 and junk-runner to round 9.

Root cause, verified in source: the v0.38.103 ceiling was added only to the
*inline* settlement inside `complete_goal` (`extensions/loops/goal-tools.ts`).
The field never settles inline — `complete_goal` returns AUDIT PENDING and
real verdicts land minutes/hours later through the detached driver
(`retryStoredCompletionAudit` in `extensions/loops/goal-auditor-hooks.ts`),
which had no hard-cap check at all. There the soft cap converts to TODOs
under aggressive mode (the default: `aggressiveMode !== false`), and the
no-progress stop only fires on *identical* objections — so a fresh-objection
treadmill loops forever by construction. Ledger evidence: zero cap-pause
events on either goal; v0.38.107 wires the identical comparable-streak
ceiling into the detached settlement, with a behavioral test driving it via
`resume_goal` re-fire (`tests/audit-convergence-breaker.test.ts`).

What the cap does NOT fix: the treadmill still burns up to 8 rounds × (1–2 h
audit + rework) before the ceiling fires. The per-round waste (§2–§3) is the
next layer.

The pattern per round, from the reports themselves:

- **hellhunter round 12 → 13**: round 12 blocked on false roadmap figures +
  a `bisection` claim. The worker fixed all three with real derivations; the
  round-13 auditor confirms "all three now closed" and "no defect found
  inside the changed paths" — then disapproves on a *new* objection (the
  round's work is uncommitted, 2 files untracked). Legitimate, but it is the
  same shape: priors closed, exactly one new narrow block, no terminal round.
- **junk-runner rounds 3 → 9**: economics-gate assertion quantity, then
  README-vs-goal disagreement, then playwright `webServer` flip-flopping
  (`bun run dev` ↔ artifact server) between rounds — the worker oscillates
  and the auditor re-opens the question each time.

The doc's own known limit stands: **no circuit breaker**. A goal whose
contract is unsatisfiable-as-audit loops forever. The recommended backstop
(bounded rounds → human decision: accept-with-debt vs continue) is still
not implemented.

Scale of the pattern (parseable `audits.jsonl` files):

- dracon-platform: 713 audits, 141 disapproved, 22 goals with ≥3 rounds, max 15
- pi-goal-list-loop-audit: 308 audits, 70 disapproved, max 6 rounds
- eve: 125 audits, 36 disapproved, max 7 rounds
- dracon-utilities: 30 audits, **17 disapproved** (>50%)
- monster-minecraft: 15 audits, 10 disapproved — all 3 goals multi-round

## 2. Pre-audit runs servers as checks (primary cause, mechanical)

The deterministic pre-audit executes contract commands with a 1200 s kill
timeout and no readiness detection. For server commands this can never pass:

- junk-runner: **9 consecutive** `verdict=error` entries, all
  `mechanical gate inconclusive (timeout): bun run dev`. The evidence shows
  vite ready in ~1–2.6 s, then SIGTERM at 647–1200 s. Each burned 10–20 min
  and the goal alternates error → disapproved every round.
- monster-minecraft: `npm run e2e` exit 1, `npm run perf` exit 1, then
  `npm run e2e` killed after 1200 s — the audit phase cannot proceed past
  the mechanical gate.

A dev server is not a check. Until the gate is readiness-aware (ready-pattern
+ bounded post-ready window) or server commands are excluded from mechanical
gating, any contract naming `dev`/`e2e`-with-server loops forever.

## 3. Host overload slows everything and restarts workers (multiplier)

- Load average **121–125** sustained (matches the 112.26 in the 09-27 doc).
- 40+ live `pi` sessions plus 7 concurrent auditor children
  (`--model openrouter/stealth/space-bunny-alpha --thinking max`), each
  itself spawning test suites and dev servers.
- An **orphaned `bun test`** (PID 823243, cwd this repo, PPID = systemd user
  manager since its parent died) has run **1 day 1.7 h / 1019 CPU-min** with
  `--parallel=1`. Nothing reaps orphaned process trees, so it burns CPU
  indefinitely and slows the checks that gate every other project.

Observed consequences:

- Worker age ≪ attempt age everywhere (e.g. glla: attempt 108 min old,
  worker 49 min; eve: 74 min vs 14 min), with workers clustering to start
  ~17:17–18:00 — consistent with stall-watchdog/eager-retry restarts under
  load. Each restart discards in-flight auditor progress.
- Durable `lastActivityAt` lags worker `progress.json` by ~1 h while
  `active.jsonl` itself is written every minute — the UI reads "no progress
  60m" for audits that are actually working. Stuck appearance, partly real
  (slow), partly stale heartbeat.

## 4. `'\x07'` errors hide infrastructure failures (observability)

Three `verdict=error` entries carry `error: '\x07'` (single BEL char) with a
one-sentence report — hellhunter ×2 (15:32, 16:25), polis ×1 (15:03). Compare
the glla 14:59 error, which kept the full string:
`'\x1b]777;notify;Pi - Agent stopped with error;…'`. The BEL is the
terminator of an OSC notify sequence: error extraction sliced the message and
kept the terminator. So worker crashes (likely load/quota kills) are recorded
as content-free errors, each costing a full round-trip with no diagnosis.

A sibling: dracon-log 14:10 `error: 'Auditor attempted unsupported tool:
write'` — the auditor tried to write, was refused, and the round died as an
error instead of a verdict.

## 5. Ledger corruption (durability)

- `browser-extensions-shared/.pi-glla/audits.jsonl:289-290`: a bare blank
  line, then two JSON objects concatenated on one line (second object is a
  *different schema*: `goalId/status/completedAt/summary` — a completion
  record appended into the audit ledger without a newline).
- `db-gateway/.pi-glla/audits.jsonl:18`: truncated/malformed JSON mid-line.

Both indicate non-atomic appends (concurrent writers or crash mid-write).
Effect today: tooling that parses the ledger throws; history-based stats and
rework framing lose entries.

## 6. Minor: come-get-me shares state across two checkouts

`wip/come-get-me` and `released/come-get-me` (both real directories, not
symlinks) contain the **same goal id and same audit attempt**; the live
worker runs against `released/`. If both checkouts ever have live parents,
both would settle the same attempt. Worth a uniqueness guard or a documented
"one checkout owns the goal" rule.

## What would unstick the fleet (not implemented — research only)

1. **DONE v0.38.107: hard cap wired into the detached settlement path.**
   Infinity is now bounded at 8 comparable rounds everywhere. Remaining:
   sessions must reload to pick it up (long-running pi processes execute
   the extension source loaded at boot). NOTE to operator: restart loop
   sessions or wait for natural session churn; already-running treadmills
   keep old code until reload.
2. **Readiness-aware mechanical gate**: never run a server command as a
   bounded check; ready-pattern + short post-ready window, or exclude
   `dev`/server commands from pre-audit.
3. **Orphan reaping + audit concurrency cap**: kill process trees with the
   worker; back off new audits when load is extreme. Operator action now:
   kill PID 823243 (orphaned suite, 25 h, reparented to systemd).
4. **Fix error extraction** so OSC/BEL sequences yield the human message;
   record infra-error distinctly from disapproval so it does not consume a
   rework round.
5. **Atomic ledger appends** (single `O_APPEND` write / lock) for
   `audits.jsonl`.
6. **Heartbeat honesty**: if the parent cannot poll (starved), say so;
   do not let the UI show "no progress 60m" for a live worker.

## Raw pointers

- Audit chains: `wip/junk-runner/.pi-glla/audits.jsonl`
  (goal `20260928024612-dt6fke`), `wip/hellhunter/.pi-glla/audits.jsonl`
  (goal `20260924093212-r35a6i`)
- Live worker evidence: `*/.pi-glla/audit-jobs/<latest>/progress.json`
- Prior art: `audit/ENDLESS-AUDIT-CONVERGENCE-2026-09-27.md`,
  `audit/DETACHED-AUDIT-LIFECYCLE-2026-09-25.md`
