import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from './harness/host-budget.js';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { loadGlobalSettings, DEFAULT_SETTINGS } from '../extensions/goal-settings.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';
import { runDetachedGoalCompletionAuditor } from '../extensions/goal-loop-auditor-process.js';

const sessions: Array<{ pi: MockPi }> = [];
const binaries: Array<string | undefined> = [];
afterEach(async () => {
  while (sessions.length) await sessions.pop()!.pi.fire('session_shutdown', { reason: 'test-end' }, makeMockCtx(tmpCwd()));
  while (binaries.length) {
    const previous = binaries.pop();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = previous;
  }
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
});

/** A worker that records the argv it was spawned with and then dies without a
 * result, which is exactly the mid-audit provider failure under test. It also
 * writes a non-empty session file when the dispatch asked for a durable one, so
 * the parent's retained-session decision has real evidence to inspect. */
function inertWorker(cwd: string, argvLog: string): string {
  const worker = path.join(cwd, 'record-argv-auditor.mjs');
  fs.writeFileSync(worker, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
const at = argv.indexOf('--session');
if (at >= 0) { try { fs.writeFileSync(argv[at + 1], '{"kind":"session","note":"prior auditor work"}\\n'); } catch {} }
process.stdin.resume();
setTimeout(() => process.exit(3), 40);
`);
  fs.chmodSync(worker, 0o700);
  return worker;
}

function argvEntries(argvLog: string): string[][] {
  if (!fs.existsSync(argvLog)) return [];
  return fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

const goalFor = (revision = 1) => seedGoal({ revision }) as never;

test('the default dispatch asks for a durable auditor session, not --no-session', async () => {
  // The incident's root cause: durability was opt-in, so a provider failure
  // left no transcript and every retry restarted the whole audit cold.
  assert.equal(loadGlobalSettings().auditorInspection ?? DEFAULT_SETTINGS.auditorInspection, true,
    'durable auditor sessions are the default, so a retry has something to resume');

  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  const result = await runDetachedGoalCompletionAuditor({
    cwd,
    model: 'test/auditor-model',
    thinkingLevel: 'medium',
    goal: goalFor(),
    inspection: loadGlobalSettings().auditorInspection !== false,
    runtime: { pollIntervalMs: 10 },
  } as never);

  const argv = argvEntries(argvLog).at(-1) ?? [];
  assert.ok(argv.includes('--session'), `the auditor spawn persists a session: ${JSON.stringify(argv.slice(0, 8))}`);
  assert.ok(!argv.includes('--no-session'), 'the default no longer discards the transcript');
  assert.ok(result, 'the dispatch still settles');
});

test('a failed attempt keeps the session a retry can resume', async () => {
  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  await runDetachedGoalCompletionAuditor({
    cwd,
    model: 'test/auditor-model',
    thinkingLevel: 'medium',
    goal: goalFor(),
    inspection: true,
    runtime: { pollIntervalMs: 10, attemptId: () => 'resume-fixture-attempt', logicalAttemptId: 'resume-fixture-logical' },
  } as never);

  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', 'resume-fixture-attempt');
  const session = path.join(jobDir, 'session.jsonl');
  assert.ok(fs.existsSync(session), 'the transcript survives the no-result cleanup, so a retry can resume it');
  assert.ok(fs.statSync(session).size > 0, 'the retained session has content');
  const journal = fs.readFileSync(path.join(cwd, '.pi-glla', 'active.jsonl'), 'utf8');
  assert.match(journal, /"audit_session_retained_for_resume"/, 'retention is durable evidence, not just an in-memory decision');
});

test('a dispatch that did not ask for a session still reaps its scratch', async () => {
  // The original cleanup existed so kill-and-restart loops do not accumulate
  // empty dirs. With durability off there is nothing to resume, so it stays.
  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  await runDetachedGoalCompletionAuditor({
    cwd,
    model: 'test/auditor-model',
    thinkingLevel: 'medium',
    goal: goalFor(),
    inspection: false,
    runtime: { pollIntervalMs: 10, attemptId: () => 'no-session-attempt', logicalAttemptId: 'no-session-logical' },
  } as never);

  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', 'no-session-attempt');
  assert.equal(fs.existsSync(jobDir), false, 'resultless scratch without a session is still removed');
  const argv = argvEntries(argvLog).at(-1) ?? [];
  assert.ok(argv.includes('--no-session'), 'an explicit opt-out keeps the original spawn');
});

test('auditorInspection=false restores the original --no-session spawn', async () => {
  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  await runDetachedGoalCompletionAuditor({
    cwd,
    model: 'test/auditor-model',
    thinkingLevel: 'medium',
    goal: goalFor(),
    inspection: false,
    runtime: { pollIntervalMs: 10, attemptId: () => 'opt-out-attempt', logicalAttemptId: 'opt-out-logical' },
  } as never);

  const argv = argvEntries(argvLog).at(-1) ?? [];
  assert.ok(argv.includes('--no-session'), 'the setting remains a real opt-out');
  assert.ok(!argv.includes('--session'), 'no session is requested when durability is off');
});
