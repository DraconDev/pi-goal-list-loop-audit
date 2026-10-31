import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGllaStateDir } from "./glla-state-root.js";

export const GLLA_PACKAGE_NAME = "pi-goal-list-loop-audit";

/** Sidecar path shared with the update check (kept here so both
 * glla-version and glla-update-check resolve it without a cycle).
 * v0.38.45 audit: root-aware — sessionDir mode keeps the sidecar beside
 * every other state file instead of splitting it under cwd. */
export function updateCheckPath(cwd: string): string {
  return path.join(resolveGllaStateDir(cwd), "update-check.json");
}

/** Numeric semver-ish compare: 1 when a > b, -1 when a < b, 0 when equal
 * or unparseable. Pure — shared by the version command and the nudge.
 * v0.38.45 audit: strictly numeric segments — parseInt equated
 * prereleases (`3-beta`→3), so a prerelease running build never nudged. */
export function compareVersions(a: string, b: string): number {
  const numParts = (s: string): number[] | null => {
    const parts = s.trim().replace(/^v/, "").split(".");
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 10));
  };
  const pa = numParts(a);
  const pb = numParts(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

export interface UpdateCheckCache {
  latest: string;
  checkedAt: number;
}

/** Raw sidecar read: null when missing/unreadable/malformed. Accepts
 * future-dated entries — the refresh skip-check uses this so one skewed
 * clock does not become a per-contact spawn storm (v0.38.45 audit). */
export function readUpdateCheckRaw(cwd: string): UpdateCheckCache | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(updateCheckPath(cwd), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.latest !== "string" || !record.latest.trim()) return null;
    if (typeof record.checkedAt !== "number" || !Number.isFinite(record.checkedAt)) return null;
    return { latest: record.latest.trim(), checkedAt: record.checkedAt };
  } catch {
    return null;
  }
}

/** Strict sidecar read for render surfaces: additionally rejects
 * future-dated entries (clock skew must read as unknown, never fresh). */
export function readUpdateCheck(cwd: string): UpdateCheckCache | null {
  const raw = readUpdateCheckRaw(cwd);
  if (!raw) return null;
  if (raw.checkedAt > Date.now() + 60_000) return null;
  return raw;
}

/** npm-version-shaped tokens only — the refresh caches stdout, so
 * registry noise must never poison the sidecar (v0.38.45 audit). */
export function isVersionLike(token: string): boolean {
  return /^v?\d+\.\d+\.\d+([\-+][\w.]+)?$/.test(token.trim());
}

export interface GllaVersionInfo {
  name: string;
  version: string;
}

/**
 * Read the installed package metadata instead of duplicating a release string
 * in the extension. This works for both a source checkout and an npm
 * installation because the extension and package.json share the package root.
 */
export function readGllaVersionInfo(): GllaVersionInfo {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const name = typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : GLLA_PACKAGE_NAME;
      const version = typeof record.version === "string" && record.version.trim()
        ? record.version.trim()
        : "unknown";
      return { name, version };
    }
  } catch {
    // A damaged/missing manifest must not make the command surface unusable.
  }
  return { name: GLLA_PACKAGE_NAME, version: "unknown" };
}

export function formatGllaVersion(cwd?: string, info: GllaVersionInfo = readGllaVersionInfo()): string {
  const lines = [
    `${info.name} v${info.version}`,
    "Installed package version.",
    `Compare with registry latest: npm view ${info.name} version`,
  ];
  // v0.38.44 (field 20260909_161057): when the update sidecar has a
  // cached registry latest, say whether this session is stale and how
  // to fix it. No cache (offline / never checked) keeps the legacy
  // three lines — absence of evidence is not evidence of freshness.
  // v0.38.45 audit: the strict shared reader (same validation as the
  // status tail, so the two surfaces cannot disagree), and no staleness
  // claim at all when the running version is unreadable — "unknown"
  // compared equal and printed a false "up to date".
  if (cwd && info.version !== "unknown") {
    try {
      const cached = readUpdateCheck(cwd);
      if (cached) {
        lines.push(`Registry latest: v${cached.latest}.`);
        lines.push(
          compareVersions(cached.latest, info.version) > 0
            ? `This session is stale — update: pi install npm:${info.name}@latest then /reload.`
            : "This session is up to date.",
        );
      }
    } catch {
      // Sidecar read failure keeps the legacy output.
    }
  }
  return lines.join("\n");
}

/**
 * v0.39.61 (note.md 2026-10-31): "a banner reported v0.39.36 while package.json
 * is 0.39.54". The user was reading behaviour that was NOT in the source under
 * discussion — the loaded extension build was older than the repository it was
 * being developed in. That makes every display observation unreliable, so it is
 * worth one clear line rather than a silent mismatch.
 *
 * Compares the LOADED build (this module's own package.json, i.e. what is
 * actually executing) against the package.json in the working directory (the
 * checkout being edited). Only a strictly older loaded build warns: a newer or
 * equal build is normal (a published install driving a repo, or the repo itself),
 * and an unreadable manifest proves nothing so it stays silent.
 */
export interface StaleBuildStatus {
  stale: boolean;
  loaded?: string;
  repo?: string;
}

function readVersionAt(manifestPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version.trim())) return version.trim();
    }
  } catch {
    // A missing/damaged manifest proves nothing about staleness.
  }
  return undefined;
}

/** Compare dotted numeric versions; returns <0, 0, >0. Non-numeric tails are
 * ignored so a prerelease suffix cannot make an older build look newer. */
export function compareGllaVersions(a: string, b: string): number {
  const parts = (value: string): number[] => value.split(/[.+-]/).slice(0, 3)
    .map((chunk) => Number.parseInt(chunk, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function detectStaleBuild(cwd: string | undefined): StaleBuildStatus {
  const loaded = readVersionAt(PACKAGE_JSON_PATH);
  if (!cwd) return { stale: false, loaded };
  const repo = readVersionAt(path.join(cwd, "package.json"));
  if (!loaded || !repo) return { stale: false, loaded, repo };
  return { stale: compareGllaVersions(loaded, repo) < 0, loaded, repo };
}

/** The single human line for a stale build — a warning plus the fix action. */
export function formatStaleBuildWarning(status: StaleBuildStatus): string | undefined {
  if (!status.stale || !status.loaded || !status.repo) return undefined;
  return `glla: loaded build v${status.loaded} is older than this repo (v${status.repo}) — behaviour below may not match the source. Reload the session (or reinstall the extension) to pick up the current build.`;
}
