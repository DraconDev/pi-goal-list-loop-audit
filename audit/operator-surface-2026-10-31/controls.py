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
        "  if (ownership === 'chat') return !!(state.goal || state.loop);",
        "  if (ownership === 'chat') return false;",
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

    # 4. List auto-advance: remove the REAL advance, which lives in
    #    archiveCurrentGoal (goal-orchestrator.ts). audit round 3: this control
    #    used to mutate a duplicate advance in the settlement path — the very
    #    double advance that skipped a queue item — so it reported the CORRECT
    #    single advance as a failure while protecting the bug.
    'no-auto-advance-regression': (
        'extensions/loops/goal-orchestrator.ts',
        '    postCompletionSettleUntil = Date.now() + LIST_COMPLETION_SETTLE_MS;\n    const advanced = activateNextListItem(ctx);',
        '    postCompletionSettleUntil = Date.now() + LIST_COMPLETION_SETTLE_MS;\n    const advanced = false;',
    ),

    # 4b. The double advance: settlement advances AGAIN after the archive already
    #     did, so the immediate next item is activated and then replaced — it
    #     never runs and the queue drains.
    'double-advance-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        '  // top of this function is what keeps paused, blocked and failed items holding.\n  return true;',
        '  // top of this function is what keeps paused, blocked and failed items holding.\n  if ((listQueue()?.length ?? 0) > 0 && !isLoopActive()) activateNextListItem(ctx);\n  return true;',
    ),

    # 5. Auditor model display: restore the old precedence (configured ref won).
    'configured-model-wins-regression': (
        'extensions/goal-loop-display.ts',
        '  const executed = audit?.model ?? claim?.auditorSourceModel;',
        '  const executed = undefined as string | undefined;',
    ),

    # 5b. audit round 5: the card names the executed model AND appends the
    #     configured candidate that was never dispatched. Presence-only assertions
    #     cannot see this; the negative assertion added in round 5 can.
    'configured-candidate-appended-regression': (
        'extensions/goal-loop-display.ts',
        '  return truncate(isSessionModel ? `${ref} · session model` : ref, 56);',
        '  return truncate(`${isSessionModel ? `${ref} · session model` : ref} · configured openai-codex/gpt-6-luna`, 200);',
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
        'extensions/goal-recovery.ts',
        "  if (ownership === 'chat') return !!(state.goal || state.loop);",
        "  if (ownership === 'chat') return true;",
    ),

    # 8. Auditor round 2, objection 2b: remove the in-dialog expand so the
    #    rationale is once again reachable only by cancelling and retyping.
    'tweak-toggle-removed-regression': (
        'extensions/confirm-draft.ts',
        '    this.expanded = !this.expanded;\n    this.md = new Markdown(',
        '    return;\n    this.expanded = !this.expanded;\n    this.md = new Markdown(',
    ),

    # 8b. The compact card reverts to the CURRENT:/NEW: wall the screenshots
    #     show, while every other part of the path stays correct.
    'tweak-wall-regression': (
        'extensions/confirm-draft.ts',
        "    ...tweakObjectiveLines(input.currentObjective, input.newObjective),",
        "    `CURRENT:\\n${input.currentObjective.trim() || '(none)'}`,\n    `NEW:\\n${input.newObjective.trim() || '(none)'}`,\n    ...tweakObjectiveLines(input.currentObjective, input.newObjective),",
    ),

    # 8d. audit round 3 [MED]: the default card reprints the whole long
    #     objective again instead of showing the changed region.
    'tweak-long-objective-regression': (
        'extensions/confirm-draft.ts',
        "    `From: ${current.trim() || '(none)'}`,",
        "    `From: ${(current.trim() || '(none)').slice(0, 180)}…`,",
    ),

    # 8e. audit round 3 [MED]: the real call site stops passing a height, so the
    #     advertised PgUp/PgDn scroll cannot move and the body renders unbounded.
    'tweak-card-height-regression': (
        'extensions/goal-commands.ts',
        '          { ...full, getHeight: () => (tui.terminal?.rows ?? 24) - 4 },',
        '          full,',
    ),

    # 8c. Auditor round 2, objection 1: the wipe's reviewer streams the whole
    #     ledger again instead of the bounded recent read.
    'wipe-full-scan-regression': (
        'extensions/loops/goal-auditor-hooks.ts',
        '      scanLedgerRecordsSince(ctx.cwd, reviewerNowMs - 24 * 60 * 60_000, (entry) => {',
        '      scanLedgerRecords(ctx.cwd, (entry) => {',
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
                 'tests/stale-build-warning.test.ts', 'tests/glla-wipe-real-path.test.ts'],
    'harmless-rewording': ['tests/stale-recovery-marker.test.ts'],
    'stale-recovery-card-regression': ['tests/stale-recovery-marker.test.ts'],
    'chat-recovery-hidden-regression': ['tests/stale-recovery-marker.test.ts'],
    'amendment-wall-regression': ['tests/amendment-confirm-compact.test.ts'],
    'amendment-wiring-regression': ['tests/amendment-confirm-compact.test.ts'],
    'no-auto-advance-regression': ['tests/list-auto-advance.test.ts'],
    'double-advance-regression': ['tests/list-auto-advance.test.ts'],
    'tweak-long-objective-regression': ['tests/amendment-confirm-compact.test.ts'],
    'tweak-card-height-regression': ['tests/amendment-confirm-compact.test.ts'],
    'configured-model-wins-regression': ['tests/auditor-model-display.test.ts'],
    'configured-candidate-appended-regression': ['tests/auditor-model-display.test.ts'],
    'stale-build-silent-regression': ['tests/stale-build-warning.test.ts'],
    'per-record-read-regression': ['tests/glla-wipe-latency.test.ts'],
    'chat-owner-orphan-regression': ['tests/stale-recovery-marker.test.ts'],
    'tweak-wall-regression': ['tests/amendment-confirm-compact.test.ts'],
    'tweak-toggle-removed-regression': ['tests/amendment-confirm-compact.test.ts'],
    'wipe-full-scan-regression': ['tests/glla-wipe-real-path.test.ts'],
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
