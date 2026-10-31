// Published goal contract — schema/runtime TYPE parity.
//
// v0.39.40 (audit 2026-10-19): the shipped schema declared
// pendingCompletion.leftOut as an ARRAY while the runtime has always written
// a STRING, so any goal the runtime persisted with a non-empty leftOut was
// invalid under the schema shipped in the npm package. The parity fixture
// used the array shape, so CI could not see the contradiction.
//
// tests/goal.schema.test.ts pins that ONE field. This file generalises the
// check: for every schema definition that has a runtime counterpart, each
// shared property's schema type must be compatible with the runtime's type.
// The schema is permissive (additionalProperties is unset), so a runtime
// field the schema does not mention is legal — but a field the schema DOES
// describe with the wrong type is a published contract that no real goal
// file can satisfy.
//
// The extraction is deliberately mechanical (read the TypeScript, read the
// JSON) so it cannot drift from either side. When a runtime type MOVES,
// update the locator below rather than deleting the mapping: the test also
// asserts that every mapping resolved, so a silently-narrowed sweep fails
// instead of passing on less coverage.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas/goal.schema.json"), "utf8")) as {
  properties?: Record<string, unknown>;
  definitions?: Record<string, { properties?: Record<string, unknown> }>;
};

const CORE = "extensions/goal-loop-core.ts";

/** Where a runtime type lives: a named interface, or an inline object literal. */
type Locator =
  | { kind: "interface"; name: string }
  | { kind: "marker"; marker: string };

const MAPPINGS: Array<[string, Locator, string]> = [
  ["pendingCompletion", { kind: "interface", name: "PendingCompletion" }, CORE],
  ["auditVerdict", { kind: "interface", name: "AuditVerdict" }, CORE],
  ["task", { kind: "interface", name: "Task" }, CORE],
  ["backgroundWait", { kind: "interface", name: "BackgroundWait" }, "extensions/work-lifecycle.ts"],
  ["backgroundWaitDependency", { kind: "marker", marker: "runId: string;" }, "extensions/work-lifecycle.ts"],
  ["objectiveProvenance", { kind: "interface", name: "ObjectiveProvenance" }, CORE],
  ["objectiveRepair", { kind: "marker", marker: "revisionBefore: number;" }, CORE],
  ["subagentQuotaEvidence", { kind: "interface", name: "SubagentQuotaEvidence" }, "extensions/quota-retry.ts"],
  ["solutionJudgment", { kind: "interface", name: "SolutionJudgment" }, "extensions/durable-solution.ts"],
  ["usage", { kind: "marker", marker: "usage: {" }, CORE],
  ["telemetry", { kind: "marker", marker: "telemetry?: {" }, CORE],
];

/** The top-level Goal interface backs the root schema's own properties. */
const GOAL: Locator = { kind: "interface", name: "Goal" };

// ---- alias map: every `export type X = ...` in extensions/ -----------------
const alias = new Map<string, string>();
for (const dir of ["extensions", "extensions/loops"]) {
  for (const file of fs.readdirSync(path.join(ROOT, dir))) {
    if (!file.endsWith(".ts")) continue;
    const src = fs.readFileSync(path.join(ROOT, dir, file), "utf8");
    for (const m of src.matchAll(/export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/g)) {
      alias.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
    }
  }
}

function jsonType(spec: unknown): string {
  if (!spec || typeof spec !== "object") return "?";
  const record = spec as Record<string, unknown>;
  if ("type" in record) {
    const t = record.type;
    return Array.isArray(t) ? t.join("|") : String(t);
  }
  if ("$ref" in record) return "ref";
  if ("oneOf" in record || "anyOf" in record) return "union";
  if ("enum" in record) return "enum";
  return "?";
}

/** Normalise a TypeScript type expression to a coarse JSON kind. */
function tsKind(ts: string, depth = 0): string {
  if (depth > 6) return "any";
  let t = ts.trim().replace(/;$/, "").trim();
  t = t.replace(/^\|/, "").replace(/\|$/, "").trim();
  t = t.replace(/^readonly\s+/, "").replace(/\?$/, "").trim();
  if (/\[\]$/.test(t) || /^Array</.test(t)) return "array";
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "null" || t === "undefined") return "null";
  if (/^"[^"]*"$/.test(t)) return "string";
  if (t === "unknown" || t === "any") return "any";
  if (/^(Record<|Partial<|\{|Readonly|\[)/.test(t)) return "object";
  if (alias.has(t)) {
    const target = alias.get(t)!;
    const members = target.split("|").map((p) => p.trim());
    if (members.every((p) => /^["'][^"']*["']$/.test(p))) return "string";
    return tsKind(target, depth + 1);
  }
  if (t.includes("|")) {
    const kinds = [...new Set(t.split("|").map((p) => tsKind(p, depth + 1)))];
    if (kinds.length === 1) return kinds[0]!;
    const rest = kinds.filter((k) => k !== "null");
    if (rest.length === 1) return rest[0]!;
    return "union";
  }
  return "object";
}

function compatible(jsonT: string, ts: string): boolean {
  const k = tsKind(ts);
  if (jsonT === "string") return k === "string" || k === "any";
  if (jsonT === "boolean") return k === "boolean" || k === "any";
  if (jsonT === "integer" || jsonT === "number") return k === "number" || k === "any";
  if (jsonT === "array") return k === "array" || k === "any";
  if (jsonT === "object") return k === "object" || k === "array" || k === "any";
  return true; // ref / union / enum are not mechanically comparable
}

/** Field map of a named interface, or of an inline `{ ... }` literal. */
function fieldsFrom(file: string, locator: Locator): Map<string, string> | null {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  let start: number;
  if (locator.kind === "interface") {
    const m = new RegExp(`(?:export\\s+)?interface\\s+${locator.name}\\b`).exec(src);
    if (!m) return null;
    start = src.indexOf("{", m.index);
  } else {
    const idx = src.indexOf(locator.marker);
    if (idx < 0) return null;
    start = src.indexOf("{", idx);
  }
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(start + 1, i);
  const fields = new Map<string, string>();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    if (/^\s*\[/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:\s*(.+?);?\s*$/.exec(line);
    if (m) fields.set(m[1]!, m[2]!.replace(/;$/, "").trim());
  }
  return fields;
}

test("every schema definition the runtime backs is reachable, and its types agree", () => {
  const mismatches: string[] = [];
  const unresolved: string[] = [];
  let checked = 0;

  const targets: Array<[string, Locator, string, Record<string, unknown>]> = [
    ...MAPPINGS.map(([name, locator, file]) => {
      const def = schema.definitions?.[name];
      const props = def?.properties ?? (schema.properties?.[name] as Record<string, unknown> | undefined);
      return [name, locator, file, props ?? {}] as [string, Locator, string, Record<string, unknown>];
    }),
    ["goal", GOAL, CORE, schema.properties ?? {}],
  ];

  for (const [name, locator, file, properties] of targets) {
    const fields = fieldsFrom(file, locator);
    if (!fields) {
      unresolved.push(`${name} (${locator.kind === "interface" ? locator.name : locator.marker} in ${file})`);
      continue;
    }
    for (const [prop, spec] of Object.entries(properties)) {
      const ts = fields.get(prop);
      if (ts === undefined) continue;
      checked++;
      const jt = jsonType(spec);
      if (!compatible(jt, ts)) {
        mismatches.push(`${name}.${prop}: schema says "${jt}" but the runtime writes "${ts}"`);
      }
    }
  }

  assert.deepEqual(unresolved, [], `runtime types could not be located: ${unresolved.join(", ")}`);
  assert.ok(checked >= 140, `the sweep must keep its coverage (checked ${checked} property pairs)`);
  assert.deepEqual(mismatches, [], `schema/runtime type mismatches:\n${mismatches.join("\n")}`);
});

/**
 * v0.39.60 (auditor objection 2026-10-31, MED #2): the schema's
 * `auditorFailureClass` enum is a THIRD copy of the failure-class list. A class
 * added to the union and the shared array but not to the shipped schema would be
 * written by the runtime and then REJECTED by schema validation of a persisted
 * goal — an accepted state the published contract forbids.
 *
 * The array and the enum are now asserted equal in both directions, so neither
 * can drift without failing here.
 */
test('the schema failure-class enum matches the shared runtime list exactly', async () => {
  const { AUDITOR_INFRASTRUCTURE_CLASS_VALUES } = await import('../extensions/goal-loop-core.js');
  const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'goal.schema.json'), 'utf8'));
  // Locate the enum wherever the claim definition lives, so a schema reshuffle
  // does not silently turn this assertion into a no-op.
  const found: string[][] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'auditorFailureClass' && value && typeof value === 'object') {
        const spec = value as { type?: unknown; enum?: unknown };
        if (Array.isArray(spec.enum)) found.push(spec.enum.filter((v): v is string => typeof v === 'string'));
      }
      walk(value);
    }
  };
  walk(schema);
  assert.equal(found.length, 1, 'expected exactly one auditorFailureClass enum in the shipped schema');
  assert.deepEqual([...found[0]!].sort(), [...AUDITOR_INFRASTRUCTURE_CLASS_VALUES].sort(),
    'the schema enum must list exactly the runtime failure classes; a class accepted by code but rejected by the schema is an unpublishable state');
});
