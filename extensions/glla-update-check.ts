import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { stateRootWriteIdentity, withStateRootSnapshot } from "./glla-state-root.js";
import { publishOwnerRecord } from "./owner-file-protocol.js";
import {
  __resetUpdateCheckRenderCache,
  compareVersions,
  GLLA_PACKAGE_NAME,
  isVersionLike,
  readUpdateCheck,
  readUpdateCheckRaw,
  updateCheckPath,
  type UpdateCheckCache,
} from "./glla-version.js";

export { compareVersions, readUpdateCheck, updateCheckPath };
export { readUpdateCheckForRender } from "./glla-version.js";
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
export const UPDATE_CHECK_RETRY_MS = 60_000;

export interface SpawnedRefreshChild {
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  unref?: () => void;
  kill?: (signal: NodeJS.Signals) => unknown;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { timeout: number; killSignal?: NodeJS.Signals; stdio?: Array<"ignore" | "pipe"> },
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
  defaultUpdateChecker(cwd, now, spawnFn);
}

/** Each checker owns a bounded set of root-specific refresh obligations.
 * Configurable windows let embedding callers and tests use the same lifecycle. */
export function createUpdateChecker({ timeoutMs = UPDATE_CHECK_TIMEOUT_MS, retryMs = UPDATE_CHECK_RETRY_MS } = {}) {
  const attempts = new Map<string, { pending: boolean; retryAt: number }>();
  return (cwd: string, now = Date.now(), spawnFn: SpawnFn = spawn as unknown as SpawnFn): void => {
    try {
      const admitted = withStateRootSnapshot(() => {
        const identity = stateRootWriteIdentity(cwd);
        return identity ? { identity, file: updateCheckPath(cwd), cached: readUpdateCheckRaw(cwd) } : undefined;
      });
      if (!admitted) return;
      if (admitted.cached && now - admitted.cached.checkedAt < UPDATE_CHECK_TTL_MS) return;
      for (const [key, attempt] of attempts) {
        if (!attempt.pending && attempt.retryAt <= now) attempts.delete(key);
      }
      if (attempts.has(admitted.identity) || attempts.size >= 128) return;
      const attempt = { pending: true, retryAt: 0 };
      attempts.set(admitted.identity, attempt);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (success = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        attempt.pending = false;
        attempt.retryAt = Math.max(now, Date.now()) + retryMs;
        if (success) attempts.delete(admitted.identity);
      };
      try {
        const child = spawnFn("npm", ["view", GLLA_PACKAGE_NAME, "version"], {
          timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
        });
        child.on("error", () => finish());
        let out = "";
        child.stdout.on("data", chunk => { out = (out + chunk.toString()).slice(-256); });
        child.on("close", code => {
          if (settled) return;
          let wrote = false;
          try {
            const latest = out.trim().split(/\s+/).pop() ?? "";
            if (code === 0 && isVersionLike(latest)) withStateRootSnapshot(() => {
              if (stateRootWriteIdentity(cwd) !== admitted.identity) return;
              fs.mkdirSync(path.dirname(admitted.file), { recursive: true });
              publishOwnerRecord(admitted.file, { latest, checkedAt: Date.now() });
              wrote = true;
              // A fresh registry answer must reach the next repaint, not
              // wait out the render cache window.
              __resetUpdateCheckRenderCache();
            });
          } catch { /* Keep the old cache on write failure. */ }
          finish(wrote);
        });
        // Retire even a child that never emits close. A late callback must
        // never publish over a newer attempt after its deadline or error.
        if (!settled) {
          timer = setTimeout(() => {
            finish();
            try { child.kill?.("SIGKILL"); } catch { /* Already exited. */ }
          }, timeoutMs);
          timer.unref();
        }
        child.unref?.();
      } catch { finish(); }
    } catch { /* Unresolved root or broken cache must not disrupt the host. */ }
  };
}

const defaultUpdateChecker = createUpdateChecker();

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
