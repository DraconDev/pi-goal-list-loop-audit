// pi-goal-list-loop-audit — v0.35.58
// extensions/glla-state-root.ts
//
// The state-root boundary is deliberately dependency-free: goal-loop-core and
// goal-settings both need it, so putting it in either of those modules would
// create a circular import. The runtime session directory is registered by the
// lifecycle slice; until then sessionDir mode is pending and persistence
// callers must not create a cwd fallback tree.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type GllaStateRoot = "workingDir" | "sessionDir";

export function globalSettingsPath(): string {
  // Test/embedding override keeps the suite hermetic from the developer's
  // real global settings file. This helper intentionally has no settings
  // module dependency because piGlaDir must read the global root selector.
  const override = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  if (override) return override;
  return path.join(os.homedir(), ".pi", "agent", "pi-goal-list-loop-audit.settings.json");
}

function configuredGlobalSettingsPath(): string {
  return globalSettingsPath();
}

/** Live session's top-level directory. The lifecycle slice registers this
 * after host admission; tests and worker processes may use PI_SESSION_FILE. */
let runtimeSessionDir: string | undefined;

export function setRuntimeSessionDir(dir: string | undefined): void {
  runtimeSessionDir = typeof dir === "string" && dir.trim() ? path.resolve(dir) : undefined;
}

/** Register the host session root from pi's file-backed SessionManager. The
 * lifecycle owns this admission point; keeping the derivation here makes the
 * state-root boundary identical for normal starts and successor rebinds.
 * `getSessionDir()` is authoritative: a session file may be imported from a
 * different directory, while in-memory subagent managers return an empty dir. */
export function setRuntimeSessionDirFromSessionManager(sessionManager: unknown): string | undefined {
  let sessionDir: unknown;
  try {
    const getter = (sessionManager as { getSessionDir?: unknown } | null | undefined)?.getSessionDir;
    if (typeof getter !== "function") {
      setRuntimeSessionDir(undefined);
      return undefined;
    }
    sessionDir = (getter as () => unknown).call(sessionManager);
  } catch {
    setRuntimeSessionDir(undefined);
    return undefined;
  }
  if (typeof sessionDir !== "string" || !sessionDir.trim()) {
    setRuntimeSessionDir(undefined);
    return undefined;
  }
  const dir = path.resolve(sessionDir);
  setRuntimeSessionDir(dir);
  return dir;
}

export function resolveRuntimeSessionDir(): string | undefined {
  if (runtimeSessionDir) return runtimeSessionDir;
  const sessionFile = process.env.PI_SESSION_FILE;
  if (!sessionFile) return undefined;
  const parent = path.dirname(path.resolve(sessionFile));
  return parent && parent !== "." ? parent : undefined;
}

interface RootSelection { root?: GllaStateRoot; unresolved: boolean; sessionDir?: string }
const validatedSelections = new Map<string, GllaStateRoot>();
let operationSelection: RootSelection | undefined;

function readRootSelection(): RootSelection {
  const file = configuredGlobalSettingsPath();
  let root: GllaStateRoot;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid settings object");
    const value = (raw as Record<string, unknown>).stateRoot;
    if (value !== undefined && value !== "sessionDir" && value !== "workingDir") throw new Error("invalid state root selector");
    root = value === "sessionDir" ? "sessionDir" : "workingDir";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Keep known reads on their established root, but refuse mutations
      // until the selector is readable and valid again. Cold uncertainty
      // must never invent a working-directory authority tree.
      return { root: validatedSelections.get(file), unresolved: true, sessionDir: resolveRuntimeSessionDir() };
    }
    root = "workingDir";
  }
  validatedSelections.set(file, root);
  if (validatedSelections.size > 64) validatedSelections.delete(validatedSelections.keys().next().value!);
  return { root, unresolved: false, sessionDir: resolveRuntimeSessionDir() };
}

/** Pin selector and session directory for one synchronous persistence operation.
 * Nested persistence shares that view; no external callback runs under an I/O
 * lock. A subsequent operation observes any newly selected root. */
export function withStateRootSnapshot<T>(action: () => T): T {
  if (operationSelection) return action();
  operationSelection = readRootSelection();
  try { return action(); } finally { operationSelection = undefined; }
}

function selection(): RootSelection {
  return operationSelection ?? readRootSelection();
}

export function configuredStateRoot(): GllaStateRoot {
  const root = selection().root;
  if (!root) throw new Error("GLLA state root unresolved: settings selector is unreadable or invalid");
  return root;
}

/** An unknown selector or missing selected session directory defers writes.
 * Only a genuinely absent settings file authorizes the historical default. */
export function stateRootPending(): boolean {
  const selected = selection();
  return selected.unresolved || (selected.root === "sessionDir" && !selected.sessionDir);
}

/** Known roots remain readable during selector failure. A cold unknown root
 * raises an explicit error rather than returning an empty fallback state. */
export function resolveGllaStateDir(cwd: string): string {
  const selected = selection();
  if (!selected.root) throw new Error("GLLA state root unresolved: settings selector is unreadable or invalid");
  if (selected.root === "sessionDir" && selected.sessionDir) return path.join(selected.sessionDir, "pi-glla");
  return path.join(cwd, ".pi-glla");
}
