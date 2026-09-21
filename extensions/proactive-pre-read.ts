/**
 * pi-goal-list-loop-audit — proactive drafting pre-read (v0.36.x)
 *
 * Before the first drafting question the agent should already have seen
 * bounded evidence for the claims/pictures the user supplied. This module
 * extracts candidate file/image paths from the drafting seed, reads at most
 * 3 files (800 chars each) relative to the project cwd, and returns a
 * bounded evidence block to prepend to the drafting prompt. No model switch or
 * external vision call is performed — image evidence is surfaced as a path
 * note so the current model can inspect it natively when supported, or a
 * confirmed external provider can be used explicitly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const PROACTIVE_MAX_FILES = 3;
export const PROACTIVE_MAX_CHARS_PER_FILE = 800;
export const PROACTIVE_MAX_TOTAL_CHARS = 2800;
export const PROACTIVE_SEED_EXCERPT = 500;

const PATH_RE = /(?:^|[\s"'`(\[])([a-zA-Z0-9_.\-/@]+\.(?:md|json|ts|js|txt|png|jpg|jpeg|webp|log))/g;
const ABSOLUTE_RE = /(\/[^\s"'`)\]]+\.(?:md|json|ts|js|txt|png|jpg|jpeg|webp|log))/g;

function isImage(p: string): boolean {
  return /\.(png|jpg|jpeg|webp)$/i.test(p);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function tryRead(cwd: string, candidate: string): { kind: "text"; snippet: string; size: number } | { kind: "image"; note: string } | null {
  const image = isImage(candidate);
  // Preserve the candidate for display; resolve relative to cwd for reads.
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  if (image) {
    // Cheap existence check — no bytes loaded. The pre-read only flags the
    // image; inspection belongs to the current model or an explicitly
    // confirmed external provider.
    try {
      const st = fs.statSync(resolved);
      if (st.isFile()) return { kind: "image", note: `Image evidence: ${candidate} — ${st.size} bytes; inspect with native vision when supported, otherwise use a confirmed external provider` };
    } catch {}
    // Also accept the raw token as evidence even if not on disk — the
    // drafting prompt still sees that an image was referenced.
    return { kind: "image", note: `Image reference: ${candidate} — visual inspection requires native image support or a confirmed external provider` };
  }
  try {
    const raw = fs.readFileSync(resolved, "utf-8");
    const snippet = truncate(raw, PROACTIVE_MAX_CHARS_PER_FILE);
    return { kind: "text", snippet, size: raw.length };
  } catch {
    return null;
  }
}

/**
 * Build a bounded pre-read block from the drafting seed.
 * Pure file reads + truncation; no network/model calls.
 */
export function gatherProactivePreRead(seed: string, cwd: string): string | null {
  if (!seed || !seed.trim()) return null;
  const seen = new Set<string>();
  const candidates: string[] = [];
  // Collect both relative/path-ish tokens and absolute paths.
  for (const re of [PATH_RE, ABSOLUTE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seed)) !== null) {
      const cand = m[1]!.trim().replace(/[),.\]]+$/, "");
      if (!cand || seen.has(cand)) continue;
      seen.add(cand);
      candidates.push(cand);
      if (candidates.length >= PROACTIVE_MAX_FILES) break;
    }
    if (candidates.length >= PROACTIVE_MAX_FILES) break;
  }
  const entries: string[] = [];
  for (const cand of candidates.slice(0, PROACTIVE_MAX_FILES)) {
    const got = tryRead(cwd, cand);
    if (!got) continue;
    if (got.kind === "image") entries.push(`- ${got.note}`);
    else entries.push(`- File evidence ${cand} (${got.size} bytes, showing first ${got.snippet.length} chars):\n\`\`\`\n${got.snippet}\n\`\`\``);
    if (entries.join("\n").length >= PROACTIVE_MAX_TOTAL_CHARS) break;
  }
  // Always surface the seed excerpt so the first question is grounded even
  // when no files matched — the bounded cap keeps the prompt small.
  const excerpt = truncate(seed.trim(), PROACTIVE_SEED_EXCERPT);
  const header = "[PROACTIVE PRE-READ — bounded evidence before first question (max 3 files, 800 chars each)]";
  if (entries.length === 0) {
    // No file hit is still a pre-read — it pins that the seed was ingested
    // before questioning, which the verification contract requires.
    const block = `${header}\nSeed excerpt (${excerpt.length} chars):\n\`\`\`\n${excerpt}\n\`\`\``;
    return truncate(block, PROACTIVE_MAX_TOTAL_CHARS);
  }
  const body = entries.join("\n");
  const block = `${header}\n${body}\nSeed excerpt (${excerpt.length} chars):\n\`\`\`\n${excerpt}\n\`\`\``;
  return truncate(block, PROACTIVE_MAX_TOTAL_CHARS);
}
