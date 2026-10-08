import type { ProgressReport } from './progress-report.mjs';
export interface ProgressSource {
  bytesRead: number;
  filesRead: number;
  truncated: boolean;
  malformedLines: number;
  oversizedLines: number;
  errors: { location: string; code: string }[];
}
export function readProgressReport(stateDir: string, options?: {
  maxBytes?: number; maxFiles?: number; maxRecords?: number; maxLineBytes?: number;
}): ProgressReport & { source: ProgressSource };
