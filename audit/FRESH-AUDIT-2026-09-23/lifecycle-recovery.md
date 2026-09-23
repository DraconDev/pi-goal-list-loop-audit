# Code Context

Fresh read-only lifecycle/recovery audit of v0.38.97. Scope was limited to the seven requested production files and directly relevant tests. No product code was changed. Findings were deduplicated against `.pi-glla/audit-loop/findings.md`.

## Files Retrieved
1. `extensions/goal-loop.ts` (lines 200-355, 381-895, 926-1209) — loop scheduling, send/tick races, branch-mode Git lifecycle, stop/finish paths.
2. `extensions/goal-loop-core.ts` (lines 2148-2320, 2564-2597, 2670-2808) — ledger rotation, state recovery/sanitization, persistence boundaries and transaction journal.
3. `extensions/goal-heartbeat.ts` (lines 240-390, 390-780, 780-1180, 1180-1530, 1530-1810) — host-loss, zombie, subagent, pending-latch, wedge, and recovery gates.
4. `extensions/goal-continuation.ts` (lines 180-1180, 1180-1808) — dispatch sidecar, retries, repair bootstrap, full/delta payloads, pause fences.
5. `extensions/goal-recovery.ts` (lines 1-900, 900-1785) — completion-claim parking, model fallback, hourly probes, async model-switch fences.
6. `extensions/goal-loop-backoff.ts` (lines 1-344) — live watchdog and pure scheduling decisions.
7. `extensions/goal-state.ts` (lines 1-74) — singleton identity and state-line wrapper.
8. `tests/loop-branch-ownership.test.ts` (lines 1-148) — branch-switch guards, but no failing Git-command coverage.
9. `tests/loop-finish.test.ts` (lines 1-44) — finish routing/source assertions only.
10. `tests/stuck-audit-latch.test.ts` (lines 1-69) — source-order assertions for stale audit parking, no persistence failure/restart test.
11. `tests/behavioral-orchestrator.test.ts` (lines 1132-1232, inspected by targeted search) — refine-hint queue/resume coverage, no failed-dispatch case.
12. `tests/main-model-recovery.test.ts`, `tests/hourly-quota-probe.test.ts`, `tests/heartbeat.test.ts`, `tests/zombie-user-input-standdown.test.ts`, `tests/subagent-hang-detection.test.ts` (targeted test-name/guard inspection) — recovery and heartbeat boundaries.

## Key Code

### Architecture
- `goal-state.ts` owns the one mutable `State` identity; `replaceState` deletes old keys and assigns a new projection in place so jiti-loaded importers stay live.
- `goal-loop-core.ts` owns durable ledger/state encoding, state sanitization, rotation, and crash-recovery journals. `goal-state.persistStateLine` delegates to this boundary.
- `goal-loop.ts` owns loop turn dispatch, `runLoopTick`, and branch-mode mutations. Its async tick rebinds to the active `LoopState` after awaits.
- `goal-continuation.ts` owns the single in-flight dispatch sidecar, start-proof watchdog, verbatim retry payload, and continuation prompt construction.
- `goal-recovery.ts` owns provider/model fallback state and completion-audit recovery parks; it depends on continuation/loop scheduling through injected functions.
- `goal-heartbeat.ts` consumes durable/lifecycle signals and applies host-loss, zombie, subagent, latch, and wedge safety actions.

## Findings

### 1. HIGH — branch-mode terminal commit failure is treated as success, then destructive reset can erase the iteration
**Location:** `extensions/goal-loop.ts:771-782`, `extensions/goal-loop.ts:873-894`

`commitPendingTerminalWork()` treats `git status` failure as “nothing pending,” ignores the `git add` result, records `commit-terminal ok:false`, and still returns `true`. `finishLoopGit()` then runs `git reset --hard HEAD` without checking either reset or checkout results.

**Concrete failure:** the final iteration reaches `maxIterations`/plateau/stuck while a commit hook, missing Git identity, index lock, or daemon race makes `git commit` exit nonzero. The code announces a stopped loop and proceeds to `reset --hard`; the uncommitted final iteration is deleted. If reset/checkout later fails, the code also writes a false `loop_git finish returnedTo:<original>` record and completes the stop path, potentially stranding the user on the scratch branch.

**Why tests miss it:** `tests/loop-branch-ownership.test.ts` proves refusal when HEAD is already foreign; `tests/loop-finish.test.ts` only checks routing/source shape. Neither injects nonzero `status`, `add`, `commit`, `reset`, or `checkout` exits. This is distinct from the recorded terminal-iteration/wrong-branch fixes: those ensure the commit is attempted on the scratch branch; they do not handle a failed commit.

### 2. MEDIUM — one-shot loop directives are consumed before dispatch acceptance
**Location:** `extensions/goal-loop.ts:514-546`

`sendLoopTurn()` clears `auditReprieveNote`, `hypothesisFeedback`, and `refineHint` before `dispatchPrepare()` and `sendMessage()` have succeeded. `dispatchPrepare()` can legitimately return `null` (persistence failure, generation mismatch, or guard), and `sendMessage()` can throw transiently.

**Concrete failure:** an audit-plateau reprieve, prior hypothesis verdict, or operator refine hint is armed durably; the next dispatch hits a transient sidecar-write or send error. The failed attempt logs/parks as appropriate, but the next rearm sees the fields already cleared, so the agent loses the one-shot instruction that explains what to do. A transient transport failure therefore changes task direction rather than merely retrying the same iteration.

**Why tests miss it:** existing refine tests verify that hints are queued/refusable and pure tests pin the field declarations, but no test makes `dispatchPrepare` or `sendMessage` fail and then checks that the one-shot directives survive for the next attempt.

### 3. MEDIUM — stale completion-audit recovery can claim durable success when its state append did not land
**Location:** `extensions/goal-recovery.ts:216-229`, `extensions/goal-heartbeat.ts:1192-1201`

The context-free stale-latch bridge writes markdown, mutates RAM, calls `persistStateLine(cwd, state)`, and ignores its boolean result before returning `true`. Even the fresh-context caller ignores `markCompletionAuditRecoveryPending()` returning `false`, then tells the user the stored claim is safe.

**Concrete failure:** a full/read-only ledger, failed append, or pending state-root resolution occurs while recovering a latched-stale auditor. The in-memory goal may become paused, but the last durable state line still says `auditing`; a process restart resurrects the stranded audit. The context-free path can additionally ledger `mainReleased:true` even though no durable state projection landed.

**Why tests miss it:** `tests/stuck-audit-latch.test.ts` only regex-pins ordering and the presence of both park functions. It neither makes persistence fail nor reloads `readState()` to prove the recovery-pending projection survived.

## Residual Risks
- No product test suite was run for this read-only scouting task; validation was limited to current-source tracing, focused test inspection, exact finding-history deduplication, and Git status inspection.
- The working tree already contained an unrelated unstaged `.pi-glla/active.jsonl` modification. This audit did not modify it, and `git diff --cached --name-only` was empty.

## Start Here
Open `extensions/goal-loop.ts:771-894` first. Finding 1 is the only data-loss blocker and the smallest high-risk failure chain to reproduce with an injected failing `git commit`.

BLOCKERS: HIGH-1 — a failed branch-mode terminal commit is followed by an unchecked destructive reset, so the final iteration can be erased.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Reported three deduplicated current findings with severity, exact locations, concrete scenarios, test gaps, and residual risks; audit remained read-only."
    }
  ],
  "changedFiles": [
    "/home/dracon/.pi/agent/sessions/--home-dracon-Dev-pi-plugins-pi-goal-list-loop-audit--/subagent-artifacts/outputs/876cf269-f827-4de0-b166-e92a0175bea8/lifecycle-recovery.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "targeted grep/find/wc/nl/sed inspection of the seven scoped production files and directly relevant tests",
      "result": "passed",
      "summary": "Mapped lifecycle, persistence, continuation, recovery, heartbeat, and branch-mode call paths."
    },
    {
      "command": "exact and conceptual deduplication search against .pi-glla/audit-loop/findings.md",
      "result": "passed",
      "summary": "Excluded previously recorded races/fixes and retained only distinct current failure paths."
    },
    {
      "command": "git status --short; git diff --cached --name-only",
      "result": "passed",
      "summary": "Only pre-existing unstaged .pi-glla/active.jsonl was present; staged file list was empty."
    }
  ],
  "validationOutput": [
    "Source paths and line ranges were re-read at finding time.",
    "No repository product files or tests were modified."
  ],
  "residualRisks": [
    "No failure-injection tests were executed or added in this read-only audit.",
    "Pre-existing unstaged .pi-glla/active.jsonl remains outside this audit."
  ],
  "noStagedFiles": true,
  "diffSummary": "Created only the required external audit artifact; repository code and tests are unchanged.",
  "reviewFindings": [
    "blocker: extensions/goal-loop.ts:771-894 - failed terminal commit is accepted and destructive reset/checkout can erase or strand work",
    "medium: extensions/goal-loop.ts:514-546 - failed dispatch consumes one-shot recovery/refine directives",
    "medium: extensions/goal-recovery.ts:216-229 and extensions/goal-heartbeat.ts:1192-1201 - stale audit recovery can claim success without durable state"
  ],
  "manualNotes": "BLOCKERS: HIGH-1 is a precise release/audit blocker."
}
```
