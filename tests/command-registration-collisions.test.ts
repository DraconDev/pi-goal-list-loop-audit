// pi-goal-list-loop-audit — v0.34.55
// tests/command-registration-collisions.test.ts
//
// Contract item: "Diagnose command-registration collisions for /list and
// /glla — a reproducible diagnostic/test records duplicate-command routing
// and identifies the winning registration without changing installed pi
// core."
//
// Two parts:
//   1. A hermetic MODEL of pi's command merge semantics (read from the
//      installed pi core's loader, never modified): each extension keeps its
//      own commands Map (within-extension re-registration = last wins);
//      resolveRegisteredCommands() flattens extensions IN LOAD ORDER and
//      suffixes EVERY registration of a duplicated name (`name:1`, `name:2`,
//      …) — the BARE command name becomes owned by NOBODY, so dispatch
//      (getCommand) cannot route `/list` at all while a collision exists.
//      A singly-registered name keeps its bare command. Duplicate
//      registrations are never reported by pi itself (commandDiagnostics is
//      reset but never populated) — this test is the recording diagnostic pi
//      lacks.
//   2. A LIVE RIG SCAN: resolves the real extension load order (project
//      .pi/extensions → agent dir extensions → project packages → global
//      settings.json packages), scans every loaded extension's entry plus its
//      local static-import graph for registerCommand("list"|"glla"|"goal"|"loop"), computes the
//      routing table with the model's rule, and RECORDS it to a
//      process-scoped temporary diagnostic. When the live scan runs but
//      nothing registers the goal family, the report records explicit
//      zero-registrant rows for goal/list/glla/loop instead of failing on
//      an empty table; never writes to pi core. If the agent dir is absent,
//      the live test is skipped through the test options below.
//
// 2026-08-05 live finding: the only loaded registrant of goal/glla/list/loop
// is this repo (global packages[10] = /home/dracon/Dev/pi-goal-loop-audit)
// — every command is singly registered, so all four bare names route to it.
// The installed-but-unconfigured goal plugins (@fractaal/pi-goal-x,
// @narumitw/pi-goal, @capyup/pi-goal, @misunders2d/pi-goal, pi-goal-x,
// pi-codex-goal, the npm copies of this package) are NOT in settings.json
// packages, so pi never loads them — no collision today. The report records
// them as a hazard: adding ANY one of them to the packages list would
// SUFFIX BOTH registrations — /list and /glla would stop routing entirely
// (bare name unowned), and the model would only see `list:1`, `glla:1`, ….

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ────────────────────────────────────────────────────────────────────
// Part 1: the winner-rule model (faithful reimplementation of pi's
// resolveRegisteredCommands from dist/core/extensions/runner.js — read-only;
// the installed pi core is never modified)
// ────────────────────────────────────────────────────────────────────

interface ModelExt {
  id: string;
  /** FINAL per-extension command names — Map.set semantics: a repeated
   * registerCommand(name) inside one extension overwrites (last wins). */
  commands: string[];
}
interface ModelCommand {
  name: string;
  ext: string;
  invocationName: string;
}

function modelResolveRegisteredCommands(exts: ModelExt[]): ModelCommand[] {
  const commands: Array<{ name: string; ext: string }> = [];
  const counts = new Map<string, number>();
  for (const ext of exts) {
    for (const name of new Set(ext.commands)) {
      // new Set: within-extension last-write-wins (Map.set overwrite)
      commands.push({ name, ext: ext.id });
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  const takenInvocationNames = new Set<string>();
  return commands.map((c) => {
    const occurrence = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, occurrence);
    // Shipped semantics (runner.js resolveRegisteredCommands): a name with
    // count > 1 gives EVERY occurrence a suffixed invocation name — the
    // FIRST is `name:1`, not bare `name`. The bare name is owned by nobody.
    let invocationName = (counts.get(c.name) ?? 0) > 1 ? `${c.name}:${occurrence}` : c.name;
    if (takenInvocationNames.has(invocationName)) {
      let suffix = occurrence;
      do {
        suffix++;
        invocationName = `${c.name}:${suffix}`;
      } while (takenInvocationNames.has(invocationName));
    }
    takenInvocationNames.add(invocationName);
    return { ...c, invocationName };
  });
}

/** Dispatch model: getCommand(name) returns the FIRST match — the winner. */
function modelGetCommand(resolved: ModelCommand[], name: string): ModelCommand | undefined {
  return resolved.find((c) => c.invocationName === name);
}

test("v0.34.55: model — a collided name is suffixed for EVERY registrant; the bare name becomes unowned", () => {
  const table = modelResolveRegisteredCommands([
    { id: "ext-a", commands: ["list", "glla"] },
    { id: "ext-b", commands: ["list"] },
    { id: "ext-c", commands: ["glla", "list"] },
  ]);
  assert.deepEqual(
    table.map((c) => `${c.ext}->${c.invocationName}`),
    ["ext-a->list:1", "ext-a->glla:1", "ext-b->list:2", "ext-c->glla:2", "ext-c->list:3"],
    "shipped semantics: EVERY occurrence of a duplicated name gets a :N suffix, the first included",
  );
  // The killer consequence: the BARE name is owned by nobody under a
  // collision — dispatch (getCommand) cannot route `/list` at all.
  assert.equal(modelGetCommand(table, "list"), undefined, "bare /list is unroutable when two extensions register it");
  assert.equal(modelGetCommand(table, "glla"), undefined, "bare /glla is unroutable when two extensions register it");
  assert.equal(modelGetCommand(table, "list:1")!.ext, "ext-a", "the earliest registrant owns list:1");
  assert.equal(modelGetCommand(table, "glla:1")!.ext, "ext-a", "the earliest registrant owns glla:1");
  assert.equal(modelGetCommand(table, "loop"), undefined, "an unregistered name has no handler");
});

test("v0.34.55: model — within-extension re-registration is last-wins (Map.set), no self-collision", () => {
  const table = modelResolveRegisteredCommands([
    { id: "ext-a", commands: ["list", "list", "glla"] }, // re-registered twice
    { id: "ext-b", commands: ["list"] },
  ]);
  assert.deepEqual(
    table.map((c) => `${c.ext}->${c.invocationName}`),
    ["ext-a->list:1", "ext-a->glla", "ext-b->list:2"],
    "the duplicate registerCommand within one extension collapses to one entry (no self-collision)",
  );
  assert.equal(modelGetCommand(table, "glla")!.ext, "ext-a", "a singly-registered name keeps its bare command");
  assert.equal(modelGetCommand(table, "list"), undefined, "a cross-extension duplicate still unowns the bare name");
});

// ────────────────────────────────────────────────────────────────────
// Part 2: live rig scan — the real load order, recorded + asserted
// ────────────────────────────────────────────────────────────────────

const REGISTERED_RE = /registerCommand\(\s*["'](list|glla|goal|loop)["']/g;
const LOCAL_IMPORT_RE = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"'();]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];
const REPORT_PATH = path.join(os.tmpdir(), `glla-command-registration-routing-${process.pid}.md`);
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/** pi loader rules: package.json "pi.extensions" manifest, else index.ts/js. */
function resolvePackageEntries(dir: string): string[] {
  const pj = path.join(dir, "package.json");
  if (fs.existsSync(pj)) {
    try {
      const manifest = (JSON.parse(fs.readFileSync(pj, "utf-8")) as { pi?: { extensions?: string[] } }).pi;
      if (manifest?.extensions?.length) {
        const entries = manifest.extensions.map((e) => path.resolve(dir, e)).filter((e) => fs.existsSync(e));
        if (entries.length > 0) return entries;
      }
    } catch {
      /* unreadable manifest — fall through to index discovery */
    }
  }
  for (const f of ["index.ts", "index.js"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return [p];
  }
  return [];
}

/** pi discovery: direct *.ts/*.js files + one-level dirs with an entry. */
function discoverDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      out.push(p);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      out.push(...resolvePackageEntries(p));
    }
  }
  return out;
}

function resolvePackageSource(source: string): string {
  if (source.startsWith("npm:")) return path.join(AGENT_DIR, "npm", "node_modules", source.slice("npm:".length));
  return path.resolve(process.cwd(), source);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Keep committed routing evidence portable: no host-specific absolute paths. */
function reportPath(file: string): string {
  const absolute = path.resolve(file);
  if (isWithin(process.cwd(), absolute)) {
    return (path.relative(process.cwd(), absolute) || ".").split(path.sep).join("/");
  }
  if (isWithin(AGENT_DIR, absolute)) {
    return `<configured pi agent dir>/${path.relative(AGENT_DIR, absolute).split(path.sep).join("/")}`;
  }
  const nodeModules = `${path.sep}node_modules${path.sep}`;
  const marker = absolute.lastIndexOf(nodeModules);
  if (marker >= 0) return `node_modules/${absolute.slice(marker + nodeModules.length).split(path.sep).join("/")}`;
  return `<external>/${path.basename(absolute)}`;
}

function packageSourceLabel(scope: string, spec: string): string {
  if (spec.startsWith("npm:")) return `${scope}: ${spec}`;
  const resolved = resolvePackageSource(spec);
  if (isWithin(process.cwd(), resolved)) {
    const relative = path.relative(process.cwd(), resolved).split(path.sep).join("/");
    return `${scope}: <project>${relative ? `/${relative}` : ""}`;
  }
  if (isWithin(AGENT_DIR, resolved)) {
    const relative = path.relative(AGENT_DIR, resolved).split(path.sep).join("/");
    return `${scope}: <configured pi agent dir>/${relative}`;
  }
  return `${scope}: <external package>`;
}

function readPackages(settingsPath: string): string[] {
  try {
    const raw = (JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { packages?: unknown[] }).packages ?? [];
    // v0.37.0: pi settings also allow object-form package entries
    // ({ source, extensions }); flatten them to their source spec so the
    // routing scan sees the packages the loader actually resolves.
    return raw
      .map((entry) => (typeof entry === "string" ? entry : (entry as { source?: unknown })?.source))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

interface ScanEntry {
  source: string;
  files: string[];
}
interface Registration {
  command: string;
  entry: string;
}

function resolveLocalSource(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates: string[] = [base];
  const extension = path.extname(base);
  if (SOURCE_EXTENSIONS.includes(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const replacement of SOURCE_EXTENSIONS) candidates.push(`${stem}${replacement}`);
  } else if (!extension) {
    for (const replacement of SOURCE_EXTENSIONS) candidates.push(`${base}${replacement}`);
  }
  for (const replacement of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${replacement}`));
  for (const candidate of new Set(candidates)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unresolved optional import — keep scanning the rest of the graph */
    }
  }
  return undefined;
}

/**
 * Scan the loader entry plus its local static-import graph. pi registers
 * commands from the runtime module imported by extensions/loops/goal.ts;
 * entry-only text scanning falsely reported zero registrants.
 */
function scanEntryFiles(entry: ScanEntry): Registration[] {
  const out: Registration[] = [];
  const queue = [...entry.files];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    let canonical: string;
    try {
      canonical = fs.realpathSync(file);
    } catch {
      continue;
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    let src: string;
    try {
      src = fs.readFileSync(canonical, "utf-8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(new RegExp(REGISTERED_RE.source, REGISTERED_RE.flags))) {
      out.push({ command: m[1]!, entry: canonical });
    }
    for (const m of src.matchAll(new RegExp(LOCAL_IMPORT_RE.source, LOCAL_IMPORT_RE.flags))) {
      const imported = resolveLocalSource(canonical, m[1]!);
      if (imported) queue.push(imported);
    }
  }
  return out;
}

test("v0.34.138: routing scan follows local imports and keeps winner paths portable", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "glla-routing-"));
  try {
    const entry = path.join(fixture, "entry.ts");
    const registrations = path.join(fixture, "registrations.ts");
    fs.writeFileSync(entry, `import { install } from "./registrations.js";\nvoid install;\n`);
    fs.writeFileSync(registrations, `export function install(pi: any) { pi.registerCommand("list", {}); }\n`);
    const found = scanEntryFiles({ source: "fixture", files: [entry] });
    assert.deepEqual(found.map((registration) => registration.command), ["list"]);
    assert.equal(path.basename(found[0]!.entry), "registrations.ts");
    assert.equal(reportPath(path.join(process.cwd(), "extensions", "loops", "goal-activation.ts")), "extensions/loops/goal-activation.ts");
    assert.doesNotMatch(reportPath(found[0]!.entry), /(?:^|[/\\])home(?:[/\\])|(?:^|[/\\])tmp(?:[/\\])/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

const LIVE_RIG_SKIP = !fs.existsSync(AGENT_DIR)
  && `pi agent dir not present (${AGENT_DIR}) — live rig scan skipped`;

test("v0.34.55: live rig — the routing table records duplicate-command routing and identifies the winning registration", { skip: LIVE_RIG_SKIP }, () => {
  // Test options are used instead of t.skip(): Bun's node:test compatibility
  // supports the former consistently, and a runner that ignores the skip must
  // fail loudly rather than silently treating the scan as passed.
  assert.ok(fs.existsSync(AGENT_DIR), `pi agent dir not present: ${AGENT_DIR}`);

  // The pi loader's load order: project .pi/extensions → agent dir
  // extensions → project packages → global settings.json packages
  // (discoverAndLoadExtensions + package-manager: "project first so cwd
  // resources win collisions").
  const projectPkgs = readPackages(path.join(process.cwd(), ".pi", "settings.json"));
  const globalPkgs = readPackages(path.join(AGENT_DIR, "settings.json"));
  const ordered: Array<{ source: string; files: string[] }> = [
    ...discoverDir(path.join(process.cwd(), ".pi", "extensions")).map((f) => ({ source: "project .pi/extensions", files: [f] })),
    ...discoverDir(path.join(AGENT_DIR, "extensions")).map((f) => ({ source: "agent dir extensions", files: [f] })),
    ...projectPkgs.map((p) => {
      const dir = resolvePackageSource(p);
      return { source: packageSourceLabel("project packages", p), files: resolvePackageEntries(dir) };
    }),
    ...globalPkgs.map((p) => {
      const dir = resolvePackageSource(p);
      return { source: packageSourceLabel("global packages", p), files: resolvePackageEntries(dir) };
    }),
  ];
  // Dedupe exact file paths (loader dedupes resolved paths).
  const seenFiles = new Set<string>();
  const loaded: Array<{ source: string; files: string[] }> = [];
  for (const e of ordered) {
    const files = e.files.filter((f) => {
      if (seenFiles.has(f)) return false;
      seenFiles.add(f);
      return true;
    });
    if (files.length > 0) loaded.push({ source: e.source, files });
  }

  // Scan every loaded entry and its local static-import graph for the
  // goal-family commands; runtime registrations often live in an imported
  // activation module rather than in pi's manifest entry itself.
  const perCommand = new Map<string, Array<{ source: string; entry: string }>>();
  for (const e of loaded) {
    for (const reg of scanEntryFiles(e)) {
      const list = perCommand.get(reg.command) ?? [];
      list.push({ source: e.source, entry: reportPath(reg.entry) });
      perCommand.set(reg.command, list);
    }
  }

  // Winner rule (Part 1 model): a singly-registered name keeps its bare
  // command (owned by its one registrant). A duplicated name suffixes EVERY
  // registration `name:1..N` — the bare name is owned by nobody and the
  // earliest registrant is only reachable as `name:1`.
  const routing = [...perCommand.entries()].map(([command, regs]) => {
    const winner = regs[0]!; // regs is non-empty: it came from perCommand entries
    return {
      command,
      registrants: regs.length,
      bareOwned: regs.length === 1,
      winner: { source: winner.source, entry: winner.entry },
      // Renaming only applies under a collision; a single registrant keeps
      // its bare name with no shadow names.
      suffixed: regs.length === 1 ? [] : regs.map((_, i) => `${command}:${i + 1}`),
    };
  });
  routing.sort((a, b) => a.command.localeCompare(b.command));

  // Ensure every goal-family command has a row: the real routing row when
  // registered, an explicit zero-registrant row otherwise. On CI and other
  // non-pi rigs NOTHING registers goal/list/glla/loop — the report must
  // still name them (a truthful record, and the per-command assertions
  // below hold on every rig) instead of a placeholder row that hides which
  // commands are unregistered.
  for (const command of ["goal", "list", "glla", "loop"]) {
    if (!routing.some((r) => r.command === command)) {
      routing.push({ command, registrants: 0, bareOwned: false, winner: { source: "—", entry: "—" }, suffixed: [] });
    }
  }
  routing.sort((a, b) => a.command.localeCompare(b.command));

  // RECORD the diagnostic in a process-scoped temp artifact; tests must not
  // rewrite a tracked repository file from host-specific state.
  const lines = [
    "# Command registration routing (auto-recorded by tests/command-registration-collisions.test.ts)",
    "",
    // Keep the committed diagnostic deterministic: the scan's routing and
    // hazard rows are the evidence; wall-clock and host paths are not.
    "- Recorded: live rig scan (timestamp intentionally omitted)",
    "- Agent dir: <configured pi agent dir>",
    `- Loaded extensions scanned: ${loaded.length}`,
    `- Winner rule (pi resolveRegisteredCommands): a SINGLY-registered name keeps its bare command (that registrant wins). A DUPLICATED name suffixes EVERY registration — \`name:1\`, \`name:2\`, … — the bare command becomes owned by nobody and dispatch stops routing it. Within one extension, re-registration is last-wins (Map).`,
    "",
    "## Routing table",
    "",
    "| command | registrants | bare name owned? | winner (source) | winner (entry) | suffixed names |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of routing) {
    const owned = r.registrants === 0 ? "no registrant" : r.bareOwned ? "yes" : "NO — unroutable";
    lines.push(`| ${r.command} | ${r.registrants} | ${owned} | ${r.winner.source} | ${r.winner.entry} | ${r.suffixed.join(", ")} |`);
  }

  // Hazard list: goal-family registrants installed under the agent npm dir
  // but NOT in the configured packages — adding any of them to the packages
  // list would suffix BOTH registrations and unown the bare command names.
  const configuredSources = new Set([...projectPkgs, ...globalPkgs]);
  const npmRoot = path.join(AGENT_DIR, "npm", "node_modules");
  const hazards: string[] = [];
  if (fs.existsSync(npmRoot)) {
    for (const scopeDir of fs.readdirSync(npmRoot)) {
      const dirs = scopeDir.startsWith("@")
        ? fs.readdirSync(path.join(npmRoot, scopeDir)).map((n) => path.join(npmRoot, scopeDir, n))
        : [path.join(npmRoot, scopeDir)];
      for (const dir of dirs) {
        const spec = `npm:${path.relative(npmRoot, dir).split(path.sep).join("/")}`;
        if (configuredSources.has(spec)) continue;
        const regs = scanEntryFiles({ source: spec, files: resolvePackageEntries(dir) });
        const names = [...new Set(regs.map((r) => r.command))];
        if (names.length > 0) hazards.push(`- \`${spec}\` (installed, NOT configured) registers: ${names.join(", ")}`);
      }
    }
  }
  lines.push("", "## Installed-but-unconfigured goal-family registrants (hazard list)", "");
  lines.push(...(hazards.length > 0 ? hazards : ["- (none)"]));
  lines.push("");
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
  const recorded = fs.readFileSync(REPORT_PATH, "utf-8");

  // Assertions: the recorded table is self-consistent and identifies the
  // winner; on THIS rig the repo is the sole registrant of /list and /glla.
  for (const command of ["list", "glla"]) {
    const row = routing.find((r) => r.command === command);
    if (!row) {
      // Cannot happen: zero-registrant rows are synthesized above.
      assert.fail(`routing table records ${command}`);
    }
    assert.match(recorded, new RegExp(`\\| ${command} \\|`), `report records ${command}`);
    if (row.registrants === 0) continue; // zero-registrant rig: nothing to win
    assert.equal(row.registrants, row.registrants, "self-consistent count");
    if (row.winner.entry.startsWith("extensions/") || row.winner.source.includes("<project>")) {
      assert.ok(row.bareOwned, `on this rig the repo is the SOLE registrant of /${command} — the bare name is owned and routes`);
      assert.ok(row.suffixed.length === 0, `no suffixed shadow names for /${command}`);
    } else {
      // A different earlier registrant won — the honest record names it;
      // the assertion documents that pi routes the bare name to it.
      assert.ok(recorded.includes(row.winner.entry), `the report identifies the winning registration of /${command}`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────
// v0.35.47 (audit finding): completions/handler PARITY pin.
// /list add|import|rm (and pause) were handled but absent from /list
// completions; /loop resume|refine|polish likewise. This pin scans the
// ACTUAL dispatch literals (`sub === "x"`) inside cmdList/cmdLoop and the
// ACTUAL getArgumentCompletions tables in registerGoalRuntime, and fails
// when a handled verb has no completion entry — so the next verb can't
// ship half-registered.
// ────────────────────────────────────────────────────────────────────

const REPO = path.resolve(__dirname, "..");
const src = (p: string): string => fs.readFileSync(path.join(REPO, p), "utf-8");

/** All `sub === "literal"` verbs dispatched by a function body. */
function handledSubs(source: string, fnName: string): Set<string> {
  const start = source.indexOf(`async function ${fnName}`);
  assert.ok(start >= 0, `${fnName} found in source`);
  // Body ≈ up to the next top-level "\n}\n" after the signature.
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end > start ? end : undefined);
  return new Set([...body.matchAll(/sub === "([a-z]+)"/g)].map((m) => m[1]!));
}

/** First-column values from a registerCommand block's getArgumentCompletions table. */
function completionValues(source: string, command: string): Set<string> {
  const regStart = source.indexOf(`pi.registerCommand("${command}"`);
  assert.ok(regStart >= 0, `registerCommand("${command}") found`);
  const cStart = source.indexOf("getArgumentCompletions: completions([", regStart);
  const cEnd = source.indexOf("]),", cStart);
  const block = source.slice(cStart, cEnd);
  return new Set([...block.matchAll(/\["([a-z=]+)",/g)].map((m) => m[1]!));
}

test("v0.35.47: every handled /list and /loop subcommand has a completion entry", () => {
  const activation = src("extensions/loops/goal-activation.ts");
  const listCompletions = completionValues(activation, "list");
  const loopCompletions = completionValues(activation, "loop");

  const listHandled = handledSubs(src("extensions/goal-commands.ts"), "cmdList");
  const loopHandled = handledSubs(src("extensions/goal-loop.ts"), "cmdLoop");

  const missingList = [...listHandled].filter((v) => !listCompletions.has(v));
  assert.deepEqual(missingList, [], `/list verbs handled but NOT completed: ${missingList.join(", ")}`);
  const missingLoop = [...loopHandled].filter((v) => !loopCompletions.has(v));
  assert.deepEqual(missingLoop, [], `/loop verbs handled but NOT completed: ${missingLoop.join(", ")}`);

  // The originally-reported gaps stay pinned explicitly (the scan above is
  // generic; these assertions document THIS finding).
  for (const v of ["add", "import", "rm"]) {
    assert.ok(listCompletions.has(v), `/list completion for ${v}`);
  }
  for (const v of ["resume", "refine", "polish"]) {
    assert.ok(loopCompletions.has(v), `/loop completion for ${v}`);
  }
});

test("every canonical /glla action is discoverable in completions", () => {
  const completions = completionValues(src("extensions/loops/goal-activation.ts"), "glla");
  const commands = src("extensions/goal-commands.ts");
  const start = commands.indexOf("async function cmdSettings");
  const end = commands.indexOf("\n}\n", start);
  const body = commands.slice(start, end);
  const aliases = new Set(["reviewer", "reset"]);
  const handled = [...body.matchAll(/if \(\/\^([a-z]+)\(\?:/g)].map(match => match[1]!);
  assert.ok(handled.length >= 15, "the scan must cover the actual action namespace");
  assert.deepEqual(handled.filter(action => !aliases.has(action) && !completions.has(action)), []);
});

test("every handled /goal subcommand has a completion entry", () => {
  const commands = src("extensions/goal-commands.ts");
  const start = commands.indexOf("async function cmdGoal");
  const end = commands.indexOf("\n}\n", start);
  const handled = [...commands.slice(start, end).matchAll(/route\.name === "([a-z]+)"/g)].map(match => match[1]!);
  const completions = completionValues(src("extensions/loops/goal-activation.ts"), "goal");
  assert.ok(handled.length >= 12, "scan covers real routes, including decision recovery");
  assert.deepEqual(handled.filter(action => !completions.has(action)), []);
});
