import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { stateRootPending } from "./glla-state-root.js";
import {
  compareVersions,
  GLLA_PACKAGE_NAME,
  isVersionLike,
  readUpdateCheck,
  readUpdateCheckRaw,
  updateCheckPath,
  type UpdateCheckCache,
} from "./glla-version.js";

export { compareVersions, readUpdateCheck, updateCheckPath };
export type { UpdateCheckCache };

/**
 * v0.38.44 (field 20260909_161057): a live session rendered the
 * pre-0.38.39 summary voice while the repo shipped 0.38.42 — nothing
 * visible told the session it runs old GLLA. Shipped fixes only reach
 * sessions that know they are stale, so the status line carries the
 * running version plus a nudge when the registry is ahead.
 *
 * Render discipline: the status/card render reads the sidecar cache ONLY
 * and never touches the network. A throttled fire-and-forget refresh
 * rides the command/lifecycle contact gate; failures (offline, slow
 * registry, missing npm) leave the old cache in place and never surface.
 */

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

export interface SpawnedRefreshChild {
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  unref?: () => void;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { timeout: number; stdio?: Array<"ignore" | "pipe"> },
) => SpawnedRefreshChild;

/**
 * Throttled fire-and-forget refresh: returns immediately in every case.
 * Skips when the cache is within TTL; otherwise shells `npm view` with a
 * bounded timeout and rewrites the cache on success. Never throws — an
 * offline session simply keeps rendering without a nudge.
 * v0.38.45 audit: the spawned child carries an `error` listener (a
 * missing/broken npm emits async `error`, which the outer try/catch
 * cannot catch and which crashes the host unhandled), detaches via
 * unref, and ignores stderr/stdin; only version-shaped stdout tokens
 * are cached. The TTL skip uses the RAW read so a future-dated cache
 * (clock skew) suppresses the spawn instead of causing one per contact.
 */
export function refreshUpdateCheck(
  cwd: string,
  now = Date.now(),
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
): void {
  // v0.38.49 audit: while sessionDir resolution is pending there is no
  // session root yet — skip the refresh (and its cache write) instead of
  // creating a <cwd>/.pi-glla fallback tree.
  if (stateRootPending()) return;
  try {
    const cached = readUpdateCheckRaw(cwd);
    if (cached && now - cached.checkedAt < UPDATE_CHECK_TTL_MS) return;
    const child = spawnFn("npm", ["view", GLLA_PACKAGE_NAME, "version"], {
      timeout: UPDATE_CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A missing/broken npm emits async `error`, not a sync throw and
    // not a nonzero close — without this listener the host crashes.
    child.on("error", () => {
      // Fail-silent by design: keep rendering without a nudge.
    });
    if (typeof child.unref === "function") child.unref();
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.length > 256) out = out.slice(-256);
    });
    child.on("close", (code) => {
      try {
        if (code !== 0) return;
        const latest = out.trim().split(/\s+/).pop() ?? "";
        if (!isVersionLike(latest)) return;
        const dir = path.dirname(updateCheckPath(cwd));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(updateCheckPath(cwd), JSON.stringify({ latest: latest.trim(), checkedAt: Date.now() }));
      } catch {
        // Cache write failure is invisible by design.
      }
    });
  } catch {
    // Spawn failure (no npm, no shell) is invisible by design.
  }
}

/**
 * The status-tail segment: `· v<running>` always (so the running
 * version is visible on every branch), plus `· update v<latest>
 * available` only when the cache proves the registry is ahead.
 * Empty string when the running version is unknown.
 */
export function buildVersionTail(running: string, latest: string | null): string {
  if (!running || running === "unknown") return "";
  const nudge = latest ? staleUpdateNudge(running, { latest, checkedAt: 0 }) : null;
  return `· v${running}${nudge ? ` · ${nudge}` : ""}`;
}

/** The nudge proper: null when there is nothing to say (no cache yet,
 * unparseable versions, or already current). "unknown" running versions
 * never nudge — a damaged manifest must not cry wolf. */
export function staleUpdateNudge(running: string, cached: UpdateCheckCache | null): string | null {
  if (!cached || running === "unknown") return null;
  if (compareVersions(cached.latest, running) > 0) return `update v${cached.latest} available`;
  return null;
}
