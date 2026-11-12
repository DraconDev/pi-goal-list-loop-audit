// Render the real end-of-task report card through the registered production
// renderer, at the two widths a person actually sees: a narrow split pane and
// a normal terminal. Dark and light are both captured because the semantic
// section colors differ between them.
//
// Field 2026-11-11 ("more like opencode's end-of-task summary"): the card is
// now ONE report — headline, prose lede, per-area change subsections, the
// always-on verification table (bullets below the narrow threshold),
// follow-ups, next steps, and a single receipt line. This capture uses the
// production composer and the production renderer, so the fixture cannot
// describe a shape the product does not produce.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { visibleWidth, type Component } from '@earendil-works/pi-tui';
import { loadThemeFromPath } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { registerSummaryRenderer } from '../extensions/summary-renderer.js';
import { buildRichTerminalParts, composeRichTerminalLines } from '../extensions/completion-summary.js';
import { MockPi } from '../tests/harness/mock-pi.js';

const content = composeRichTerminalLines(buildRichTerminalParts({
  outcome: 'Completion reports now read as one account of the work', countsLine: '', chat: true,
  groups: [
    { title: 'Report shape', findings: ['The card is one document: headline, lede, changes, verification, follow-ups, next steps, receipt — sections, not an audit log for extensions/completion-summary.ts:1200'] },
    { title: 'Verification', findings: ['The gate inventory is always visible, derived from the notes rather than claimed — impossible gate rows stay REPORTED, never PASS'] },
  ],
  details: ['Unresolved: Provider results are still unknown.', 'Left out: The narrow-window check is not wired into smoke.',
    'Next: The narrow-window check is not wired into smoke.', 'Next: Wire the 390px case into the browser gate.'],
  gates: [
    { gate: 'Release gate', command: 'npm run release:check', scope: 'full suite', notes: '4552 passed, 0 failed' },
    { gate: 'Typecheck', command: 'npm run check', scope: 'all sources', notes: 'tsc --noEmit exited 0' },
  ],
})).join('\n');
const directory = path.resolve('audit/summary-captures'); fs.mkdirSync(directory, { recursive: true });
for (const appearance of ['dark', 'light']) for (const width of [40, 120]) {
  const theme = loadThemeFromPath(path.resolve(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), 'truecolor');
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  const message = { content, details: { terminalApprovalGoalId: 'capture-fixture' } };
  const renderer = pi.messageRenderers.get('goal-event')!(message as never, { outputPad: 1 } as never, theme) as Component;
  const rows = renderer.render(width);
  if (rows.some(row => visibleWidth(row) > width)) throw new Error('Renderer exceeded terminal width');
  // The capture must prove the narrow fallback rather than assume it: a receipt
  // narrower than the table threshold may not print a raw pipe row.
  if (width < 50 && rows.some(row => row.trim().startsWith('|'))) throw new Error('Narrow capture printed a raw table row');
  if (message.content !== content || /\x1b/.test(content)) throw new Error('Durable fixture was mutated or contains ANSI');
  const stem = `${appearance}-${width}`;
  fs.writeFileSync(path.join(directory, `${stem}.ansi`), rows.join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(directory, `${stem}.json`), JSON.stringify({
    width,
    rows: rows.length,
    appearance,
    source: 'registered goal-event production report renderer; installed Pi dark/light theme',
    durableContentUnchanged: true,
    maxVisibleWidth: Math.max(...rows.map(visibleWidth)),
    narrowTableFallback: width < 50 ? 'bullets' : 'table',
  }, null, 2) + '\n');
}
fs.writeFileSync(path.join(directory, 'fixture.md'), content + '\n');
