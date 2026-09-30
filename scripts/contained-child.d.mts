import type { ChildProcess } from "node:child_process";
export function terminateContainedChild(child: ChildProcess, options?: { graceMs?: number; forceMs?: number; signalTree?: (signal: NodeJS.Signals) => void }): Promise<void>;
