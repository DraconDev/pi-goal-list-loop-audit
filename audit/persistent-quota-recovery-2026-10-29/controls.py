#!/usr/bin/env python3
"""Run isolated behavioral controls; never edit live source or invoke from tests."""
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
    'diagnostic-rewording': (
        'extensions/goal-recovery.ts',
        'ctx.ui.notify(`Main model recovery: ${sanitizeProviderDisplayText(normalized.reason)}. Trying again in ${minutes}m; work is saved and will not be abandoned. The agent can retry now with resume_goal.`, "warning");',
        'ctx.ui.notify(`Provider recovery remains scheduled in ${minutes} minutes. Saved work stays available; resume_goal requests an immediate attempt.`, "warning");',
    ),
    'terminal-compaction-regression': (
        'extensions/loops/goal-activation.ts',
        "if (failure.kind === 'provider-recovery') {",
        "if (false && failure.kind === 'provider-recovery') {",
    ),
    'expired-audit-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        'const expired = !isRecoverableProviderError(pending.providerErrorDiagnostic) && deadlines.some((value) => {',
        'const expired = deadlines.some((value) => {',
    ),
    # The narrowed policy must stay narrow: reinstating the over-broad
    # five-minute cadence for EVERY recoverable failure (billing, auth, 503)
    # overrides each family's separately configured pacing and must fail.
    'blanket-cadence-regression': (
        'extensions/goal-recovery.ts',
        'const steadyDelayMs = isQuotaHorizonExempt(diagnostic) ? PERSISTENT_PROVIDER_RETRY_MS : delayMs;',
        'const steadyDelayMs = isRecoverableProviderError(diagnostic) ? PERSISTENT_PROVIDER_RETRY_MS : delayMs;',
    ),
    # The one-time legacy-compaction migration must not invent a cadence the
    # live path would not choose: forcing the quota cadence onto a billing or
    # transient wall must fail.
    'legacy-migration-cadence-regression': (
        'extensions/goal-recovery.ts',
        'const steadyDelayMs = isQuotaHorizonExempt(goal.pauseReason)',
        'const steadyDelayMs = isRecoverableProviderError(goal.pauseReason)',
    ),
}
# Which suites prove each case's protected contract.
SUITES = {
    'baseline': ['tests/persistent-provider-recovery.test.ts'],
    'diagnostic-rewording': ['tests/persistent-provider-recovery.test.ts'],
    'terminal-compaction-regression': ['tests/persistent-provider-recovery.test.ts'],
    'expired-audit-regression': ['tests/persistent-provider-recovery.test.ts'],
    'blanket-cadence-regression': ['tests/quota-horizon-exemption.test.ts'],
    'legacy-migration-cadence-regression': ['tests/persistent-provider-recovery.test.ts'],
}
results = []
for case, mutation in CASES.items():
    with tempfile.TemporaryDirectory(prefix='glla-persistent-control-') as temporary:
        copy = Path(temporary)
        for name in ['extensions', 'scripts', 'tests', 'prompts', 'schemas']:
            shutil.copytree(ROOT / name, copy / name)
        for name in ['package.json', 'tsconfig.json', 'bunfig.toml']:
            shutil.copy2(ROOT / name, copy / name)
        (copy / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        if mutation:
            name, before, after = mutation
            source = copy / name
            text = source.read_text()
            assert text.count(before) == 1, (case, text.count(before))
            source.write_text(text.replace(before, after, 1))
        env = dict(os.environ)
        toolchain = Path.home() / '.local/share/bun-toolchains/bun-1.3.14'
        if toolchain.is_dir():
            env['PATH'] = str(toolchain) + os.pathsep + env['PATH']
        command = ['node', 'scripts/run-tests.mjs', *SUITES[case]]
        with (OUT / f'{case}.log').open('w') as output:
            run = subprocess.run(command, cwd=copy, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=300)
        expected_failure = case.endswith('-regression')
        results.append({'case': case, 'command': command, 'exitCode': run.returncode,
                        'expectedFailure': expected_failure,
                        'expectedResultObserved': (run.returncode != 0) == expected_failure})
        print(json.dumps(results[-1]), flush=True)
        if case == 'baseline' and run.returncode:
            break  # A broken control surface cannot establish any findings.
(OUT / 'controls.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(0 if len(results) == len(CASES) and all(r['expectedResultObserved'] for r in results) else 1)
