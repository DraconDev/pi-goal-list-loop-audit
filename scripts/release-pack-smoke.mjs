#!/usr/bin/env node
/**
 * Release gate: install the exact npm tarball into a disposable prefix and
 * load the published extension through the same Jiti boundary used by Pi.
 * `npm pack --dry-run` only checks the file list; this catches missing runtime
 * files, bad package paths, and peer-module resolution errors in the artifact
 * that users actually receive.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "glla-pack-smoke-"));
const packDir = path.join(workspace, "pack");
const installPrefix = path.join(workspace, "install");
fs.mkdirSync(packDir, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function packFilename(raw) {
  const report = JSON.parse(raw);
  const entry = Array.isArray(report) ? report[0] : report;
  if (!entry || typeof entry.filename !== "string") throw new Error("npm pack did not return a tarball filename");
  return entry.filename;
}

try {
  const filename = packFilename(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]));
  const tarball = path.join(packDir, filename);
  if (!fs.existsSync(tarball)) throw new Error(`npm pack reported a missing tarball: ${tarball}`);

  const required = [
    "extensions/loops/goal.ts",
    "extensions/goal-loop-auditor-process.ts",
    "scripts/goal-auditor-launch.mjs",
    "scripts/goal-auditor-worker.mjs",
    "scripts/release-pack-smoke.mjs",
    "skills/glla-delegate/SKILL.md",
  ];
  const listing = run("tar", ["-tzf", tarball]);
  for (const file of required) {
    if (!listing.split("\n").some((entry) => entry === `package/${file}`)) {
      throw new Error(`packed artifact is missing ${file}`);
    }
  }

  run("npm", [
    "install",
    tarball,
    "--ignore-scripts",
    "--omit=dev",
    "--legacy-peer-deps",
    "--no-save",
    "--prefix",
    installPrefix,
  ]);

  const installedPackage = path.join(installPrefix, "node_modules", packageName);
  if (!fs.existsSync(installedPackage)) throw new Error(`packed package was not installed at ${installedPackage}`);
  const nodeModules = path.join(repoRoot, "node_modules");
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-agent-core": path.join(nodeModules, "@earendil-works/pi-agent-core"),
      "@earendil-works/pi-ai": path.join(nodeModules, "@earendil-works/pi-ai"),
      "@earendil-works/pi-coding-agent": path.join(nodeModules, "@earendil-works/pi-coding-agent"),
      "@earendil-works/pi-tui": path.join(nodeModules, "@earendil-works/pi-tui"),
      // Audit 2026-09-06: the @tintinweb/pi-subagents alias was stale
      // tintinweb-era drift — nothing imports the scoped name and the
      // package depends on unscoped pi-subagents (which no extension
      // imports directly, so no alias is needed).
      // TypeBox exposes only an ESM `exports` entry; point Jiti at that
      // concrete module because the disposable install intentionally omits
      // peer dependencies.
      typebox: path.join(nodeModules, "typebox", "build", "index.mjs"),
    },
  });

  const activate = await jiti.import(path.join(installedPackage, "extensions/loops/goal.ts"), { default: true });
  if (typeof activate !== "function") throw new Error("packed extension entry did not export a default activation function");
  const auditor = await jiti.import(path.join(installedPackage, "extensions/goal-loop-auditor-process.ts"));
  if (typeof auditor.resolveWorkerCommand !== "function") throw new Error("packed auditor process did not expose its worker command resolver");
  if (auditor.resolveWorkerCommand("/usr/bin/node") !== "/usr/bin/node") throw new Error("packed auditor resolver returned an unexpected command");
  console.log(`OK: installed and imported ${packageName}@${packageJson.version} from its packed tarball`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
