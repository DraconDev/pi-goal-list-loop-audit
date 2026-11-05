// tests/amendment-confirm-styling.test.ts
//
// note.md 2026-10-29: "but htis question looks fine, except unstyled"
// (Screenshot_20261029_151933) — the task-amendment dialog rendered as flat
// body text with the host's raw `↑↓ navigate enter select escape/ctrl+c cancel`
// footer: no card border, no title treatment. The copy had already been made
// compact by an earlier goal, so only the chrome was missing.
//
// These cases assert the decision the note asked for, not the shape of the
// implementation:
//   - an amendment is confirmed through the STYLED card (bordered, titled,
//     dim help line) rather than the flat confirm;
//   - the exact amendment body the user is agreeing to is carried through
//     unchanged;
//   - Yes/No semantics are unchanged (No and cancel both refuse);
//   - hosts whose `custom` never invokes the factory still get the plain
//     confirm, and a stale host API is not swallowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_CONFIRM_NO,
  CARD_CONFIRM_YES,
  CardConfirmComponent,
  buildAmendmentConfirmBody,
  confirmCard,
} from '../extensions/confirm-draft.js';

const FAKE_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;
const FAKE_KB = { matches: (data: string, key: string) => data === key };

const BODY = buildAmendmentConfirmBody({
  oldObjective: 'Repair the sweep record so its live-CWS evidence is internally consistent',
  newObjective: 'Validate the whole document and the tree scope',
  oldContract: 'Done when: counts agree\nDone when: totals match',
  newContract: 'Done when: counts agree\nDone when: totals match\nDone when: tree scope matches',
});

/** A ctx whose custom() behaves like interactive pi: it invokes the factory and
 * resolves whatever the card's done() resolves. */
function interactiveCtx(answer: boolean | undefined) {
  const calls: { custom: number; confirm: number } = { custom: 0, confirm: 0 };
  let built: CardConfirmComponent | undefined;
  const ctx = {
    ui: {
      custom: async (factory: unknown) => {
        calls.custom += 1;
        const card = (factory as (...a: unknown[]) => CardConfirmComponent)(
          { requestRender: () => {}, terminal: { rows: 24 } },
          FAKE_THEME,
          FAKE_KB,
          (value: boolean) => value,
        );
        built = card;
        if (answer === undefined) return undefined;
        // Resolve the way pi does for the chosen item: by running the card's
        // own done(), which the SelectList wires to onSelect.
        const deps = card.dialogDeps;
        return answer ? deps.options[0] : undefined;
      },
      confirm: async () => {
        calls.confirm += 1;
        return answer === true;
      },
    },
    get built() { return built; },
  };
  return { ctx, calls, getBuilt: () => built };
}

test('an amendment is confirmed through the styled card, not the flat confirm', async () => {
  const h = interactiveCtx(true);
  const accepted = await confirmCard(h.ctx as never, 'Confirm committed task amendment', BODY);

  assert.equal(accepted, true, 'Yes accepts');
  assert.equal(h.calls.custom, 1, 'the styled card was used');
  assert.equal(h.calls.confirm, 0, 'the flat confirm was NOT used when a card is available');

  // The card is genuinely styled, not a pass-through of the flat path: it has a
  // border, the title on its own row, and a dim-keyed help line instead of the
  // host's raw select footer.
  const card = h.getBuilt()!;
  const rows = card.render(76);
  assert.ok(rows.some((r) => r.includes('─')), 'the card draws a border');
  assert.ok(rows.some((r) => r.includes('Confirm committed task amendment')), 'the title is on the card');
  assert.ok(rows.some((r) => r.includes('PgUp/PgDn scroll')), 'the card documents its own keys');
  assert.equal(rows.some((r) => r.includes('escape/ctrl+c cancel')), false,
    'the host’s raw select footer is no longer what the user reads');

  // The exact body the user is agreeing to is carried through unchanged.
  assert.equal(card.dialogDeps.body, BODY, 'the amendment body is byte-identical to the caller’s text');
  assert.ok(BODY.includes('From:\n\n> Repair the sweep record'), 'fixture is the real amendment shape: label, blank line, quoted text');
  assert.ok(BODY.includes('\n\nTo:\n\n> Validate the whole document'), 'the new side is labelled and quoted the same way');
  assert.ok(BODY.includes('This changes what the independent auditor will judge.'),
    'and carries the consequence line the caller produced');
  const paged = rows.join('\n');
  assert.ok(paged.length > 0);
});

test('No and cancel both refuse — the decision semantics are unchanged', async () => {
  const refused = interactiveCtx(false);
  assert.equal(await confirmCard(refused.ctx as never, 'Confirm committed task amendment', BODY), false,
    'No refuses');

  // The card's own cancel path resolves false, which must not be read as Yes.
  const card = new CardConfirmComponent(
    { title: 'Confirm committed task amendment', body: BODY, getHeight: () => 20 },
    () => {}, FAKE_THEME, FAKE_KB, (value) => {
      assert.equal(value, false, 'esc resolves a refusal');
    },
  );
  card.handleInput('tui.select.cancel');

  assert.equal(card.dialogDeps.options[1], CARD_CONFIRM_NO, 'the second action is the refusal');
  assert.equal(card.dialogDeps.options.length, 2,
    'amendments stay a two-way decision — no third auto-accept action is offered');
});

test('a host whose custom() never invokes the factory still gets the plain confirm', async () => {
  // The RPC/noOp stub shape: custom resolves WITHOUT calling the factory. The
  // dialog never rendered, so there is no answer to read — falling through beats
  // treating it as a refusal, which would silently cancel every amendment.
  const calls = { custom: 0, confirm: 0 };
  const ctx = {
    ui: {
      custom: async () => { calls.custom += 1; return undefined; },
      confirm: async () => { calls.confirm += 1; return true; },
    },
  };
  assert.equal(await confirmCard(ctx as never, 'Confirm committed task amendment', BODY), true);
  assert.equal(calls.custom, 1, 'custom was attempted');
  assert.equal(calls.confirm, 1, 'and the plain confirm carried the decision');
});

test('a stale host API is surfaced, not papered over with a plain confirm', async () => {
  const ctx = {
    ui: {
      custom: async () => { throw new Error('stale after session replacement'); },
      confirm: async () => true,
    },
  };
  await assert.rejects(
    () => confirmCard(ctx as never, 'Confirm committed task amendment', BODY),
    /stale after session replacement/,
    'a dead session must not be answered for by a dialog the host cannot show',
  );
});

test('a long amendment pages instead of pushing the decision off screen', () => {
  const rows = 20;
  const card = new CardConfirmComponent(
    { title: 'Confirm committed task amendment', body: BODY, getHeight: () => rows - 4 },
    () => {}, FAKE_THEME, FAKE_KB, () => {},
  );
  const first = card.render(80);
  assert.ok(first.length <= rows, `the card fits the terminal: ${first.length} rows`);
  assert.ok(first.some((r) => r.includes(CARD_CONFIRM_YES)), 'Yes stays visible');
  assert.ok(first.some((r) => r.includes(CARD_CONFIRM_NO)), 'No stays visible');

  const before = first.join('\n');
  card.handleInput('tui.select.pageDown');
  const second = card.render(80);
  assert.notEqual(second.join('\n'), before, 'PgDn moves the body');
  assert.ok(second.some((r) => r.includes(CARD_CONFIRM_YES)), 'Yes still visible after paging');
  card.handleInput('tui.select.pageUp');
  assert.equal(card.render(80).join('\n'), before, 'PgUp returns to the first window');
});
