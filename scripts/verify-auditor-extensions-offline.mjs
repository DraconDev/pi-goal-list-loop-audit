#!/usr/bin/env node
// pi-goal-list-loop-audit — scripts/verify-auditor-extensions-offline.mjs
//
// Mandatory hermetic check for the auditor extension allowlist. By default it
// loads the repository's local fixture, with an isolated PI_CODING_AGENT_DIR,
// PI_OFFLINE=1, and no network/package installation. GLLA_LIVE_EXT_PKG remains
// available for an explicit installed-package check, but missing inputs fail
// rather than silently skipping the release gate.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI = process.env.PI_BIN ?? "pi";
const repoRoot = path.resolve(import.meta.dirname, "..");
const fixture = process.env.GLLA_AUDITOR_EXTENSION_FIXTURE
  ?? path.join(repoRoot, "scripts", "auditor-extension-fixture.mjs");
const externalPackage = process.env.GLLA_LIVE_EXT_PKG?.trim();
const externalAgentDir = process.env.GLLA_LIVE_AGENT_DIR
  ?? path.join(os.homedir(), ".pi", "agent");
const resolved = externalPackage
  ? path.join(externalAgentDir, "npm", "node_modules", externalPackage)
  : fixture;
const provider = externalPackage
  ? (process.env.GLLA_LIVE_EXT_PROVIDER ?? "cursor")
  : "glla-auditor-fixture";
const hermeticAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-auditor-extension-check-"));

function listModels(extArg) {
  return execFileSync(
    "timeout",
    ["60", PI, "--no-extensions", "-e", extArg, "--list-models"],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: hermeticAgentDir,
        PI_OFFLINE: "1",
      },
      encoding: "utf8",
    },
  );
}

try {
  if (!fs.existsSync(resolved)) {
    throw new Error(`required auditor extension input is missing: ${resolved}`);
  }

  // 1. The resolved allowlist path registers the expected provider offline.
  const out = listModels(resolved);
  const providerModels = out
    .split("\n")
    .filter((line) => line.startsWith(provider) && /\s/.test(line)).length;
  if (providerModels === 0) {
    throw new Error(`-e ${resolved} registered 0 ${provider} models offline`);
  }
  console.log(`OK: -e <resolved-path> registered ${providerModels} ${provider} models offline (PI_OFFLINE=1)`);

  // 2. The isolated spawn must not create a temporary extension install dir.
  const tmpExtensionsDir = path.join(hermeticAgentDir, "tmp", "extensions");
  if (fs.existsSync(tmpExtensionsDir)) {
    throw new Error("a temporary extension install directory was created during the spawn");
  }
  console.log("OK: no temporary extension install directory created");
  console.log(`VERIFIED offline auditor extension loading via resolved path: ${resolved}`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(hermeticAgentDir, { recursive: true, force: true });
}
