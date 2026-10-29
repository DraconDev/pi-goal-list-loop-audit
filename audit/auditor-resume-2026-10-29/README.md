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
