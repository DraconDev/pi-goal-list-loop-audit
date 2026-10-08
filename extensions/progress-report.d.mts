export type ProgressMode = 'goal' | 'list-goal' | 'metric-loop' | 'metricless-loop' | 'requirement-builder';
export interface ProgressVerification {
  requirementId: string;
  title?: string;
  attemptId?: string;
  observedAt?: string;
  current: boolean;
  provenance: 'recorded-state' | 'observed-receipt';
}
export interface ProgressRun {
  id: string;
  family: 'unknown' | 'goal' | 'loop' | 'project';
  mode: ProgressMode;
  target: string;
  status: string;
  iterations: number;
  cycle?: number;
  loadedVersion: string;
  capabilityProgress: 'unknown' | 'recorded-current-verification' | 'historical-verification-only';
  coverage: { total: number; verified: number; open: number; blocked: number };
  historicalVerification: ProgressVerification[];
  historyTruncated: boolean;
  coverageIncomplete: boolean;
  checkpoint: { revision?: string; attribution: 'unknown' };
  phaseAccounting: { provenance: 'unknown' | 'observed'; durationsMs: Record<string, number>; recordedTokens?: number; monetaryCost: 'unknown' };
  latestObservationAt?: string;
}
export interface ProgressReport {
  schemaVersion: 1;
  window: { records: number; firstAt?: string; lastAt?: string; invalidRecords: number; truncated: boolean; omittedRuns: number; scope: 'provided-records-only' };
  runs: ProgressRun[];
  limitations: string[];
}
export function projectProgress(records: Iterable<unknown>, options?: { maxRecords?: number; maxRuns?: number }): ProgressReport;
export function formatProgressReport(report: ProgressReport): string;
