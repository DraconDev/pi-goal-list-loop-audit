// Project tool options are optional argument overrides, applied through Pi's
// public tool_call hook. Validate a complete copy before changing live input:
// the host validated the original arguments before this event, and does not
// revalidate them afterward.
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

interface ToolSchemaInfo {
  name: string;
  parameters: TSchema;
}
export type ToolConfigResult = { block: true; reason: string } | undefined;

export function applyToolConfig(
  toolName: string,
  input: unknown,
  options: unknown,
  tools: () => readonly ToolSchemaInfo[],
): ToolConfigResult {
  if (options === undefined) return undefined;
  const reject = (detail: string): ToolConfigResult => ({
    block: true,
    reason: `GLLA tool configuration for "${toolName}" was refused: ${detail}. Edit /glla → Tool overrides or use /glla tooloverride unset ${toolName} <key>.`,
  });
  if (!options || typeof options !== "object" || Array.isArray(options)) return reject("options must be an object");
  const entries = Object.entries(options);
  if (!entries.length) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject("tool arguments must be an object");
  try {
    const tool = tools().find((candidate) => candidate.name === toolName);
    if (!tool) return reject("no registered parameter schema is available on this host");
    const schema = tool.parameters as TSchema & { type?: unknown; properties?: Record<string, unknown>; required?: string[] };
    if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
      return reject("the tool does not expose named optional arguments");
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(key) || !Object.hasOwn(schema.properties, key)) {
        return reject(`unsupported option "${key}"`);
      }
      if (required.has(key)) return reject(`"${key}" is required operation input, not an optional setting`);
    }
    const candidate = { ...input, ...options };
    if (!Value.Check(schema, candidate)) return reject("configured option values do not match the tool parameter schema");
    // Preserve Pi's input identity: this is the object the executor will use.
    // Clone settings-derived objects so a tool cannot mutate durable settings
    // or another call's configured options through shared nested references.
    const cloned = structuredClone(options) as Record<string, unknown>;
    Object.assign(input, cloned);
    return undefined;
  } catch (error) {
    return reject(`option validation failed (${error instanceof Error ? error.message : String(error)})`);
  }
}
