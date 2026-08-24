// pi-goal-list-loop-audit — v0.35.55
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

export function resolveRuntimeSessionDir(): string | undefined {
  if (runtimeSessionDir) return runtimeSessionDir;
  const sessionFile = process.env.PI_SESSION_FILE;
  if (!sessionFile) return undefined;
  const parent = path.dirname(path.resolve(sessionFile));
  return parent && parent !== "." ? parent : undefined;
}

function readStateRootSetting(): GllaStateRoot {
  try {
    const raw = JSON.parse(fs.readFileSync(configuredGlobalSettingsPath(), "utf8")) as Record<string, unknown>;
    return raw.stateRoot === "sessionDir" ? "sessionDir" : "workingDir";
  } catch {
    return "workingDir";
  }
}

export function configuredStateRoot(): GllaStateRoot {
  return readStateRootSetting();
}

/** True when sessionDir is selected but the lifecycle has not registered a
 * session root yet. Reads may fall back for compatibility; write callers must
 * defer so startup cannot recreate state under an ambiguous cwd. */
export function stateRootPending(): boolean {
  return readStateRootSetting() === "sessionDir" && !resolveRuntimeSessionDir();
}

/** Resolve the selected root without performing migration or filesystem I/O. */
export function resolveGllaStateDir(cwd: string): string {
  if (readStateRootSetting() === "sessionDir") {
    const sessionDir = resolveRuntimeSessionDir();
    if (sessionDir) return path.join(sessionDir, "pi-glla");
  }
  return path.join(cwd, ".pi-glla");
}
