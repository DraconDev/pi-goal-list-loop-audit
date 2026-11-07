// pi-goal-list-loop-audit — no private project names in shipped text.
//
// This repo publishes to npm and mirrors publicly. A field report's durable
// value is the bug, the reproduction and the fix — not which proprietary tree
// found it. Naming a project in CHANGELOG.md publishes an inventory of private
// work to every consumer of the package.
//
// The gate is forward-looking: the tree already carries ~950 historical
// references, grandfathered because npm tarballs are immutable, AGENTS.md
// forbids rewriting pushed history, and no test can prove what a published
// version contained. Only lines NEW relative to the last release tag are
// judged, which needs no committed baseline — and that matters, because a
// baseline manifest in git would publish the very names it protects.
//
// The denylist lives in untracked `.dracon/no-project-names.txt`, so these
// tests drive the SCRIPT in a temp directory with a synthetic denylist. That
// keeps this file name-free too: a test that lists the names it forbids leaks
// them in the public mirror just as effectively as a changelog entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type StdioOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface MakeRepoOptions {
  denylist?: boolean;
  changelog?: string;
  files?: Record<string, string>;
}
interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SCRIPT = path.resolve("scripts/check-no-project-names.mjs");

/** A throwaway repo with a synthetic denylist. The names are invented so this
 * file never contains a real one. */
function makeRepo({ denylist = true, changelog = "", files = {} }: MakeRepoOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glla-names-"));
  fs.mkdirSync(path.join(root, ".dracon"), { recursive: true });
  fs.mkdirSync(path.join(root, "CHANGELOG.md").replace(/CHANGELOG\.md$/, ""), { recursive: true });
  if (denylist) {
    fs.writeFileSync(
      path.join(root, ".dracon", "no-project-names.txt"),
      "# synthetic denylist\nacmecorp\nwidgetworks\n",
    );
  }
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] as StdioOptions });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("tag", "v1.0.0");
  return { root, git };
}

function run(root: string, args: string[] = []): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("no-project-names: clean tree passes", () => {
  const { root } = makeRepo({
    changelog: "# Changelog\n\n## Unreleased\n\n- Fixes a scheduling bug.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  });
  const result = run(root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /clean/);
});

test("no-project-names: a new line naming a denied project fails", () => {
  const { root, git } = makeRepo({
    changelog: "# Changelog\n\n## Unreleased\n\n- Fixes a scheduling bug.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  });
  fs.writeFileSync(
    path.join(root, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n- Reproduced in the AcmeCorp tree today.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "leak");
  const result = run(root, ["--verbose"]);
  assert.equal(result.code, 1, "the gate must fail the release");
  assert.match(result.stderr, /CHANGELOG\.md:\d+/);
  assert.match(result.stderr, /AcmeCorp/, "the offending name is reported (case-insensitively)");
  assert.match(result.stderr, /private project names/);
});

test("no-project-names: pre-existing references are grandfathered", () => {
  // The name is already in history *at the tag*: editing around it must not
  // fail, because only added lines are judged.
  const { root, git } = makeRepo({
    changelog: "# Changelog\n\n## 1.0.0 — first (2026-01-01)\n\n- Originally found in widgetworks.\n",
  });
  const lines = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf-8").split("\n");
  lines.splice(2, 0, "## Unreleased", "", "- Fixes a scheduling bug.", "");
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), lines.join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "new work");
  const result = run(root);
  assert.equal(result.code, 0, `the historical name is not this release's problem: ${result.stderr}`);
});

test("no-project-names: word boundaries do not fire on longer words", () => {
  const { root, git } = makeRepo({
    changelog: "# Changelog\n\n## Unreleased\n\n- x.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  });
  fs.writeFileSync(
    path.join(root, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n- The acmecorpish helper and widgetworkshop naming stay untouched.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "near miss");
  const result = run(root);
  assert.equal(result.code, 0, `substring matches must not fire: ${result.stderr}`);
});

test("no-project-names: audit/ is judged even though npm does not ship it", () => {
  const { root, git } = makeRepo({
    changelog: "# Changelog\n\n## Unreleased\n\n- x.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  });
  fs.mkdirSync(path.join(root, "audit", "fix-2026-01-01"), { recursive: true });
  fs.writeFileSync(path.join(root, "audit", "fix-2026-01-01", "README.md"), "- Replay from AcmeCorp/widgets/entry.ts:41\n");
  git("add", "-A");
  git("commit", "-q", "-m", "audit doc");
  const result = run(root, ["--verbose"]);
  assert.equal(result.code, 1, "the public mirror publishes audit/, so it is in scope");
  assert.match(result.stderr, /audit\/fix-2026-01-01\/README\.md:1/);
});

test("no-project-names: tests/ is out of scope", () => {
  const { root, git } = makeRepo({
    changelog: "# Changelog\n\n## Unreleased\n\n- x.\n\n## 1.0.0 — first (2026-01-01)\n\n- Held.\n",
  });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "fixture.test.ts"), "// realistic fixture: AcmeCorp\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const result = run(root);
  assert.equal(result.code, 0, "a test fixture may need a realistic repo name");
});

test("no-project-names: no denylist means nothing to check, not a failure", () => {
  const { root } = makeRepo({
    denylist: false,
    changelog: "# Changelog\n\n## Unreleased\n\n- Names AcmeCorp freely.\n",
  });
  const result = run(root);
  assert.equal(result.code, 0, "a fresh clone has no denylist; the gate must degrade loudly but not fail");
  assert.match(result.stdout, /denylist absent/);
});

test("release:check runs the gate", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["release:check"] ?? "", /check:names/, "the gate is part of the release gate, not optional");
  assert.match(pkg.scripts["check:names"] ?? "", /check-no-project-names\.mjs/);
});

test("this test file and the gate script name no real project", () => {
  const denylistPath = path.join(".dracon", "no-project-names.txt");
  if (!fs.existsSync(denylistPath)) return; // fresh clone: nothing to compare
  const names = fs.readFileSync(denylistPath, "utf-8").split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const self = fs.readFileSync("tests/no-project-names.test.ts", "utf-8").toLowerCase();
  const script = fs.readFileSync("scripts/check-no-project-names.mjs", "utf-8").toLowerCase();
  for (const name of names) {
    assert.equal(self.includes(name.toLowerCase()), false, `this test file must not name ${name}`);
    assert.equal(script.includes(name.toLowerCase()), false, `the gate script must not name ${name}`);
  }
});
