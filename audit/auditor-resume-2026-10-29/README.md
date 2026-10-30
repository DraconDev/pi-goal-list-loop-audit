# Auditor resume, not restart — field report 2026-10-29

This records why the last completion claim never received a verdict and the
decision taken to fix it: resume the auditor's own pi session across a
provider failure instead of restarting the audit cold.

## The reported symptom

`note.md` asked: *"if model runs out midway do we redo the whole audit?"* and
*"we keep failing the last audit perhaps due to auditor switching"*.
Screenshot `Screenshot_20261029_165300.png` shows the answer GLLA actually
gave at the time:

    GOAL · auditing · RUNNING · 8/8 tasks · age 5h 24m · 450k tok
      provider error
      64 calls finished · activity 0s ago
      audit elapsed 1h 46m

immediately after a sequence of infrastructure notices:

    Detached auditor failed on openai-codex/gpt-6-luna (setting) — retrying
    with minimax/MiniMax-M3.1-Flash (fallback-pin). This is infrastructure,
    not a verdict.
    Detached auditor failed on minimax/MiniMax-M3.1-Flash (fallback-pin) —
    retrying with amr/deepseek-v4.1-flash (session-fallback). This is
    infrastructure, not a verdict.

## Observed journal evidence (`.pi-glla/active.jsonl`, this repo)

Candidate exhaustion on 2026-10-29, all `failureClass: "provider"`:

| at | from | to |
| --- | --- | --- |
| 18:02:56.278Z | openai-codex/gpt-6-luna (setting) | minimax/MiniMax-M3.1-Flash (fallback-pin) |
| 18:03:06.183Z | minimax/MiniMax-M3.1-Flash (fallback-pin) | amr/deepseek-v4.1-flash (session-fallback) |
| 18:04:27.589Z | amr/deepseek-v4.1-flash (session-fallback) | *(none)* — `503: workspace_billing_scope_unavailable` |
| 18:04:27.590Z | `auditor_fallback_exhausted` | — |
| 18:19:27.645Z | retry: gpt-6-luna again | → MiniMax → deepseek |
| 22:39:33.567Z | `auditor_fallback_exhausted` | `failureClass: "no-verdict"`, display `no auditor model` |

**Observed**: every configured auditor candidate failed on a provider error.
The claim was never rejected on merit — no verdict was produced at all. GLLA
behaved correctly here: the stored completion claim stayed durable and the
notices explicitly said "this is infrastructure, not a verdict".

**Inferred, not established**: which provider or account state caused the
individual failures beyond the recorded `503 workspace_billing_scope_unavailable`
and generic `provider error` text. No inference is made about account quota.

## The GLLA-owned cause

A mid-audit failure does not just switch models — it discards the audit.

1. Every auditor spawn uses `--no-session` unless `auditorInspection` is on,
   and that setting **defaults to `false`**
   (`extensions/goal-settings.ts:468`, spawn at
   `scripts/goal-auditor-worker.mjs:836`). Nothing persists the auditor's pi
   session by default, so there is no session to resume even in principle.
2. Each retry allocates a **new** `attemptId` and cancels the previous worker
   (`extensions/loops/goal-auditor-hooks.ts:731-736`, `:802-804`).
3. No partial result is carried forward. A search for
   `priorReport|partialFindings|carryForward|resumeFrom` across
   `goal-auditor-hooks.ts` returns **zero matches**.

Consequence: the 64 tool calls and 1h 46m of work shown in the screenshot are
thrown away on every switch, and the next attempt starts cold. On a large goal
this makes a successful verdict much less likely, which matches the reported
"we keep failing the last audit". The restart is deterministic, not a race.

The capability to fix this already exists but is unused by default: `inspection`
(`extensions/goal-loop-auditor-process.ts:1475-1477`) spawns
`--session <jobDir>/session.jsonl` instead of `--no-session`, and the worker
already honours it (`scripts/goal-auditor-worker.mjs:831-836`, including round 2
reusing the same spec).

## Why this is GLLA-owned

The classification, fallback walk, attempt rotation and `--no-session` default
are all GLLA code. The upstream provider failures are external and are *not*
part of the fix: the defect is that GLLA responds to an external failure by
discarding its own completed work. No Pi core, provider or external plugin
change is required.

## Decision: resume the session, and when to refuse

Chosen: spawn auditors with a durable `--session <jobDir>/session.jsonl` by
default and, on retry, resume that same session with a short continuation
brief. The auditor keeps its own real transcript — the files it read, the
commands it ran, the objections it had already formed — so a model switch no
longer restarts 64 tool calls of reasoning. The alternative (start fresh and
seed a summary of prior findings) was rejected: a summary is lossy and the
retry would have to trust evidence it did not gather itself.

Resume is deliberately **not** universal. It applies only to `provider`,
`transport` and `rate-limit` failures, where the session is healthy and was
merely cut off. A `context-exhausted` or compaction-failed audit restarts cold:
its transcript is already over budget, so resuming reproduces the same failure
and spends the retry budget to arrive at the same wall.

Resume is refused, and the audit restarts cold, when anything that defines the
audit has changed: the goal revision, the claim identity (replaced or
cancelled), the audit tier, or an explicit user cancel. Resuming across any of
those would judge a different question with the old work.

### A resume that cannot survive cleanup is not a resume

The session file lives in the attempt's job directory, and a failed attempt is
currently deleted whenever it produced no result — explicitly so kill-and-
restart loops do not accumulate empty dirs
(`extensions/goal-loop-auditor-process.ts:2920-2926`). Enabling durable
sessions alone would therefore persist a file that the very next failure path
removes, leaving nothing to resume. The retained session must survive that
cleanup for an attempt that is still resumable, while resultless directories
must still not accumulate.

### Verdict integrity is unchanged

A resumed audit is still one logical attempt and is judged normally. Verdicts
remain attempt-gated and revision-validated, a stale or mismatched attempt can
never apply its result, full-tier falsification still runs, and in-flight
isolation is preserved. What changes is only that the work is not thrown away.
Resume lineage (priorAttemptId, from/to model, resume count, revision, tier) is
recorded in the ledger and in verdict provenance, so an operator can tell a
resumed audit from a first-pass one without the verdict itself weakening.

## Related, separately reported — OUT OF SCOPE for this goal

- Tweak-confirm "wall of text": `extensions/goal-commands.ts:1206` interpolates
  the full `CURRENT:` and `NEW:` objective unformatted and untruncated, so a
  long objective is printed twice and fills the screen
  (`Screenshot_20261029_112819.png`, `_152631.png`, `_165336.png`).
- `/glla wipe` feels frozen: `.pi-glla/active.jsonl` here is 6.8 MB and
  rotation only triggers at 8 MB (`LEDGER_ROTATION_BYTES`,
  `extensions/goal-loop-core.ts:2379`). The reported slowness resolved on its
  own after waiting, so this is a latency note, not a hang.

## Prior recovery goal — closure status

The provider/quota recovery goal (`20261029112830-o9ecox`) was archived
`aborted` with `stopReason: "user wipe (/glla wipe)"`, not approved. Its work is
present in HEAD and green (`recoveryWaitIsDue` at both call sites;
`release:check` 4461 pass / 1 skip / 0 fail). It carries no auditor verdict
because of the same candidate exhaustion documented above.

## Implemented

- `auditorInspection` now defaults to `true`, so an auditor dispatch asks for a
  durable `--session <jobDir>/session.jsonl` instead of `--no-session`. The
  setting remains a real opt-out.
- A no-result attempt now KEEPS its job directory when it actually wrote a
  session (`hasResumableAuditorSession`). Previously that directory was deleted,
  which made resume a no-op. Retained directories keep the worker lock a
  finished audit keeps, so `inspectAuditJobHealth` classifies them `dead` once
  the worker PID is gone and the existing retention ceiling still reaps them —
  verified: `{"dead":1,"ambiguous":0,"cleanupCandidates":1}`.
- `decideAuditorResume` is the explicit policy. Resume requires: durable
  sessions on, a prior attempt, a `provider` or `transport` failure, an
  unchanged goal revision, the same claim lineage, an unchanged audit tier, no
  cancel, and a real non-empty session on disk. Every refusal returns a named
  reason.
- The worker spawns `--session <prior session>` and, when resuming, sends a
  short continuation brief instead of the full audit prompt, because the
  session already holds the brief and the commands already run.
- A missing or empty transcript degrades to a cold start, never a failed audit.
- Every dispatch records `auditor_resume_decision` (resumed or refused, with
  its reason, the prior attempt, the model being resumed onto, tier and
  revision), so a continued audit is distinguishable from a first-pass one.

## Verification

`tests/auditor-resume.test.ts` (18 cases) covers the default dispatch, the
retained-session artifact, reaping of a retained directory, the opt-out, the
resume/restart matrix for every failure class and every disqualifier, the
end-to-end `--session <prior transcript>` spawn, and cold fallback for a
vanished transcript.

Isolated controls (`controls.py`) prove both directions fail meaningfully, and
that a harmless rewording still passes. Raw logs are in `verification/`.

The auditor verdict path was not changed: `tests/auditor-verdict-authentication`,
`tests/revision-bound-audit`, `tests/auditor-challenge` and the full
`tests/auditor-*.test.ts` + `tests/audit-*.test.ts` set stay green (522 pass).

Gates at final HEAD `5e576645`: `npm run release:check` exits 0 — 4479 pass,
1 skip, 0 fail across 476 files, plus pack smoke; `npm run check` and
`npm run check:inventory` exit 0. Full output retained at
`verification/release-check.log`.

## Regressions this change surfaced (fixed)

Making durable sessions the default exposed a latent terminal-summary bug that
had been dormant only because the session hint almost never rendered: the
"Auditor session kept for review" line was contributed as bare prose AFTER the
record pointer. It now renders as a bullet and is placed before the record, so
the summary keeps one change-first voice with the record still last
(`extensions/completion-summary.ts`, `extensions/loops/goal-auditor-hooks.ts`).
`tests/approval-notify.test.ts`'s shape assertion was updated to match the new
bullet prefix while keeping its real requirement — shell-safe quoting of a
worker-reported path — intact.
