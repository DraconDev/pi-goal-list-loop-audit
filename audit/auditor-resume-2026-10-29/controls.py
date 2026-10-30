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
        'if (input.priorRevision !== undefined && input.currentRevision !== undefined\n'
        '    && input.priorRevision !== input.currentRevision) {\n'
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
        command = ['node', 'scripts/run-tests.mjs', *SUITES[case]]
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
