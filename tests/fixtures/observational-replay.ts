import type { ProgressReceipt } from '../../extensions/progress-observer.ts';

// Sanitized observational replay fixture derived from
// audit/LIVE-PROJECT-PROGRESS-2026-10-08.md. Targets/identifiers/values are
// illustrative, not transcripts or actual project diagnostics.
export const REPLAY_FIXTURE: ProgressReceipt[] = [
  {
    schemaVersion: 1, receiptId: 'rt-1', runtimeId: 'runtime-h', generation: 1, rootId: 'root-h',
    runId: 'hegemon-snapshot', family: 'metricless-loop', mode: 'metricless-loop', kind: 'state',
    version: '0.39.16', at: '2026-10-03T12:00:00.000Z', phase: 'building', reasonCode: 'building',
    iteration: 686, tokensUsed: 4096,
  },
  {
    schemaVersion: 1, receiptId: 'rt-2', runtimeId: 'runtime-h', generation: 1, rootId: 'root-h',
    runId: 'hegemon-snapshot', family: 'metricless-loop', mode: 'metricless-loop', kind: 'iteration',
    version: '0.39.16', at: '2026-10-03T12:00:30.000Z', phase: 'building',
    signals: { fileWrites: 4, gitCommits: 0, specItemProgress: 0, currentHead: '9e704fd1b' },
    interval: { phase: 'building', milliseconds: 30_000, provenance: 'inferred-between-state-observations' },
  },
  {
    schemaVersion: 1, receiptId: 'rt-3', runtimeId: 'runtime-d', generation: 3, rootId: 'root-d',
    runId: 'darklord', family: 'project', mode: 'requirement-builder', kind: 'state',
    version: '0.39.16', at: '2026-10-05T09:00:00.000Z', phase: 'verification', reasonCode: 'building',
    iteration: 100, cycle: 28, revision: 12, attemptId: 'audit-9',
    tokensUsed: 5120,
    deltas: [
      { id: 'feature-toggle', from: 'open', to: 'verified', attemptId: 'audit-9' },
      { id: 'theme', from: 'verified', to: 'open', attemptId: 'audit-9', reason: 'unspecified regression scope' },
    ],
  },
  {
    schemaVersion: 1, receiptId: 'rt-4', runtimeId: 'runtime-d', generation: 3, rootId: 'root-d',
    runId: 'darklord', family: 'project', mode: 'requirement-builder', kind: 'state',
    version: '0.39.16', at: '2026-10-05T09:01:00.000Z', phase: 'retry-recovery', reasonCode: 'auditor-infrastructure-stall',
    tokensUsed: 5120, cycle: 28, revision: 12,
  },
  {
    schemaVersion: 1, receiptId: 'rt-5', runtimeId: 'runtime-s', generation: 2, rootId: 'root-s',
    runId: 'studio', family: 'goal', mode: 'goal', kind: 'state',
    version: '0.39.16', at: '2026-10-06T10:00:00.000Z', phase: 'verification', reasonCode: 'auditing',
    tokensUsed: 8000,
  },
];
