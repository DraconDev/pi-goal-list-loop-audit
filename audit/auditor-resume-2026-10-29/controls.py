#!/usr/bin/env python3
"""Isolated behavioral controls for auditor resume. Never edits live source.

Two directions must fail meaningfully:
  * forcing every retry to restart cold discards completed audit work;
  * resuming across a changed revision or a replaced claim judges a different
    question with the old transcript.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / 'verification'
OUT.mkdir(exist_ok=True)

CASES = {
    'baseline': None,
    # A harmless rewording of the refusal reason must not change behavior: it
    # is prose, not a contract.
    'reason-rewording': (
        'extensions/goal-loop-auditor-process.ts',
        'return { resume: false, reason: "failure-class" };',
        'return { resume: false, reason: "failure-class" };  // clarified copy',
    ),
    # Direction 1: always restart cold. This is the incident's behavior and it
    # throws away completed audit work.
    'always-restart-regression': (
        'extensions/goal-loop-auditor-process.ts',
        'const RESUMABLE_AUDITOR_FAILURES = new Set<AuditorInfrastructureClass>(["provider", "transport"]);',
        'const RESUMABLE_AUDITOR_FAILURES = new Set<AuditorInfrastructureClass>([]);',
    ),
    # Direction 2: resume regardless of a moved revision.
    'resume-across-revision-regression': (
        'extensions/goal-loop-auditor-process.ts',
        'if (input.currentRevision !== undefined && input.priorRevision !== input.currentRevision) {\n'
        '    return { resume: false, reason: "revision-moved" };',
        'if (false) {\n'
        '    return { resume: false, reason: "revision-moved" };',
    ),
    # Direction 2: resume regardless of a replaced claim.
    'resume-across-claim-regression': (
        'extensions/goal-loop-auditor-process.ts',
        'if (input.priorClaimAttemptId && input.currentClaimAttemptId\n'
        '    && input.priorClaimAttemptId !== input.currentClaimAttemptId) {\n'
        '    return { resume: false, reason: "claim-replaced" };',
        'if (false) {\n'
        '    return { resume: false, reason: "claim-replaced" };',
    ),
    # Durability off must still be an opt-out, not a silent resume.
    'durability-optout-regression': (
        'extensions/goal-loop-auditor-process.ts',
        'if (!input.inspection) return { resume: false, reason: "inspection-off" };',
        'if (false) return { resume: false, reason: "inspection-off" };',
    ),
    # v0.39.55 (auditor objection 2026-10-30): the ORIGINAL suite passed while
    # production still refused every retry, because it called the pure policy
    # with fabricated matching ids. These two mutations restore exactly that
    # production bug and must fail the end-to-end wiring tests.
    #   Direction: claim identity goes back to the ROTATED attempt id, so every
    #   ordinary retry is refused as claim-replaced.
    'rotated-claim-identity-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        'priorClaimAttemptId: input.claim.priorClaimLineageId ?? input.claim.claimLineageId,',
        'priorClaimAttemptId: input.claim.priorAttemptId,',
    ),
    #   Direction: the resolver goes back to guessing the bare attempt-id path,
    #   so the retained nonce-suffixed session is never found.
    'bare-session-path-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        'const priorJobDir = findAuditJobDirectory(input.cwd, priorAttempt);',
        'const priorJobDir = path.join(input.cwd, ".pi-glla", "audit-jobs", priorAttempt);',
    ),
    # v0.39.56 (auditor objection 2026-10-30): the user abort was never recorded,
    # so an explicit cancel was classified transport and got resumed. Restoring
    # that bug must fail the abort-cause test.
    'user-abort-unrecorded-regression': (
        'extensions/goal-loop-auditor-process.ts',
        'signal.addEventListener("abort", () => recordUserAuditorAbort(logicalAttemptId), { once: true });',
        'signal.addEventListener("abort", () => {}, { once: true });',
    ),
    # v0.39.56: the source model was only stamped on a resumed dispatch, so the
    # FIRST resume omitted fromModel. Restoring that must fail the lineage test.
    # The stamping decision lives in auditorDispatchStampFacts; mutating THAT
    # restores the original defect (source model only on a resumed dispatch).
    'first-resume-source-model-regression': (
        'extensions/goal-loop-core.ts',
        '    ...(input.attemptModel ? { sourceModel: input.attemptModel } : {}),',
        '    ...(input.resumed && input.attemptModel ? { sourceModel: input.attemptModel } : {}),',
    ),
    # v0.39.57 (auditor objection 2026-10-30): the PRIMARY complete_goal dispatch
    # never stamped the retry baseline, so the first retry's revision/tier guards
    # compared against undefined and could not fire. Removing the primary stamp
    # must fail the real-dispatch tests.
    'primary-dispatch-baseline-regression': (
        'extensions/loops/goal-tools.ts',
        '      if (dispatchBaseline) updateGoal({ pendingCompletion: dispatchBaseline }, ctx);',
        '      void dispatchBaseline;',
    ),
    # v0.39.58 (auditor objection 2026-10-30, HIGH #1): context exhaustion fell
    # through to the resumable "provider" class, so an already-overflowed
    # transcript was resumed — the exact retry-budget burn the contract forbids.
    'context-exhaustion-resumable-regression': (
        'extensions/goal-loop-auditor-process.ts',
        '  if (isContextExhaustionError(error)) return "context-exhausted";\n  return "provider";\n}',
        '  return "provider";\n}',
    ),
    # v0.39.58 (MED #3): the resume-lineage ledger row had no test at all.
    'missing-resume-ledger-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        'appendLedger(liveCtx.cwd, "auditor_resume_decision", {',
        'appendLedger(liveCtx.cwd, "auditor_resume_decision_suppressed", {',
    ),
    # v0.39.59 (auditor objection 2026-10-30, HIGH #1): the surviving hand-copied
    # whitelist in normalizePendingCompletion silently DROPPED the new class on
    # reload. Reinstate it: the durable round-trip must then fail.
    'reload-drops-context-class-regression': (
        'extensions/auditor-failure-classes.ts',
        '  const auditorFailureClass = isAuditorInfrastructureClass(_auditorFailureClass)\n    ? _auditorFailureClass\n    : undefined;',
        '  const _stale: AuditorRecoveryFailureClass[] = ["transport", "timeout", "no-verdict", "provider"];\n'
        '  const auditorFailureClass = typeof _auditorFailureClass === "string" && _stale.includes(_auditorFailureClass as AuditorRecoveryFailureClass)\n'
        '    ? _auditorFailureClass as AuditorRecoveryFailureClass\n'
        '    : undefined;',
    ),
    # The shared list omits a member the union declares.
    'shared-class-list-incomplete-regression': (
        'extensions/auditor-failure-classes.ts',
        '  "no-verdict", "timeout", "transport", "provider", "context-exhausted",\n] as const satisfies readonly AuditorInfrastructureClass[];',
        '  "no-verdict", "timeout", "transport", "provider",\n] as const satisfies readonly AuditorInfrastructureClass[];',
    ),
    # v0.39.60 (auditor objection 2026-10-31, HIGH #1): reinstate the hand-copied
    # Set in process.ts, omitting the context class. tsc cannot see a MISSING
    # element in an array literal, so only the runtime gate test catches this.
    'hand-copied-process-set-regression': (
        'extensions/goal-loop-auditor-process.ts',
        'import { AUDITOR_INFRASTRUCTURE_CLASSES } from "./auditor-failure-classes.js";',
        'const AUDITOR_INFRASTRUCTURE_CLASSES: ReadonlySet<string> = new Set<string>([\n'
        '  "no-verdict", "timeout", "transport", "provider",\n]);',
    ),
    # v0.39.60 (MED #2): the shipped schema enum is a third copy. Dropping the
    # context class there would let the runtime write a class the published
    # schema rejects.
    'schema-enum-drops-context-class-regression': (
        'schemas/goal.schema.json',
        '"auditorFailureClass": { "type": "string", "enum": ["transport", "timeout", "no-verdict", "provider", "context-exhausted"] },',
        '"auditorFailureClass": { "type": "string", "enum": ["transport", "timeout", "no-verdict", "provider"] },',
    ),
    # Direction: the baseline guard becomes permissive again (absent = resume),
    # which is the exact production shape the auditor probed.
    'fail-open-baseline-regression': (
        'extensions/goal-loop-auditor-process.ts',
        '  if (input.priorRevision === undefined) return { resume: false, reason: "revision-unknown" };',
        '  if (input.priorRevision === undefined) return { resume: true };',
    ),
}
SUITES = {
    'baseline': ['tests/auditor-resume.test.ts'],
    'reason-rewording': ['tests/auditor-resume.test.ts'],
    'always-restart-regression': ['tests/auditor-resume.test.ts'],
    'resume-across-revision-regression': ['tests/auditor-resume.test.ts'],
    'resume-across-claim-regression': ['tests/auditor-resume.test.ts'],
    'durability-optout-regression': ['tests/auditor-resume.test.ts'],
    'rotated-claim-identity-regression': ['tests/auditor-resume.test.ts'],
    'bare-session-path-regression': ['tests/auditor-resume.test.ts'],
    'user-abort-unrecorded-regression': ['tests/auditor-resume.test.ts'],
    'first-resume-source-model-regression': ['tests/auditor-resume.test.ts'],
    'primary-dispatch-baseline-regression': ['tests/auditor-resume.test.ts'],
    'fail-open-baseline-regression': ['tests/auditor-resume.test.ts'],
    'context-exhaustion-resumable-regression': ['tests/auditor-resume.test.ts'],
    'missing-resume-ledger-regression': ['tests/auditor-resume.test.ts'],
    'reload-drops-context-class-regression': ['tests/auditor-resume.test.ts'],
    # This one must fail at TYPECHECK, not at test time: the exhaustiveness guard
    # is a compile error by design.
    'shared-class-list-incomplete-regression': ['CHECK'],
    # Runtime gate: tsc cannot see a missing element in an array literal.
    'hand-copied-process-set-regression': ['tests/auditor-resume.test.ts'],
    'schema-enum-drops-context-class-regression': ['tests/goal-schema-parity.test.ts'],
}

results = []
for case, mutation in CASES.items():
    with tempfile.TemporaryDirectory(prefix='glla-auditor-resume-control-') as temporary:
        copy = Path(temporary)
        for name in ['extensions', 'scripts', 'tests', 'prompts', 'schemas']:
            shutil.copytree(ROOT / name, copy / name)
        for name in ['package.json', 'tsconfig.json', 'bunfig.toml']:
            shutil.copy2(ROOT / name, copy / name)
        (copy / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        if mutation:
            name, *pairs = mutation
            source = copy / name
            text = source.read_text()
            for before, after in zip(pairs[0::2], pairs[1::2]):
                assert text.count(before) == 1, (case, before[:60], text.count(before))
                text = text.replace(before, after, 1)
            source.write_text(text)
        env = dict(os.environ)
        toolchain = Path.home() / '.local/share/bun-toolchains/bun-1.3.14'
        if toolchain.is_dir():
            env['PATH'] = str(toolchain) + os.pathsep + env['PATH']
        # A `CHECK` suite means the defect must be caught at TYPECHECK: the
        # exhaustiveness guard is a compile error by design, so asserting it via
        # runtime tests would prove the wrong mechanism.
        command = (['npx', 'tsc', '--noEmit'] if SUITES[case] == ['CHECK']
                   else ['node', 'scripts/run-tests.mjs', *SUITES[case]])
        with (OUT / f'{case}.log').open('w') as output:
            run = subprocess.run(command, cwd=copy, env=env, stdout=output,
                                 stderr=subprocess.STDOUT, timeout=600)
        expected_failure = case.endswith('-regression')
        results.append({'case': case, 'command': command, 'exitCode': run.returncode,
                        'expectedFailure': expected_failure,
                        'expectedResultObserved': (run.returncode != 0) == expected_failure})
        print(json.dumps(results[-1]), flush=True)
        if case == 'baseline' and run.returncode:
            break  # A broken control surface cannot establish any findings.

(OUT / 'controls.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(0 if len(results) == len(CASES) and all(r['expectedResultObserved'] for r in results) else 1)
