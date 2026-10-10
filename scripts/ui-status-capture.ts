// Reproducible production renderer fixtures; no session dispatch or journal IO.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui';
import { buildWidgetLines, buildStatusText, type DisplayTheme } from '../extensions/goal-loop-display.js';
import type { State } from '../extensions/goal-loop-core.js';
import { uiStatusOwnerKey, type UiStatusContext } from '../extensions/ui-status.js';
import { createRespecBuilder, adoptRespecRequirements } from '../extensions/respec-builder.js';
import { buildRichTerminalParts, composeRichTerminalLines } from '../extensions/completion-summary.js';
const now = Date.parse('2026-10-10T12:00:00Z');
const at = new Date(now - 600000).toISOString();
const ansi = (code: number, text: string): string => `\x1b[38;5;${code}m${text}\x1b[0m`;
const theme: DisplayTheme = { fg: (color, text) => ansi(({ accent: 147, success: 72, warning: 179, error: 168, dim: 244, muted: 245 })[color] ?? 252, text) };
const mdTheme: MarkdownTheme = {
  heading: text => ansi(147, text), link: text => ansi(147, text), linkUrl: text => ansi(244, text), code: text => ansi(179, text),
  codeBlock: text => text, codeBlockBorder: text => ansi(244, text), quote: text => ansi(244, text), quoteBorder: text => ansi(244, text),
  hr: text => ansi(244, text), listBullet: text => ansi(72, text), bold: text => `\x1b[1m${text}\x1b[0m`, italic: text => `\x1b[3m${text}\x1b[0m`,
  strikethrough: text => `\x1b[9m${text}\x1b[0m`, underline: text => `\x1b[4m${text}\x1b[0m`,
};
function goal(): State { return { goal: { id: 'capture-fixture', objective: 'Make execution evidence clear without losing the cohesive card',
  status: 'active', policy: 'goal', autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 }, createdAt: at, updatedAt: at }, list: [] }; }
function observed(state: State): UiStatusContext { return { now, generation: 1, evidence: { ownerKey: uiStatusOwnerKey(state)!, generation: 1, observedAt: now, session: 'open', turnActive: true, lastActivityAt: now - 1000 } }; }
const running = goal();
const quota = goal(); quota.mainModelRecovery = { kind: 'goal', owner: { kind: 'goal', id: quota.goal!.id }, primary: 'minimax/MiniMax-M3.1-Flash', active: 'minimax/MiniMax-M3.1-Flash', reason: 'Provider 429 · saved work retained', retryAt: new Date(now + 300000).toISOString(), startedAt: at, regularRetries: 1, hourlyProbes: 0, skipped: [] };
const quotaContext = observed(quota); quotaContext.evidence!.recovery = { retryTimerArmed: true, hourlyTimerArmed: false, turnActive: false, turnQueued: false, switchInFlight: false };
const blocked = goal(); blocked.goal!.status = 'paused'; blocked.goal!.pauseKind = 'blocked'; blocked.goal!.pauseReason = 'Version evidence missing'; blocked.goal!.pauseSuggestedAction = 'Paste AAV version';
const dormant = goal(); dormant.goal!.status = 'auditing'; dormant.goal!.pendingCompletion = { phase: 'running', at, attemptId: 'closed-fixture', completionSummary: 'Saved claim' };
const dormantContext = observed(dormant); dormantContext.evidence!.session = 'closed';
const unconfirmed = structuredClone(dormant);
const settling = structuredClone(dormant); settling.goal!.pendingCompletion!.phase = 'settling';
const project: State = { list: [], loop: { target: 'Build a truthful project UI', startedAt: at, active: true, iteration: 3, maxIterations: 50,
  plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [], builder: adoptRespecRequirements(createRespecBuilder('Build a truthful project UI'), [{ id: 'ui', text: 'Truthful execution', acceptance: 'Owner-fenced evidence' }]) } };
project.loop!.builder!.phase = 'replanning';
const rejection = observed(project); rejection.workflowIssue = 'Audit rejected: plan the next increment';
const completed = structuredClone(project); completed.loop!.builder!.phase = 'complete'; completed.loop!.builder!.requirements.forEach(r => { r.status = 'verified'; });
const fixtures: [string, State, UiStatusContext][] = [
  ['Running', running, observed(running)], ['Quota recovery', quota, quotaContext], ['Workflow rejection', project, rejection],
  ['Blocked prerequisite', blocked, observed(blocked)], ['Dormant audit', dormant, dormantContext],
  ['Unconfirmed audit', unconfirmed, { now }], ['Approved settlement owed', settling, { now }], ['Completed project', completed, { now }],
];
const directory = path.resolve('audit/ui-captures'); fs.mkdirSync(directory, { recursive: true });
for (const width of [40, 120]) {
  const rows: string[] = [];
  for (const [label, state, uiStatusContext] of fixtures) {
    rows.push(ansi(244, `── ${label} ${'─'.repeat(Math.max(0, width - label.length - 4))}`));
    const extras = { uiStatusContext, compactAuditCard: true, modelProvenance: { primary: 'openai-codex/gpt-6.1-sol', primarySource: 'inherited' as const, fallbackRefs: ['minimax/MiniMax-M3.1-Flash'] } };
    rows.push(...(buildWidgetLines(state, null, now, theme, width, extras) ?? []));
    rows.push(buildStatusText(state, null, now, theme, extras, width) ?? '', '');
  }
  rows.push(ansi(244, '── Outcome-first completed summary'));
  const summary = composeRichTerminalLines(buildRichTerminalParts({ outcome: 'Execution status is now truthful and actionable', countsLine: '3 areas improved', chat: true,
    details: ['Changed: Cards share owner-fenced execution evidence.', 'Unresolved: Saved journals cannot prove a live session.', 'Next: Use /glla fleet for a read-only health observation.'],
    auditHistory: [{ at, verdict: 'approved', summary: 'Fixture verification' }],
  })).join('\n');
  rows.push(...new Markdown(summary, 0, 0, mdTheme).render(width));
  fs.writeFileSync(path.join(directory, `${width}.ansi`), rows.join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(directory, `${width}.json`), JSON.stringify({ width, rows: rows.length, fixedNow: new Date(now).toISOString(), fixtures: fixtures.map(([name]) => name), source: 'production card/footer builders and pi-tui Markdown' }, null, 2) + '\n');
}
