export declare const STDERR_DIAGNOSTIC_MAX: number;

export declare function stripStderrControlChars(text: unknown): string;

export declare function accumulateStderrDiagnostic(
  current: string | undefined,
  chunk: unknown,
): string | undefined;
