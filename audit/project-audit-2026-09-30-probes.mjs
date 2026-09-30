// Reproduce audit findings without providers, live Pi sessions, or repository state writes.
// Run: node audit/project-audit-2026-09-30-probes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-project-audit-'));
const owned = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate) {
  const limit = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= limit) throw new Error('probe observation timed out');
    await delay(20);
  }
}
function start(file, args, env) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child.pid);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, closed };
}

try {
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(scratch, 'runner-ready');
  const descendantFile = path.join(scratch, 'descendant-pid');
  fs.writeFileSync(path.join(bin, 'bun'), `#!${process.execPath}\n` + [
    "const fs = require('node:fs');",
    "const {spawn} = require('node:child_process');",
    "const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'ignore'});",
    "escaped.unref();",
    "fs.writeFileSync(process.env.PROBE_DESCENDANT, String(escaped.pid));",
    "process.on('SIGTERM', () => process.exit(0));",
    "fs.writeFileSync(process.env.PROBE_MARKER, 'ready');",
    "setInterval(() => {}, 1000);",
  ].join('\n'), { mode: 0o755 });
  const runner = start(process.execPath, ['scripts/run-tests.mjs', '--all'], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    PROBE_MARKER: marker,
    PROBE_DESCENDANT: descendantFile,
  });
  await until(() => fs.existsSync(marker));
  const descendant = Number(fs.readFileSync(descendantFile, 'utf8'));
  owned.add(descendant);
  runner.child.kill('SIGTERM');
  const runnerResult = await runner.closed;
  console.log(JSON.stringify({ probe: 'interrupted-runner', ...runnerResult, detachedDescendantSurvived: alive(descendant) }));
  process.kill(descendant, 'SIGKILL');
  owned.delete(descendant);

  const job = path.join(scratch, 'compactor-job');
  fs.mkdirSync(job);
  const piPidFile = path.join(scratch, 'pi-pid');
  const piStub = path.join(bin, 'pi');
  fs.writeFileSync(piStub, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.PROBE_PI_PID,String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(job, 'request.json'), JSON.stringify({ model: 'stub/model', prompt: 'compress', timeoutMs: 60_000 }));
  const worker = start(process.execPath, ['scripts/goal-compactor-worker.mjs', '--job-dir', job], {
    GLLA_PI_BINARY: piStub, PROBE_PI_PID: piPidFile,
  });
  await until(() => fs.existsSync(piPidFile));
  const piPid = Number(fs.readFileSync(piPidFile, 'utf8'));
  owned.add(piPid);
  worker.child.kill('SIGTERM');
  // The Pi child inherits the worker's pipes, so close may be held open too.
  await until(() => worker.child.signalCode !== null);
  console.log(JSON.stringify({ probe: 'terminated-compactor-worker', workerSignal: worker.child.signalCode, piChildSurvived: alive(piPid) }));
  process.kill(piPid, 'SIGKILL');
  owned.delete(piPid);
  await worker.closed;

  const jiti = createJiti(import.meta.url);
  const { deliverTerminalSummary } = await jiti.import(path.join(root, 'extensions/terminal-summary-delivery.ts'));
  const sessionFile = path.join(scratch, 'session.jsonl');
  for (const chars of [1000, 280_000]) {
    const content = 'x'.repeat(chars);
    const entry = { type: 'custom_message', id: 'receipt', customType: 'goal-complete', display: true, content, details: { terminalApprovalGoalId: 'goal-1' } };
    fs.writeFileSync(sessionFile, JSON.stringify(entry) + '\n');
    let sends = 0;
    const confirmed = deliverTerminalSummary({ sessionManager: { getBranch: () => [entry], getSessionFile: () => sessionFile } }, { sendMessage: () => { sends++; } }, entry.customType, 'goal-1', content);
    console.log(JSON.stringify({ probe: 'durable-summary-receipt', chars, fileBytes: fs.statSync(sessionFile).size, confirmed, sends }));
  }
} finally {
  for (const pid of owned) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
