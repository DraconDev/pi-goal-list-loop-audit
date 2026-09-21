# Architecture: GLLA in 20 minutes

Read top to bottom. Each section names the files that own it; the
[promotion contract](PROMOTION-CONTRACT.md) covers the list→goal→archive
seam in full.

## 0. The one paragraph (1 min)

GLLA is mission control for long-running Pi work: it drafts objectives
with the user, runs them as audited goals, and verifies every completion
with a detached auditor that never shares the worker's session. Three
loops (`/goal`, `/list`, `/loop`) share one runtime, one ledger
(`.pi-glla/active.jsonl`), and one rule: **one active thing at a time**.

## 1. Entry and runtime (3 min)

- Entry: `extensions/loops/goal.ts` → `registerGoalRuntime`
  (`extensions/loops/goal-activation.ts`). All 17 Pi event
  registrations (`session_start`, `agent_end`, `tool_result`, …) live
  there; per-handler gates differ deliberately (worker vs subagent
  vs foreign vs host-successor planes).
- `session_start` is the lifecycle spine: 12 numbered stages from
  admission → root ownership → retention sweep → rebind reset →
  queue convergence → recovery prep → resume-consent → load barrier
  → arbitration → held-loop resume → continuation release →
  stored-claim release. Three closed stages are extracted helpers;
  the rest stay inline and source-pinned on purpose (see
  `audit/LIFECYCLE-MAP-*.md`).
- Shared state: `extensions/goal-state.ts` (`state`, `replaceState`)
  plus module-level runtime vars; cross-file sharing goes through
  `goal-runtime-globals.ts` (being retired slice by slice).

```
Pi events ──▶ registerGoalRuntime ──▶ state + ledger ──▶ UI (status line, banners, /goal status)
                                              │
                                              ▼
                                    detached auditor (separate process)
```

## 2. The three loops (5 min)

- **Loop 1 `/goal`** — one objective, drafted (interview + Confirm) or
  started, worked until the agent claims completion, then audited.
  States: `active → auditing → complete|aborted`, with `paused`
  overlays (decision, wait, error, blocked, standby).
- **Loop 2 `/list`** — a durable queue of short items. Items activate
  head-first into real goals (`policy: "list"`), complete → archive →
  auto-advance; aborts archive without advancing; nothing ever
  returns to the queue. Full contract: PROMOTION-CONTRACT.md.
- **Loop 3 `/loop`** — metric loops (`LoopState` in
  `goal-loop-forever.ts`: target, measure command, direction,
  iteration/max/plateau/stall accounting). No `Goal`, no audit
  verdicts — it ends on bounds, plateau, or `/loop stop`. Metricless
  spec loops end on bounds only.

One-active-thing: a live loop blocks list activation (loudly, with
the way out); completion cascades hand the surface to the next item.

## 3. The audit lifecycle (5 min)

```
complete_goal → claim → dispatch (tier) → worker (round 1 [+ challenge]) → shield → verdict → history → archive|park
```

- **Claim**: `complete_goal` persists a `PendingCompletion` (summaries,
  Left-out, finding groups, gates, optional full-audit request).
- **Dispatch** (`goal-loop-auditor-process.ts`): resolves the risk
  tier (full = audit + falsification round; light = single round),
  ledgers `audit_tier_decided`, spawns the worker with a hashed
  `request.json`.
- **Worker** (`scripts/goal-auditor-worker.mjs`): runs Pi `--no-session`
  against the brief, parses the final-line verdict (`<approved/>` /
  `<disapproved/>`), challenges approvals in a fresh session unless
  the tier says light. Fail-open: a failed challenge yields
  byte-identical round-1 output, recorded as `skipped:*`.
- **Parent**: validates attempt/hash/revision, enforces the audit-tool
  floor and the regression shield (contract items must be cited),
  records the `AuditVerdict` (tier, challenge outcome, duration),
  then archives on clean approval or parks with objections on
  disapproval. Spot-checks (default 1-in-10 light audits) calibrate
  the tiers; `/glla stats challenges` reports the flip rates.

## 4. Persistence (3 min)

- **Ledger** (`.pi-glla/active.jsonl`): append-only JSONL, ~340 event
  types, the forensic trail. Stats, timeline, and recovery all read it.
- **State**: snapshots persist the live goal/loop/list; `readState`
  reconciles with the ledger at boundaries.
- **Sidecars**: durable per-queue-item files; deleted before an item
  leaves the queue so half-moves can't resurrect work.
- **Archive** (`.pi-glla/archive/<id>.md`): exclusive-create,
  intent-journaled, human + machine record. Terminal and immutable.
- **Recovery**: crash-safe by construction — intent journals,
  archive fences, revision-bound verdicts, stale-refusal instead of
  silent overwrite. When in doubt it parks loudly, never proceeds
  quietly.

## 5. The test suite (3 min)

- ~260 files, must run **serialized** (`--parallel=1
  --max-concurrency=1`): parallel files trip Bun's nesting guard.
- `npm test` = fast set (minus the 12 slowest, see
  `tests/slow-files.mjs`); `npm run test:slow`, `test:changed`,
  `test:all` cover the rest. `release:check` = full suite + tsc +
  jiti repro + offline auditor-extension check + pack + smoke.
- Two test kinds: **behavioral** (MockPi harness drives real code)
  and **source pins** (`assert.match` on runtime source — order and
  presence guards for load-bearing structure). Pins are curated; if
  a refactor breaks one, the pin's *intent* decides whether the
  refactor or the pin is wrong.

## Where to go next

- Operating: `README.md`, `docs/SETTINGS.md`, `/goal timeline`.
- Deep design: `docs/DESIGN.md` (+ addenda), `docs/RELEASING.md`.
- History of why: `audit/*.md` — every incident and decision, dated.
