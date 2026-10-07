import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureWorkerFailure, diagnosticTail } from '../scripts/test-failure-diagnostics.mjs';

test('injected failure retains worker verdict, specific timeout and process identity without secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-diagnostics-'));
  try {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, output: '<disapproved/>', error: 'tool exceeded granted budget', request: 'secret request', token: 'private' }));
    fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ phase: 'tool_executing', currentTool: 'bash', currentToolTimeoutMs: 600000, currentToolArgs: 'private args' }));
    const file = captureWorkerFailure({ directory: path.join(dir, 'retained'), jobDir: dir, exitCode: 1,
      reason: 'tool-timeout: bash exceeded 600000ms', outputTail: 'Authorization: Bearer abcsecret\napi_key=privatesecret\nghp_abcdefghijklmnopqrstuvwxyz0123456789',
      processState: { pid: 123, group: 123, birth: '9876', unverified: 1 } as unknown as import('../scripts/test-failure-diagnostics.mjs').ProcessStateSnapshot });
    const text = fs.readFileSync(file, 'utf8');
    const saved = JSON.parse(text);
    assert.equal(saved.workerResult.output, '<disapproved/>');
    assert.equal(saved.workerResult.error, 'tool exceeded granted budget');
    assert.equal(saved.reason, 'tool-timeout: bash exceeded 600000ms');
    assert.equal(saved.progress.currentToolTimeoutMs, 600000);
    assert.equal(saved.processState.birth, '9876');
    assert.doesNotMatch(text, /abcsecret|privatesecret|ghp_|private args|secret request|private environment/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing or oversized worker files still retain the runner failure and bounded output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-diagnostics-'));
  try {
    fs.writeFileSync(path.join(dir, 'result.json'), 'x'.repeat(70000));
    const file = captureWorkerFailure({ directory: dir, jobDir: dir, exitCode: 124, reason: 'suite stalled: no output for 120000ms', outputTail: 'x'.repeat(30000) + 'last phase' });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.exitCode, 124);
    assert.match(saved.reason, /suite stalled/);
    assert.ok(Buffer.byteLength(saved.outputTail) <= 8192);
    assert.match(saved.outputTail, /last phase$/);
    assert.deepEqual(saved.workerResult, {});
    assert.ok(Buffer.byteLength(diagnosticTail('x'.repeat(50000))) <= 8192);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
