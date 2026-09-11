// ============================================================================
// prompt-layers.ts — static skeleton + on-demand detail assembly for prompts/
// ============================================================================
// Every prompts/*.md file is one canonical, editor-renderable document.
// Detail sections are wrapped in zero-width structural markers:
//
//   <!-- glla-layer: detail <id> -->
//   ...section body, untouched...
//   <!-- glla-layer: end -->
//
// Everything outside a detail block is the skeleton: always loaded.
// A detail block loads only when its phase predicate holds. Assembly order
// is file order, every turn — static layers resolve before dynamic
// ${...} substitution slots, so renders are deterministic.
//
// Loudness contract: any structural problem (missing file, unclosed block,
// duplicate id, end-without-start, unknown requested id) THROWS naming the
// file. A render never proceeds lean on a "[template-not-found]" fallback.
// Marker lines are structural only and are stripped from assembled output,
// so full assembly (every detail active) is byte-identical to the source
// file minus its marker lines.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

const LAYER_START_RE = /^\s*<!--\s*glla-layer:\s*detail\s+([A-Za-z0-9_-]+)\s*-->\s*$/;
const LAYER_END_RE = /^\s*<!--\s*glla-layer:\s*end\s*-->\s*$/;

export interface PromptSegment {
  kind: "skeleton" | "detail";
  /** Present only for detail segments. */
  id?: string;
  /** Exact source lines for this segment (marker lines excluded). */
  lines: string[];
}

export function promptFilePath(name: string): string {
  return path.resolve(__dirname, "..", "prompts", name);
}

/** Parse one prompt source into ordered segments. Throws naming the file
 * on any structural defect. Pure (no fs) so tests can feed fixtures. */
export function parsePromptLayers(source: string, name: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let current: PromptSegment = { kind: "skeleton", lines: [] };
  let openId: string | null = null;
  const seen = new Set<string>();
  const fail = (why: string): never => {
    throw new Error(`[glla] prompts/${name}: ${why}`);
  };
  for (const line of source.split("\n")) {
    const start = line.match(LAYER_START_RE);
    const end = LAYER_END_RE.test(line);
    if (start) {
      if (openId !== null) fail(`detail "${openId}" unclosed before detail "${start[1]}" starts`);
      const id = start[1] as string;
      if (seen.has(id)) fail(`duplicate detail id "${id}"`);
      seen.add(id);
      segments.push(current);
      current = { kind: "detail", id, lines: [] };
      openId = id;
      continue;
    }
    if (end) {
      if (openId === null) fail("glla-layer end marker without an open detail block");
      segments.push(current);
      current = { kind: "skeleton", lines: [] };
      openId = null;
      continue;
    }
    current.lines.push(line);
  }
  if (openId !== null) fail(`detail "${openId}" unclosed at end of file`);
  segments.push(current);
  return segments;
}

/** Read + parse a prompt file. Throws naming the path when unreadable. */
export function loadPromptSegments(name: string): PromptSegment[] {
  const file = promptFilePath(name);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `[glla] prompt file missing: prompts/${name} (${file}): ${(err as Error)?.message ?? err}. ` +
        "Refusing to render lean — restore the file, do not proceed without it.",
    );
  }
  return parsePromptLayers(source, name);
}

/** Raw whole-file read. Throws (loud) when unreadable. Use for
 * skeleton-only phases and for render-diff baselines. */
export function loadPromptWhole(name: string): string {
  const file = promptFilePath(name);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `[glla] prompt file missing: prompts/${name} (${file}): ${(err as Error)?.message ?? err}. ` +
        "Refusing to render lean — restore the file, do not proceed without it.",
    );
  }
}

/** Detail ids declared by a prompt file, in file order. */
export function promptDetailIds(name: string): string[] {
  const ids: string[] = [];
  for (const seg of loadPromptSegments(name)) {
    if (seg.kind === "detail" && seg.id) ids.push(seg.id);
  }
  return ids;
}

/** Assemble skeleton + the requested details in file order. Unknown ids
 * throw. Empty `active` renders the bare skeleton. */
export function assemblePrompt(name: string, active: Iterable<string>): string {
  const segments = loadPromptSegments(name);
  const want = new Set(active);
  const known = new Set<string>();
  for (const seg of segments) {
    if (seg.kind === "detail" && seg.id) known.add(seg.id);
  }
  for (const id of want) {
    if (!known.has(id)) {
      throw new Error(
        `[glla] prompts/${name}: unknown detail id "${id}" (known: ${[...known].join(", ") || "(none)"}). ` +
          "Refusing to render lean — fix the request, do not proceed without it.",
      );
    }
  }
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "skeleton" || (seg.id && want.has(seg.id))) out.push(...seg.lines);
  }
  return out.join("\n");
}

/** Full assembly: every declared detail active. Render-diff gate: this must
 * equal the source file minus its marker lines. */
export function assemblePromptFull(name: string): string {
  return assemblePrompt(name, promptDetailIds(name));
}
