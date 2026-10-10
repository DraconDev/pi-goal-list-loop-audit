import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectFleetHealth, formatFleetHealth } from '../extensions/fleet-health.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-fleet-test-'));
  const snapshot = { goal: { id: 'fleet-fixture', status: 'auditing', objective: 'Private objective', policy: 'goal',
    pendingCompletion: { phase: 'running', at: '2026-01-01T00:00:00Z' } }, list: [] };
  function project(name: string, content = JSON.stringify({ type: 'state', at: '2026-01-01T00:00:00Z', value: snapshot }) + '\n') {
    const dir = path.join(root, name); fs.mkdirSync(path.join(dir, '.pi-glla'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi-glla', 'active.jsonl'), content);
    fs.writeFileSync(path.join(dir, 'conversation.txt'), 'DO NOT READ CONVERSATION');
    return dir;
  }
  return { root, snapshot, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('configured roots remain read-only and saved audits never prove running or death', async () => {
  const f = setup();
  try {
    const project = f.project('one'); f.project('outside');
    const journal = path.join(project, '.pi-glla', 'active.jsonl'); const before = fs.readFileSync(journal);
    const statBefore = fs.statSync(journal);
    const report = await inspectFleetHealth([project]);
    assert.equal(report.projects.length, 1);
    assert.equal(report.projects[0]!.status!.execution, 'unconfirmed');
    assert.equal(report.projects[0]!.status!.workflow, 'auditing');
    assert.equal(report.projects[0]!.provenance, 'journal');
    assert.deepEqual(fs.readFileSync(journal), before);
    assert.equal(fs.statSync(journal).mtimeMs, statBefore.mtimeMs);
    assert.equal(fs.existsSync(path.join(project, '.pi-glla', 'session-owner.json')), false);
    assert.doesNotMatch(formatFleetHealth(report).join('\n'), /Private objective|DO NOT READ CONVERSATION|worker dead|running session detected/);
  } finally { f.cleanup(); }
});

test('fleet output never exposes saved prerequisites or private workflow text', async () => {
  const f = setup();
  try {
    const value = { ...f.snapshot, goal: { ...f.snapshot.goal, status: 'paused', pauseKind: 'blocked',
      pauseReason: 'Private case secret-case-123',
      pauseSuggestedAction: 'Send customer alice@example.com secret-case-123 evidence' } };
    const p = f.project('private', JSON.stringify({ type: 'state', at: '2026-01-01T00:00:00Z', value }));
    const report = await inspectFleetHealth([p]);
    const text = formatFleetHealth(report).join('\n');
    assert.equal(report.projects[0]!.status!.execution, 'blocked');
    assert.doesNotMatch(text, /Private objective|Private case|alice@example\.com|secret-case-123|Send customer/);
    assert.match(text, /Open this project and use \/glla status/);
  } finally { f.cleanup(); }
});

test('only explicit closure after the state observation establishes dormant', async () => {
  const f = setup();
  try {
    const p = f.project('closed'), owner = path.join(p, '.pi-glla', 'session-owner.json');
    fs.writeFileSync(owner, JSON.stringify({ generation: 12, pid: 999999, shutdownAt: '2026-01-02T00:00:00Z' }));
    let report = await inspectFleetHealth([p]);
    assert.equal(report.projects[0]!.status!.execution, 'dormant');
    assert.equal(report.projects[0]!.provenance, 'journal+closure');
    fs.writeFileSync(owner, JSON.stringify({ pid: 999999, shutdownAt: '2025-12-31T00:00:00Z' }));
    report = await inspectFleetHealth([p]);
    assert.equal(report.projects[0]!.status!.execution, 'unconfirmed');
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    report = await inspectFleetHealth([p]);
    assert.equal(report.projects[0]!.status!.execution, 'unconfirmed');
  } finally { f.cleanup(); }
});

test('malformed, missing and invalid journals cannot make a healthy report', async () => {
  const f = setup();
  try {
    f.project('bad', '{bad json}\n');
    f.project('invalid', JSON.stringify({ type: 'state', at: '2026-01-01', value: { goal: { status: 'active' }, list: [] } }));
    const missing = f.project('missing'); fs.unlinkSync(path.join(missing, '.pi-glla', 'active.jsonl'));
    const report = await inspectFleetHealth([f.root]);
    assert.equal(report.complete, false); assert.equal(report.projects.length, 3);
    assert.ok(report.projects.every(p => p.partial && !p.status));
    assert.ok(report.issues.some(i => i.kind === 'malformed'));
    assert.match(formatFleetHealth(report)[0]!, /PARTIAL/);
  } finally { f.cleanup(); }
});

test('permission-denied journals report unreadable rather than healthy', { skip: process.getuid?.() === 0 }, async () => {
  const f = setup();
  try {
    const p = f.project('denied');
    fs.chmodSync(path.join(p, '.pi-glla', 'active.jsonl'), 0);
    const report = await inspectFleetHealth([p]);
    assert.equal(report.complete, false);
    assert.equal(report.projects[0]!.status, undefined);
    assert.ok(report.issues.some(issue => issue.kind === 'unreadable' && issue.detail === 'EACCES'));
  } finally { f.cleanup(); }
});

test('a malformed newest record cannot advertise an earlier terminal snapshot', async () => {
  const f = setup();
  try {
    const value = { ...f.snapshot, goal: { ...f.snapshot.goal, status: 'complete' } };
    const p = f.project('truncated', JSON.stringify({ type: 'state', at: '2026-01-01T00:00:00Z', value }) + '\n{"type":"state"');
    const report = await inspectFleetHealth([p]);
    assert.equal(report.complete, false);
    assert.equal(report.projects[0]!.status, undefined);
  } finally { f.cleanup(); }
});

test('depth, directory, project, total-byte and time budgets report incompleteness', async () => {
  const f = setup();
  try {
    f.project('nested/project'); f.project('other');
    for (const bounds of [{ maxDepth: 0 }, { maxDirectories: 1 }, { maxProjects: 0 }, { maxTotalBytes: 0 }, { maxMs: 0 }]) {
      const report = await inspectFleetHealth([f.root], bounds);
      assert.equal(report.complete, false, JSON.stringify(bounds));
      assert.ok(report.issues.length > 0, JSON.stringify(bounds));
    }
  } finally { f.cleanup(); }
});

test('bounded journal tails keep current workflow but disclose skipped history', async () => {
  const f = setup();
  try {
    const stateLine = JSON.stringify({ type: 'state', at: '2026-01-01T00:00:00Z', value: f.snapshot }) + '\n';
    const p = f.project('large', ('{"type":"history"}\n').repeat(1000) + stateLine);
    const report = await inspectFleetHealth([p], { maxJournalBytes: 1024 });
    assert.equal(report.projects[0]!.status!.execution, 'unconfirmed');
    assert.equal(report.projects[0]!.partial, true); assert.equal(report.complete, false);
    assert.ok(report.bytesRead <= 1024);
  } finally { f.cleanup(); }
});

test('symlinks, nonregular artifacts and unavailable roots are explicit skipped/unreadable observations', async () => {
  const f = setup();
  try {
    const p = f.project('regular'), journal = path.join(p, '.pi-glla', 'active.jsonl');
    fs.unlinkSync(journal); fs.mkdirSync(journal);
    fs.symlinkSync(p, path.join(f.root, 'linked'));
    const report = await inspectFleetHealth([f.root, path.join(f.root, 'absent')]);
    assert.equal(report.complete, false);
    assert.ok(report.issues.some(i => i.kind === 'skipped' && i.detail.includes('regular file')));
    assert.ok(report.issues.some(i => i.kind === 'skipped' && i.detail.includes('Symlink')));
    assert.ok(report.issues.some(i => i.kind === 'unreadable'));
  } finally { f.cleanup(); }
});

test('/glla fleet command does not dispatch work or change sibling artifacts', async () => {
  const f = setup();
  try {
    const sibling = f.project('sibling'), current = f.project('current');
    const settings = path.join(current, '.pi-glla', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ fleetHealthRoots: [sibling] }));
    const artifact = path.join(sibling, '.pi-glla', 'active.jsonl');
    const before = fs.readFileSync(artifact), beforeFiles = fs.readdirSync(path.dirname(artifact));
    const { default: activate } = await import('../extensions/loops/goal.js');
    const { MockPi, makeMockCtx } = await import('./harness/mock-pi.js');
    const pi = new MockPi(); activate(pi.api);
    const ctx = makeMockCtx(current);
    await pi.command('glla', 'fleet', ctx);
    assert.equal(pi.userMessages.length, 0);
    assert.deepEqual(fs.readFileSync(artifact), before);
    assert.deepEqual(fs.readdirSync(path.dirname(artifact)), beforeFiles);
  } finally { f.cleanup(); }
});

test('a saved retry is not an armed timer in fleet output', async () => {
  const f = setup();
  try {
    const value = { ...f.snapshot, mainModelRecovery: { kind: 'goal', reason: 'quota', owner: { kind: 'goal', id: 'fleet-fixture' }, retryAt: new Date(Date.now() + 60000).toISOString() } };
    const p = f.project('retry', JSON.stringify({ type: 'state', at: '2026-01-01T00:00:00Z', value }));
    const report = await inspectFleetHealth([p]);
    assert.equal(report.projects[0]!.status!.execution, 'unconfirmed');
    assert.doesNotMatch(formatFleetHealth(report).join('\n'), /retry-armed/);
  } finally { f.cleanup(); }
});
