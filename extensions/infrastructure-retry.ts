import { safeDiagnostic } from "./safe-diagnostic.js";
import { AUDITOR_INFRASTRUCTURE_CLASS_VALUES } from "./auditor-failure-classes.js";
/** Infrastructure failures end a bounded episode, never the supervision contract.
 * Counts are diagnostic and affect pacing only; admission belongs to the host. */
export type InfrastructureFailureClass =
  | "no-verdict" | "timeout" | "transport" | "provider" | "context-exhausted"
  | "auth" | "config";

// The auditor classes are DERIVED from the one shared list; only the two
// retry-specific classes are added here, so this copy cannot drift stale.
const INFRASTRUCTURE_FAILURE_CLASSES: ReadonlySet<string> = new Set<string>([
  ...AUDITOR_INFRASTRUCTURE_CLASS_VALUES, "auth", "config",
]);
export interface InfrastructureRetry {
  scopeId: string;
  failureClass: InfrastructureFailureClass;
  diagnostic?: string;
  failures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  nextRetryAt: number;
  pendingEpisode: boolean;
}
export function nextInfrastructureRetry(scopeId: string, failureClass: InfrastructureFailureClass, now: number, previous?: InfrastructureRetry, diagnostic?: unknown): InfrastructureRetry {
  const prior = previous?.scopeId === scopeId ? previous : undefined;
  const failures = Math.min(1_000_000, (prior?.failures ?? 0) + 1);
  const delay = Math.min(300_000, 5_000 * 2 ** Math.min(6, failures - 1));
  return { scopeId, failureClass, ...(safeDiagnostic(diagnostic) ? { diagnostic: safeDiagnostic(diagnostic) } : {}), failures, firstFailureAt: prior?.firstFailureAt ?? now, lastFailureAt: now, nextRetryAt: now + delay, pendingEpisode: true };
}
export function infrastructureRetryDelay(retry: InfrastructureRetry | undefined, now: number): number {
  return retry ? Math.min(2_147_483_647, Math.max(0, retry.nextRetryAt - now)) : 0;
}
export function sanitizeInfrastructureRetry(value: unknown, scopeId: string): InfrastructureRetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as InfrastructureRetry;
  if (r.scopeId !== scopeId || !INFRASTRUCTURE_FAILURE_CLASSES.has(r.failureClass)
      || ![r.firstFailureAt, r.lastFailureAt, r.nextRetryAt].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
      || r.lastFailureAt < r.firstFailureAt || r.nextRetryAt < r.lastFailureAt) return undefined;
  return { scopeId, failureClass: r.failureClass, ...(safeDiagnostic(r.diagnostic) ? { diagnostic: safeDiagnostic(r.diagnostic) } : {}), failures: Number.isFinite(r.failures) ? Math.min(1_000_000, Math.max(1, Math.floor(r.failures))) : 1,
    firstFailureAt: r.firstFailureAt, lastFailureAt: r.lastFailureAt, nextRetryAt: r.nextRetryAt, pendingEpisode: r.pendingEpisode === true };
}
