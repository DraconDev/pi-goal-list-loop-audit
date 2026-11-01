#!/usr/bin/env python3
"""Isolated controls for audit/operator-surface-2026-10-31.

Each case copies the tree, applies ONE mutation that reinstates a defect the
operator-surface goal fixed, and runs the suite that is supposed to catch it.
A `-regression` case MUST exit nonzero (the test bites); the baseline and the
harmless-change case MUST exit zero (the checks are not over-tight).

The harmless-change case matters as much as the regressions: it proves these
assertions protect behaviour rather than incidental wording.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'audit' / 'operator-surface-2026-10-31' / 'verification'
OUT.mkdir(parents=True, exist_ok=True)

# case name -> (file, before, after) or None for the unmutated baseline
CASES: dict[str, tuple[str, str, str] | None] = {
    'baseline': None,

    # Harmless change: reword a log/notification string the tests must NOT pin.
    # If this fails, the suite is over-fitted to wording rather than behaviour.
    'harmless-rewording': (
        'extensions/goal-loop-display.ts',
        '/glla resume clears the stale marker',
        '/glla resume clears the stale recovery marker',
    ),

    # 1. Stale recovery marker: drop the ownership gate so an ownerless marker
    #    renders the card again (the note.md bug).
    'stale-recovery-card-regression': (
        'extensions/goal-loop-display.ts',
        'if (!state.goal && state.mainModelRecovery && extras?.recoveryHasLiveOwner === true) return standaloneRecoveryLines(',
        'if (!state.goal && state.mainModelRecovery) return standaloneRecoveryLines(',
    ),

    # 1b. The "chat counts as live" half: treat chat ownership as dead, which
    #     would hide a legitimate ordinary-chat recovery (the opposite defect).
    'chat-recovery-hidden-regression': (
        'extensions/goal-recovery.ts',
        "return ownership === 'retained' || ownership === 'restore-pending' || ownership === 'chat';",
        "return ownership === 'retained' || ownership === 'restore-pending';",
    ),

    # 2. Tweak-confirm: restore full contracts in the body even when unchanged.
    'amendment-wall-regression': (
        'extensions/confirm-draft.ts',
        '    // An UNCHANGED contract is not part of the decision — printing it twice was\n    // most of the wall. Say it is untouched instead of echoing it.\n    lines.push("", "Contract: unchanged");',
        '    lines.push("", `Contract: ${clipContract(oldContract)} → ${clipContract(newContract)}`);',
    ),

    # 2b. Tweak-confirm WIRING: the real complete_goal call site reverts to the
    #     old five-section body while the helper stays correct. This is the test
    #     that proves the suite drives the real path, not just the helper.
    'amendment-wiring-regression': (
        'extensions/loops/goal-tools.ts',
        '            confirmed = await ctx.ui.confirm(\n              "Confirm completion scope amendment",\n              buildAmendmentConfirmBody({',
        '            confirmed = await ctx.ui.confirm(\n              "Confirm completion scope amendment",\n              [oldObjective, amendmentContract, cleanObj, proposedContract].join("\\n") || buildAmendmentConfirmBody({',
    ),

    # 4. List auto-advance: remove the settlement advance.
    'no-auto-advance-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        "  if ((listQueue()?.length ?? 0) > 0 && !isLoopActive()) {",
        "  if (false) {",
    ),

    # 5. Auditor model display: restore the old precedence (configured ref won).
    'configured-model-wins-regression': (
        'extensions/goal-loop-display.ts',
        '  const executed = audit?.model ?? claim?.auditorSourceModel;',
        '  const executed = undefined as string | undefined;',
    ),

    # 3. Wipe latency: add per-record work to the reader. This models the real
    #    regression the budget guards (replaying every historical record with
    #    work per record) and is quadratic, so it cannot hide inside I/O cost.
    'per-record-read-regression': (
        'extensions/goal-loop-core.ts',
        '    const files = ledgerFiles(cwd);\n    const hasSegments = files.some((candidate) => candidate !== file);',
        '    const files = ledgerFiles(cwd);\n    for (const _f of files) { try { const _t = fs.readFileSync(_f, "utf8"); for (const _l of _t.split("\\n")) { if (_l) fs.readFileSync(_f, "utf8"); } } catch {} }\n    const hasSegments = files.some((candidate) => candidate !== file);',
    ),

    # 6. Stale-build: stop emitting the warning at session start.
    'stale-build-silent-regression': (
        'extensions/loops/goal-activation.ts',
        '        ctx.ui.notify(staleLine, "warning");',
        '        void staleLine;',
    ),
    # 7. Auditor objection 1: revert the chat-with-no-supervised-target rule so
    #    the REAL screenshot marker (owner:chat, kind:goal, goal:null) is live
    #    again and renders the complaint card.
    'chat-owner-orphan-regression': (
        'extensions/recovery-ownership.ts',
        "    if (!work.goal && !work.loop) return 'absent';\n    return 'chat';",
        "    return 'chat';",
    ),

    # 8. Auditor objection 2: restore the CURRENT:/NEW: wall in the real
    #    /goal tweak confirm that the screenshots show.
    'tweak-wall-regression': (
        'extensions/goal-commands.ts',
        '  return ctx.ui.confirm(title, input.showRationale ? buildTweakRationaleBody(input) : buildTweakConfirmBody(input));',
        '  return ctx.ui.confirm(title, `CURRENT:\\n${input.currentObjective}\\n\\nNEW:\\n${input.newObjective}`);',
    ),

    # 9. Auditor objection 4: remove the settlement status guard so a paused,
    #    blocked, or failed item is archived and advances past the decision.
    'settle-status-guard-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        '  if (settleGoal.status !== "auditing" && !isSettlingClaim(settleGoal.pendingCompletion)) return false;\n',
        '',
    ),

    # 10. Auditor objection 5: drop the package-name check so a foreign project
    #     manifest produces a false stale-build warning.
    'stale-build-foreign-name-regression': (
        'extensions/glla-version.ts',
        '    if (manifest.name !== GLLA_PACKAGE_NAME) return undefined;',
        '    void GLLA_PACKAGE_NAME;',
    ),

    # 11. Auditor objection 3: restore the unbounded full-ledger rescan that
    #     froze the surface for ~4.8 s at the real profile.
    'ledger-full-scan-regression': (
        'extensions/goal-loop-core.ts',
        '  try { entries = scanIndexedLedgerStateFinals(cwd); } catch { entries = []; }',
        '  try { const f = new Map<string, { type: string; value?: any }>(); scanLedgerRecords(cwd, (e) => { if (e.type === "state" && e.value?.goal?.id) f.set(String(e.value.goal.id), e); }); entries = [...f.values()]; } catch { entries = []; }',
    ),
}

# case name -> suite(s) the mutation must be caught by
SUITES: dict[str, list[str]] = {
    'baseline': ['tests/stale-recovery-marker.test.ts', 'tests/amendment-confirm-compact.test.ts',
                 'tests/list-auto-advance.test.ts', 'tests/auditor-model-display.test.ts',
                 'tests/stale-build-warning.test.ts'],
    'harmless-rewording': ['tests/stale-recovery-marker.test.ts'],
    'stale-recovery-card-regression': ['tests/stale-recovery-marker.test.ts'],
    'chat-recovery-hidden-regression': ['tests/stale-recovery-marker.test.ts'],
    'amendment-wall-regression': ['tests/amendment-confirm-compact.test.ts'],
    'amendment-wiring-regression': ['tests/amendment-confirm-compact.test.ts'],
    'no-auto-advance-regression': ['tests/list-auto-advance.test.ts'],
    'configured-model-wins-regression': ['tests/auditor-model-display.test.ts'],
    'stale-build-silent-regression': ['tests/stale-build-warning.test.ts'],
    'per-record-read-regression': ['tests/glla-wipe-latency.test.ts'],
    'chat-owner-orphan-regression': ['tests/stale-recovery-marker.test.ts'],
    'tweak-wall-regression': ['tests/amendment-confirm-compact.test.ts'],
    'settle-status-guard-regression': ['tests/list-auto-advance.test.ts'],
    'stale-build-foreign-name-regression': ['tests/stale-build-warning.test.ts'],
    'ledger-full-scan-regression': ['tests/wipe-ledger-scan.test.ts'],
}

results = []
for case, mutation in CASES.items():
    with tempfile.TemporaryDirectory(prefix='glla-ops-control-') as temporary:
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
            assert text.count(before) == 1, (case, before[:60], text.count(before))
            source.write_text(text.replace(before, after, 1))
        env = dict(os.environ)
        toolchain = Path.home() / '.local/share/bun-toolchains/bun-1.3.14'
        if toolchain.is_dir():
            env['PATH'] = str(toolchain) + os.pathsep + env['PATH']
        command = ['node', 'scripts/run-tests.mjs', *SUITES[case]]
        with (OUT / f'{case}.log').open('w') as output:
            run = subprocess.run(command, cwd=copy, env=env, stdout=output,
                                 stderr=subprocess.STDOUT, timeout=900)
        expected_failure = case.endswith('-regression')
        results.append({'case': case, 'command': command, 'exitCode': run.returncode,
                        'expectedFailure': expected_failure,
                        'expectedResultObserved': (run.returncode != 0) == expected_failure})
        print(json.dumps(results[-1]), flush=True)
        if case == 'baseline' and run.returncode:
            break  # A broken control surface cannot establish any findings.

(OUT / 'controls.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(0 if len(results) == len(CASES) and all(r['expectedResultObserved'] for r in results) else 1)
