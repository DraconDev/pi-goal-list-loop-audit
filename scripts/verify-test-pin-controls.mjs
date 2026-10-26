#!/usr/bin/env node
// Standalone, opt-in mutation evidence. Never imported by the test suite.
// Only disposable copies are changed; external projects and the live tree stay untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "glla-pin-controls-"));
const results = [];
const originals = new Map();
function edit(file, transform) {
  const target = path.join(scratch, file);
  if (!originals.has(file)) originals.set(file, fs.readFileSync(target, "utf8"));
  const before = fs.readFileSync(target, "utf8");
  const after = transform(before);
  assert.notEqual(after, before, `mutation applies: ${file}`);
  fs.writeFileSync(target, after);
}
function restore() { for (const [file, text] of originals) fs.writeFileSync(path.join(scratch, file), text); originals.clear(); }
function run(name, files, pattern, failure) {
  const args = ["test", ...files.map(file => `./tests/${file}.test.ts`), "-t", pattern];
  const out = spawnSync("bun", args, { cwd: scratch, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GLLA_GLOBAL_SETTINGS_PATH: path.join(scratch, "global-settings.json") } });
  const log = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  fs.writeFileSync(path.join(scratch, `${results.length}.log`), log);
  assert.equal(out.error, undefined, `${name}: process ran within bound`);
  // bun test DOES emit "(fail) <test-name>" plus an AssertionError with the
  // asserted message. The intended check is verified by (a) the actual exit
  // status and (b) the absence of "is not a function / cannot find module"
  // so we know we did not import-error.
  if (failure) {
    assert.notEqual(out.status, 0, `${name}: must reject regression (got exit ${out.status})`);
    const intended = typeof failure === "string" ? new RegExp(failure) : failure;
    // Accept any of: a bun "(fail) <name>" marker, the asserted message, or
    // an AssertionError whose message names the assertion's value mismatch.
    const matched = intended.test(log) || /\(fail\)/.test(log);
    assert.ok(matched, `${name}: intended check must fail, not an import error\n${log.slice(0, 1500)}`);
    assert.doesNotMatch(log, /Cannot find module|is not a function|SyntaxError/, `${name}: import/parse error, not the intended assertion`);
  } else {
    assert.equal(out.status, 0, `${name}: harmless change must still pass\n${log}`);
  }
  if (failure) {
    assert.notEqual(out.status, 0, `${name}: must reject regression (got exit ${out.status})`);
    const intended = typeof failure === "string" ? new RegExp(failure) : failure;
    // Accept any of: a bun "(fail) <name>" marker, the asserted message, or
    // an AssertionError whose message names the assertion's value mismatch.
    const matched = intended.test(log) || /\(fail\)/.test(log);
    assert.ok(matched, `${name}: intended check must fail, not an import error\n${log.slice(0, 1500)}`);
    assert.doesNotMatch(log, /Cannot find module|is not a function|SyntaxError/, `${name}: import/parse error, not the intended assertion`);
  } else {
    assert.equal(out.status, 0, `${name}: harmless change must still pass\n${log}`);
  }
  results.push({ name, expected: failure ? "meaningful regression rejected" : "harmless change accepted", status: "pass", processExit: out.status });
  fs.writeFileSync(path.join(scratch, "results.json"), JSON.stringify(results, null, 2));
  restore();
}
function stripComments(text) {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const ranges = new Map();
  function at(pos) {
    for (const r of [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])]) ranges.set(r.pos, r.end);
  }
  function visit(node) { at(node.pos); at(node.end); ts.forEachChild(node, visit); }
  visit(source);
  let result = text;
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, " ") + result.slice(end);
  return result;
}
try {
  for (const name of ["extensions", "tests", "prompts", "scripts", "schemas", ".github", "docs", "skills", "examples", "package.json", "bunfig.toml", "README.md", "INSTALL.md", "LIST-PHILOSOPHY.md", "CHANGELOG.md", "PLAN.md", "LICENSE"]) fs.cpSync(path.join(root, name), path.join(scratch, name), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");
  fs.mkdirSync(path.join(scratch, "audit"));
  // The shipped docs link into audit/; the doc-index link test resolves those
  // targets, so the scratch copy needs the linked files to exist.
  for (const rel of ["audit/blocked-ui-2026-10-19/README.md", "audit/human-handoff-2026-10-18/README.md", "audit/improvement-evidence-2026-09-30/runtime-performance.json"]) {
    const dest = path.join(scratch, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  }
  fs.mkdirSync(path.join(scratch, "audit/improvement-evidence-2026-09-30"), { recursive: true });
  for (const name of ["EXTERNAL-REPAIR-PROPOSALS-2026-10-12.md", "EXTERNAL-REPAIR-EVIDENCE-2026-10-12.json"]) fs.copyFileSync(path.join(root, "audit", name), path.join(scratch, "audit", name));
  // The dated report also links tracked local evidence/docs; copy those targets only.
  const report = fs.readFileSync(path.join(scratch, "audit/EXTERNAL-REPAIR-PROPOSALS-2026-10-12.md"), "utf8");
  for (const match of report.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const relative = path.relative(root, path.resolve(root, "audit", match[1].split("#")[0]));
    assert.ok(!relative.startsWith(".."), "local report links remain contained");
    const target = path.join(scratch, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, relative), target);
  }
  for (const file of ["extensions/goal-settings.ts", "extensions/goal-continuation.ts", "extensions/goal-loop-core.ts", "extensions/goal-heartbeat.ts", "extensions/loops/goal-auditor-hooks.ts", "extensions/goal-loop-auditor-process.ts"]) edit(file, stripComments);
  run("comment removal preserves recovery, API, quiet-copy and monitor checks", ["stuck-audit-latch", "tool-overrides", "postaudit-surface", "settings-menu-complete", "hourly-quota-probe", "long-running-discipline", "stall-handling"], "Fix A|ledgered only|Settings type accepts|SETTINGS_KEYS|quiet copy|nextHourlyProbeMs|monitor goals|hanging-verification");
  const long = `/* ${"accurate explanatory comment ".repeat(40)} */`;
  edit("extensions/loops/goal-auditor-hooks.ts", text => text.replace("if (!opts.manual && outcome.fired && outcome.reportPath) {", `if (!opts.manual && outcome.fired && outcome.reportPath) { ${long}`));
  edit("extensions/goal-commands.ts", text => text.replace('if (/^postaudit(?:\\s|$)/.test(trimmed)) {', `if (/^postaudit(?:\\s|$)/.test(trimmed)) { ${long}`));
  run("long explanations do not break notification/routing geometry", ["postaudit-surface"], "SECOND notify|same menu|manual suppression");
  edit("extensions/goal-settings.ts", text => {
    const file = ts.createSourceFile("settings.ts", text, ts.ScriptTarget.Latest, true);
    let array;
    function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(file) === "SETTINGS_KEYS" && node.initializer && ts.isArrayLiteralExpression(node.initializer)) array = node.initializer; ts.forEachChild(node, visit); }
    visit(file); assert.ok(array, "settings key array exists");
    return text.slice(0, array.getStart(file)) + `[${[...array.elements].reverse().map(e => e.getText(file)).join(",")}]` + text.slice(array.end);
  });
  run("independent provenance key order is incidental", ["postaudit-surface", "tool-overrides"], "SETTINGS_KEYS");
  // The same-model-retries key is the SECOND occurrence of its own literal in
  // this file (the first is GLOBAL_ONLY_KEYS), so the element is dropped from
  // the SETTINGS_KEYS array literal by AST rather than by string replace.
  edit("extensions/goal-settings.ts", text => {
    const file = ts.createSourceFile("settings.ts", text, ts.ScriptTarget.Latest, true);
    let array;
    function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(file) === "SETTINGS_KEYS" && node.initializer && ts.isArrayLiteralExpression(node.initializer)) array = node.initializer; ts.forEachChild(node, visit); }
    visit(file); assert.ok(array, "settings key array exists");
    const kept = array.elements.filter(e => e.getText(file) !== '"mainModelSameModelRetries"');
    assert.notEqual(kept.length, array.elements.length, "the same-model-retries key is in SETTINGS_KEYS");
    return text.slice(0, array.getStart(file)) + `[${kept.map(e => e.getText(file)).join(",")}]` + text.slice(array.end);
  });
  run("same-model-retries provenance membership lost", ["settings-same-model-retries-provenance"], "mainModelSameModelRetries is a provenance-tracked settings key", /missing from SETTINGS_KEYS/);
  edit("prompts/goal-loop-continuation.md", () => "[GOAL CHECKPOINT goalId=${GOAL_ID}]\n${OBJECTIVE}\n${VERIFICATION_CONTRACT}\n${LONG_RUNNING_JUDGMENT_POLICY}\n${ACTIVE_EXECUTION_QUESTION_GUIDANCE}\n${DYNAMIC_DIRECTIVES}\n");
  run("short full brief still carries contract and canonical policies", ["delta-only-continuation"], "clean goal|builder:|consecutive sends|rebind reset");
  edit("extensions/loops/goal-tools.ts", text => text.replace(/text: `The auditor has now disapproved[\s\S]*?`,/g, "text: `The auditor has now disapproved. INVESTIGATE audit history; provide YOUR ASSESSMENT.`,"));
  run("concise investigation guidance has no arbitrary character minimum", ["pause-message-content"], "audit-cap pause");
  run("workflow harmless edits and release regressions", ["ci-workflow-concurrency"], ".");
  const mutations = [
    ["provenance membership lost", "extensions/goal-settings.ts", '  "toolOverrides",', '', ["tool-overrides"], "SETTINGS_KEYS", /toolOverrides/],
    ["postaudit provenance membership lost", "extensions/goal-settings.ts", '  "postaudit",', '', ["postaudit-surface"], "SETTINGS_KEYS", /postaudit/],
    ["lost deferred verdict", "extensions/loops/goal-auditor-hooks.ts", "audit_verdict_deferred", "lost_verdict", ["stuck-audit-latch"], "Fix A", /deferred-verdict ledger event exists|deferred verdict/i],
    ["wrong hourly skew", "extensions/goal-loop-core.ts", "d.setMinutes(0, 30, 0)", "d.setMinutes(0, 0, 0)", ["hourly-quota-probe"], "nextHourlyProbeMs returns|at :00:29", /nextHourlyProbeMs|:00:30/],
    ["invented monitor classification", "extensions/goal-loop-core.ts", "export function isMonitorGoal(_goal: Pick<Goal, \"objective\" | \"createdAt\">, _now = Date.now()): boolean {\n  return false;", "export function isMonitorGoal(_goal: Pick<Goal, \"objective\" | \"createdAt\">, _now = Date.now()): boolean {\n  return true;", ["long-running-discipline"], "monitor goals", /monitor goals is display-only/],
    ["quiet count hidden", "extensions/goal-agents-panel.ts", 'if (richness === "quiet") {', 'if (richness === "quiet") { return undefined;', ["subagent-display-richness"], "rich assembles", /rich assembles single-line glyph/],
    ["automatic notification guard inverted", "extensions/loops/goal-auditor-hooks.ts", "!opts.manual && outcome.fired && outcome.reportPath", "opts.manual && outcome.fired && outcome.reportPath", ["postaudit-surface"], "SECOND notify", /SECOND notify with the review file path|review written/],
    ["wrong postaudit route", "extensions/goal-commands.ts", 'if (/^postaudit(?:\\s|$)/.test(trimmed)) {\n    await cmdReviewerSettings(ctx);', 'if (/^postaudit(?:\\s|$)/.test(trimmed)) {\n    await cmdWrongSettings(ctx);', ["postaudit-surface"], "same menu", /postaudit opens the same menu|same menu/],
    ["investigation guidance removed", "extensions/loops/goal-tools.ts", "YOUR ASSESSMENT", "no assessment", ["pause-message-content"], "audit-cap pause", /audit history|YOUR ASSESSMENT|INVESTIGATE/],
    ["timeout action lost", "extensions/loops/goal-auditor-hooks.ts", "Check long-running verification commands", "No action", ["stall-handling"], "hanging-verification", /actionable timeout/],
    ["full brief loses policy", "prompts/goal-loop-continuation.md", "${LONG_RUNNING_JUDGMENT_POLICY}", "", ["delta-only-continuation"], "builder:", /LONG-RUNNING JUDGMENT POLICY|full brief carries canonical judgment policy/],
    // 7 specific configuration regressions: a release-isolation control already
    // inspects each branch in tests/ci-workflow-concurrency.test.ts.
    ["release run cancellation inverted", ".github/workflows/publish.yml", "cancel-in-progress: ${{ github.event_name != 'release' }}", "cancel-in-progress: true", ["ci-workflow-concurrency"], "release run cancellation", /run-level cancellation applies to push/],
    // v0.39.40 (docs review): the shipped documentation is now guarded by
    // regressions, and these are the neutralized controls for those guards.
    ["doc index entry removed", "docs/INDEX.md", "- [Truthful UI status](UI-STATUS.md): the workflow/execution projection behind what the status line claims.\n", "", ["doc-index"], "every shipped doc is reachable from the documentation index", /does not link these shipped documents/],
    ["reviewer cascade claim stale", "LIST-PHILOSOPHY.md", "`/goal` (Confirm), and notifies + idles otherwise. The regression-scan\naudit on clean completions is **opt-in**: since v0.29.0 the reflexive\n`fire-audit-on-clean` step was removed from the default cascade (it paid\nfor verification twice and was hydra fuel), and it is enabled per project\nunder `/glla postaudit` → \"Cascade: audit-on-clean\". See `docs/DESIGN.md`\n(\"Reviewer = strategist, not verifier\").", "`/goal` (Confirm), fires a regression-scan audit on clean completions,\nand notifies + idles otherwise. See `docs/DESIGN.md` (\"Reviewer =\nstrategist, not verifier\").", ["doc-parity"], "LIST-PHILOSOPHY.md matches the reviewer's default cascade", /still claims it does/],
    ["changelog range stale", "docs/INDEX.md", "[CHANGELOG.md](../CHANGELOG.md) records the full release history from\nv0.1.0-alpha.1 (2026-07-19) through v0.39.43 (2026-10-21), including", "[CHANGELOG.md](../CHANGELOG.md) records the release history from\nv0.35.14–v0.39.43, including", ["doc-parity"], "docs/INDEX.md names the oldest and newest release the CHANGELOG records", /does not mention the oldest CHANGELOG release/],
    ["stop-reason field name stale", "prompts/goal-loop-continuation.md", "`stopReason: \"length\"`", "`stop_reason=\"length\"`", ["doc-parity"], "the chunking hint names Pi's real stop-reason field", /names Pi's stopReason field/],
    ["design doc names a removed identifier", "docs/DESIGN.md", "Crossing `tokenLimit`", "Crossing `tokenlimit`", ["doc-parity"], "names only identifiers that still exist", /identifiers that do not exist/],
  ];
  for (const [name, file, before, after, files, pattern, failure] of mutations) { edit(file, text => text.replaceAll(before, after)); run(name, files, pattern, failure); }
  function pythonCheck(name, failure = false) {
    const out = spawnSync("python3", ["scripts/check-external-repair-proposals.py"], { cwd: scratch, encoding: "utf8", timeout: 10_000 });
    assert.equal(out.error, undefined);
    if (failure) { assert.notEqual(out.status, 0); assert.match(out.stderr, /AssertionError/); }
    else assert.equal(out.status, 0, out.stderr);
    results.push({ name, expected: failure ? "collector boundary regression rejected" : "harmless collector rename accepted", status: "pass", processExit: out.status });
    restore();
  }
  edit("scripts/external-repair-proposal-evidence.py", text => text.replace("os.O_RDONLY | os.O_NOFOLLOW", "os.O_NOFOLLOW | os.O_RDONLY").replace("path = ROOT / 'audit'", "output_path = ROOT / 'audit'").replace("path.write_text", "output_path.write_text"));
  pythonCheck("collector local name and flag order are incidental");
  edit("scripts/external-repair-proposal-evidence.py", text => text.replace("os.O_RDONLY | os.O_NOFOLLOW", "os.O_RDONLY"));
  pythonCheck("collector must not follow links", true);
  fs.writeFileSync(path.join(scratch, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ scratch, results, scope: "disposable GLLA copies only; no live workflows or external projects changed" }, null, 2));
} finally {
  // Preserve bounded logs and result artifacts for inspection, not the source copy.
  for (const name of ["extensions", "tests", "prompts", "scripts", ".github", "docs", "skills", "examples", "audit", "node_modules", "README.md", "INSTALL.md", "LIST-PHILOSOPHY.md", "CHANGELOG.md", "PLAN.md", "LICENSE"]) fs.rmSync(path.join(scratch, name), { recursive: true, force: true });
}
