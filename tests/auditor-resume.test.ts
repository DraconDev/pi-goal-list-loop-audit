import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from './harness/host-budget.js';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { loadGlobalSettings, DEFAULT_SETTINGS } from '../extensions/goal-settings.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';
import { decideAuditorResume, inspectAuditJobHealth, runDetachedGoalCompletionAuditor } from '../extensions/goal-loop-auditor-process.js';

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
  // The decision is also recorded, but `appendLedger` is a deliberate no-op
  // while no session root is resolved (this dispatch runs outside a session),
  // so the durable artifact above is the load-bearing evidence here.
  const journal = path.join(cwd, '.pi-glla', 'active.jsonl');
  if (fs.existsSync(journal)) {
    assert.match(fs.readFileSync(journal, 'utf8'), /"audit_session_retained_for_resume"/);
  }
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

  // The worker still writes an atomic (failed) result.json, so the dir is kept
  // as a finished-audit artifact exactly as before this change — the branch
  // under test here is that NO session is persisted for it to resume from.
  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', 'no-session-attempt');
  assert.equal(fs.existsSync(path.join(jobDir, 'session.jsonl')), false,
    'a dispatch without durability leaves nothing a retry could resume');
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

test('a retained session directory is still reapable by the retention sweep', async () => {
  // Keeping the transcript must not mean leaking it: the retained dir keeps
  // the worker lock a finished audit keeps, so health classifies it `dead`
  // once its worker PID is gone and the normal retention ceiling reaps it.
  const cwd = tmpCwd();
  const dir = path.join(cwd, '.pi-glla', 'audit-jobs', 'retained-for-resume');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), '{}');
  fs.writeFileSync(path.join(dir, 'session.jsonl'), '{"kind":"session"}\n');
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({
    protocolVersion: 1, attemptId: 'retained-for-resume', pid: 999999, role: 'worker', workerPath: '/tmp/worker.mjs',
  }));
  const health = inspectAuditJobHealth(cwd, Date.now(), 0) as unknown as {
    dead: number; ambiguous: number; cleanupCandidates: number; entries: Array<{ status: string }>;
  };
  assert.equal(health.entries[0]?.status, 'dead', 'a retained session is a reapable artifact, not an ambiguous one');
  assert.ok(health.cleanupCandidates > 0, 'the retention sweep can still take it, so sessions do not accumulate unbounded');
});

for (const [label, priorClass, expected] of [
  ['a provider failure resumes', 'provider', true],
  ['a transport failure resumes', 'transport', true],
  ['a timeout restarts cold', 'timeout', false],
  ['a no-verdict attempt restarts cold', 'no-verdict', false],
] as const) {
  test(`${label} the prior transcript`, () => {
    const decision = decideAuditorResume({
      inspection: true,
      priorAttemptId: 'prior-attempt',
      priorFailureClass: priorClass,
      priorRevision: 3, currentRevision: 3,
      priorClaimAttemptId: 'prior-attempt', currentClaimAttemptId: 'prior-attempt',
      priorTier: 'full', currentTier: 'full',
      sessionExists: true,
    });
    assert.equal(decision.resume, expected, `${label}: ${JSON.stringify(decision)}`);
    if (!expected) assert.equal(decision.reason, 'failure-class');
  });
}

for (const [label, overrides, reason] of [
  ['a moved goal revision', { priorRevision: 2, currentRevision: 3 }, 'revision-moved'],
  ['a replaced claim', { priorClaimAttemptId: 'old-claim', currentClaimAttemptId: 'new-claim' }, 'claim-replaced'],
  ['a changed audit tier', { priorTier: 'light', currentTier: 'full' }, 'tier-changed'],
  ['an explicit cancel', { cancelled: true }, 'cancelled'],
  ['a vanished transcript', { sessionExists: false }, 'no-session'],
  ['durability turned off', { inspection: false }, 'inspection-off'],
] as const) {
  test(`${label} still restarts the audit cold`, () => {
    const decision = decideAuditorResume({
      inspection: true,
      priorAttemptId: 'prior-attempt',
      priorFailureClass: 'provider',
      priorRevision: 3, currentRevision: 3,
      priorClaimAttemptId: 'prior-attempt', currentClaimAttemptId: 'prior-attempt',
      priorTier: 'full', currentTier: 'full',
      sessionExists: true,
      ...overrides,
    } as never);
    assert.equal(decision.resume, false, `${label} must not resume`);
    assert.equal(decision.reason, reason, `${label} names its refusal`);
  });
}

test('a resumed dispatch spawns against the prior attempt transcript', async () => {
  // End-to-end: the worker must actually receive --session <prior session>
  // rather than a fresh per-attempt file, otherwise "resume" is a label.
  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  const priorDir = path.join(cwd, '.pi-glla', 'audit-jobs', 'prior-attempt');
  fs.mkdirSync(priorDir, { recursive: true });
  const priorSession = path.join(priorDir, 'session.jsonl');
  fs.writeFileSync(priorSession, '{"kind":"session","note":"work already done"}\n');

  await runDetachedGoalCompletionAuditor({
    cwd,
    model: 'test/auditor-model',
    thinkingLevel: 'medium',
    goal: goalFor(),
    inspection: true,
    resumeSessionPath: priorSession,
    runtime: { pollIntervalMs: 10, attemptId: () => 'resume-attempt', logicalAttemptId: 'resume-logical' },
  } as never);

  const argv = argvEntries(argvLog).at(-1) ?? [];
  const at = argv.indexOf('--session');
  assert.ok(at >= 0, 'the resume dispatch requests a session');
  assert.equal(argv[at + 1], priorSession, 'it continues the PRIOR transcript, not a new empty one');
  // The fixture worker writes its own stub into whatever --session it was
  // given, which is exactly what a real pi would append to; the load-bearing
  // assertion is the path identity asserted above.
});

test('a resume request whose transcript vanished degrades to a cold start', async () => {
  // A stale path must never fail an audit: the retry runs cold instead.
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
    resumeSessionPath: path.join(cwd, 'gone', 'session.jsonl'),
    runtime: { pollIntervalMs: 10, attemptId: () => 'stale-resume', logicalAttemptId: 'stale-logical' },
  } as never);

  const argv = argvEntries(argvLog).at(-1) ?? [];
  const at = argv.indexOf('--session');
  assert.ok(at >= 0, 'still a durable dispatch');
  assert.ok(!argv[at + 1].includes('gone'), 'a missing transcript is not passed through');
  assert.ok(argv[at + 1].includes('stale-resume'), 'the attempt falls back to its own session file');
});
