// pi-goal-list-loop-audit — v0.36.0
// extensions/auditor-extensions.ts
//
// Discovery + normalization for the auditor extension allowlist
// (`auditorAllowedExtensions`, GitHub issue: "Allow extension-based model
// providers in detached auditor sessions").
//
// The detached auditor worker spawns `pi --mode rpc --no-extensions …`. Pi's
// `--extension <spec>` flag still loads explicitly given specs even under
// `--no-extensions`, BUT a raw `npm:<pkg>` spec makes pi perform a fresh
// *temporary* npm install into `~/.pi/agent/tmp/extensions/npm/<hash>` on
// every spawn — network-bound, hundreds of MB, and completely dead offline
// (field-verified by the 2026-08-22 audit: `-e npm:pi-cursor-sdk` with
// PI_OFFLINE=1 registered 0 models; the resolved install path registered
// 209). Relative `extensions[]` entries are likewise resolved by pi against
// the *auditor's cwd*, not the settings base dir, so a verbatim
// `../../ghq/...` spec silently loads nothing.
//
// We therefore resolve every allowlist entry to a concrete, existing
// absolute path BEFORE it reaches the worker:
//   • `npm:<name>[@version]` → `~/.pi/agent/npm/node_modules/<name>` (or the
//     project `.pi/npm/node_modules/<name>` equivalent) — existing install
//     only, never triggering a new one.
//   • `git:<url>` → `~/.pi/agent/git/<host>/<user>/<project>` (or project
//     `.pi/git/...` equivalent).
//   • paths → `~` expanded; relative paths resolved against the settings
//     base dir (user scope: `~/.pi/agent`, project scope: `<cwd>/.pi`),
//     matching pi's own `getBaseDirForScope` resolution.
// Entries that do not resolve to an existing path are dropped (fail-closed)
// rather than emitted as unloadable specs.
//
// Discovery is read-only and best-effort: unreadable files simply contribute
// no entries. The picker menu (Auditor tab) is the only consumer besides the
// dispatch path, which re-reads the normalized settings at request time.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** One extension the user could allow-list for the auditor. */
export interface DiscoveredPiExtension {
  /** The spec to pass to `pi --extension` / store in settings.
   * Settings-sourced entries are RESOLVED to concrete install paths (see
   * module header); directory-discovered entries are already absolute. */
  spec: string;
  /** Short human label (package name or file/dir basename). */
  label: string;
  /** Where the entry came from — for the picker's descriptive text. */
  source: "package" | "extensions-setting" | "user-dir" | "project-dir";
  /** The raw settings entry this was resolved from (specs resolved from
   * packages[]/extensions[] keep the original string for display). */
  raw?: string;
}

/** Parse an npm package spec into its install directory name.
 * Mirrors pi's PackageManager.parseNpmSpec: `@scope/pkg@1.2.3` →
 * `@scope/pkg`; `pkg@^2` → `pkg`; `pkg` → `pkg`. */
function npmSpecName(spec: string): string {
  const match = spec.match(/^(@?[^@]+(?:\/?[^@]+)?)(?:@(.+))?$/);
  return (match?.[1] ?? spec).trim() || spec;
}

/** Parse a git source into `{ host, repoPath }` where repoPath is
 * `user/project` (`.git` and ref stripped). Mirrors the subset of pi's
 * parseGitUrl/splitRef that settings `packages[]` entries can contain.
 * Returns undefined when the string is not a git source. */
function parseGitSpec(source: string): { host: string; repoPath: string } | undefined {
  let url = source.trim();
  if (url.startsWith("git:")) url = url.slice(4).trim();
  else if (!/^(https?|ssh|git):\/\//i.test(url) && !/^git@[^:]+:/.test(url) && !/^[^.\s]+\.[^.\s]+\//.test(url)) {
    return undefined; // not a git-shaped source
  }
  url = url.split("#")[0] ?? url; // strip #ref
  let host = "";
  let rest = "";
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1] ?? "";
    rest = scp[2] ?? "";
  } else if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      rest = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else {
    const slash = url.indexOf("/");
    if (slash < 0) return undefined;
    host = url.slice(0, slash);
    rest = url.slice(slash + 1);
  }
  const at = rest.indexOf("@"); // strip @ref (pi's splitRef semantics)
  if (at >= 0) rest = rest.slice(0, at);
  rest = rest.replace(/\.git$/, "").replace(/^\/+/, "");
  const parts = rest.split("/").filter(Boolean);
  if (!host || parts.length < 2 || parts.some((p) => p === "..")) return undefined;
  return { host, repoPath: parts.join("/") };
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable — treat as missing */
    }
  }
  return undefined;
}

/** Expand `~` and resolve a path against a base dir (pi's
 * resolvePathFromBase semantics for settings entries). */
function resolveSettingsPath(input: string, baseDir: string, home: string): string {
  if (input.startsWith("~")) return path.join(home, input.slice(1).replace(/^\/+/, ""));
  return path.resolve(baseDir, input);
}

/** Resolve one allowlist spec to a concrete existing absolute path the
 * worker can pass as `pi --extension <path>` without triggering installs.
 * `base` is the settings base dir for relative paths (user scope:
 * `~/.pi/agent`; project scope: `<cwd>/.pi`). Returns undefined when the
 * entry does not resolve to something loadable — callers drop it
 * (fail-closed) rather than emit an unloadable spec. */
export function resolveAuditorExtensionSpec(
  spec: string,
  opts: { home: string; cwd?: string; base?: string },
): string | undefined {
  const agentDir = path.join(opts.home, ".pi", "agent");
  const projectDir = opts.cwd ? path.join(opts.cwd, ".pi") : undefined;
  const trimmed = spec.trim();
  if (trimmed.startsWith("npm:")) {
    const name = npmSpecName(trimmed.slice(4));
    if (!name) return undefined;
    return firstExisting([
      path.join(agentDir, "npm", "node_modules", name),
      ...(projectDir ? [path.join(projectDir, "npm", "node_modules", name)] : []),
    ]);
  }
  const git = parseGitSpec(trimmed);
  if (git) {
    return firstExisting([
      path.join(agentDir, "git", git.host, ...git.repoPath.split("/")),
      ...(projectDir ? [path.join(projectDir, "git", git.host, ...git.repoPath.split("/"))] : []),
    ]);
  }
  // Local path: `~`/absolute as-is, relative against the settings base dir
  // (NOT the auditor's future cwd — pi resolves -e against cwd, so emitting
  // a relative spec would silently load nothing).
  if (/^[a-z]+:/.test(trimmed)) return undefined; // unknown scheme — no safe resolution
  const resolved = resolveSettingsPath(trimmed, opts.base ?? agentDir, opts.home);
  return firstExisting([resolved]);
}

/** Resolve an allowlist to worker-ready install paths: every entry maps to
 * a concrete existing path; unresolvable entries are dropped fail-closed. */
export function resolveAuditorAllowedExtensions(
  specs: string[] | undefined,
  home: string,
  cwd?: string,
  settingsBase?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const userBase = path.join(home, ".pi", "agent");
  const projectBase = cwd ? path.join(cwd, ".pi") : undefined;
  for (const spec of normalizeAuditorAllowedExtensions(specs)) {
    const trimmed = spec.trim();
    const isLocal = !trimmed.startsWith("npm:") && !parseGitSpec(trimmed) && !trimmed.startsWith("~") && !path.isAbsolute(trimmed) && !/^[a-z]+:/i.test(trimmed);
    const bases = settingsBase
      ? [settingsBase]
      : isLocal && projectBase
        ? [projectBase, userBase]
        : [userBase];
    const candidates = bases
      .map((base) => resolveAuditorExtensionSpec(trimmed, { home, cwd, base }))
      .filter((resolved): resolved is string => !!resolved);
    const unique = [...new Set(candidates)];
    // A relative entry found in both scopes is ambiguous: silently choosing
    // one could load a different extension than the settings author named.
    if (unique.length !== 1 || seen.has(unique[0]!)) continue;
    seen.add(unique[0]!);
    out.push(unique[0]!);
  }
  return out;
}

/** v0.38.65 (field 151158): repo root of THIS extension — the session
 * mirror must never feed GLLA back into its own detached worker (an
 * auditor loading the goal toolkit could re-dispatch goals). Exported
 * for tests; the mirror filter is the real consumer. */
export function gllaRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** v0.38.65: true when a mirror candidate is GLLA itself — by package
 * name (no filesystem touch; covers npm: specs and relative paths on
 * machines where the install lives under a different path) or by
 * resolved path inside this repo (covers relative-path specs pointing
 * here under an unfamiliar spelling). */
export function isSelfMirrorSpec(raw: string, opts: { home: string; cwd?: string }): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/pi-goal-list-loop-audit/i.test(labelForSpec(trimmed))) return true;
  const root = gllaRepoRoot();
  const bases = [path.join(opts.home, ".pi", "agent"), ...(opts.cwd ? [path.join(opts.cwd, ".pi")] : [])];
  for (const base of bases) {
    const resolved = resolveAuditorExtensionSpec(trimmed, { home: opts.home, cwd: opts.cwd, base });
    if (resolved && (resolved === root || resolved.startsWith(root + path.sep))) return true;
  }
  return false;
}

/** v0.38.65 (field 151158): raw session package specs to mirror into the
 * detached auditor — user settings packages[]/extensions[] first, then
 * project settings. Raw strings, not resolved paths: the process layer
 * resolves them fail-closed at dispatch, so an entry that vanishes
 * between mirror and spawn simply drops out. GLLA itself is excluded.
 * Read-only and best-effort like the rest of discovery: unreadable
 * settings files contribute nothing. */
export function sessionMirrorExtensionSpecs(home: string, cwd?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const spec = raw.trim();
    const key = spec.toLowerCase();
    if (!spec || seen.has(key)) return;
    if (isSelfMirrorSpec(spec, { home, cwd })) return;
    seen.add(key);
    out.push(spec);
  };
  for (const raw of readJsonArray(path.join(home, ".pi", "agent", "settings.json"))) push(raw);
  if (cwd) {
    for (const raw of readJsonArray(path.join(cwd, ".pi", "settings.json"))) push(raw);
  }
  return out;
}

/** v0.38.65: union the curated allowlist with the session mirror — user
 * entries first (first spelling wins, case-insensitive), then mirrored
 * session specs. Mirror off restores the pre-mirror behavior exactly:
 * the curated allowlist alone, possibly empty (fully isolated). Bounded
 * like the allowlist itself. */
export function mergeAuditorAllowedExtensions(
  user: string[] | undefined,
  mirror: string[],
  mirrorEnabled: boolean,
): string[] {
  const base = normalizeAuditorAllowedExtensions(user);
  if (!mirrorEnabled) return base;
  const seen = new Set(base.map((entry) => entry.toLowerCase()));
  const out = [...base];
  for (const entry of normalizeAuditorAllowedExtensions(mirror)) {
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    out.push(entry);
  }
  return out;
}

/** v0.38.65 (field 151158): dispatch-time allowlist — the curated
 * setting union the session package mirror, unless the user explicitly
 * opted out (auditorMirrorSessionExtensions === false). Both dispatch
 * paths (complete_goal launch + provider-retry re-seed) call this so
 * provider parity between session and worker stays identical. */
export function dispatchAuditorAllowedExtensions(
  user: string[] | undefined,
  mirrorSetting: boolean | undefined,
  home: string,
  cwd?: string,
): string[] {
  const enabled = mirrorSetting !== false;
  const mirror = enabled ? sessionMirrorExtensionSpecs(home, cwd) : [];
  return mergeAuditorAllowedExtensions(user, mirror, enabled);
}

/** Bounded, deterministic normalization of the allowlist value.
 * Audit 2026-09-06: dedup is case-insensitive like the model fallback
 * chains (npm names cannot differ by case; a same-case pair is always the
 * same intent). The first spelling wins; the original is preserved. */
export function normalizeAuditorAllowedExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const spec = entry.trim();
    const key = spec.toLowerCase();
    if (!spec || seen.has(key)) continue;
    if (out.length >= 32) break; // bounded: the request hash stays sane
    seen.add(key);
    out.push(spec);
  }
  return out;
}

function readJsonArray(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const out: string[] = [];
    for (const key of ["packages", "extensions"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Auto-discovered extension entries in a directory: *.ts / *.js files and
 * subdirectories (loaded by pi as <dir>/index.ts). */
function discoverDir(dir: string, source: DiscoveredPiExtension["source"]): DiscoveredPiExtension[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredPiExtension[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      out.push({ spec: full, label: entry.name, source });
    } else if (entry.isDirectory()) {
      out.push({ spec: full, label: `${entry.name}/`, source });
    }
  }
  return out;
}

function labelForSpec(spec: string): string {
  // "npm:@scope/pkg@version" → "@scope/pkg"; "git:url" → url tail; paths → basename.
  const colon = spec.indexOf(":");
  if (colon > 0) {
    const scheme = spec.slice(0, colon);
    const rest = spec.slice(colon + 1);
    if (scheme === "npm" || scheme === "git") {
      const withoutVersion = rest.replace(/@[^/@]*$/, "");
      return withoutVersion || rest;
    }
  }
  return path.basename(spec) || spec;
}

/**
 * Discover every extension a normal pi session would load in this
 * environment: user settings packages/extensions, the user extensions dir,
 * project settings packages/extensions, and the project extensions dir.
 * Deduplicated by spec, stable order: settings packages first, then
 * settings extension paths, then directory discovery (user before project).
 */
export function discoverAuditorExtensions(home: string, cwd?: string): DiscoveredPiExtension[] {
  const agentDir = path.join(home, ".pi", "agent");
  const out: DiscoveredPiExtension[] = [];
  const seen = new Set<string>();
  const push = (spec: string, source: DiscoveredPiExtension["source"]) => {
    if (!spec || seen.has(spec)) return;
    seen.add(spec);
    out.push({ spec, label: labelForSpec(spec), source });
  };
  // Settings entries: packages[] specs and extensions[] paths are resolved
  // to concrete install paths (npm: → managed node_modules, git: → managed
  // git root, relative paths → settings base dir) so the stored allowlist
  // entry is directly loadable by `pi --extension <path>` without a fresh
  // temporary install. Unresolvable entries are skipped, not emitted.
  const pushResolved = (raw: string, source: DiscoveredPiExtension["source"], base: string) => {
    const spec = resolveAuditorExtensionSpec(raw, { home, cwd, base });
    if (!spec || seen.has(spec)) return;
    seen.add(spec);
    out.push({ spec, label: labelForSpec(raw), source, raw });
  };
  const userSettings = readJsonArray(path.join(agentDir, "settings.json"));
  for (const raw of userSettings) pushResolved(raw, /^[a-z]+:/.test(raw) ? "package" : "extensions-setting", agentDir);
  for (const entry of discoverDir(path.join(agentDir, "extensions"), "user-dir")) push(entry.spec, entry.source);
  if (cwd) {
    const projectSettings = readJsonArray(path.join(cwd, ".pi", "settings.json"));
    const projectBase = path.join(cwd, ".pi");
    for (const raw of projectSettings) pushResolved(raw, /^[a-z]+:/.test(raw) ? "package" : "extensions-setting", projectBase);
    for (const entry of discoverDir(path.join(cwd, ".pi", "extensions"), "project-dir")) push(entry.spec, entry.source);
  }
  return out;
}

/** Expand the allowlist into `pi` CLI args: ["--extension", spec, …].
 * Audit 2026-09-06: entries resolve fail-closed through
 * resolveAuditorAllowedExtensions first — raw `npm:`/relative specs are
 * never emitted (a raw npm: entry would trigger a fresh network install,
 * or silently load nothing offline). Empty/absent list → [] (the worker
 * keeps plain --no-extensions). */
export function auditorExtensionArgs(
  allowed: string[] | undefined,
  home: string,
  cwd?: string,
  settingsBase?: string,
): string[] {
  const args: string[] = [];
  for (const spec of resolveAuditorAllowedExtensions(allowed, home, cwd, settingsBase)) {
    args.push("--extension", spec);
  }
  return args;
}
