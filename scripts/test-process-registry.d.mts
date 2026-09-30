import type { ChildProcess } from "node:child_process";
export function registerOwnedTestProcess(child: ChildProcess, env?: NodeJS.ProcessEnv): void;
export function createTestProcessRegistry(dir: string): Record<string, string>;
export function reapOwnedTestProcesses(env: NodeJS.ProcessEnv, options?: { graceMs?: number }): Promise<{ reaped: number; unverified: number }>;
