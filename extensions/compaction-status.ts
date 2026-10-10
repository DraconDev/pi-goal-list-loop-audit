import * as fs from 'node:fs';

export type CompactionReason = 'unconfirmed' | 'unknown-usage' | 'below-target' | 'eligible'
  | 'unsupervised' | 'audit' | 'paused' | 'recovery' | 'busy' | 'pending'
  | 'boundary-unknown' | 'pressure-budget' | 'prior-attempt' | 'rearming' | 'unavailable' | 'metadata-unknown' | 'compacting';
export interface CompactionStatus {
  reason: CompactionReason;
  tokens?: number;
  threshold: number;
  observedAt: number;
  /** Observation only, never a permission to dispatch or compact. */
  note: string;
}
export interface CompactionObservation {
  tokens?: number | null;
  threshold: number;
  observedAt: number;
  supervising: boolean;
  audit: boolean;
  paused: boolean;
  recovery: boolean;
  compacting?: boolean;
  idle?: boolean;
  pending?: boolean;
  available: boolean;
  pressureBudget: boolean;
  marker: 'absent' | 'suppressed' | 'rearming' | 'unknown';
}
const notes: Record<CompactionReason, string> = {
  unconfirmed: 'eligibility unconfirmed; no fresh owner observation',
  'unknown-usage': 'context usage unknown', 'below-target': 'below token target',
  eligible: 'eligible at a safe boundary; not a hard ceiling',
  unsupervised: 'no supervised work', audit: 'deferred during audit', paused: 'deferred while held',
  recovery: 'deferred to provider recovery owner', busy: 'deferred until host is idle',
  pending: 'deferred while messages are pending', 'boundary-unknown': 'host boundary unknown',
  'pressure-budget': 'suppressed by failed-request attempt budget',
  'prior-attempt': 'suppressed by prior boundary attempt',
  rearming: 'prior attempt can rearm at the next boundary',
  unavailable: 'host compaction API unavailable', 'metadata-unknown': 'attempt metadata unreadable',
  compacting: 'compaction already in flight',
};
export function unconfirmedCompactionStatus(): CompactionStatus {
  return { reason: 'unconfirmed', threshold: 200_000, observedAt: 0, note: notes.unconfirmed };
}
/** Pure, read-only explanation of preventive compaction admission. */
export function projectCompactionStatus(input: CompactionObservation): CompactionStatus {
  const threshold = Number.isFinite(input.threshold) && input.threshold > 0 ? input.threshold : 200_000;
  const tokens = typeof input.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens > 0 ? input.tokens : undefined;
  const reason: CompactionReason = input.audit ? 'audit' : input.paused ? 'paused'
    : input.recovery ? 'recovery' : input.compacting ? 'compacting' : !input.supervising ? 'unsupervised' : input.pressureBudget ? 'pressure-budget'
    : input.idle === undefined || input.pending === undefined ? 'boundary-unknown'
    : !input.idle ? 'busy' : input.pending ? 'pending' : tokens === undefined ? 'unknown-usage'
    : input.marker === 'unknown' ? 'metadata-unknown' : input.marker === 'rearming' ? 'rearming'
    : input.marker === 'suppressed' ? 'prior-attempt' : tokens < threshold ? 'below-target'
    : !input.available ? 'unavailable' : 'eligible';
  return { reason, threshold, observedAt: input.observedAt, ...(tokens !== undefined ? { tokens } : {}), note: notes[reason] };
}

/** Two tiny metadata files only; never scan journals or start work. */
export function readCompactionMetadata(markerPath: string, budgetPath: string, workKey: string,
  now: number, tokens: number | undefined, threshold: number, lastCompactionAt?: number): Pick<CompactionObservation, 'marker' | 'pressureBudget'> {
  const read = (file: string): { missing?: boolean; value?: Record<string, unknown>; invalid?: boolean } => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 4096) return { invalid: true };
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { value: value as Record<string, unknown> } : { invalid: true };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { invalid: true };
    }
  };
  const budget = read(budgetPath);
  const marker = read(markerPath);
  const pressureBudget = budget.value?.key === workKey;
  if (budget.invalid || marker.invalid) return { marker: 'unknown', pressureBudget };
  if (marker.missing) return { marker: 'absent', pressureBudget };
  const at = typeof marker.value?.at === 'string' ? Date.parse(marker.value.at) : NaN;
  const completed = typeof marker.value?.completedAt === 'number' ? marker.value.completedAt : lastCompactionAt;
  const success = Number.isFinite(at) && typeof completed === 'number' && Number.isFinite(completed) && completed >= at && completed <= now;
  return { marker: (typeof tokens === 'number' && tokens < threshold / 2) || (success && now - completed! >= 180_000)
    ? 'rearming' : 'suppressed', pressureBudget };
}

export function compactionStatusText(status: CompactionStatus): string {
  const usage = status.tokens === undefined ? '' : `${Math.round(status.tokens)} / ${status.threshold} target · `;
  return `compaction: ${usage}${status.note}`;
}
