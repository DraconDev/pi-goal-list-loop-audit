// tests/amendment-confirm-compact.test.ts
//
// note.md 2026-10-31: the tweak/amendment confirm was "the ugly wall of text".
// The old body printed five labelled sections and reprinted BOTH full contracts
// even when nothing about the contract had changed.
//
// The requirement is not "short for its own sake": the confirm IS the consent
// record, so it must still show the EXACT old and new objective. What it must
// stop doing is reprinting an unchanged contract and burying the decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAmendmentConfirmBody, buildTweakConfirmBody, buildTweakRationaleBody, TweakConfirmComponent,
} from '../extensions/confirm-draft.js';

const LONG_OBJECTIVE =
  'Make a mid-audit provider failure resume the independent auditor own pi session instead of '
  + 'discarding its completed work, including every retained-session interaction and the durable '
  + 'ledger lineage requirement, while keeping verdict integrity unchanged.';

test('the amendment confirm keeps the exact old and new objective text', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
  });
  // Consent fidelity: both sides verbatim, so the user approves a specific pair.
  assert.match(body, /Ship the feature\b/, 'the old objective appears');
  assert.match(body, /Ship the feature and its tests/, 'the new objective appears');
  assert.match(body, /auditor will judge/, 'the consequence is still stated');
});

test('an unchanged contract is NOT reprinted — that was most of the wall', () => {
  const contract = 'npm run check exits 0; npm run release:check exits 0';
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
    oldContract: contract,
    newContract: contract,
  });
  assert.equal(body.includes(contract), false,
    'an identical contract must not be echoed twice; it is not part of the decision');
  assert.match(body, /Contract: unchanged/, 'the user is still told the contract is untouched');
});

test('a changed contract IS shown, both sides', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
    oldContract: 'npm run check exits 0',
    newContract: 'npm run check and npm run release:check both exit 0',
  });
  assert.match(body, /npm run check exits 0/, 'the previous contract is shown when it changes');
  assert.match(body, /release:check/, 'the proposed contract is shown when it changes');
});

test('a long objective is NEVER clipped — consent exactness beats brevity', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: LONG_OBJECTIVE,
    newObjective: `${LONG_OBJECTIVE} Additionally record lineage.`,
  });
  // Both sides appear in full: the user is approving this exact pair.
  assert.ok(body.includes(LONG_OBJECTIVE.trim()),
    'the previous objective must appear verbatim, not abbreviated');
  assert.ok(body.includes(`${LONG_OBJECTIVE} Additionally record lineage.`),
    'the proposed objective must appear verbatim');
  assert.equal(body.includes('…'), false,
    'the objective is never clipped; only secondary contract detail may be');
});

test('a very long CONTRACT is shortened with a visible marker', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
    oldContract: 'x'.repeat(4000),
    newContract: 'y'.repeat(4000),
  });
  assert.match(body, /…/, 'secondary contract detail carries an explicit ellipsis marker');
  assert.ok(body.length < 900, `the contract detail must stay bounded, got ${body.length} chars`);
});

test('the compact body is measurably smaller than the old five-section form', () => {
  const oldForm = `Current objective:\n${LONG_OBJECTIVE}\n\nCurrent verification contract:\n${'x'.repeat(300)}`
    + `\n\nProposed objective:\n${LONG_OBJECTIVE} Additionally record lineage.`
    + `\n\nProposed verification contract:\n${'x'.repeat(300)}`
    + `\n\nThis changes what the independent auditor will judge. Approve this specific amendment?`;
  const compact = buildAmendmentConfirmBody({
    oldObjective: LONG_OBJECTIVE,
    newObjective: `${LONG_OBJECTIVE} Additionally record lineage.`,
    oldContract: 'x'.repeat(300),
    newContract: 'x'.repeat(300),
  });
  assert.ok(compact.length < oldForm.length / 2,
    `the default body must be materially shorter (${compact.length} vs ${oldForm.length})`);
});

/**
 * The test above calls the builder directly. That is the SAME fabricated-input
 * shape earlier audits rejected: if the real tool stopped calling this builder,
 * the suite would stay green. This drives the real `complete_goal` amendment
 * confirm and reads the body it actually passed to the UI.
 */
test('the real complete_goal amendment confirm uses the compact body', async () => {
  const { default: activate, __testOnlyLoadState, __testOnlyResetOwnerSession,
    __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } = await import('../extensions/loops/goal.js');
  const { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } = await import('./harness/mock-pi.js');
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();

  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `amendment-compact-${Math.random()}` } });
  Object.assign(ctx, { modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);

  const LONG_OLD = 'Ship the feature end to end with its tests and the release notes';
  const LONG_NEW = 'Ship the feature end to end with its tests, the release notes, and the migration guide';
  const SAME_CONTRACT = 'npm run check exits 0';
  seedState(cwd, {
    goal: seedGoal({ status: 'active', objective: LONG_OLD, verificationContract: SAME_CONTRACT }),
    list: [],
  });
  __testOnlyLoadState(cwd);

  // Capture the body the real tool passes to the confirm dialog.
  const seen: Array<{ title: string; body: string }> = [];
  Object.assign(ctx.ui, {
    confirmImpl: (title: string, body: string) => {
      seen.push({ title, body });
      return Promise.resolve(false); // decline: we only inspect the rendering
    },
  });

  await pi.runTool('complete_goal', {
    completionSummary: 'Outcome: shipped. Changed: feature. Evidence: tests. Tests: pass. Unresolved: none. Next: none.',
    verificationSummary: 'Fixture only',
    newObjective: LONG_NEW,
  }, ctx);

  const amendment = seen.find((entry) => /scope amendment/i.test(entry.title));
  assert.ok(amendment, 'the real complete_goal path opened the scope-amendment confirm');
  // Consent fidelity: the exact old and new objective both appear.
  assert.ok(amendment!.body.includes(LONG_OLD), 'the exact previous objective is shown');
  assert.ok(amendment!.body.includes(LONG_NEW), 'the exact proposed objective is shown');
  // Compactness: an unchanged contract is not echoed.
  assert.equal(amendment!.body.includes(SAME_CONTRACT), false,
    'the unchanged contract must not be reprinted by the real path');
  assert.match(amendment!.body, /Contract: unchanged/, 'the user is told the contract is untouched');
  // And it is materially shorter than the old five-section form would have been.
  const oldFormLength = 5 * SAME_CONTRACT.length + LONG_OLD.length + LONG_NEW.length + 200;
  assert.ok(amendment!.body.length < oldFormLength,
    `the real confirm body must be shorter than the old form (${amendment!.body.length} vs ${oldFormLength})`);
});

/**
 * The auditor's objection: the screenshots show `/goal tweak`, and an earlier
 * revision only compacted the `complete_goal` amendment call. This drives the
 * REAL `cmdTweak` — the path those screenshots came from.
 */
test('the real /goal tweak card is compact, exact, and expands with --rationale', async () => {
  const { cmdTweak } = await import('../extensions/goal-commands.js');
  const goalMod = await import('../extensions/loops/goal.js');
  const activate = goalMod.default;
  const __testOnlyLoadState = goalMod.__testOnlyLoadState;
  const { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } = await import('./harness/mock-pi.js');
  goalMod.__testOnlyResetOwnerSession(); goalMod.__testOnlyResetStaleFlag(); goalMod.__testOnlyResetTerminalFlags();

  const OLD = 'Audit the widget surface end to end and record what the user sees';
  const NEW = 'Audit the widget surface end to end, record what the user sees, and file the defects';
  const CONTRACT = 'npm run check exits 0';

  async function run(args: string): Promise<{ body: string; applied: boolean; notifies: string[]; options: string[]; card: { render: (w: number) => string[]; toggleRationale: () => void } | undefined }> {
    const cwd = tmpCwd();
    const pi = new MockPi();
    activate(pi.api);
    const ctx = makeMockCtx(cwd, { sessionManager: { name: `tweak-${Math.random()}` } });
    Object.assign(ctx, { modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
    await pi.fire('session_start', { reason: 'startup' }, ctx);
    seedState(cwd, {
      goal: seedGoal({ status: 'active', objective: OLD, verificationContract: CONTRACT }),
      list: [],
    });
    __testOnlyLoadState(cwd);
    const bodies: string[] = [];
    Object.assign(ctx.ui, {
      confirmImpl: (title: string, body: string) => { bodies.push(body); return Promise.resolve(false); },
      selectImpl: undefined,
    });
    await cmdTweak(args, ctx as never, 'goal');
    return {
      body: bodies[0] ?? '',
      applied: bodies.length > 0,
      notifies: ctx.ui.notifies.map((n: { message: string }) => n.message),
      options: (ctx.ui as { lastCardDeps?: { options: string[] } }).lastCardDeps?.options ?? [],
      card: (ctx.ui as { lastCard?: unknown }).lastCard as { render: (w: number) => string[]; toggleRationale: () => void } | undefined,
    };
  }

  // Default: compact, and both objectives are present EXACTLY.
  const compact = await run(`${OLD} and file the defects. Done when: ${CONTRACT}`);
  assert.ok(compact.applied, 'the real tweak path opened its confirmation');
  assert.ok(compact.body.includes(OLD), 'the exact previous objective is shown');
  assert.ok(compact.body.includes(NEW) || compact.body.includes(`${OLD} and file the defects`),
    'the exact proposed objective is shown');
  assert.equal(compact.body.includes('CURRENT:'), false, 'the old CURRENT/NEW wall is gone');
  assert.equal(compact.body.includes(CONTRACT), false, 'the contract body is not in the default card');
  // The expand is IN THE DIALOG, so the compact body carries no "re-run with a
  // flag" instruction — the action is on the card (asserted below).
  assert.equal(/re-run with --rationale/.test(compact.body), false,
    'the card does not ask the user to cancel and retype the command');
  // The real command builds the toggle card: the expand action is on offer in
  // the dialog the user actually gets, not only in a unit fixture.
  assert.ok(compact.options.includes('Show the full rationale'),
    `the real /goal tweak dialog must offer the expand (got ${JSON.stringify(compact.options)})`);
  assert.ok(compact.options.includes('Confirm — apply this tweak'), 'confirm semantics are unchanged');
  assert.ok(compact.options.includes('Cancel — change nothing'), 'cancel semantics are unchanged');

  // The REAL call site passes a height. Without one the component renders with
  // POSITIVE_INFINITY, pageSize is infinite and the advertised PgUp/PgDn scroll
  // cannot move — so this is asserted on the component confirmTweak actually
  // constructed, not on a fixture.
  assert.ok(compact.card, 'confirmTweak built a card component');
  compact.card!.toggleRationale();
  const realRows = compact.card!.render(80);
  assert.ok(realRows.length <= 20,
    `the card the real call site built rendered ${realRows.length} rows — it was built without a height`);

  // The expand: the same gate, opened expanded via --rationale.
  const expanded = await run(`--rationale ${OLD} and file the defects. Done when: ${CONTRACT}`);
  assert.ok(expanded.applied, 'the expanded card is still the same consent gate');
  assert.ok(expanded.body.includes('CURRENT:'), 'the full form carries the reference labels');
  assert.ok(expanded.body.includes(CONTRACT), 'the full contract text is reachable through the expand');
  assert.ok(expanded.body.length > compact.body.length, 'the expand is genuinely richer than the default');
});

// The audit-round-2 requirement: the rationale must be reachable FROM THE CARD.
// A `--rationale` flag that needs the user to cancel and retype the command is a
// re-run, not an expand. These cases drive the real component the real dialog
// builds, so they cannot pass by a flag alone.
test('the tweak card expands the rationale in place and keeps one consent gate', async () => {
  const {
    TweakConfirmComponent, TWEAK_CONFIRM_ACTION, TWEAK_RATIONALE_ACTION,
    TWEAK_COLLAPSE_ACTION, TWEAK_CANCEL_ACTION, buildTweakConfirmBody, buildTweakRationaleBody,
  } = await import('../extensions/confirm-draft.js');

  const input = {
    currentObjective: 'Audit the widget surface',
    newObjective: 'Audit the widget surface and file the defects',
    hasNewContract: true,
    newContract: 'npm run check exits 0',
    clearsContract: false,
    mode: 'goal' as const,
    title: 'Tweak goal?',
  };
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const kb = { matches: (_d: string, key: string) => key === 'tui.select.confirm' };
  let resolved: string | undefined | 'unset' = 'unset';
  let renders = 0;

  const card = new TweakConfirmComponent(input, () => { renders++; }, theme, kb as never, (v) => { resolved = v; });

  // Opens compact, with all three actions on offer.
  assert.equal(card.isExpanded(), false);
  assert.equal(card.bodyText(), buildTweakConfirmBody(input));
  assert.deepEqual(card.dialogDeps.options, [TWEAK_CONFIRM_ACTION, TWEAK_RATIONALE_ACTION, TWEAK_CANCEL_ACTION]);
  assert.equal(resolved, 'unset', 'building the card applies nothing');

  // Expanding is a no-op on the decision: same dialog, same gate, still open.
  card.toggleRationale();
  assert.equal(card.isExpanded(), true);
  assert.equal(card.bodyText(), buildTweakRationaleBody(input), 'the expanded body is the pre-existing rationale text');
  assert.ok(card.bodyText().includes('npm run check exits 0'), 'the full rationale carries the contract');
  assert.equal(resolved, 'unset', 'expanding never answers the question');
  assert.ok(renders > 0, 'the expand re-renders the open dialog rather than closing it');

  // The action itself now reads as a collapse, so the toggle works both ways.
  assert.deepEqual(card.dialogDeps.options, [TWEAK_CONFIRM_ACTION, TWEAK_COLLAPSE_ACTION, TWEAK_CANCEL_ACTION]);
  assert.match(card.render(80).join('\n'), /Hide the full rationale/);
  card.toggleRationale();
  assert.equal(card.isExpanded(), false, 'the expand toggles back');
  assert.equal(resolved, 'unset');

  // Confirm from the expanded state still records the exact consent: a card
  // opened expanded (the --rationale form) confirms with the same action.
  let confirmedExpanded: string | undefined | 'unset' = 'unset';
  const openedExpanded = new TweakConfirmComponent(
    { ...input, showRationale: true }, () => {}, theme, kb as never, (v) => { confirmedExpanded = v; },
  );
  assert.equal(openedExpanded.isExpanded(), true, '--rationale opens the card already expanded');
  assert.equal(openedExpanded.dialogDeps.options[0], TWEAK_CONFIRM_ACTION, 'confirm stays the first action');
  openedExpanded.handleInput('tui.select.confirm');
  assert.equal(confirmedExpanded, TWEAK_CONFIRM_ACTION, 'confirming from the expanded card applies the tweak');
});

test('cancelling after expanding still changes nothing', async () => {
  const { TweakConfirmComponent } = await import('../extensions/confirm-draft.js');
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const kb = { matches: (_d: string, key: string) => key === 'tui.select.cancel' };
  let resolved: string | undefined | 'unset' = 'unset';
  const card = new TweakConfirmComponent(
    { currentObjective: 'a', newObjective: 'b', hasNewContract: false, clearsContract: false, mode: 'goal' as const },
    () => {}, theme, kb as never, (v) => { resolved = v; },
  );
  card.toggleRationale();
  card.handleInput('tui.select.cancel');
  assert.equal(resolved, undefined, 'esc after expanding is still a cancel');
});

test('the tweak card reports its CURRENT body to the host after an expand', async () => {
  // The host reads dialogDeps to know what the user was shown. A snapshot taken
  // at construction would report the compact body even while the expanded one is
  // on screen — the exact confusion this round is about.
  const { TweakConfirmComponent } = await import('../extensions/confirm-draft.js');
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const card = new TweakConfirmComponent(
    { currentObjective: 'a', newObjective: 'b', hasNewContract: true, newContract: 'gate', clearsContract: false, mode: 'goal' as const, title: 'Tweak goal?' },
    () => {}, theme, { matches: () => false } as never, () => {},
  );
  const before = card.dialogDeps.body;
  card.toggleRationale();
  const after = card.dialogDeps.body;
  assert.notEqual(before, after, 'dialogDeps must reflect the expanded state');
  assert.ok(after.includes('gate'), 'the host sees the rationale it is displaying');
});

// audit round 3 [MED]: the observed note.md objective is a long paragraph, and
// every earlier case here used a short one. For a 400-word objective the old
// body was ~4,079 characters (~50 rows at 80 columns) — still the wall. These
// cases use the real shape and the real component.
const LONG_COMMON = 'Audit the whole GLLA operator surface end to end, covering the widget, the status footer, the settings menu, the list queue, the auditor display and every recovery card, then record precisely what the user sees in each of those places so that a reader who was not present can follow the narrative without guessing at any step of the way, and';
const LONG_CURRENT = `${LONG_COMMON} stop there.`;
const LONG_NEXT = `${LONG_COMMON} file each defect as a tracked item with its own reproduction.`;

test('a long objective keeps BOTH objectives in full on the default card', () => {
  const input = {
    currentObjective: LONG_CURRENT,
    newObjective: LONG_NEXT,
    hasNewContract: false,
    clearsContract: false,
    mode: 'goal' as const,
    title: 'Tweak goal?',
  };
  const body = buildTweakConfirmBody(input);

  // The consent record is exact, on the default card, for the long objective the
  // note actually reported. An elided diff is not a consent record.
  assert.ok(body.includes(LONG_CURRENT), 'the FULL previous objective is on the default card');
  assert.ok(body.includes(LONG_NEXT), 'the FULL proposed objective is on the default card');
  assert.equal(body.includes('…'), false, 'nothing in the objective pair is elided');
  assert.equal(/\[-|\[\+/.test(body), false, 'no diff markers on the consent pair');

  // Shortness comes from what is NOT on the card, not from dropping consent
  // text: no duplicated contract, no reference labels, no five-section wall.
  assert.equal(body.includes('CURRENT:'), false, 'the CURRENT: label belongs to the expand');
  assert.equal(body.includes('NEW:'), false, 'the NEW: label belongs to the expand');
  assert.equal(body.includes('Verification contract:'), false, 'the contract body belongs to the expand');
  assert.ok(body.split('\n').length <= 5,
    `the default body is the pair plus one consequence line, got ${body.split('\n').length} lines`);

  // And the rationale still carries everything, reachable from this same card.
  const rationale = buildTweakRationaleBody(input);
  assert.ok(rationale.includes(LONG_CURRENT) && rationale.includes(LONG_NEXT));
  assert.ok(rationale.includes('CURRENT:'), 'the expand is what carries the labelled form');
});

test('a long objective is bounded on screen by paging, and paging reveals the whole exact text', () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const kb = { matches: (d: string, key: string) => d === key };
  const rows = 20;
  const card = new TweakConfirmComponent(
    {
      currentObjective: LONG_CURRENT, newObjective: LONG_NEXT,
      hasNewContract: false, clearsContract: false, mode: 'goal', title: 'Tweak goal?',
      getHeight: () => rows - 4,
    },
    () => {}, theme, kb as never, () => {},
  );

  // On screen the card fits the terminal at a normal width, with the actions
  // and the paging affordance visible.
  const first = card.render(80);
  assert.ok(first.length <= rows, `the card fits the terminal: ${first.length} rows`);
  assert.ok(first.some((l) => l.includes('Confirm — apply this tweak')), 'Confirm visible');
  assert.ok(first.some((l) => l.includes('Cancel — change nothing')), 'Cancel visible');
  assert.ok(first.some((l) => l.includes('PgUp/PgDn scroll')), 'the overflow is disclosed with a paging hint');

  // Page through the whole card at a width that does not truncate rows, and
  // prove the exact pair appears in full across the pages. This is why a
  // bounded viewport is compatible with exactness: nothing is dropped, it is
  // only paged.
  const pages: string[] = [...card.render(2000)];
  let guard = 0;
  let previous = pages.length;
  while (guard++ < 200) {
    const before = card.render(2000);
    card.handleInput('tui.select.pageDown');
    const after = card.render(2000);
    if (after.join('\n') === before.join('\n')) break;
    pages.push(...after.slice(0, Math.max(0, after.length - previous)));
    previous = after.length;
  }
  const paged = pages.join('\n');
  assert.ok(paged.includes(LONG_CURRENT), 'paging reveals the whole previous objective verbatim');
  assert.ok(paged.includes(LONG_NEXT), 'paging reveals the whole proposed objective verbatim');
});

test('a 400-word objective is exact on the default card and bounded on screen', () => {
  // The auditor measured the observed case specifically: a 400-word objective
  // produced a 4,079-character body. That size must not buy elision — it must
  // page.
  const filler = 'and confirm that every surface keeps reporting the same facts in the same order so a reader can compare them without re-reading the whole document ';
  const base = `Audit the whole GLLA operator surface end to end. ${filler.repeat(20)}`;
  const current = `${base}Stop there.`;
  const next = `${base}File each defect as a tracked item.`;
  assert.ok(current.length > 2000, `fixture should be genuinely long (${current.length} chars)`);

  const body = buildTweakConfirmBody({
    currentObjective: current, newObjective: next,
    hasNewContract: false, clearsContract: false, mode: 'goal' as const,
  });
  assert.ok(body.includes(current) && body.includes(next),
    'both full objectives are on the default card, however long they are');

  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const kb = { matches: (d: string, key: string) => d === key };
  const rows = 20;
  const card = new TweakConfirmComponent(
    {
      currentObjective: current, newObjective: next,
      hasNewContract: false, clearsContract: false, mode: 'goal', title: 'Tweak goal?',
      getHeight: () => rows - 4,
    },
    () => {}, theme, kb as never, () => {},
  );
  const rendered = card.render(80);
  assert.ok(rendered.length <= rows, `the screen stays bounded for a ${current.length}-char objective: ${rendered.length} rows`);
  assert.ok(rendered.some((l) => l.includes('PgUp/PgDn scroll')), 'and it tells the user the body is paged');
});

test('a short objective is still printed verbatim — the diff never guesses', () => {
  const input = {
    currentObjective: 'Audit the widget surface',
    newObjective: 'Audit the widget surface and file the defects',
    hasNewContract: false, clearsContract: false, mode: 'goal' as const,
  };
  const body = buildTweakConfirmBody(input);
  assert.ok(body.includes('From: Audit the widget surface\n'), body);
  assert.ok(body.includes('To:   Audit the widget surface and file the defects'), body);
  assert.equal(/showing the changed region/.test(body), false, 'nothing is elided, so nothing is disclosed as elided');
});

test('the expanded rationale scrolls: PgUp/PgDn move the view and Confirm/Cancel stay visible', () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const kb = { matches: (d: string, key: string) => d === key };
  const rows = 20;
  const card = new TweakConfirmComponent(
    {
      currentObjective: LONG_CURRENT, newObjective: LONG_NEXT,
      hasNewContract: true, newContract: 'npm run release:check exits 0', clearsContract: false,
      mode: 'goal', title: 'Tweak goal?',
      // The real call site passes exactly this (goal-commands.ts confirmTweak).
      getHeight: () => rows - 4,
    },
    () => {}, theme, kb as never, () => {},
  );
  card.toggleRationale();

  const first = card.render(80);
  assert.ok(first.length <= rows, `the card fits the terminal: ${first.length} rows`);
  assert.ok(first.some((l) => l.includes('Confirm — apply this tweak')), 'Confirm stays visible');
  assert.ok(first.some((l) => l.includes('Cancel — change nothing')), 'Cancel stays visible');
  assert.ok(first.some((l) => l.includes('PgUp/PgDn')), 'the scroll hint is shown because the body overflows');

  // Page down, and prove the window actually moved (different body rows).
  card.handleInput('tui.select.pageDown');
  const second = card.render(80);
  assert.notDeepEqual(second, first, 'PgDn moved the body window');
  assert.ok(second.some((l) => l.includes('Confirm — apply this tweak')), 'Confirm still visible after scrolling');
  assert.ok(second.some((l) => l.includes('Cancel — change nothing')), 'Cancel still visible after scrolling');

  // And back up.
  card.handleInput('tui.select.pageUp');
  assert.deepEqual(card.render(80), first, 'PgUp returns to the first window');
});

test('without a height the card cannot scroll — which is why the call site passes one', () => {
  // Pins the defect that made PgUp/PgDn decorative: an unset height makes
  // pageSize infinite, so the advertised scroll is a no-op and the body renders
  // unbounded. The real call site (confirmTweak) always supplies getHeight; this
  // case documents the failure mode so the omission cannot come back silently.
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const kb = { matches: (d: string, key: string) => d === key };
  const card = new TweakConfirmComponent(
    { currentObjective: LONG_CURRENT, newObjective: LONG_NEXT, hasNewContract: false, clearsContract: false, mode: 'goal' },
    () => {}, theme, kb as never, () => {},
  );
  card.toggleRationale();
  const before = card.render(80);
  card.handleInput('tui.select.pageDown');
  assert.deepEqual(card.render(80), before,
    'with no height the page-down cannot move the view — this is the bug the call site fixes');
  assert.ok(before.length > 20, `and the body renders unbounded (${before.length} rows)`);
});
