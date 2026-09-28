# /loop engine and scheduling/state machinery — 2026-09-28

Read-only survey of `extensions/goal-loop.ts`, `goal-loop-core.ts`, `goal-loop-dispatch.ts`,
`goal-loop-forever.ts`, `goal-loop-repetition.ts`, `goal-loop-stats.ts`, `goal-loop-backoff.ts`,
`goal-loop-shield.ts`, `goal-loop-subagents.ts`, `loops/goal-orchestrator.ts` (loop parts).
Dedupe run against `.pi-glla/audit-loop/findings.md` (no hits for any keyword below).

## Findings

### F1 [SEVERITY: HIGH] `/loop stop` and `/loop finish` destroy the final in-flight iteration's uncommitted work on the scratch branch, while the tick's own terminal stops explicitly guard it
- Where: `extensions/goal-loop.ts:1390` (stop/cancel) and `extensions/goal-loop.ts:1460` (finish) call `finishLoopGit(ctx, state.loop)` directly; `extensions/goal-loop.ts:919` inside `finishLoopGit` runs `git reset --hard HEAD` unconditionally, then checks out `originalBranch`. Contrast `extensions/goal-loop.ts:800-822` (`commitPendingTerminalWork`) and its two in-tick call sites `extensions/goal-loop.ts:834` / `:877`, added with the comment at `:783-786` "a terminal stop never destroys the last iteration's work".
- What breaks: `branch=1` loop, agent iteration writes files, tick is inside `await runMeasure` (up to `MEASURE_TIMEOUT_MS` = 10 min, `goal-loop-backoff.ts:49`) before reaching the `git add -A` / `commit` at `goal-loop.ts:770-774`. User types `/loop stop` in that window: `cmdLoop` replaces `state.loop` with an inactive copy (`:1389`), the in-flight tick then fails `rebindLoop()` and abandons (`:609-621`, ledger `loop_tick_abandoned`), and `/loop stop`'s `finishLoopGit` hard-resets the dirty tree — the iteration's uncommitted work is silently deleted and the branch checked back out. The user is then told "Loop work is on branch `<scratch>` … Merge with: git merge …" (`goal-loop.ts:944-948`), a promise the just-erased diff breaks. Same for `/loop finish` (`:1460`) and for `/loop stop` right after a flat/regressed iteration that the continue-branch left uncommitted.
- Fix: hoist `commitPendingTerminalWork` (plus its `parkLoopOnWrongBranch`/failure parking) out of `runLoopTick`'s closure to module scope and call it at the top of the `stop` and `finish` paths (and at the head of `finishLoopGit` itself), so every terminal route commits before any `reset --hard`.
- Confidence: high — both call sites and the destructive `reset` were read directly; the missing commit is a plain control-flow absence, not a race I had to infer.

### F2 [SEVERITY: MEDIUM] `runMeasure` fails OPEN on a missing exit code while its sibling `runGit` fails closed — a killed/timed-out measure can be recorded as a real metric value
- Where: `extensions/goal-loop.ts:304` — `const code = typeof r?.code === "number" ? r.code : (typeof r?.exitCode === "number" ? r.exitCode : 0); if (code !== 0) return null;` vs `extensions/goal-loop.ts:319` — `const code = typeof r?.code === "number" ? r.code : (r?.exitCode ?? 1);` (defaults to failure). The two wrappers of the same `flags.extensionApi.exec` disagree on the "no code field" case.
- What breaks: any exec result that carries neither a numeric `code` nor a numeric `exitCode` (process killed by the measure timeout, a non-standard result envelope) makes `runMeasure` treat the run as a success and hand its partial stdout to `parseMetric` (`goal-loop-forever.ts:246-252`, first-number-wins). A measure like `bash -c "…progress… 42"` that never finishes is recorded as value 42, which can set `bestValue` (`goal-loop-forever.ts:305`) and permanently suppress the plateau stop, while `runGit` on the very same result shape would have failed closed.
- Fix: make the default `1` (fail closed) in `runMeasure` so an exit-code-less result counts as a broken measure (`consecutiveNullMeasures`, `goal-loop-forever.ts:336-342`) rather than as a reading; add a regression asserting `{}`/`{stdout:"42"}` yields `null`.
- Confidence: medium — the asymmetry and the `0` default are read verbatim; the concrete trigger depends on the exec envelope produced for a killed child, which I did not read.

## Checked and clean
- The v0.35.4 tick-rebind fix holds: `rebindLoop()` (`:609-621`) is called after every `await` in `runLoopTick` (`:631, 656, 661, 771, 773, 777, 804, 811, 817`) and the tick abandons with a `loop_tick_abandoned` ledger entry when `state.loop` was replaced by an inactive object.
- `parkLoopOnWrongBranch` (`:340-366`) checks HEAD *before* consulting `branchGuardRebind`, so a stop's own branch restoration is not vetoed by its own in-flight tick.
- `/loop audit` measure-path resolution against the selected state root holds: `auditMeasureCmd` (`goal-loop-forever.ts:588-604`) builds the path from `auditFindingsPath` → `piGlaDir` → `resolveGllaStateDir` and emits the absolute selected path (single-quote escaped) in `sessionDir` mode, so the `cwd` fallback cannot be measured; `countOpenAuditFindings`/`topOpenAuditFinding` (`:628-648`) use the same resolver and the same `[ \t]+` box class as the fan-out matcher.
- `parseLoopStartArgs` (`goal-loop-forever.ts:430-524`) restores unknown/invalid `key=value` spans into the target, skips key-looking text inside quoted target spans, and rejects `direction=` without `measure=`; `done=` still throws its teaching error.
- Plateau/never-moved accounting in `applyMeasurement` (`goal-loop-forever.ts:270-372`) is era-scoped off the last measure-changing refinement and is separately bounded by the `plateauWindow * 2` never-moved stop; metricless loops use `applyMetriclessTick`, which correctly applies time/token/iteration bounds with no plateau.
- `syncSubagentModelOverrides` (`goal-loop-subagents.ts:214-330`) confines every write/unlink to `<agentDir>/agents/<safeName>.md` via `isSafeManagedAgentName` (`:205-209`, rejects separators, dot segments, `..`), skips un-managed user files, and persists the full managed set (the v0.34.x repair-state fix holds).

## BLOCKERS
- none (survey was stopped at the tool-call budget; `loops/goal-orchestrator.ts` was sampled for loop-related dispatch/loop state only, not read in full)
