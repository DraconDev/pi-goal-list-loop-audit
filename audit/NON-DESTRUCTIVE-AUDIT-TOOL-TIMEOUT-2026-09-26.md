# Non-destructive audit tool timeout — why audits were not landing

**Date**: 2026-09-26 · **Scope**: `extensions/goal-loop-auditor-process.ts`,
`extensions/goal-loop-auditor.ts`, `extensions/goal-loop-display.ts`,
`scripts/goal-auditor-worker.mjs`, `tests/auditor-stall-watchdog.test.ts`

## The report

Audits across the fleet were not landing, including this repo's. Measured over
all 612 audit results on disk (read-only across every repo):

| window | n | failure rate |
|---|---|---|
| all time | 612 | 15% — median **102s**, p90 605s, p99 2229s |
| last 48h | 74 | **22%** |

The "slow audits" framing was wrong at the population level: the median audit
finishes in under two minutes, and 90% finish inside ten. The tail is a
*failure* tail, not a slow tail.

Last-48h failures, by class:

- **6× `Auditor stalled — tool bash exceeded its 5m/10m timeout`** ← dominant
- 6× `\x07` — a one-day provider crash artifact, all on 2026-09-25
- 2× `Auditor aborted.`
- 2× provider errors (429 rate limit, empty response)

A separate historical class — 60 attempts on 2026-09-14…18 dying on
`Model "agnes/agnes-3.0-flash" not found` — was already resolved and is not
part of this change.

## Root cause

`DEFAULT_AUDITOR_TOOL_TIMEOUT_MS` is 5 minutes. When the auditor's `bash`
verification step (`npm test`, `tsc`) runs past that budget, the watchdog
terminated the **whole worker** and returned a `timeout` — discarding every
tool call the audit had already completed. One recorded attempt died at 23
minutes holding **64 completed tool calls**. The goal then re-audited from
zero, hit the same slow step on the same loaded host, and blew the budget
again. That is what "audits not landing" looked like from the outside.

The trigger is host pressure, which this repo does not own: load 48–95 across
16 cores, 0 free RAM, 30 GB swapped, memory PSI `full avg10=9.2%`, ~94 MB/s
swap-out, 749 processes across 21–27 logins. This repo's own prior claim
already recorded *"host load 106 on 16 cores — load flakes"*.

A second, independent defect surfaced while testing: `progress.json` is
**telemetry** — the verdict arrives in `result.json` — but a torn read of it
failed the entire attempt. The pinned test
`progress: a live auditor outlives the legacy wall metadata` failed **3 of 6
runs on the unmodified tree**, because its fake worker republishes
`progress.json` non-atomically every 20 ms while the parent polls every 10 ms.
Losing a healthy audit to a partial telemetry read is the same failure class.

## The fix

### 1. Cancel the tool, not the audit

The worker now owns the decision. When a tool blows its budget it records the
cancellation, sends the RPC `abort` to cancel the in-flight turn, and resumes
with a brief that carries the original prompt, the list of tool calls already
completed, and an explicit statement that the cancelled call produced no
result. The expensive part of an audit — the accumulated evidence — survives.

The continuation brief follows the existing challenge-round precedent
(`buildChallengePrompt`): the default audit spawns with `--no-session`, so
there is no persisted session to resume and the brief must carry its context.

One cancellation per attempt. A second one finishes the attempt failed rather
than granting an unbounded chain of retries.

### 2. The parent holds its hard kill

The parent's per-tool watchdog and the worker's own timer expire at the same
instant, so the parent was killing the worker just as it tried to continue.
It now records the stall evidence once and waits out
`TOOL_CANCEL_GRACE_MS` (60s — abort + republish + re-prompt is seconds) before
falling back to the hard kill. A genuinely wedged tool still fails fast, one
grace window later; `toolCancelGraceMs` is a runtime knob so tests do not have
to wait 60s.

### 3. The approval guard (audit integrity)

A cancelled tool produced **no result**, so an approval from such an attempt
rests on evidence the auditor never saw. The parent refuses it and fails the
attempt as retryable `timeout` infrastructure, carrying the tool-timeout
evidence.

It is deliberately **not** laundered into a disapproval: the goal did not
regress, the audit simply cannot certify it, and a disapproval would send the
agent into pointless rework for a load problem. The retry ladder re-audits,
and a later attempt that completes its verification can approve.

### 4. Torn telemetry no longer kills an audit

`PROGRESS_READ_TOLERANCE_MS` (30s) makes an unreadable `progress.json`
time-bounded rather than count-bounded — a writer republishing every few ms
under load can be caught mid-write many times in a row, and each of those is
the same transient condition. A genuinely corrupt file still fails inside the
window, so real corruption is never masked, and the other watchdogs keep
bounding the attempt meanwhile. The final pre-verdict snapshot is best-effort:
the verdict is already durable and validated, so a torn snapshot is skipped
rather than discarding a good result.

## Verification

- `npm test` → **2396 pass / 2 skip / 0 fail** across 282 files. The prior
  baseline on this tree was 2394 pass / **2 fail** (host-load flakes); both
  are now green.
- `tsc --noEmit` clean.
- The previously flaky `outlives the legacy wall metadata` test: **3/6 → 10/10**.
- New tests in `tests/auditor-stall-watchdog.test.ts`:
  - an over-budget tool is not fatal — the worker cancels, resumes, and its
    result still lands;
  - an approving verdict from a verification-incomplete attempt is refused,
    not applied and not laundered into a disapproval;
  - a genuinely wedged tool still fails fast once the grace expires.
- The first two **fail on the unmodified tree** and pass with the change, so
  they pin the fix rather than the status quo. The third passes both ways by
  design — it guards the preserved fail-fast path against regressing into an
  unbounded lease.

## Known limits

- The dominant **trigger** is host capacity, which GLLA does not own. This fix
  stops a slow step from destroying completed work; it cannot make a starved
  host fast. On a host this loaded, some attempts will still fail and retry.
- A session quit mid-audit still cancels the attempt
  (`session_shutdown:quit` — it killed this repo's `audit-muixkwqx` at 21:57).
  That is upstream session lifecycle, not an audit-engine defect; the recovery
  path does restart the audit on the next session.
- Two orphaned `running`-phase job dirs remain as debris in `eve`
  (`audit-mugvyizl`, 35.6h) and `db-gateway` (`audit-mugsy75v`, 35.7h), both
  with dead workers. Their goals have since moved on, so they are inert; the
  retention sweep reaps them.
