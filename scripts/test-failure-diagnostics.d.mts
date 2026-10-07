export interface WorkerResultSnapshot {
  ok?: boolean;
  output?: string;
  error?: string;
  infrastructureFailureKind?: string;
  attemptId?: string;
}
export interface ProgressSnapshot {
  phase?: string;
  elapsedMs?: number;
  currentTool?: string;
  currentToolTimeoutMs?: number;
  currentToolStartedAt?: number;
  lastActivityAt?: number;
}
export interface ProcessStateSnapshot {
  pid?: number;
  group?: number;
  session?: string;
  birth?: string;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  killed?: boolean;
  unverified?: number;
  reaped?: number;
}
export interface CaptureDiagnosticsInput {
  directory: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  reason?: string;
  outputTail?: string;
  workerResult?: WorkerResultSnapshot;
  progress?: ProgressSnapshot;
  processState?: ProcessStateSnapshot;
}
export function captureTestFailureDiagnostics(input: CaptureDiagnosticsInput): string;
export function captureWorkerFailure(input: CaptureDiagnosticsInput & { jobDir: string }): string;
export function diagnosticTail(text: string, limit?: number): string;
export function redactDiagnostic(value: unknown): string;
