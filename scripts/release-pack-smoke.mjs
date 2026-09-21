#!/usr/bin/env node
/**
 * Release gate: install the exact npm tarball into a disposable prefix and
 * load the published extension through the same Jiti boundary used by Pi.
 * `npm pack --dry-run` only checks the file list; this catches missing runtime
 * files, bad package paths, and peer-module resolution errors in the artifact
 * that users actually receive.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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
    // Audit 2026-09-13: every runtime-loaded file rides the gate, not just
    // the entry points — a files-narrowing that drops a prompt, the schema,
    // or a spawned worker must fail here, not at draft time in the field.
    "scripts/goal-compactor-worker.mjs",
    "scripts/durable-wait.mjs",
    "scripts/release-pack-smoke.mjs",
    "prompts/goal-loop-continuation.md",
    "prompts/goal-loop-draft.md",
    "prompts/goal-loop-forever-draft.md",
    "prompts/goal-loop-forever-metricless.md",
    "prompts/goal-loop-forever.md",
    "prompts/goal-loop-plan-loop.md",
    "prompts/goal-loop-plan.md",
    "schemas/goal.schema.json",
    "skills/glla-delegate/SKILL.md",
    // Audit 2026-09-15: docs/ and media/ ship whole — a SETTINGS.md or
    // hero-image drop must fail here, not in the field.
    "docs/SETTINGS.md",
    "media/glla2.png",
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
    "--no-save",
    "--prefix",
    installPrefix,
  ]);

  const installedPackage = path.join(installPrefix, "node_modules", packageName);
  if (!fs.existsSync(installedPackage)) throw new Error(`packed package was not installed at ${installedPackage}`);
  // Load the packed extension with the disposable install's own peer tree.
  // Never alias imports back to this checkout: that masks a published peer
  // declaration or an artifact-only module-resolution failure.
  const jiti = createJiti(pathToFileURL(installedPackage).href, { moduleCache: false });

  const activate = await jiti.import(path.join(installedPackage, "extensions/loops/goal.ts"), { default: true });
  if (typeof activate !== "function") throw new Error("packed extension entry did not export a default activation function");
  const auditor = await jiti.import(path.join(installedPackage, "extensions/goal-loop-auditor-process.ts"));
  if (typeof auditor.resolveWorkerCommand !== "function") throw new Error("packed auditor process did not expose its worker command resolver");
  if (auditor.resolveWorkerCommand("/usr/bin/node") !== "/usr/bin/node") throw new Error("packed auditor resolver returned an unexpected command");
  const packedLauncher = await import(pathToFileURL(path.join(installedPackage, "scripts/goal-auditor-launch.mjs")).href);
  if (typeof packedLauncher.buildAuditorPiSpawnSpec !== "function") throw new Error("packed launcher did not load");
  if (typeof packedLauncher.renameWithWindowsRetry !== "function") throw new Error("packed launcher exports are incomplete");

  // Tar-list presence is not worker coverage. Start the shipped worker from
  // the installed tree with a tiny RPC stub, then require its real result.json
  // protocol to complete within the smoke timeout.
  const stableJson = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  };
  const attemptId = "packed-worker-probe";
  const workerProbe = path.join(workspace, attemptId);
  fs.mkdirSync(workerProbe, { recursive: true });
  const request = {
    protocolVersion: 1,
    attemptId,
    cwd: repoRoot,
    prompt: "packed worker smoke probe",
    model: "packed-probe/model",
    thinkingLevel: "minimal",
  };
  request.requestHash = createHash("sha256").update(stableJson(request), "utf8").digest("hex");
  fs.writeFileSync(path.join(workerProbe, "request.json"), `${JSON.stringify(request)}\n`);
  fs.writeFileSync(path.join(workerProbe, "lock"), "{}\n");
  const piStub = path.join(workspace, "pi-rpc-stub.mjs");
  fs.writeFileSync(piStub, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: '<approved/>'}}) + '\\n');",
    "process.stdout.write(JSON.stringify({type: 'agent_settled'}) + '\\n');",
  ].join("\n"));
  fs.chmodSync(piStub, 0o755);
  const workerPath = path.join(installedPackage, "scripts/goal-auditor-worker.mjs");
  // The worker's bounded process-tree cleanup enumerates its own process
  // group. Keep this probe in a detached group so a direct smoke invocation
  // cannot signal the release gate's parent shell while terminating its RPC
  // stub; the production launcher already supplies the same isolation.
  execFileSync(process.execPath, [workerPath, "--job-dir", workerProbe], {
    cwd: installedPackage,
    detached: true,
    env: { ...process.env, GLLA_PI_BINARY: piStub, GLLA_AUDITOR_STALL_MS: "1000", GLLA_AUDITOR_EOF_EXIT_GRACE_MS: "100" },
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const workerResult = JSON.parse(fs.readFileSync(path.join(workerProbe, "result.json"), "utf8"));
  // v0.38.76: the stub approves, so the worker must run its falsification
  // round — the probe now pins the challenge (final-line verdict composes).
  const probeFinalLine = workerResult.output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (workerResult.ok !== true || probeFinalLine !== "<approved/>") throw new Error("packed worker did not complete its RPC probe");
  if (workerResult.challenge !== "confirmed") throw new Error("packed worker skipped its challenge round");
  console.log("OK: packed launcher loaded and worker completed its bounded RPC probe (challenge confirmed)");

  // Audit 2026-09-13: presence is not loadability — run the packed skill
  // through Pi's own loader against the INSTALLED tree (the source-tree
  // check in release-contract.test.ts cannot catch tarball-only defects).
  const piCoding = await jiti.import("@earendil-works/pi-coding-agent");
  if (typeof piCoding.loadSkills !== "function") throw new Error("packed gate could not resolve Pi loadSkills");
  const skillProbe = piCoding.loadSkills({
    cwd: installedPackage,
    agentDir: installedPackage,
    skillPaths: ["skills/glla-delegate"],
    includeDefaults: false,
  });
  if (skillProbe.diagnostics.length > 0) throw new Error(`packed skill has loader diagnostics: ${JSON.stringify(skillProbe.diagnostics).slice(0, 300)}`);
  if (!skillProbe.skills.some((skill) => skill.name === "glla-delegate")) throw new Error("packed skill not discoverable by Pi loadSkills");
  console.log("OK: packed glla-delegate skill loads with zero diagnostics");
  console.log(`OK: installed and imported ${packageName}@${packageJson.version} from its packed tarball`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
