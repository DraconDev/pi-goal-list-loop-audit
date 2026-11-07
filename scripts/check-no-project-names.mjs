#!/usr/bin/env node
// pi-goal-list-loop-audit — v0.39.64
// scripts/check-no-project-names.mjs
//
// Shipped text must not name the operator's own private projects. This repo is
// published to npm and mirrored publicly; the durable information in a field
// report is the bug, the reproduction, and the fix — never which proprietary
// tree found it. Naming a project in CHANGELOG.md publishes an inventory of
// private work to every consumer of the package.
//
// Scope (operator decision 2026-11-07):
//   - every path in package.json's `files` list (what npm actually publishes),
//   - plus `audit/`, which ships in the public repo even though it is not in
//     the npm tarball. Audit docs keep their reproduction; they redact the
//     name (`<project>/entrypoints/background.ts`) so the path shape and file
//     counts still verify.
//   - `tests/` is out of scope: a test fixture may need a realistic repo name,
//     and tests are not shipped documentation.
//
// The denylist lives OUTSIDE git (`.dracon/no-project-names.txt`) because this
// gate's own data would otherwise publish the names it exists to protect.
//
// Grandfathered: release sections published before this rule (plus the
// v0.39.64 section that was scrubbed by hand) keep their original text — an
// npm tarball is immutable and AGENTS.md forbids rewriting pushed history.
// Only the NEWEST release heading and the current `## Unreleased` section are
// gated, so the rule moves forward with each release instead of demanding a
// retroactive scrub it cannot verify.
//
// Usage: node scripts/check-no-project-names.mjs [--verbose]
// Exit 0 = clean (or no denylist present), exit 1 = violation.

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const DENYLIST_PATH = path.join(ROOT, ".dracon", "no-project-names.txt");
const VERBOSE = process.argv.includes("--verbose");

/** Paths under the repo root this gate scans. `audit/` is included even though
 * the npm tarball does not carry it: the GitHub mirror is public too. */
const SCAN_DIRS = ["extensions", "skills", "prompts", "schemas", "scripts", "docs", "examples", "audit"];
const SCAN_FILES = ["README.md", "INSTALL.md", "PLAN.md", "LIST-PHILOSOPHY.md", "CHANGELOG.md"];

/** Binary/asset extensions that carry no reviewable prose. */
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp4", ".webm", ".mp3", ".wav", ".pdf", ".zip", ".gz", ".tgz", ".kra",
  ".woff", ".woff2", ".ttf", ".otf", ".db", ".sqlite", ".sqlite3",
]);

/** Test fixtures and this script's own denylist handling are exempt. */
const EXEMPT_PATH = /(?:^|\/)(?:fixtures?|__fixtures__)\//i;

function readDenylist() {
  if (!fs.existsSync(DENYLIST_PATH)) return [];
  const entries = [];
  for (const line of fs.readFileSync(DENYLIST_PATH, "utf-8").split("\n")) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    entries.push(clean);
  }
  return entries;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match, case-insensitive. `hegemon` must not fire inside
 * `hegemonic`, and `eve`-style 3-letter names are why the boundary matters. */
function buildPattern(names) {
  if (names.length === 0) return undefined;
  return new RegExp(`(?<![\\w-])(?:${names.map(escapeRegExp).join("|")})(?![\\w-])`, "gi");
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      yield full;
    }
  }
}

/** Only the newest release section and the live Unreleased section are gated.
 * Everything older is grandfathered published text. */
function gatedChangelogText(text) {
  const lines = text.split("\n");
  let firstReleaseAt = -1;
  let secondReleaseAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\d+\.\d+\.\d+/.test(lines[i])) {
      if (firstReleaseAt < 0) firstReleaseAt = i;
      else if (secondReleaseAt < 0) { secondReleaseAt = i; break; }
    }
  }
  const kept = [];
  // The Unreleased section, wherever it sits (normally above the newest).
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Unreleased/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
      kept.push({ offset: i, text: lines.slice(i, j).join("\n") });
    }
  }
  if (firstReleaseAt >= 0) {
    const end = secondReleaseAt >= 0 ? secondReleaseAt : lines.length;
    kept.push({ offset: firstReleaseAt, text: lines.slice(firstReleaseAt, end).join("\n") });
  }
  // Return a text with non-gated regions blanked, so reported line numbers
  // still point at the real file.
  const blanked = lines.map(() => "");
  for (const section of kept) {
    const sectionLines = section.text.split("\n");
    for (let k = 0; k < sectionLines.length; k++) blanked[section.offset + k] = sectionLines[k];
  }
  return blanked.join("\n");
}

function scan() {
  const names = readDenylist();
  if (names.length === 0) {
    return { skipped: true, violations: [], scannedFiles: 0 };
  }
  const pattern = buildPattern(names);
  const violations = [];
  let scannedFiles = 0;

  const targets = [];
  for (const file of SCAN_FILES) {
    if (fs.existsSync(path.join(ROOT, file))) targets.push(path.join(ROOT, file));
  }
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) targets.push(...walk(full));
  }

  for (const file of targets) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    if (EXEMPT_PATH.test(rel)) continue;
    if (rel === "scripts/check-no-project-names.mjs") continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // A NUL byte means binary despite the extension.
    if (text.includes("\u0000")) continue;
    scannedFiles++;
    // CHANGELOG: only the newest release + Unreleased are gated.
    const focus = rel === "CHANGELOG.md" ? gatedChangelogText(text) : text;
    const lines = focus.split("\n");
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      const matches = [...lines[i].matchAll(pattern)];
      if (matches.length === 0) continue;
      violations.push({
        file: rel,
        line: i + 1,
        names: [...new Set(matches.map((m) => m[0]))],
        excerpt: lines[i].trim().slice(0, 160),
      });
    }
  }
  return { skipped: false, violations, scannedFiles, names };
}

const result = scan();

if (result.skipped) {
  console.log(
    "no-project-names: denylist absent (.dracon/no-project-names.txt) — nothing to check.\n" +
    "  This file is intentionally untracked; a fresh clone cannot run the gate.",
  );
  process.exit(0);
}

if (result.violations.length === 0) {
  console.log(
    `no-project-names: clean — ${result.scannedFiles} shipped files scanned against ${result.names.length} denied name(s).`,
  );
  process.exit(0);
}

console.error(`no-project-names: ${result.violations.length} reference(s) to private project names in shipped text:\n`);
for (const v of result.violations) {
  console.error(`  ${v.file}:${v.line}  [${v.names.join(", ")}]`);
  if (VERBOSE) console.error(`      ${v.excerpt}`);
}
console.error(
  "\nShipped text names a private project. Describe the bug, the reproduction and the fix\n" +
  "without naming which private tree found it — e.g. \"a field report\" instead of the\n" +
  "project, and `<project>/entrypoints/background.ts` in audit reproductions so the path\n" +
  "shape still verifies. Published release sections older than the newest are grandfathered.\n\n" +
  "Denylist: .dracon/no-project-names.txt (untracked by design).",
);
process.exit(1);
