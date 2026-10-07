// Failure evidence is opt-in to read and bounded. Never dump request/env/session
// files: they may contain credentials. Only explicitly selected protocol fields
// and the runner's already-visible output are retained.
import * as fs from 'node:fs';
import * as path from 'node:path';
export function redactDiagnostic(value) {
  return String(value).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|glpat-[\w-]+|sk-[\w-]+)\b/g, '[redacted]')
    .replace(/((?:authorization|api[_-]?key|token|password|secret)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi, '$1[redacted]');
}
export function diagnosticTail(text, limit = 8192) {
  return Buffer.from(redactDiagnostic(text)).subarray(-limit).toString('utf8');
}
function readProtocol(file) {
  try {
    if (fs.statSync(file).size > 65536) return { omitted: 'exceeds 64KiB protocol limit' };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return { unavailable: true }; }
}
export function captureTestFailureDiagnostics({ directory, exitCode, signal, reason, outputTail = '', workerResult, progress, processState }) {
  const select = (record, keys) => Object.fromEntries(keys.filter(key => record?.[key] !== undefined).map(key => [key, record[key]]));
  const bundle = {
    capturedAt: new Date().toISOString(), exitCode, signal, reason,
    outputTail: diagnosticTail(outputTail),
    workerResult: select(workerResult, ['ok', 'output', 'error', 'infrastructureFailureKind', 'attemptId']),
    progress: select(progress, ['phase', 'elapsedMs', 'currentTool', 'currentToolTimeoutMs', 'currentToolStartedAt', 'lastActivityAt']),
    processState: select(processState, ['pid', 'group', 'session', 'birth', 'exitCode', 'signalCode', 'killed', 'unverified', 'reaped']),
  };
  // Redact every value, not just stdout. Bound externally supplied fields too.
  for (const record of [bundle.workerResult, bundle.progress, bundle.processState]) {
    for (const key of Object.keys(record)) if (typeof record[key] === 'string') record[key] = diagnosticTail(record[key]);
  }
  bundle.reason = diagnosticTail(reason ?? '', 1024);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'failure.json');
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return file;
}
export function captureWorkerFailure({ directory, jobDir, ...args }) {
  return captureTestFailureDiagnostics({ ...args, directory,
    workerResult: readProtocol(path.join(jobDir, 'result.json')),
    progress: readProtocol(path.join(jobDir, 'progress.json')),
  });
}
