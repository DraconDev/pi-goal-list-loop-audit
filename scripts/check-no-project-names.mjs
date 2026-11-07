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
// FORWARD-LOOKING BY DESIGN (operator decision 2026-11-07). The tree already
// carries ~950 historical references in code comments, docs and published
// release sections. Those are grandfathered: an npm tarball is immutable,
// AGENTS.md forbids rewriting pushed history, and a retroactive scrub would be
// a large risky edit to shipped sources for no behavioural gain.
//
// So the gate judges the RELEASE, not the tree: it reads only lines that are
// NEW relative to the most recent release tag. Existing text is grandfathered
// automatically, with no baseline manifest — which matters, because a
// committed baseline would publish the very names it exists to protect.
//
// Scope (operator decision): every path in package.json's `files` list (what
// npm publishes) plus `audit/`, which is absent from the tarball but present
// in the public GitHub/GitLab mirrors. Audit docs keep their reproduction and
// redact the name (`<project>/entrypoints/background.ts`) so the path shape and
// file counts still verify. `tests/` is out of scope: a fixture may need a
// realistic repo name and tests are not shipped documentation.
//
// The denylist lives OUTSIDE git (`.dracon/no-project-names.txt`, covered by
// the `.dracon/*` ignore rule) for the same reason.
//
// Usage: node scripts/check-no-project-names.mjs [--verbose] [--base <ref>]
//   --base  compare against this ref instead of the newest tag. Pass `HEAD` to
//           audit only the working tree (used by the unit test).
// Exit 0 = clean (or nothing to judge), exit 1 = violation.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
/** Operator-local plaintext list (untracked). Preferred when present. */
const DENYLIST_PATH = path.join(ROOT, ".dracon", "no-project-names.txt");
/** Tracked hashed watch list, so the gate also runs in CI and for
 * contributors who have no plaintext list. One-way: it can catch a leak
 * without publishing the names it protects. */
const HASHED_LIST_PATH = path.join(ROOT, "scripts", "no-project-names.denylist.json");
/** Must match the "salt" value in the hashed list. */
const HASH_SALT = "glla-no-project-names-v1";
const VERBOSE = process.argv.includes("--verbose");
const baseArgIndex = process.argv.indexOf("--base");
const BASE_ARG = baseArgIndex >= 0 ? process.argv[baseArgIndex + 1] : undefined;

/** Files scanned when no base ref resolves (fallback: judge the newest release
 * section + Unreleased only). Mirrors package.json `files` plus `audit/`. */
const SCAN_PREFIXES = ["extensions", "skills", "prompts", "schemas", "scripts", "docs", "examples", "audit"];
const SCAN_FILES = ["README.md", "INSTALL.md", "PLAN.md", "LIST-PHILOSOPHY.md", "CHANGELOG.md"];

/** Extensions that carry no reviewable prose. */
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".mp4", ".webm", ".mp3", ".wav", ".pdf", ".zip", ".gz", ".tgz", ".kra",
  ".woff", ".woff2", ".ttf", ".otf", ".db", ".sqlite", ".sqlite3",
]);

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

/** SHA-256 of one candidate token, lowercased, salted. */
function hashToken(token) {
  return createHash("sha256").update(`${HASH_SALT}|${token.toLowerCase()}`).digest("hex");
}

/** Read the tracked hashed watch list. Returns [] when absent/malformed — the
 * plaintext path still works locally. */
function readHashedDenylist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HASHED_LIST_PATH, "utf-8"));
    const salt = typeof parsed?.salt === "string" ? parsed.salt : HASH_SALT;
    const denied = Array.isArray(parsed?.denied) ? parsed.denied : [];
    return {
      salt,
      hashes: new Set(denied.filter((h) => typeof h === "string" && /^[0-9a-f]{64}$/i.test(h)).map((h) => h.toLowerCase())),
    };
  } catch {
    return { salt: HASH_SALT, hashes: new Set() };
  }
}

/** Every case-preserving token shape worth hashing: whole words, hyphen/underscore
 * joined runs, and single tokens. We hash candidates rather than regex-matching
 * because a hash cannot be turned back into a pattern. */
const CANDIDATE_TOKEN = /[A-Za-z0-9][A-Za-z0-9_.-]*/g;
/** The name may appear with a hyphen inside a longer identifier (the way a
 * project name shows up in a package or a directory). Each contiguous run is
 * hashed whole, and also in every underscore/dash-split segment, so both
 * `lib/ui/theme.css`-style paths and joined identifiers are covered. */
function candidateTokens(text) {
  const seen = new Set();
  for (const match of text.matchAll(CANDIDATE_TOKEN)) {
    const run = match[0];
    seen.add(run);
    for (const part of run.split(/[-_.]/)) {
      if (part.length >= 3) seen.add(part);
    }
  }
  return seen;
}

/** Hashed-match a single added line. Returns the set of hex digests that hit,
 * or null when there is no hashed list to check. */
function hashedHits(text, hashed) {
  if (hashed.hashes.size === 0) return null;
  const hits = [];
  for (const token of candidateTokens(text)) {
    const digest = createHash("sha256").update(`${hashed.salt}|${token.toLowerCase()}`).digest("hex");
    if (hashed.hashes.has(digest)) hits.push(token);
  }
  return hits;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary, case-insensitive. The boundary keeps a denied name from
 * firing inside a longer word that merely starts with it, and the `[\w-]`
 * lookarounds stop a longer project name from matching a shorter denied one. */
function buildPattern(names) {
  if (names.length === 0) return undefined;
  return new RegExp(`(?<![\\w-])(?:${names.map(escapeRegExp).join("|")})(?![\\w-])`, "gi");
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim();
  } catch {
    return undefined;
  }
}

function newestTag() {
  const tag = git(["describe", "--tags", "--abbrev=0"]);
  return tag && tag.length > 0 ? tag : undefined;
}

function inScope(relPath) {
  if (SCAN_FILES.includes(relPath)) return true;
  if (!SCAN_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`))) return false;
  return !SKIP_EXT.has(path.extname(relPath).toLowerCase());
}

/** Added lines only, as `file -> lineNumber -> text`. `-U0` keeps the diff
 * small: we only need the new side. */
function addedLines(base) {
  const diff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--"]);
  if (diff === undefined) return undefined;
  const result = [];
  let file;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (!file || !line.startsWith("@@")) continue;
    // @@ -a,b +c,d @@ — the new-side start is the second number group.
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    result.push({ file, start: Number(hunk[1]), count: hunk[2] === undefined ? 1 : Number(hunk[2]) });
  }
  // Re-walk to attach the actual added text to each hunk.
  const out = [];
  let fileB;
  let cursor = -1;
  let hunkIdx = -1;
  const hunks = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { fileB = line.slice("+++ b/".length); continue; }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      cursor = Number(hunk[1]);
      hunkIdx++;
      hunks.length = 0;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push({ file: fileB, line: cursor, text: line.slice(1) });
      cursor++;
    } else if (line.startsWith(" ")) {
      cursor++;
    }
  }
  void result; void hunkIdx; void hunks;
  return out;
}

/** Fallback when no base ref resolves: judge only the newest release section
 * and the live Unreleased section of CHANGELOG.md, plus every file under
 * `audit/` (which the mirrors publish whether or not the tarball carries it). */
function fallbackTargets() {
  const targets = [];
  const changelog = path.join(ROOT, "CHANGELOG.md");
  if (fs.existsSync(changelog)) {
    const lines = fs.readFileSync(changelog, "utf-8").split("\n");
    const sectionStarts = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+(?:Unreleased|\d+\.\d+\.\d+)/.test(lines[i])) sectionStarts.push(i);
      if (sectionStarts.length === 2) break;
    }
    const end = sectionStarts.length > 1 ? sectionStarts[1] : lines.length;
    for (let i = sectionStarts[0] ?? lines.length; i < end; i++) {
      targets.push({ file: "CHANGELOG.md", line: i + 1, text: lines[i] });
    }
  }
  const auditDir = path.join(ROOT, "audit");
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      let text;
      try { text = fs.readFileSync(full, "utf-8"); } catch { continue; }
      if (text.includes("\u0000")) continue;
      const rel = path.relative(ROOT, full).replaceAll("\\", "/");
      text.split("\n").forEach((lineText, i) => targets.push({ file: rel, line: i + 1, text: lineText }));
    }
  };
  walk(auditDir);
  return targets;
}

const names = readDenylist();
const hashed = readHashedDenylist();
if (names.length === 0 && hashed.hashes.size === 0) {
  console.log(
    "no-project-names: no watch list — nothing to check.\n" +
    `  Expected one of: ${path.relative(ROOT, DENYLIST_PATH)} (operator-local, untracked)\n` +
    `  or ${path.relative(ROOT, HASHED_LIST_PATH)} (tracked, hashed).\n` +
    "  This is not a failure: there are no names to enforce yet.",
  );
  process.exit(0);
}
const pattern = buildPattern(names);

const base = BASE_ARG ?? newestTag();
const judged = base ? addedLines(base) : undefined;
const candidates = judged ?? fallbackTargets();
const judgedBy = base && judged ? `lines new since ${base}` : "newest release section + audit/ (no base ref)";

const violations = [];
let considered = 0;
for (const entry of candidates) {
  if (!entry.file || !inScope(entry.file)) continue;
  if (entry.file === "scripts/check-no-project-names.mjs") continue;
  if (entry.text.includes("\u0000")) continue;
  considered++;
  const found = new Set();
  if (pattern) {
    pattern.lastIndex = 0;
    for (const match of entry.text.matchAll(pattern)) found.add(match[0]);
  }
  // The hashed list catches names even when no plaintext list exists (CI, or a
  // contributor checkout). Reported as `<matches a watched name>`: the whole
  // point of hashing is that this output cannot echo the name back.
  const hits = hashedHits(entry.text, hashed);
  const hashedOnly = [];
  if (hits && hits.length > 0) {
    found.add("<matches a watched name>");
    hashedOnly.push(...hits);
  }
  if (found.size === 0) continue;
  // A name known only as a hash must STAY unknown in the output: this runs in
  // CI, whose logs are public. Redact hash-matched tokens from the excerpt.
  let excerpt = entry.text.trim();
  for (const token of hashedOnly) {
    excerpt = excerpt.split(token).join("<redacted>");
  }
  violations.push({
    file: entry.file,
    line: entry.line,
    names: [...found],
    excerpt: excerpt.slice(0, 160),
  });
}

if (violations.length === 0) {
  const watched = names.length + hashed.hashes.size;
  console.log(
    `no-project-names: clean — ${considered} ${judgedBy} checked against ${watched} watched name(s)` +
    ` (${names.length} plaintext, ${hashed.hashes.size} hashed).`,
  );
  process.exit(0);
}

console.error(`no-project-names: ${violations.length} reference(s) to private project names in text shipping in this release (${judgedBy}):\n`);
const seen = new Set();
for (const v of violations) {
  const key = `${v.file}:${v.line}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.error(`  ${v.file}:${v.line}  [${v.names.join(", ")}]`);
  if (VERBOSE) console.error(`      ${v.excerpt}`);
}
console.error(
  "\nShipped text names a private project. Describe the bug, the reproduction and the fix\n" +
  "without naming which private tree found it — \"a field report\" instead of the project,\n" +
  "and `<project>/entrypoints/background.ts` in audit reproductions so the path shape and\n" +
  "file counts still verify. Pre-existing text is grandfathered; only new lines are judged.\n\n" +
  "Watch list: .dracon/no-project-names.txt (operator-local, untracked) and\n" +
  "scripts/no-project-names.denylist.json (tracked, SHA-256 hashed).",
);
process.exit(1);
