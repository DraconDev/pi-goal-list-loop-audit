// Render real terminal receipts through the registered production renderer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { visibleWidth, type Component } from '@earendil-works/pi-tui';
import { loadThemeFromPath } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { registerSummaryRenderer } from '../extensions/summary-renderer.js';
import { buildRichTerminalParts, composeRichTerminalLines } from '../extensions/completion-summary.js';
import { MockPi } from '../tests/harness/mock-pi.js';

const content = composeRichTerminalLines(buildRichTerminalParts({
  outcome: 'Completion summaries are easier to scan', countsLine: '', chat: true,
  groups: [
    { title: 'Layout', findings: ['The menu stays readable at narrow widths — browser probe at 390px confirmed no document overflow'] },
    { title: 'Evidence', findings: ['Neutral observations do not imply passing verification — unavailable provider results remain explicitly unknown'] },
  ],
  details: ['Unresolved: Provider results are still unknown.', 'Left out: The narrow-window check is not wired into smoke.',
    'Next: The narrow-window check is not wired into smoke. Wire the 390px case into the browser gate.'],
})).join('\n');
const directory = path.resolve('audit/summary-captures'); fs.mkdirSync(directory, { recursive: true });
for (const appearance of ['dark', 'light']) for (const width of [40, 120]) {
  const theme = loadThemeFromPath(path.resolve(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), 'truecolor');
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  const message = { content, details: { terminalApprovalGoalId: 'capture-fixture' } };
  const renderer = pi.messageRenderers.get('goal-event')!(message as never, { outputPad: 1 } as never, theme) as Component;
  const rows = renderer.render(width);
  if (rows.some(row => visibleWidth(row) > width)) throw new Error('Renderer exceeded terminal width');
  if (message.content !== content || /\x1b/.test(content)) throw new Error('Durable fixture was mutated or contains ANSI');
  const stem = `${appearance}-${width}`;
  fs.writeFileSync(path.join(directory, `${stem}.ansi`), rows.join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(directory, `${stem}.json`), JSON.stringify({ width, rows: rows.length, appearance,
    source: 'registered goal-event production summary renderer; installed Pi dark/light theme',
    durableContentUnchanged: true, maxVisibleWidth: Math.max(...rows.map(visibleWidth)) }, null, 2) + '\n');
}
fs.writeFileSync(path.join(directory, 'fixture.md'), content + '\n');
