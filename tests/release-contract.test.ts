import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { loadSkills } from "@earendil-works/pi-coding-agent";

function dryRunFiles(): Set<string> {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = JSON.parse(raw) as unknown;
  const entries = Array.isArray(report)
    ? report
    : report && typeof report === "object" && Array.isArray((report as { files?: unknown }).files)
      ? [report]
      : report && typeof report === "object"
        ? Object.values(report)
        : [];
  // npm versions have emitted a keyed object, a single report object, and an
  // array of reports, plus root-relative and `package/...` paths. Normalize
  // those transport details before asserting the package contract.
  return new Set(entries
    .flatMap((entry) => (entry && typeof entry === "object" && Array.isArray((entry as { files?: unknown }).files)
      ? (entry as { files: Array<{ path: string }> }).files
      : []))
    .map((file) => file.path.replace(/^package\//, "")));
}

test("release contract: published documentation links are covered by the npm tarball", () => {
  const files = dryRunFiles();
  for (const required of ["README.md", "INSTALL.md", "PLAN.md", "LIST-PHILOSOPHY.md", "CHANGELOG.md", "docs/INDEX.md", "docs/SETTINGS.md", "media/glla2.png", "examples/example-objective.md", "scripts/release-pack-smoke.mjs", "skills/glla-delegate/SKILL.md"]) {
    assert.ok(files.has(required), `${required} must be shipped`);
  }
  const index = fs.readFileSync("docs/INDEX.md", "utf-8");
  for (const omitted of ["../PLAN.md", "../LIST-PHILOSOPHY.md", "../audit/INDEX.md"]) {
    assert.doesNotMatch(index, new RegExp(omitted.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), `${omitted} must not be a broken package link`);
  }
});

test("release contract: the release gate exercises the packed artifact", () => {
  const packageJson = fs.readFileSync("package.json", "utf-8");
  assert.match(packageJson, /release:check[\s\S]*release-pack-smoke\.mjs/);
  assert.match(fs.readFileSync("scripts/release-pack-smoke.mjs", "utf-8"), /npm pack/);
  assert.match(fs.readFileSync("scripts/release-pack-smoke.mjs", "utf-8"), /goal\.ts/);
  assert.match(fs.readFileSync("scripts/release-pack-smoke.mjs", "utf-8"), /loadSkills\(/);
  const smoke = fs.readFileSync("scripts/release-pack-smoke.mjs", "utf-8");
  assert.match(smoke, /installedPackage/);
  assert.match(smoke, /packedLauncher/);
  assert.match(smoke, /workerPath/);
  assert.match(smoke, /result\.json/);
  assert.match(smoke, /detached:\s*true/, "the direct worker probe must isolate its process group");
  assert.doesNotMatch(smoke, /legacy-peer-deps/, "the smoke must not skip declared peer resolution");
  assert.doesNotMatch(smoke, /alias\s*:/, "the smoke must not alias peers back to the source tree");
});

test("release contract: packed prompts, schema, and workers ship in the dry-run list", () => {
  const files = dryRunFiles();
  for (const required of [
    "scripts/goal-compactor-worker.mjs",
    "scripts/durable-wait.mjs",
    "prompts/goal-loop-continuation.md",
    "prompts/goal-loop-draft.md",
    "prompts/goal-loop-forever-draft.md",
    "prompts/goal-loop-forever-metricless.md",
    "prompts/goal-loop-forever.md",
    "prompts/goal-loop-plan-loop.md",
    "prompts/goal-loop-plan.md",
    "schemas/goal.schema.json",
  ]) {
    assert.ok(files.has(required), `${required} must be shipped`);
  }
});

test("release contract: glla-delegate skill loads without diagnostics (source-tree fast tier)", () => {
  // Audit 2026-09-13: this is the fast source-tree tier only. The packed-
  // tarball tier lives in scripts/release-pack-smoke.mjs (loadSkills
  // against the installed tree) — the pin below keeps the two linked.
  const result = loadSkills({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    skillPaths: ["skills/glla-delegate"],
    includeDefaults: false,
  });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.skills.some((skill) => skill.name === "glla-delegate"), "glla-delegate must be discoverable by Pi");
});

test("release contract: docs index tracks the package version", () => {
  const version = (JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string }).version;
  const index = fs.readFileSync("docs/INDEX.md", "utf-8");
  assert.ok(index.includes(`v0.35.14–v${version}`), "the active-focus trail must reach the current package version");
});

test("release contract: package is discoverable as a Pi extension and skill", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
    keywords?: string[];
    pi?: { extensions?: string[]; skills?: string[]; image?: string };
  };
  assert.ok(manifest.keywords?.includes("pi-package"), "pi-package makes the release eligible for the Pi gallery");
  assert.deepEqual(manifest.pi?.extensions, ["extensions/loops/goal.ts"]);
  assert.deepEqual(manifest.pi?.skills, ["skills/glla-delegate"]);
  // v0.38.99: the gallery image is derived from the manifest instead of a
  // pinned filename — commit 917949e7 repointed `pi.image` at the new
  // thumbnail and this test kept asserting the old one, so the release gate
  // went red for a rename. The contract that actually matters is stronger
  // than the filename: the URL must be the raw gallery form, the file it
  // names must exist, be a real image (not a placeholder), and SHIP in the
  // tarball (a manifest pointing at an unshipped file breaks the gallery).
  const imageUrl = manifest.pi?.image ?? "";
  assert.match(imageUrl, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:main|master)\/media\/[A-Za-z0-9._-]+\.png$/, `the gallery image must be the raw main-branch media URL: ${imageUrl}`);
  const imagePath = imageUrl.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:main|master)\//, "");
  assert.ok(fs.existsSync(imagePath), `${imagePath} must exist in the repository`);
  assert.ok(fs.statSync(imagePath).size > 10_000, `${imagePath} must be a real image, not a placeholder`);
  assert.ok(dryRunFiles().has(imagePath), `${imagePath} must ship in the npm tarball`);
});

test("release contract: README package contents claim matches the files allowlist", () => {
  const readme = fs.readFileSync("README.md", "utf-8");
  assert.match(readme, /full test suite remains\s+repository material/);
  assert.doesNotMatch(readme, /and the full test suite\. `audit/);
  assert.equal([...dryRunFiles()].some((file) => file === "tests" || file.startsWith("tests/")), false, "tests remain repository-only material");
});

test("release contract: first-use README guidance matches current behavior", () => {
  const readme = fs.readFileSync("README.md", "utf-8");
  assert.match(readme, /State root.*workingDir.*sessionDir/s);
  assert.match(readme, /propose_task_list/);
  assert.match(readme, /`\/list resume`/);
  assert.match(readme, /npm run release:check/);
  assert.doesNotMatch(readme, /Expected output at v0\.35\.3/);
  assert.doesNotMatch(readme, /cargo test/);
});

test("release contract: smoke waits use durable or literal transition markers", () => {
  const smoke = fs.readFileSync("scripts/smoke.sh", "utf-8");
  assert.match(smoke, /wait_for\(\) \{ # wait_for <literal marker>/);
  assert.match(smoke, /grep -Fq -- "\$pat"/);
  assert.match(smoke, /ledger_has '\"approved\":true'/);
  assert.doesNotMatch(smoke, /wait_for "\?"/);
  assert.doesNotMatch(smoke, /wait_for "Yes"/);
});

test("release workflow scopes trusted-publishing OIDC to the publish job", () => {
  const workflow = fs.readFileSync(".github/workflows/publish.yml", "utf-8");
  const jobsAt = workflow.indexOf("jobs:\n");
  assert.ok(jobsAt > 0, "publish workflow has a jobs section");
  const globalPermissions = workflow.slice(0, jobsAt);
  assert.doesNotMatch(globalPermissions, /id-token:\s*write/, "quality must not inherit publish OIDC permission");
  const qualityAt = workflow.indexOf("  quality:", jobsAt);
  const publishAt = workflow.indexOf("  publish:", qualityAt);
  assert.ok(qualityAt > jobsAt && publishAt > qualityAt, "quality and publish jobs are present");
  assert.doesNotMatch(workflow.slice(qualityAt, publishAt), /id-token:\s*write/, "quality has no OIDC permission");
  assert.match(workflow.slice(publishAt), /permissions:\n\s+contents: read\n\s+id-token: write/, "publish retains trusted publishing OIDC");
});

test("v0.38.32: release runs never share the push-churn concurrency group", () => {
  // Field: v0.38.28/.30/.31/.32 release runs died with zero jobs — the
  // run-level group pooled release events with per-push quality churn and
  // GitHub supersede-cancels queued-never-started runs when a newer run
  // enters the group. The run-level group must key on the event.
  const workflow = fs.readFileSync(".github/workflows/publish.yml", "utf-8");
  const runConcurrency = workflow.slice(0, workflow.indexOf("jobs:\n"));
  assert.doesNotMatch(runConcurrency, /^\s*group: glla-quality\s*$/m, "no shared static run-level group");
  assert.match(runConcurrency, /github\.event_name == 'release'/, "run-level group keys on the event");
});

test("release contract: changelog has one heading for the current package version", () => {
  const version = (JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string }).version;
  const changelog = fs.readFileSync("CHANGELOG.md", "utf-8");
  const headings = changelog.split(/\r?\n/).filter((line) => line.startsWith(`## ${version} `));
  assert.equal(headings.length, 1, `${version} release notes must have one unambiguous heading`);
});
