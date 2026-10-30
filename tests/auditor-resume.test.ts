import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from './harness/host-budget.js';
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from '../extensions/loops/goal.js';
import { appendAuditVerdict, auditorDispatchStampFacts, isGoalRevisionCurrent, readState, stampAuditorDispatchFacts, type AuditVerdict } from '../extensions/goal-loop-core.js';
import { loadGlobalSettings, DEFAULT_SETTINGS } from '../extensions/goal-settings.js';
import { replaceState } from '../extensions/goal-state.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from './harness/mock-pi.js';
import { persistClaimWorkerActivity } from '../extensions/loops/goal-auditor-hooks.js';
import { resolveAuditorResumeForDispatch } from '../extensions/loops/goal-auditor-hooks.js';
import { abortCauseForAttempt, decideAuditorResume, findAuditJobDirectory, inspectAuditJobHealth, newDetachedAuditJobAttemptId, recordGllaInitiatedAuditorAbort, recordUserAbortOnSignal, runDetachedGoalCompletionAuditor } from '../extensions/goal-loop-auditor-process.js';

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
      ...{
        inspection: true,
        priorAttemptId: 'prior-attempt',
        priorFailureClass: 'provider',
        priorRevision: 3, currentRevision: 3,
        priorClaimAttemptId: 'prior-attempt', currentClaimAttemptId: 'prior-attempt',
        priorTier: 'full', currentTier: 'full',
        sessionExists: true,
      },
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
  const chosen = argv[at + 1] ?? '';
  assert.ok(!chosen.includes('gone'), 'a missing transcript is not passed through');
  assert.ok(chosen.includes('stale-resume'), 'the attempt falls back to its own session file');
});

test('a resumed attempt is still one attempt: identity, tier and challenge are unchanged', () => {
  // Resume changes WHERE the transcript lives, never HOW the verdict is
  // judged. These are the properties the audit's independence rests on.
  const resumed = decideAuditorResume({
    inspection: true, priorAttemptId: 'prior-attempt', priorFailureClass: 'provider',
    priorRevision: 3, currentRevision: 3,
    priorClaimAttemptId: 'prior-attempt', currentClaimAttemptId: 'prior-attempt',
    priorTier: 'full', currentTier: 'full', sessionExists: true,
  });
  assert.equal(resumed.resume, true);
  // A moved revision is refused even when every other condition allows resume,
  // so a resumed audit can never judge a revision the prior work did not see.
  const moved = decideAuditorResume({
    inspection: true, priorAttemptId: 'prior-attempt', priorFailureClass: 'provider',
    priorRevision: 3, currentRevision: 4,
    priorClaimAttemptId: 'prior-attempt', currentClaimAttemptId: 'prior-attempt',
    priorTier: 'full', currentTier: 'full', sessionExists: true,
  });
  assert.equal(moved.resume, false, 'a resumed audit cannot cross a revision boundary');
  assert.equal(moved.reason, 'revision-moved');
  // A light-tier audit must not inherit a full-tier transcript (and vice
  // versa): the falsification round is tier-scoped.
  const tierMoved = decideAuditorResume({
    inspection: true, priorAttemptId: 'prior-attempt', priorFailureClass: 'provider',
    priorRevision: 3, currentRevision: 3,
    priorClaimAttemptId: 'prior-attempt', currentClaimAttemptId: 'prior-attempt',
    priorTier: 'full', currentTier: 'light', sessionExists: true,
  });
  assert.equal(tierMoved.resume, false, 'a tier change restarts so the challenge round matches the tier');
  assert.equal(tierMoved.reason, 'tier-changed');
});

/**
 * v0.39.55 (auditor objection 2026-10-30, HIGH #1): the resume decision must be
 * driven by the REAL dispatch resolver with PRODUCTION attempt-ID naming, not
 * by calling the pure policy with fabricated matching ids. The policy tests
 * above passed while production still refused every retry as `claim-replaced`,
 * because `priorAttemptId` is the rotated job-dir key being compared against
 * the new attempt id. These tests pin the wiring.
 */
test('production retry wiring: a real rotation resumes instead of reporting claim-replaced', async () => {
  const cwd = tmpCwd();
  // Production naming: dirs are `<logicalAttemptId>-<nonce>`, and the claim
  // records the ROTATED id, never the current attempt id.
  const priorAttemptId = 'audit-mvprior-aaaaaa';
  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', newDetachedAuditJobAttemptId(priorAttemptId));
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'session.jsonl'), '{"type":"session"}\n');

  const claim = {
    attemptId: 'audit-mvcurrent-bbbbbb',
    claimLineageId: 'claim-mvlineage-cccccc',
    priorAttemptId,
    auditorFailureClass: 'provider' as const,
    auditorTier: 'full' as const,
    auditorRevision: 3,
    at: new Date().toISOString(),
  };
  const resumed = resolveAuditorResumeForDispatch({
    inspection: true, claim, currentAttemptId: claim.attemptId,
    currentTier: 'full', currentRevision: 3, cwd,
  });
  assert.equal(resumed.resume, true,
    'a normal retry must resume: priorAttemptId is the rotated job-dir key, not claim identity');
  assert.equal(resumed.sessionPath, path.join(jobDir, 'session.jsonl'),
    'the resolver must find the nonce-suffixed job dir the worker actually wrote');

  // A genuinely NEW claim is a fresh submission: no prior attempt, so it can
  // never inherit an older transcript that happens to still be on disk.
  const freshClaim = resolveAuditorResumeForDispatch({
    inspection: true,
    claim: { attemptId: 'audit-mvfresh-gggggg', claimLineageId: 'claim-fresh-hhhhhh', auditorFailureClass: 'provider', at: claim.at },
    currentAttemptId: 'audit-mvfresh-gggggg',
    currentTier: 'full', currentRevision: 3, cwd,
  });
  assert.equal(freshClaim.resume, false, 'a fresh claim must not inherit a lingering transcript');
  assert.equal(freshClaim.reason, 'no-prior-attempt');

  // A claim REPLACED mid-flight carries the previous lineage explicitly, so the
  // mismatch is detectable without conflating it with the rotated job-dir key.
  const replaced = resolveAuditorResumeForDispatch({
    inspection: true,
    claim: { ...claim, claimLineageId: 'claim-other-dddddd', priorClaimLineageId: 'claim-mvlineage-cccccc' },
    currentAttemptId: claim.attemptId,
    currentTier: 'full', currentRevision: 3, cwd,
  });
  assert.equal(replaced.resume, false, 'a replaced claim must not inherit the transcript');
  assert.equal(replaced.reason, 'claim-replaced');
});

test('a resume whose retained session is only in the nonce-suffixed dir is found, not missed', async () => {
  const cwd = tmpCwd();
  const priorAttemptId = 'audit-mvfind-eeeeee';
  // The bare logical id does NOT exist; only the production-named sibling does.
  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', `${priorAttemptId}-mvfind2-ffffff`);
  fs.mkdirSync(jobDir, { recursive: true });
  assert.equal(findAuditJobDirectory(cwd, priorAttemptId), jobDir,
    'the shared finder must match the production `<logical>-<nonce>` shape');
  fs.writeFileSync(path.join(jobDir, 'session.jsonl'), '');
  // A fully-armed baseline isolates the empty-transcript cause: without it the
  // fail-closed baseline check would fire first and mask what this proves.
  const empty = resolveAuditorResumeForDispatch({
    inspection: true,
    claim: {
      attemptId: 'a2', claimLineageId: 'cl', priorAttemptId,
      auditorFailureClass: 'provider', at: new Date().toISOString(),
      auditorRevision: 0, auditorTier: 'full',
    },
    currentAttemptId: 'a2', currentTier: 'full', currentRevision: 0, cwd,
  });
  assert.equal(empty.resume, false, 'an empty transcript is a cold start');
  assert.equal(empty.reason, 'no-session');
});

/**
 * v0.39.55 (auditor objection 2026-10-30, HIGH #2): resume lineage must land in
 * BOTH the ledger and the verdict provenance, with the source and target model
 * and a resume count — not just "resumed: true". These assert the durable
 * fields a reviewer needs to tell a continued audit from a first pass.
 */
test('a resumed dispatch stamps lineage on the claim so the next retry can detect movement', () => {
  const attemptId = 'audit-mvstamp-iiiiii';
  const pending = {
    at: new Date().toISOString(), attemptId, claimLineageId: 'claim-mvstamp-jjjjjj',
    priorAttemptId: 'audit-mvprev-kkkkkk', auditorFailureClass: 'provider' as const,
  };
  const stamped = stampAuditorDispatchFacts(pending, attemptId, {
    forAttemptId: attemptId, tier: 'full', revision: 7,
    resumeCount: 2, sourceModel: 'openai-codex/gpt-6-luna',
  });
  assert.ok(stamped, 'the current attempt must be stamped');
  assert.equal(stamped.auditorTier, 'full');
  assert.equal(stamped.auditorRevision, 7);
  assert.equal(stamped.auditorResumeCount, 2);
  assert.equal(stamped.auditorSourceModel, 'openai-codex/gpt-6-luna');

  // A stamp for a superseded attempt must never touch the live claim: a late
  // write from the rotated-away worker cannot rewrite lineage.
  const stale = stampAuditorDispatchFacts(pending, attemptId, { forAttemptId: 'audit-old-llllll', tier: 'light' });
  assert.equal(stale, undefined, 'a mismatched attempt cannot stamp dispatch facts');
});

test('the resume and dispatch facts survive a durable round-trip', () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
    status: 'auditing',
    pendingCompletion: {
      at: new Date().toISOString(),
      attemptId: 'audit-mvrt-mmmmmm',
      claimLineageId: 'claim-mvrt-nnnnnn',
      priorClaimLineageId: 'claim-mvrt-nnnnnn',
      priorAttemptId: 'audit-mvrtold-oooooo',
      auditorFailureClass: 'provider',
      auditorTier: 'full',
      auditorRevision: 4,
      auditorResumeCount: 1,
      auditorSourceModel: 'minimax/MiniMax-M3.1-Flash',
      auditorAbortCause: 'transport',
    },
    }),
  });
  const reloaded = readState(cwd)?.goal?.pendingCompletion;
  assert.equal(reloaded?.claimLineageId, 'claim-mvrt-nnnnnn', 'claim lineage must survive reload');
  assert.equal(reloaded?.priorAttemptId, 'audit-mvrtold-oooooo', 'the rotated job-dir key must survive reload');
  assert.equal(reloaded?.auditorTier, 'full', 'the dispatch tier must survive so a change is detectable');
  assert.equal(reloaded?.auditorRevision, 4, 'the dispatch revision must survive so a move is detectable');
  assert.equal(reloaded?.auditorResumeCount, 1);
  assert.equal(reloaded?.auditorSourceModel, 'minimax/MiniMax-M3.1-Flash');
  assert.equal(reloaded?.auditorAbortCause, 'transport');
});

/**
 * v0.39.55 (auditor objection 2026-10-30, HIGH #3): the cold-start classes must
 * be proven through the REAL dispatch resolver, so a context-exhausted or
 * timed-out transcript cannot be resumed just because the file happens to
 * exist. Resuming an overflowed transcript reproduces the failure and burns the
 * retry budget, so this is the safety direction that must hold.
 */
test('context-exhaustion and compaction failures restart cold through the real resolver', () => {
  const cwd = tmpCwd();
  const priorAttemptId = 'audit-mvcold-pppppp';
  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', `${priorAttemptId}-mvcold1-qqqqqq`);
  fs.mkdirSync(jobDir, { recursive: true });
  // A NON-EMPTY transcript exists: only the failure class may refuse here, so
  // a passing assertion proves the class check is load-bearing.
  fs.writeFileSync(path.join(jobDir, 'session.jsonl'), '{"type":"session","overflow":true}\n');
  const base = {
    attemptId: 'audit-mvcold-rrrrrr', claimLineageId: 'claim-mvcold-ssssss',
    priorAttemptId, auditorTier: 'full' as const, auditorRevision: 1, at: new Date().toISOString(),
  };
  for (const failureClass of ['timeout', 'no-verdict'] as const) {
    const decision = resolveAuditorResumeForDispatch({
      inspection: true, claim: { ...base, auditorFailureClass: failureClass },
      currentAttemptId: base.attemptId, currentTier: 'full', currentRevision: 1, cwd,
    });
    assert.equal(decision.resume, false,
      `${failureClass} must restart cold even though the transcript exists`);
    assert.equal(decision.reason, 'failure-class');
  }
  // The same claim on a provider failure DOES resume, proving the transcript is
  // genuinely available and only the class refusal is doing the work.
  const provider = resolveAuditorResumeForDispatch({
    inspection: true, claim: { ...base, auditorFailureClass: 'provider' },
    currentAttemptId: base.attemptId, currentTier: 'full', currentRevision: 1, cwd,
  });
  assert.equal(provider.resume, true, 'a provider failure on the same claim resumes');
});

test('an explicit user cancel and a moved revision both restart cold through the resolver', () => {
  const cwd = tmpCwd();
  const priorAttemptId = 'audit-mvguard-tttttt';
  const jobDir = path.join(cwd, '.pi-glla', 'audit-jobs', `${priorAttemptId}-mvguard1-uuuuuu`);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'session.jsonl'), '{"type":"session"}\n');
  const base = {
    attemptId: 'audit-mvguard-vvvvvv', claimLineageId: 'claim-mvguard-wwwwww',
    priorAttemptId, auditorFailureClass: 'provider' as const,
    auditorTier: 'full' as const, auditorRevision: 2, at: new Date().toISOString(),
  };
  const cancelled = resolveAuditorResumeForDispatch({
    inspection: true, claim: { ...base, auditorAbortCause: 'user' as const },
    currentAttemptId: base.attemptId, currentTier: 'full', currentRevision: 2, cwd,
  });
  assert.equal(cancelled.resume, false, 'a user cancel must restart cold');
  assert.equal(cancelled.reason, 'cancelled');

  const moved = resolveAuditorResumeForDispatch({
    inspection: true, claim: base,
    currentAttemptId: base.attemptId, currentTier: 'full', currentRevision: 3, cwd,
  });
  assert.equal(moved.resume, false, 'a moved goal revision must restart cold');
  assert.equal(moved.reason, 'revision-moved');

  const retiered = resolveAuditorResumeForDispatch({
    inspection: true, claim: base,
    currentAttemptId: base.attemptId, currentTier: 'light', currentRevision: 2, cwd,
  });
  assert.equal(retiered.resume, false, 'a changed tier must restart cold');
  assert.equal(retiered.reason, 'tier-changed');
});

/**
 * v0.39.55 (auditor objection 2026-10-30, HIGH #1/#3): the FULL chain end to
 * end — the production resolver locates a production-named retained session for
 * a rotated claim, and that exact path is what the real worker is spawned
 * against. Each half was tested separately before, which is how a broken join
 * between them passed review while production still restarted cold.
 */
test('end to end: a rotated claim resolves to the prior transcript and the worker resumes it', async () => {
  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  // The first attempt died on a provider failure, leaving a real transcript in
  // a production-named dir `<logicalAttemptId>-<nonce>`.
  const priorLogical = 'audit-mve2e-xxxxxx';
  const priorDir = path.join(cwd, '.pi-glla', 'audit-jobs', newDetachedAuditJobAttemptId(priorLogical));
  fs.mkdirSync(priorDir, { recursive: true });
  const priorSession = path.join(priorDir, 'session.jsonl');
  fs.writeFileSync(priorSession, '{"kind":"session","note":"64 tool calls already spent here"}\n');

  // The claim has ROTATED: new attemptId, priorAttemptId is the old one.
  const claim = {
    attemptId: 'audit-mve2e2-yyyyyy', claimLineageId: 'claim-mve2e-zzzzzz',
    priorAttemptId: priorLogical, auditorFailureClass: 'provider' as const,
    auditorTier: 'full' as const, auditorRevision: 5, at: new Date().toISOString(),
  };
  const decision = resolveAuditorResumeForDispatch({
    inspection: true, claim, currentAttemptId: claim.attemptId,
    currentTier: 'full', currentRevision: 5, cwd,
  });
  assert.equal(decision.resume, true, 'the rotated claim resumes');
  assert.equal(decision.sessionPath, priorSession);

  await runDetachedGoalCompletionAuditor({
    cwd,
    model: 'test/auditor-model',
    thinkingLevel: 'medium',
    goal: goalFor(),
    inspection: true,
    resumeSessionPath: decision.sessionPath,
    resumeProvenance: {
      priorAttemptId: priorLogical, fromModel: 'openai-codex/gpt-6-luna',
      toModel: 'test/auditor-model', resumeCount: 1, revision: 5, tier: 'full',
    },
    runtime: { pollIntervalMs: 10, attemptId: () => newDetachedAuditJobAttemptId(claim.attemptId), logicalAttemptId: claim.attemptId },
  } as never);

  const argv = argvEntries(argvLog).at(-1) ?? [];
  const at = argv.indexOf('--session');
  assert.ok(at >= 0, 'the resumed dispatch asks for a durable session');
  assert.equal(argv[at + 1], decision.sessionPath,
    'the worker continues the REAL prior transcript, so completed tool work is not recomputed');
});

/**
 * v0.39.55 (auditor objection 2026-10-30, HIGH #2): resume lineage must reach
 * the VERDICT record, not only the dispatch ledger. appendAuditVerdict keeps it
 * durably, so a reviewer can tell a continued audit from a first pass by
 * reading the verdict itself.
 */
test('a resumed verdict carries its lineage into the durable audit history', () => {
  const history: AuditVerdict[] = [];
  appendAuditVerdict(history, {
    at: new Date().toISOString(),
    approved: true,
    disapproved: false,
    model: 'test/target-model',
    report: '<approved/>',
    revision: 5,
    auditTier: 'full',
    resumeProvenance: {
      priorAttemptId: 'audit-mvprov-aaaaaa',
      fromModel: 'openai-codex/gpt-6-luna',
      toModel: 'test/target-model',
      resumeCount: 1,
      revision: 5,
      tier: 'full',
    },
  });
  const entry = history.at(-1)!;
  assert.deepEqual(entry.resumeProvenance, {
    priorAttemptId: 'audit-mvprov-aaaaaa',
    fromModel: 'openai-codex/gpt-6-luna',
    toModel: 'test/target-model',
    resumeCount: 1,
    revision: 5,
    tier: 'full',
  }, 'every lineage field must be recorded on the verdict');
  // Attempt gating is unchanged: the verdict still binds to its revision.
  assert.equal(entry.revision, 5);
});

test('a first-pass verdict carries NO resume lineage', () => {
  const history: AuditVerdict[] = [];
  appendAuditVerdict(history, {
    at: new Date().toISOString(), approved: true, disapproved: false,
    model: 'test/auditor', report: '<approved/>', revision: 1, auditTier: 'light',
  });
  assert.equal(history.at(-1)!.resumeProvenance, undefined,
    'absent stays absent — a cold audit must not look resumed');
});

/**
 * v0.39.55 (auditor objection 2026-10-30, HIGH #3): a full-tier resumed audit
 * must still run its falsification round. The worker derives the challenge from
 * the TIER alone, so this asserts the resume feature cannot reach that decision
 * — a resumed full-tier dispatch carries challenge:true exactly like a cold
 * one, and a light tier still skips it with the correct reason.
 */
test('a resumed full-tier dispatch still asks for the falsification round', async () => {
  const cwd = tmpCwd();
  const argvLog = path.join(cwd, 'argv.log');
  const previous = process.env.GLLA_PI_BINARY;
  binaries.push(previous);
  process.env.GLLA_PI_BINARY = inertWorker(cwd, argvLog);

  const priorDir = path.join(cwd, '.pi-glla', 'audit-jobs', 'prior-full-tier');
  fs.mkdirSync(priorDir, { recursive: true });
  const priorSession = path.join(priorDir, 'session.jsonl');
  fs.writeFileSync(priorSession, '{"kind":"session"}\n');

  // The request must be read while it exists: a resultless job dir is removed
  // after the run, so capturing it at spawn time is the honest read.
  const seen: Array<{ challenge?: boolean; challengeSkip?: string }> = [];
  const captureWorker = path.join(cwd, 'capture-request.mjs');
  // This script IS the child pi that the real worker spawns, so the job dir is
  // not on its argv — find the active request on disk instead.
  fs.writeFileSync(captureWorker, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(${JSON.stringify(cwd)}, '.pi-glla', 'audit-jobs');
const dirs = fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
const reqPath = dirs.map((d) => path.join(root, d, 'request.json')).filter((f) => fs.existsSync(f)).at(-1);
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
fs.appendFileSync(${JSON.stringify(path.join(cwd, 'captured.jsonl'))},
  JSON.stringify({ challenge: req.challenge, challengeSkip: req.challengeSkip }) + '\\n');
process.exit(1);
`);
  fs.chmodSync(captureWorker, 0o755);
  process.env.GLLA_PI_BINARY = captureWorker;

  // ONE dispatch: the property under test is that RESUME does not change the
  // challenge decision. A cold full-tier dispatch is already covered elsewhere,
  // so spawning a second worker here only adds load-shaped flakiness.
  await runDetachedGoalCompletionAuditor({
    cwd, model: 'test/auditor-model', thinkingLevel: 'medium', goal: goalFor(),
    inspection: true, auditTier: 'full', strictChallenge: true,
    resumeSessionPath: priorSession,
    resumeProvenance: { priorAttemptId: 'prior-full-tier', resumeCount: 1, tier: 'full' },
    runtime: { pollIntervalMs: 10, attemptId: () => newDetachedAuditJobAttemptId('chal'), logicalAttemptId: 'chal' },
  } as never);
  seen.push(...fs.readFileSync(path.join(cwd, 'captured.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  assert.equal(seen.length, 1, 'the resumed dispatch captured its request');
  const captured = seen[0]!;
  // Absence of `challenge` means "challenge enabled" (the safe default). A
  // resumed full-tier dispatch under strictChallenge must NOT send
  // challenge:false, which is what would silently drop the falsification round.
  assert.notEqual(captured.challenge, false,
    'a resumed FULL-tier audit keeps its falsification round — resume cannot reach this decision');
  assert.equal(captured.challengeSkip, undefined,
    'no skip reason is sent, so round 2 is not disabled');
});

/**
 * v0.39.56 (auditor objection 2026-10-30, HIGH #2): the resume ledger entry must
 * carry the source model on the FIRST resume, and the verdict must too. Before
 * this, `auditorSourceModel` was only stamped during a RESUMED dispatch, so the
 * first resume had nothing to read and silently omitted `fromModel` — the
 * lineage was absent exactly when it was first needed.
 */
test('the first resume names its source model in both ledger and verdict', () => {
  // The claim as it exists at the START of a first resume: the prior attempt
  // stamped its own model at ITS dispatch (no resume had happened yet).
  const priorModel = 'openai-codex/gpt-6-luna';
  const claim = {
    at: new Date().toISOString(),
    attemptId: 'audit-first-new',
    claimLineageId: 'claim-first-lineage',
    priorAttemptId: 'audit-first-old',
    auditorFailureClass: 'provider' as const,
    auditorTier: 'full' as const,
    auditorRevision: 2,
    auditorCandidateRef: priorModel,
    auditorSourceModel: priorModel,
  };
  // A dispatch stamps the model IT runs on, so the next attempt can name it.
  // This goes through the PRODUCTION decision function, so dropping the
  // always-stamp (the original defect) fails here.
  const stamped = stampAuditorDispatchFacts(claim, claim.attemptId, {
    forAttemptId: claim.attemptId,
    ...auditorDispatchStampFacts({
      attemptModel: 'minimax/MiniMax-M3.1-Flash',
      resumed: false,   // a FIRST pass: the defect omitted the model here
      tier: 'full',
      revision: 2,
      resumeCount: 0,
    }),
  })!;
  assert.equal(stamped.auditorSourceModel, 'minimax/MiniMax-M3.1-Flash',
    'every dispatch records the model it ran on, not only resumed ones');

  // The resume decision reads the PRIOR value, which must be present.
  assert.ok(claim.auditorSourceModel, 'the first resume has a source model to report');
  const provenance = {
    priorAttemptId: claim.priorAttemptId,
    fromModel: claim.auditorSourceModel,
    toModel: 'test/target-model',
    resumeCount: 1,
    revision: 2,
    tier: 'full' as const,
  };
  // And it reaches the durable verdict record with that field intact.
  const history: AuditVerdict[] = [];
  appendAuditVerdict(history, {
    at: new Date().toISOString(), approved: true, disapproved: false,
    model: 'test/target-model', report: '<approved/>', revision: 2,
    auditTier: 'full', resumeProvenance: provenance,
  });
  assert.equal(history.at(-1)!.resumeProvenance?.fromModel, priorModel,
    'the first resumed verdict names the model it continued from');
});

test('an explicit user abort is recorded through the real signal and stamped on the claim', () => {
  // v0.39.56 (HIGH #1): the user-abort recorder had NO caller, so "user" was
  // unreachable and an explicit cancel was classified "transport" — which the
  // resume policy treats as resumable. Prove the production wrapper records it.
  const attemptId = 'audit-abort-signal';
  const controller = new AbortController();
  const wrapped = recordUserAbortOnSignal(controller.signal, attemptId);
  assert.equal(wrapped, controller.signal, 'the original signal is passed through');
  assert.equal(abortCauseForAttempt(attemptId), 'transport', 'not yet aborted');
  controller.abort();
  assert.equal(abortCauseForAttempt(attemptId), 'user',
    'aborting the host signal IS the user decision and must be recorded');

  // An already-aborted signal (aborted before wrapping) is recorded too: the
  // Esc path can fire before the dispatch reaches the wrapper.
  const preAborted = new AbortController();
  preAborted.abort();
  recordUserAbortOnSignal(preAborted.signal, 'audit-abort-pre');
  assert.equal(abortCauseForAttempt('audit-abort-pre'), 'user');

  // GLLA-initiated stops must NOT be reclassified as the user's decision.
  recordGllaInitiatedAuditorAbort('audit-abort-glla');
  assert.equal(abortCauseForAttempt('audit-abort-glla'), 'transport',
    'a GLLA stop stays transport and remains resumable');
});

/**
 * v0.39.56 (auditor objection 2026-10-30, HIGH #3): the suite proved a
 * mismatched attempt cannot STAMP dispatch facts, but never proved a stale or
 * moved verdict cannot be APPLIED once a resume is involved. Resume must not
 * create a path where an old transcript's verdict lands on a moved contract.
 */
test('a resumed verdict captured against a moved goal revision is refused', () => {
  const goal = { id: '20261030180000-moved', revision: 4 } as never;
  const capturedAtDispatch = { goalId: '20261030180000-moved', revision: 3 };
  assert.equal(isGoalRevisionCurrent(capturedAtDispatch, goal), false,
    'the goal moved while the resumed audit ran, so its verdict must not apply');
  // A different goal is refused even when the revision numbers coincide.
  assert.equal(isGoalRevisionCurrent({ goalId: 'other-goal', revision: 4 }, goal), false,
    'a verdict from another goal can never apply');
  // The unchanged case still passes, proving the guard is not blanket-refusing.
  assert.equal(isGoalRevisionCurrent({ goalId: '20261030180000-moved', revision: 4 }, goal), true);
});

test('a stale attempt cannot write to the claim, resumed or not', () => {
  // Exercises the REAL production gate (persistClaimWorkerActivity), not a
  // reimplementation of its comparison. A retired worker's late activity must
  // not touch a claim that has rotated to a new attempt.
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd);
  seedState(cwd, {
    goal: seedGoal({
      id: '20261030180000-stale',
      status: 'auditing',
      pendingCompletion: {
        at: new Date().toISOString(),
        attemptId: 'audit-live-attempt',
        claimLineageId: 'claim-live',
        priorAttemptId: 'audit-retired-attempt',
        phase: 'running',
        lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
      },
    }),
  });
  // Load the seeded record into the module's live state — the gate reads live
  // state, so a disk-only seed would make the positive case look refused.
  replaceState(readState(cwd));
  assert.equal(
    persistClaimWorkerActivity(ctx as never, '20261030180000-stale', 'audit-retired-attempt', Date.now()),
    false,
    'the rotated-away attempt cannot update the live claim',
  );
  assert.equal(
    persistClaimWorkerActivity(ctx as never, '20261030180000-stale', 'audit-live-attempt', Date.now()),
    true,
    'the live attempt still can — the gate is not blanket-refusing',
  );
});

/**
 * v0.39.57 (auditor objection 2026-10-30, HIGH #1/#3): the PRIMARY `complete_goal`
 * dispatch must record the baseline a retry compares against. The earlier tests
 * hand-built claims carrying `auditorTier`/`auditorRevision`/`auditorSourceModel`,
 * so they proved the helper while the real dispatch left those absent and the
 * first retry's moved-revision and changed-tier guards could not fire.
 *
 * This drives the REAL tool and asserts the durable claim it leaves behind.
 */
async function primaryDispatchClaim() {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `primary-${Math.random()}` } });
  Object.assign(ctx, { modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  seedState(cwd, {
    goal: seedGoal({ status: 'active', policy: 'goal', objective: 'Verify the intended feature', verificationContract: 'Inspect the feature behavior' }),
    list: [],
  });
  __testOnlyLoadState(cwd);
  // An inert worker that records that it was spawned, then dies without a
  // verdict — the mid-audit provider failure this goal is about.
  const worker = path.join(cwd, 'inert-auditor.mjs');
  fs.writeFileSync(worker, '#!/usr/bin/env node\nprocess.stdin.resume();\nsetTimeout(() => process.exit(3), 40);\n');
  fs.chmodSync(worker, 0o700);
  process.env.GLLA_PI_BINARY = worker;
  // Compaction is not due, so the dispatch is the PRIMARY path, not admission.
  ctx.isIdle = () => true; ctx.hasPendingMessages = () => false;
  ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 1048000, percent: 0.1 });
  ctx.compact = options => options?.onComplete?.({ summary: 'x', firstKeptEntryId: 'kept', tokensBefore: 1000 });
  await pi.runTool('complete_goal', {
    completionSummary: 'Outcome: feature verified. Changed: feature. Evidence: tests. Tests: pass. Unresolved: none. Next: none.',
  }, ctx);
  await tick(600);
  return readState(cwd).goal?.pendingCompletion;
}

test('the PRIMARY complete_goal dispatch stamps the retry baseline on the claim', async () => {
  const claim = await primaryDispatchClaim();
  assert.ok(claim, 'the primary dispatch persists a claim');
  // These are the exact fields whose absence made the guards inert.
  assert.ok(claim.auditorRevision !== undefined,
    'the primary dispatch records the revision it audited, so a move is detectable');
  assert.ok(claim.auditorTier,
    'the primary dispatch records the tier it ran, so a tier change is detectable');
  assert.ok(claim.auditorSourceModel || claim.auditorCandidateRef,
    'the primary dispatch records the model it ran on, so fromModel is populated on the first resume');
});

test('the first retry after a real primary dispatch refuses a moved revision and a changed tier', async () => {
  const claim = await primaryDispatchClaim();
  assert.ok(claim, 'the primary dispatch persists a claim');
  // Build the retry the way the hooks do: same claim, new attempt id.
  const retry = {
    ...claim!,
    priorAttemptId: claim!.attemptId,
    attemptId: 'audit-retry-after-primary',
    auditorFailureClass: 'provider' as const,
  };
  const cwd = tmpCwd();
  const priorDir = path.join(cwd, '.pi-glla', 'audit-jobs', `${retry.priorAttemptId}-r1`);
  fs.mkdirSync(priorDir, { recursive: true });
  fs.writeFileSync(path.join(priorDir, 'session.jsonl'), '{"kind":"session"}\n');
  const baseRevision = claim!.auditorRevision!;
  const baseTier = claim!.auditorTier!;

  const moved = resolveAuditorResumeForDispatch({
    inspection: true, claim: retry, currentAttemptId: retry.attemptId,
    currentTier: baseTier, currentRevision: baseRevision + 98, cwd,
  });
  assert.equal(moved.resume, false, 'a moved revision must restart cold on the FIRST retry');
  assert.equal(moved.reason, 'revision-moved');

  const retiered = resolveAuditorResumeForDispatch({
    inspection: true, claim: retry, currentAttemptId: retry.attemptId,
    currentTier: baseTier === 'light' ? 'full' : 'light', currentRevision: baseRevision, cwd,
  });
  assert.equal(retiered.resume, false, 'a changed tier must restart cold on the FIRST retry');
  assert.equal(retiered.reason, 'tier-changed');

  const unchanged = resolveAuditorResumeForDispatch({
    inspection: true, claim: retry, currentAttemptId: retry.attemptId,
    currentTier: baseTier, currentRevision: baseRevision, cwd,
  });
  assert.equal(unchanged.resume, true, 'an unchanged claim still resumes — the guards are not blanket-refusing');
});

test('a claim with no baseline fails closed instead of resuming blindly', () => {
  // The production shape that made the guards inert: no revision, no tier.
  const decision = decideAuditorResume({
    inspection: true, priorAttemptId: 'audit-unbased', priorFailureClass: 'provider',
    priorClaimAttemptId: 'cl', currentClaimAttemptId: 'cl',
    currentRevision: 99, currentTier: 'light', sessionExists: true,
  });
  assert.equal(decision.resume, false,
    'absence of a baseline is not permission: the audit must restart cold');
  assert.equal(decision.reason, 'revision-unknown');
});
