#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { buildCanaryExtensionSource } from "./canary-extension.mjs";
import { terminateContainedChild } from "./contained-child.mjs";
import { buildAuditorPiSpawnSpec } from "./goal-auditor-launch.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputIndex = process.argv.indexOf("--output");
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputFile) throw new Error("--output needs a filename");
function report(result) {
  const json = JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: process.platform, ...result }, null, 2) + "\n";
  if (outputFile) fs.writeFileSync(outputFile, json);
  process.stdout.write(json);
}
if (process.env.GLLA_RUN_REAL_CANARY !== "1") {
  report({ status: "skipped", reason: "explicit opt-in GLLA_RUN_REAL_CANARY=1 is required; no provider request sent" });
} else {
  const model = process.env.GLLA_CANARY_MODEL;
  if (!model) throw new Error("opt-in canary requires GLLA_CANARY_MODEL=provider/model");
  const maxUsd = Number(process.env.GLLA_CANARY_MAX_USD ?? 0.1);
  if (!(maxUsd > 0 && maxUsd <= 1)) throw new Error("canary estimated-spend budget must be >0 and <=1 USD");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "glla-real-canary-"));
  let child;
  try {
    const receipt = path.join(scratch, "request-receipt.json");
    const outcome = path.join(scratch, "outcome.json");
    const settings = path.join(scratch, "glla-settings.json");
    fs.writeFileSync(settings, '{"autoResume":false,"aggressiveMode":false}');
    // Provider retries can occur after onPayload, bypassing our hook count.
    // Keep this policy private to the disposable canary host.
    const agentDir = path.join(scratch, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false }, cacheWarming: "off",
    }));
    const hook = path.join(scratch, "canary-budget-extension.mjs");
    fs.writeFileSync(hook, buildCanaryExtensionSource({ maxUsd, receipt, outcome }));
    const binary = process.env.GLLA_PI_BINARY ?? path.join(root, "node_modules/.bin", process.platform === "win32" ? "pi.cmd" : "pi");
    const versionSpec = buildAuditorPiSpawnSpec(binary, ["--version"]);
    const piVersion = execFileSync(versionSpec.file, versionSpec.args, { ...versionSpec.options, encoding: "utf8", timeout: 10_000 }).trim();
    const args = ["-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--no-approve",
      "-e", path.join(root, "extensions/loops/goal.ts"), "-e", hook, "--model", model, "--thinking", "off", "--system-prompt", "Reply exactly with the requested word. Do not call tools.", "--", "Reply GLLA_CANARY_OK"];
    const launch = buildAuditorPiSpawnSpec(binary, args);
    child = spawn(launch.file, launch.args, { ...launch.options, cwd: scratch, detached: process.platform !== "win32",
      env: { ...process.env, GLLA_GLOBAL_SETTINGS_PATH: settings, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-2000); });
    let timedOut = false;
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; void terminateContainedChild(child); }, 45_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", value => { clearTimeout(timer); resolve(value); });
    });
    await terminateContainedChild(child);
    const request = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
    const final = fs.existsSync(outcome) ? JSON.parse(fs.readFileSync(outcome, "utf8")) : undefined;
    const passed = code === 0 && !timedOut && request?.requests === 1 && request?.attempts === 1 && request?.refused === false && final?.matched === true;
    report({ status: passed ? "passed" : "failed", piVersion, gllaVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
      model, code, timedOut, estimatedSpendBudgetUsd: maxUsd, request, outcome: final,
      scope: "One real-host activation and provider reply with GLLA loaded. Output cap 32 tokens; one request; 8192-byte payload cap. Price metadata preflight is an estimate, not a billing guarantee. This is not a completion-audit or live-compaction certification.",
      ...(!passed ? { diagnostic: stderr.trim().slice(-500) } : {}) });
    if (!passed) process.exitCode = 1;
  } finally {
    if (child) await terminateContainedChild(child);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
