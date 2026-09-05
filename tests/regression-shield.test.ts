// pi-goal-list-loop-audit — v0.2.0
// tests/regression-shield.test.ts
//
// Unit tests for the regression_shield: contract item extraction and the
// evidence-enforcement check. This is the core anti-bamboozle hardening —
// the tests pin both the accept and reject paths.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  checkRegressionShield,
  contractItems,
  isSafeMechanicalCommand,
} from "../extensions/goal-loop-shield.ts";

// ---- contractItems ----

test("contractItems: strips the 'Done when:' marker line", () => {
  const items = contractItems("Done when:\n- npm test passes\n- grep -q ok x.txt");
  assert.deepEqual(items, ["npm test passes", "grep -q ok x.txt"]);
});

test("contractItems: handles inline single-line contracts", () => {
  const items = contractItems("Done when: grep -q world hello.txt");
  assert.deepEqual(items, ["grep -q world hello.txt"]);
});

test("contractItems: strips bullets and numbering", () => {
  const items = contractItems("- first check\n* second check\n1. third check\n2) fourth check");
  assert.deepEqual(items, ["first check", "second check", "third check", "fourth check"]);
});

test("contractItems: drops empty lines", () => {
  const items = contractItems("one\n\n\n  \ntwo");
  assert.deepEqual(items, ["one", "two"]);
});

// ---- checkRegressionShield ----

const CONTRACT = "Done when:\n- curl returns 200 from /healthz\n- npm test exits 0";

test("passes: evidence block present, all items referenced", () => {
  const report = [
    "Audit report.",
    "<evidence>",
    "Item: curl returns 200 from /healthz",
    "Output:",
    "HTTP/1.1 200 OK",
    "Item: npm test exits 0",
    "Output:",
    "Tests: 12 passed, 0 failed",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, true);
  assert.equal(r.hasEvidenceBlock, true);
  assert.deepEqual(r.missingItems, []);
});

test("rejects: approval without an evidence block", () => {
  const report = "I checked /healthz and npm test, both fine.\n<approved/>";
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, false);
});

test("rejects: evidence block but an item is not addressed", () => {
  const report = [
    "<evidence>",
    "Item: curl returns 200 from /healthz",
    "Output: HTTP/1.1 200 OK",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, true);
  assert.deepEqual(r.missingItems, ["npm test exits 0"]);
});

test("rejects: bamboozle-style empty evidence block", () => {
  const report = "<evidence>\n</evidence>\n<approved/>";
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
});

test("rejects: contract prose outside evidence cannot satisfy the shield", () => {
  const report = [
    "The contract says curl returns 200 from /healthz and npm test exits 0.",
    "<evidence>",
    "Checked unrelated documentation only.",
    "</evidence>",
    "<approved/>",
  ].join("\\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.deepEqual(r.missingItems, contractItems(CONTRACT));
});

test("distinctive-token matching: references the item by a filename", () => {
  // The auditor may not quote the item verbatim; referencing hello.txt counts.
  const report = [
    "<evidence>",
    "Checked the file:",
    "$ cat hello.txt",
    "world",
    "$ grep -q world hello.txt && echo PASS",
    "PASS",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when: grep -q world hello.txt");
  assert.equal(r.passed, true);
});

test("case-insensitive matching", () => {
  const report = "<evidence>\nItem: NPM TEST exits 0\nOutput: ok\n</evidence>\n<approved/>";
  const r = checkRegressionShield(report, "Done when:\n- npm test exits 0");
  assert.equal(r.passed, true);
});

// ---- v0.22.6: false-rejection fixes (the hegemon case: three genuine
// <approved/> audits were shield-converted to disapprovals on vocabulary) ----

test("contractItems: excludes 'Out of scope' boundary lines", () => {
  const items = contractItems("Done when:\n- npm test passes\n- Out of scope: gameplay changes, dev-route gating");
  assert.deepEqual(items, ["npm test passes"]);
});

test("compound tokens match via segments (left-cropped → left + cropped)", () => {
  const report = [
    "<evidence>",
    "P0: map canvas now fills the viewport at 1920x895 — screenshot shows the full-width map,",
    "no cropped strip on the left edge.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- P0 play-phaser regression fixed — map canvas fills viewport width at 1920x895 (screenshot shows full-width map, no left-cropped strip).",
  );
  assert.equal(r.passed, true);
});

test("prose punctuation glued to tokens does not break matching (file/element.)", () => {
  const report = [
    "<evidence>",
    "P2 polish: type rhythm and contrast improvements shipped, each scoped to a single file",
    "(one element at a time); surfaces feel tangibly more premium.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- P2 polish items shipped: type rhythm / contrast / micro-anim surfaces that tangibly improve premium feel, each scoped to a single file/element.",
  );
  assert.equal(r.passed, true);
});

test("top-3 candidate matching tolerates contract-only vocabulary", () => {
  // The single-longest-word rule demanded "regression"'s longer sibling
  // verbatim; a natural report that says "screenshot" + "viewport" counts.
  const report = [
    "<evidence>",
    "Final premium-feel pass captured: 12 screenshots under .pi/chrome-screenshots/audit-2026-07-21/final/",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- Goal ends when: every audit row is fixed OR DEFER-with-reason, AND a final premium-feel screenshot pass of the whole game is captured under .pi/chrome-screenshots/audit-2026-07-21/final/.",
  );
  assert.equal(r.passed, true);
});

test("still rejects: bamboozle report that never touches the item's vocabulary", () => {
  const report = [
    "<evidence>",
    "I ran the checks and everything looks good. The work is complete and correct.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- P0 play-phaser regression fixed — map canvas fills viewport width at 1920x895.",
  );
  assert.equal(r.passed, false);
  assert.equal(r.missingItems.length, 1);
});

// ---- v0.34.77 (GitHub #5): non-ASCII (Chinese) contract items — the token
// extraction regex was ASCII-only, so pure-CJK lines produced zero candidates
// and could never be matched against the evidence block. ----

const ZH_CONTRACT = "Done when:\n- 调研报告文件存在且包含以下章节：\n- 包含「横向对比表」，至少对比 5 个工具/方案\n- README 包含 Markdown 渲染说明";

test("CJK: a verbatim-quoted Chinese item passes (token is one CJK word, not delimiters)", () => {
  const report = [
    "Audit report.",
    "<evidence>",
    "Item: 调研报告文件存在且包含以下章节：",
    "Output:",
    "$ ls reports/调研.pdf",
    "调研报告文件存在且包含以下章节",
    "Item: 包含「横向对比表」，至少对比 5 个工具/方案",
    "Output:",
    "横向对比表 rendered",
    "Item: README 包含 Markdown 渲染说明",
    "Output:",
    "README section: Markdown rendering",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, ZH_CONTRACT);
  assert.equal(r.passed, true, JSON.stringify(r.missingItems));
  assert.deepEqual(r.missingItems, []);
});

test("CJK: a quote that drops the trailing full-width colon still matches", () => {
  // The auditor copied the item without its final ： — the candidate token
  // (colon stripped by the split) is a substring of the report either way.
  const report = [
    "<evidence>",
    "Item: 调研报告文件存在且包含以下章节",
    "Output:",
    "found",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when:\n- 调研报告文件存在且包含以下章节：");
  assert.equal(r.passed, true, JSON.stringify(r.missingItems));
});

test("CJK: a Chinese line with no ASCII letters is one candidate token", () => {
  const r = checkRegressionShield(
    "<evidence>\nItem: 调研报告文件存在且包含以下章节\nOutput: ok\n</evidence>\n<approved/>",
    "Done when:\n- 调研报告文件存在且包含以下章节",
  );
  assert.equal(r.passed, true);
});

test("CJK: an English-only paraphrase of a Chinese item is still rejected (strict shield)", () => {
  const report = [
    "<evidence>",
    "Item: the research report file exists and contains the following sections",
    "Output: confirmed",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, ZH_CONTRACT);
  assert.equal(r.passed, false);
  assert.ok(r.missingItems.length >= 1);
});

test("CJK: mixed item matches on its ASCII token even when CJK words are not quoted", () => {
  // 包含「横向对比表」… also carries the ASCII token Markdown via README line.
  const report = [
    "<evidence>",
    "README includes a Markdown rendering section.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when:\n- README 包含 Markdown 渲染说明");
  assert.equal(r.passed, true);
});

test("ASCII behavior is unchanged: distinctive-token + compound matching still work", () => {
  const report = [
    "<evidence>",
    "Checked the file:",
    "$ cat hello.txt",
    "world",
    "$ grep -q world hello.txt && echo PASS",
    "PASS",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when: grep -q world hello.txt");
  assert.equal(r.passed, true);
  // compound segments still match
  const r2 = checkRegressionShield(
    "<evidence>\nno cropped strip on the left edge\n</evidence>\n<approved/>",
    "Done when:\n- left-cropped strip absent",
  );
  assert.equal(r2.passed, true);
});

// ---- v0.23.4: preamble lines are not items (darklord field bug) ----

test("contractItems: 'Done when ALL of the following are true:' preamble is dropped", () => {
  const items = contractItems([
    "Done when ALL of the following are true:",
    "1. combat-debug route renders without console errors",
    "2. art-demo-v7 variants persist across reload",
  ].join("\n"));
  assert.deepEqual(items, [
    "combat-debug route renders without console errors",
    "art-demo-v7 variants persist across reload",
  ]);
});

test("contractItems: preamble without trailing colon is also dropped", () => {
  const items = contractItems("Done when all of the following are true\n- tests pass cleanly");
  assert.deepEqual(items, ["tests pass cleanly"]);
});

test("shield passes a genuine approval that a preamble-only false positive used to block", () => {
  const report = [
    "<evidence>",
    "combat-debug renders: bun test src/lib — 42 pass, 0 fail.",
    "variants persist: reloaded the page, localStorage key art-demo-v7 intact.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, [
    "Done when ALL of the following are true:",
    "1. combat-debug route renders without console errors",
    "2. art-demo-v7 variants persist across reload",
  ].join("\n"));
  assert.equal(r.passed, true);
  assert.deepEqual(r.missingItems, []);
});

test("extractMechanicalCheckCommands: extracts backticked and raw shell commands", async () => {
  const { extractMechanicalCheckCommands, runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const contract = [
    "Done when:",
    "1. Run `npm test` and ensure 0 failures",
    "2. `tsc --noEmit` passes with zero errors",
    "3. cargo test --lib passes cleanly",
    "4. The UI displays the dark theme correctly",
  ].join("\n");
  const cmds = extractMechanicalCheckCommands(contract);
  assert.deepEqual(cmds, ["npm test", "tsc --noEmit", "cargo test --lib"]);

  // v0.35.24: trailing "completes successfully" / "succeeds" must be stripped
  // like "passes cleanly" — field incident 2026-08-22: "bun run build completes
  // successfully" was run verbatim and vite parsed "completes" as its root dir.
  const proseContract = [
    "bun test passes with 0 failures",
    "bun run build completes successfully",
    "cargo build succeeds cleanly",
  ].join("\n");
  assert.deepEqual(extractMechanicalCheckCommands(proseContract), ["bun test", "bun run build", "cargo build"]);

  // v0.36.1: a contract may name two independent safe commands with `&&`.
  // Extract each executable separately so the shell operator never reaches
  // execFileSync, while both gates remain mechanically enforced.
  const chainedContract = "`cargo test -p billing-api --test account_delete && cargo test -p music-api --test account_delete`";
  assert.deepEqual(extractMechanicalCheckCommands(chainedContract), [
    "cargo test -p billing-api --test account_delete",
    "cargo test -p music-api --test account_delete",
  ]);
  assert.equal(isSafeMechanicalCommand(extractMechanicalCheckCommands(chainedContract)[0]!), true);
  assert.equal(isSafeMechanicalCommand(extractMechanicalCheckCommands(chainedContract)[1]!), true);

  const res = await runMechanicalPreAuditChecks(process.cwd(), ["node --version"]);
  assert.equal(res.passed, true);

  const failRes = await runMechanicalPreAuditChecks(process.cwd(), ["node --definitely-not-a-real-option"]);
  assert.equal(failRes.passed, false);
  assert.notEqual(failRes.exitCode, 0);
  assert.match(failRes.output!, /bad option|unknown option|invalid option/i);

  const unsafeRes = await runMechanicalPreAuditChecks(process.cwd(), ["node --version; printf boom"]);
  assert.equal(unsafeRes.passed, false);
  assert.equal(unsafeRes.exitCode, 126);
  assert.doesNotMatch(unsafeRes.output!, /boom/);

  // v0.36.0: one narrow file-marker assertion is expanded into two
  // shell-free commands, so the release contract can verify both existence
  // and text without allowing arbitrary compound shell syntax.
  const markerRes = await runMechanicalPreAuditChecks(process.cwd(), ["test -s docs/DESIGN-long-running-supervision.md && grep -q 'event-driven' docs/DESIGN-long-running-supervision.md"]);
  assert.equal(markerRes.passed, true);
  const unsafeCompound = await runMechanicalPreAuditChecks(process.cwd(), ["test -s package.json && printf boom"]);
  assert.equal(unsafeCompound.passed, false);
  assert.equal(unsafeCompound.exitCode, 126);
  assert.doesNotMatch(unsafeCompound.output!, /boom/);
});

test("v0.35.16: mechanical checks keep the TAIL of failed output and banner a timeout kill", async () => {
  const { runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  // A failing command whose output exceeds the 4000-char evidence budget:
  // the DIAGNOSTIC END (where the runner prints failures) must survive, not
  // the startup head (field failure 2026-08-21: two auditor rounds saw only
  // startup logs of a gate killed mid-run — no failure was ever visible).
  // The script file path stays inside the safe-command character class so
  // the shell-free boundary itself is exercised, not bypassed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mech-tail-"));
  const scriptPath = path.join(dir, "fail-late.js");
  fs.writeFileSync(scriptPath, [
    "for (let i = 0; i < 300; i++) console.log('filler line ' + i + ' ' + 'x'.repeat(40));",
    "console.error('THE_ACTUAL_FAILURE_MARKER');",
    "process.exit(3);",
  ].join("\n"));
  try {
    const res = await runMechanicalPreAuditChecks(dir, ["node " + scriptPath]);
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, 3);
    assert.match(res.output!, /THE_ACTUAL_FAILURE_MARKER/, "the tail (where the failure lives) is kept");
    assert.match(res.output!, /truncated head/, "truncation is honest about what was dropped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The timeout-kill path banners honestly instead of masquerading as a
  // test failure (the field failure looked like 'exit code 1' with no
  // failing test anywhere).
  const slow = await runMechanicalPreAuditChecks(process.cwd(), ["sleep 5"], 1000);
  assert.equal(slow.passed, false);
  assert.match(slow.output!, /mechanical check killed after 1s/, "a timeout kill is named as such");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mechanical checks stay async and kill descendant processes on timeout", async () => {
  const { runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mech-tree-"));
  const scriptPath = path.join(dir, "spawn-child.js");
  const startedPath = path.join(dir, "started");
  const survivorPath = path.join(dir, "survived");
  const childCode = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivorPath)}, 'survived'), 1500);`,
  ].join("\n");
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `fs.writeFileSync(${JSON.stringify(startedPath)}, 'started');`,
    `spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
    "setTimeout(() => {}, 10000);",
  ].join("\n"));
  try {
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 20);
    const result = await runMechanicalPreAuditChecks(dir, ["node " + scriptPath], 500);
    clearTimeout(timer);
    assert.equal(timerFired, true, "the pre-audit must not block the event loop");
    assert.equal(result.passed, false);
    assert.match(result.output ?? "", /process tree terminated/);
    assert.equal(fs.existsSync(startedPath), true, "the fixture started before timeout");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(fs.existsSync(survivorPath), false, "descendants are killed with the process group");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanical checks stop a runaway process group before the wall timeout", async () => {
  const { runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mech-fork-"));
  const scriptPath = path.join(dir, "spawn-many.js");
  fs.writeFileSync(scriptPath, [
    "const { spawn } = require('node:child_process');",
    "for (let i = 0; i < 12; i++) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });",
    "setTimeout(() => {}, 10000);",
  ].join("\n"));
  try {
    const result = await runMechanicalPreAuditChecks(dir, ["node " + scriptPath], 5000, undefined, 4);
    assert.equal(result.passed, false);
    assert.match(result.output ?? "", /process group safety limit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("v0.35.18: resolveCanonicalRunnerCommand maps raw runners to their canonical package script", async () => {
  const { resolveCanonicalRunnerCommand } = await import("../extensions/goal-loop-backoff.ts");
  const scripts = {
    test: "bun test --parallel=1 --max-concurrency=1 --timeout=60000",
    "test:all": "bun test --parallel=1 --max-concurrency=1 --timeout=60000 && tsc --noEmit",
  };
  // The field case: contract prose names `bun test` → run the project's
  // declared invocation, not the bare runner (whose defaults ignore the
  // required serialization/timeout flags and fail spuriously).
  assert.deepEqual(resolveCanonicalRunnerCommand("bun test", scripts), { program: "npm", args: ["run", "test"] });
  // A narrower deliberate run passes through untouched.
  assert.deepEqual(resolveCanonicalRunnerCommand("bun test tests/foo.test.ts", scripts), { program: "bun", args: ["test", "tests/foo.test.ts"] });
  // Already-project-aware runners are never rewritten.
  assert.deepEqual(resolveCanonicalRunnerCommand("npm run test:all", scripts), { program: "npm", args: ["run", "test:all"] });
  // No wrapping script → passthrough.
  assert.deepEqual(resolveCanonicalRunnerCommand("vitest run", {}), { program: "vitest", args: ["run"] });
  // Non-runner programs pass through.
  assert.deepEqual(resolveCanonicalRunnerCommand("tsc --noEmit", scripts), { program: "tsc", args: ["--noEmit"] });
});

test("v0.35.20: runMechanicalPreAuditChecks retries a transiently failing check exactly once, honestly bannered", async () => {
  const { runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  // Case 1: first attempt fails (exit 3), second passes → overall pass with
  // an honest recoveredRetryNote.
  const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "mech-retry-1-"));
  const counter1 = path.join(cwd1, "attempts");
  fs.writeFileSync(path.join(cwd1, "flaky.sh"), `#!/bin/bash
n=$(cat ${counter1} 2>/dev/null || echo 0)
n=$((n+1)); echo $n > ${counter1}
[ $n -ge 2 ] && exit 0 || exit 3
`);
  fs.chmodSync(path.join(cwd1, "flaky.sh"), 0o755);
  const r1 = await runMechanicalPreAuditChecks(cwd1, ["bash " + path.join(cwd1, "flaky.sh")]);
  assert.equal(r1.passed, true, "a transient first-attempt failure is retried and passes");
  assert.match(r1.recoveredRetryNote ?? "", /first attempt failed \(exit 3\); automatic retry passed/);
  assert.equal(fs.readFileSync(counter1, "utf8").trim(), "2", "exactly ONE retry ran");

  // Case 2: both attempts fail → honest fail whose output names the retry.
  const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "mech-retry-2-"));
  fs.writeFileSync(path.join(cwd2, "red.sh"), "#!/bin/bash\necho deterministic-red\nexit 7\n");
  fs.chmodSync(path.join(cwd2, "red.sh"), 0o755);
  const r2 = await runMechanicalPreAuditChecks(cwd2, ["bash " + path.join(cwd2, "red.sh")]);
  assert.equal(r2.passed, false, "a genuinely red command stays red after the retry");
  assert.equal(r2.exitCode, 7);
  assert.match(r2.output ?? "", /retried once after a failed first attempt \(exit 7\); second attempt also failed/);
  assert.match(r2.output ?? "", /deterministic-red/, "second attempt's diagnostics are preserved");

  // Case 3: a recovered first command must not short-circuit the remaining
  // contract commands. The second script leaves a marker only if invoked.
  const cwd3 = fs.mkdtempSync(path.join(os.tmpdir(), "mech-retry-3-"));
  const counter3 = path.join(cwd3, "attempts");
  const marker3 = path.join(cwd3, "second-ran");
  fs.writeFileSync(path.join(cwd3, "flaky.sh"), `n=$(cat ${counter3} 2>/dev/null || echo 0)
n=$((n+1)); echo $n > ${counter3}
[ $n -ge 2 ] && exit 0 || exit 3
`);
  fs.writeFileSync(path.join(cwd3, "second.sh"), `echo ran > ${marker3}
`);
  fs.chmodSync(path.join(cwd3, "flaky.sh"), 0o755);
  fs.chmodSync(path.join(cwd3, "second.sh"), 0o755);
  const r3 = await runMechanicalPreAuditChecks(cwd3, ["bash " + path.join(cwd3, "flaky.sh"), "bash " + path.join(cwd3, "second.sh")]);
  assert.equal(r3.passed, true);
  assert.equal(fs.readFileSync(counter3, "utf8").trim(), "2");
  assert.equal(fs.readFileSync(marker3, "utf8").trim(), "ran", "later checks still execute after a recovered retry");
  assert.match(r3.recoveredRetryNote ?? "", /automatic retry passed/);
  fs.rmSync(cwd1, { recursive: true, force: true });
  fs.rmSync(cwd2, { recursive: true, force: true });
  fs.rmSync(cwd3, { recursive: true, force: true });
});

test("v0.38.23: mechanical checks resolve project-local node_modules/.bin (bare tsc ENOENT field fix)", async () => {
  const { mechanicalCheckEnv, runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  // Field 2026-09-05: contract `tsc --noEmit` spawned BARE against a parent
  // PATH without tsc → `spawn tsc ENOENT` fast-fail on a green tree.
  // Pure part: the project .bin dir goes first on PATH when present.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mech-localbin-"));
  const binDir = path.join(cwd, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const env = mechanicalCheckEnv(cwd);
  assert.ok(
    env.PATH === binDir || env.PATH?.startsWith(binDir + path.delimiter),
    "project .bin must resolve first",
  );
  // Absent .bin dir → parent environment untouched.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "mech-nobin-"));
  assert.equal(mechanicalCheckEnv(bare).PATH, process.env.PATH);

  // Integration part: a stub bin placed ONLY in the fixture .bin resolves.
  const stubName = process.platform === "win32" ? "mech-stub.cmd" : "mech-stub";
  const stubPath = path.join(binDir, stubName);
  fs.writeFileSync(
    stubPath,
    process.platform === "win32"
      ? "@echo mech-stub-ok\r\n"
      : "#!/bin/sh\necho mech-stub-ok\n",
  );
  if (process.platform !== "win32") fs.chmodSync(stubPath, 0o755);
  const res = await runMechanicalPreAuditChecks(cwd, [stubName]);
  assert.equal(res.passed, true, `bare stub in node_modules/.bin must resolve (output: ${res.output ?? ""})`);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});
