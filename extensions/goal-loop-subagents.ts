// pi-goal-list-loop-audit — v0.36.2
// extensions/goal-loop-subagents.ts
//
// Model override support for the current nicobailon/pi-subagents package.
// Current built-ins inherit the parent model by default; unlike the old
// provider, they do not pin Explore/Plan/general-purpose to a hidden model.
// GLLA therefore only writes a role file when the user explicitly pins a
// model, plus its own read-only Designer role.
//
// The current package's agent definitions are shipped as ordinary
// <agentDir>/agents/<name>.md files. When GLLA needs to override a built-in it
// reads that installed definition, preserves its complete frontmatter/prompt,
// and adds only the model plus a management marker. This avoids copying stale
// upstream prompts into GLLA and makes package upgrades visible on the next
// sync.
//
// Files without the marker are user-owned and are never modified or removed.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Frontmatter marker identifying files this module wrote. Files without it
 * are user-owned: never modified, never deleted. */
export const SUBAGENT_MANAGED_MARKER = "pi-goal-list-loop-audit";

/** Current pi-subagents built-ins exposed by the model settings UI. External
 * CLI runners are intentionally excluded: their model selection is
 * provider-specific. */
export const CURRENT_SUBAGENT_AGENT_NAMES = [
  "delegate",
  "oracle",
  "researcher",
  "reviewer",
  "scout",
  "worker",
] as const;

/** The current package has no hidden model pins in its built-in agents. This
 * remains exported because older callers/tests use it as a drift contract. */
export const KNOWN_PINNED_DEFAULT_AGENTS = [] as const;

/** Roles that GLLA itself owns. Built-ins are created only for explicit model
 * pins; Designer is always present because GLLA invokes it as a checkpoint. */
export const KNOWN_MANAGED_AGENT_NAMES = ["Designer"] as const;

/** Names managed by the pre-0.36 Tintin integration. They are cleanup targets
 * only: user-owned files are still left untouched, and old settings are not
 * silently mapped to a semantically different current role. */
const LEGACY_MANAGED_AGENT_NAMES = ["Explore", "Plan", "general-purpose"] as const;

/** Strategy for subagent model selection. Current built-ins already inherit
 * the parent model, so both choices now differ only for GLLA-managed files
 * and explicit per-role pins. The setting remains for compatibility. */
export type SubagentModelStrategy = "inherit-parent" | "agent-default";

// These source-level aliases avoid breaking consumers that imported the old
// names. They describe the nearest current role; files and settings use the
// lowercase current names. The real definition body is loaded from the
// installed package below, not copied into this extension.
export const SCOUT_DEFAULT_DESCRIPTION = "Fast codebase recon that returns compressed context for handoff";
export const SCOUT_DEFAULT_TOOLS = "read, grep, find, ls, bash, write";
export const SCOUT_DEFAULT_SYSTEM_PROMPT = `You are a scouting subagent running inside pi.

Use the provided tools directly. Move fast, but do not guess. Start discovery with task-provided paths and specific symbols, types, methods, filenames, or likely source roots. Use \`find\` for path discovery. Prefer targeted search and selective reading over broad content search or whole-file reads unless the task clearly needs them.

Focus on the minimum context another agent needs to act: relevant entry points, key types and functions, data flow and dependencies, likely files to change, constraints, risks, and open questions.`;
export const EXPLORE_DEFAULT_DESCRIPTION = SCOUT_DEFAULT_DESCRIPTION;
export const EXPLORE_DEFAULT_SYSTEM_PROMPT = SCOUT_DEFAULT_SYSTEM_PROMPT;
export const EXPLORE_DEFAULT_TOOLS = SCOUT_DEFAULT_TOOLS;

export const DESIGNER_DEFAULT_DESCRIPTION = "Read-only design specialist for turning an explicit design request into an architecture, affected-file map, risks, trade-offs, and a verification plan before implementation.";

export const DESIGNER_DEFAULT_SYSTEM_PROMPT = `# DESIGNER ROLE — READ-ONLY DESIGN CHECKPOINT
You are the Designer subagent. Do not edit, create, delete, or move files and do not run commands that change repository state.

For the assigned objective:
1. Inspect the relevant repository files and existing conventions.
2. Return a concise implementation design: current behavior, proposed shape, affected files, interfaces/data flow, risks, trade-offs, and concrete verification steps.
3. Call out assumptions and unresolved user decisions as explicit questions with a recommended default.
4. Prefer durable, maintainable fixes over cosmetic workarounds. The parent agent owns implementation and decides whether to apply the design.

Use only read, bash, grep, find, and ls. End with a short DESIGN CHECKPOINT summary the parent agent can turn into a task or plan.`;

interface EmbeddedAgentDefault {
  /** Current built-ins are read from the installed companion package. */
  upstream?: boolean;
  description: string;
  systemPrompt: string;
  tools: string;
}

/** Only Designer is embedded because it is GLLA-owned. Current built-ins are
 * represented here for validation and loaded from pi-subagents at sync time. */
const EMBEDDED_DEFAULTS: Record<string, EmbeddedAgentDefault> = {
  ...Object.fromEntries(CURRENT_SUBAGENT_AGENT_NAMES.map((name) => [name, {
    upstream: true,
    description: name,
    systemPrompt: "",
    tools: "",
  }])),
  Designer: {
    description: DESIGNER_DEFAULT_DESCRIPTION,
    systemPrompt: DESIGNER_DEFAULT_SYSTEM_PROMPT,
    tools: "read, bash, grep, find, ls",
  },
};

/** Agent types the user can pin per type via subagentModelOverrides. */
export const OVERRIDABLE_AGENT_TYPES = [...CURRENT_SUBAGENT_AGENT_NAMES, "Designer"];

/** Default global agent dir (pi-subagents reads $PI_CODING_AGENT_DIR/agents,
 * default ~/.pi/agent/agents). Delegate to pi's runtime resolver so custom
 * `PI_CODING_AGENT_DIR` and future app-specific config-dir names stay aligned
 * with the host rather than being silently ignored by GLLA. */
export function defaultAgentDir(): string {
  return getAgentDir();
}

function upstreamAgentDefinitionPath(name: string): string | undefined {
  const candidates = [
    path.resolve("node_modules", "pi-subagents", "agents", `${name}.md`),
    path.join(defaultAgentDir(), "npm", "node_modules", "pi-subagents", "agents", `${name}.md`),
    path.join(defaultAgentDir(), "node_modules", "pi-subagents", "agents", `${name}.md`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function designerDefinition(): string {
  return [
    "---",
    "name: Designer",
    `description: '${DESIGNER_DEFAULT_DESCRIPTION.replace(/'/g, "''")}'`,
    "tools: read, bash, grep, find, ls",
    "thinking: high",
    "systemPromptMode: replace",
    "inheritProjectContext: true",
    "inheritSkills: false",
    "---",
    "",
    DESIGNER_DEFAULT_SYSTEM_PROMPT,
    "",
  ].join("\n");
}

function installedAgentDefinition(name: string): string {
  if (name === "Designer") return designerDefinition();
  const file = upstreamAgentDefinitionPath(name);
  if (!file) {
    throw new Error(`installed pi-subagents agent definition is unavailable for "${name}"`);
  }
  return fs.readFileSync(file, "utf-8");
}

/** Build the override .md file content. With `model`, the pin is written;
 * without, the file falls through to the parent session model. The complete
 * current role definition is retained so a model-only override cannot turn a
 * worker/scout into an accidentally empty agent. */
export function buildAgentOverrideMd(name: string, model?: string): string {
  const def = EMBEDDED_DEFAULTS[name];
  if (!def) throw new Error(`no embedded default config for agent "${name}"`);
  const source = def.upstream ? installedAgentDefinition(name) : designerDefinition();
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`installed pi-subagents agent definition for "${name}" has invalid frontmatter`);
  const frontmatter = match[1]!.split(/\r?\n/).filter((line) =>
    !/^model:\s*/.test(line) && !/^x-managed-by:\s*/.test(line) && !/^x-glla-note:\s*/.test(line));
  const body = match[2]!.replace(/^\r?\n/, "").replace(/\s*$/, "");
  const lines = ["---", ...frontmatter];
  if (model) lines.push(`model: ${model}`);
  lines.push(
    `x-managed-by: ${SUBAGENT_MANAGED_MARKER}`,
    model
      ? `x-glla-note: model pinned to ${model} by glla subagentModelOverrides. Remove the file or clear the /glla ${name} pin to restore the upstream model behavior.`
      : "x-glla-note: model pin omitted so this agent inherits the parent session model. Managed by glla; clear the override or switch /glla subagent strategy to agent-default to remove this file.",
    "---",
    "",
    body || def.systemPrompt || "(no system-prompt override)",
    "",
  );
  return lines.join("\n");
}

function hasManagedMarker(content: string): boolean {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return !!frontmatter?.split(/\r?\n/).some((line) => line.trim() === `x-managed-by: ${SUBAGENT_MANAGED_MARKER}`);
}

export interface SubagentSyncResult {
  written: string[];
  removed: string[];
  /** Files left untouched because the user owns them (no marker). */
  skipped: Array<{ name: string } & { reason: string }>;
  /** Managed files expected from a previous run but found missing or altered. */
  repaired: string[];
}

/** State file tracking what the last sync wrote (repair detection). */
export function subagentSyncStatePath(agentDir: string): string {
  return path.join(agentDir, "agents", ".glla-subagent-sync.json");
}

/** Sync <agentDir>/agents/<name>.md with the desired state. Idempotent:
 * writes only when content differs. Never touches non-managed files. */
export function syncSubagentModelOverrides(opts: {
  agentDir: string;
  strategy: SubagentModelStrategy;
  overrides?: Record<string, string>;
}): SubagentSyncResult {
  const result: SubagentSyncResult = { written: [], removed: [], skipped: [], repaired: [] };
  const overrides = opts.overrides ?? {};
  const managedNow = new Set<string>();
  let prevWritten: string[] = [];
  try {
    const prev = JSON.parse(fs.readFileSync(subagentSyncStatePath(opts.agentDir), "utf-8"));
    if (Array.isArray(prev?.written)) prevWritten = prev.written.map(String);
  } catch {
    /* first sync or unreadable state */
  }

  // Legacy names remain in the pass solely so a previously managed file is
  // removed safely. They are not aliases: silently changing their semantics
  // would be worse than a visible settings warning.
  const names = new Set<string>([
    ...KNOWN_MANAGED_AGENT_NAMES,
    ...LEGACY_MANAGED_AGENT_NAMES,
    ...prevWritten,
    ...Object.keys(overrides),
  ]);

  for (const name of names) {
    const overrideModel = overrides[name];
    const file = path.join(opts.agentDir, "agents", `${name}.md`);
    const exists = fs.existsSync(file);
    const current = exists ? fs.readFileSync(file, "utf-8") : undefined;
    const def = EMBEDDED_DEFAULTS[name];

    if (overrideModel !== undefined && !def) {
      if (exists && hasManagedMarker(current!)) {
        fs.unlinkSync(file);
        result.removed.push(name);
      } else {
        result.skipped.push({
          name,
          reason: `legacy or unknown agent name "${name}" — choose one of ${OVERRIDABLE_AGENT_TYPES.join(", ")} in the current pi-subagents package; user-owned files are left untouched`,
        });
      }
      continue;
    }

    // Explicit pins are the only reason to copy a current built-in. Designer
    // remains a GLLA-owned role regardless of strategy.
    const desired = overrideModel !== undefined
      ? (() => {
        try { return buildAgentOverrideMd(name, overrideModel); }
        catch (error) {
          result.skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
          return undefined;
        }
      })()
      : name === "Designer"
        ? (() => {
          try { return buildAgentOverrideMd(name); }
          catch (error) {
            result.skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
            return undefined;
          }
        })()
        : undefined;

    if (desired === undefined) {
      if (exists && hasManagedMarker(current!)) {
        fs.unlinkSync(file);
        result.removed.push(name);
      } else if (exists && name === "Designer") {
        result.skipped.push({ name, reason: "user-owned file (no glla marker) — left untouched" });
      }
      continue;
    }

    if (exists && !hasManagedMarker(current!)) {
      result.skipped.push({ name, reason: "user-owned file (no glla marker) — left untouched" });
      continue;
    }
    if (current === desired) {
      managedNow.add(name);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, desired);
    managedNow.add(name);
    result.written.push(name);
    if (prevWritten.includes(name)) result.repaired.push(name);
  }

  try {
    fs.mkdirSync(path.join(opts.agentDir, "agents"), { recursive: true });
    fs.writeFileSync(subagentSyncStatePath(opts.agentDir), JSON.stringify({ written: [...managedNow].sort(), at: new Date().toISOString() }));
  } catch {
    /* repair detection is best-effort */
  }
  return result;
}

/** Effective model for the headless settings display. Current built-ins use
 * the companion's own default (which normally inherits the parent session). */
export function resolveEffectiveSubagentModel(
  name: string,
  settings: { subagentModelStrategy?: string; subagentModelOverrides?: Record<string, string>; subagentFallbacks?: Record<string, string[]> },
  sessionModel?: string,
): string {
  const chain = settings.subagentFallbacks?.[name];
  if (chain && chain.length > 0) return `${chain.join(" → ")} (subagentFallbacks chain)`;
  const pin = settings.subagentModelOverrides?.[name];
  if (pin) return `${pin} (per-type pin)`;
  if ((settings.subagentModelStrategy ?? "inherit-parent") === "inherit-parent") {
    return sessionModel ? `${sessionModel} (inherits session)` : "(session model)";
  }
  return "(agent default)";
}

/** Pure helper: choose the first eligible model ref in a fallback chain. */
export function resolveSubagentOverrideRef(
  _name: string,
  chain: string[] | undefined,
  resolve: (ref: string) => unknown | undefined,
  isForbidden: (ref: string) => boolean,
): string | undefined {
  if (!chain || chain.length === 0) return undefined;
  for (const ref of chain) {
    if (isForbidden(ref)) continue;
    if (!resolve(ref)) continue;
    return ref;
  }
  return undefined;
}
