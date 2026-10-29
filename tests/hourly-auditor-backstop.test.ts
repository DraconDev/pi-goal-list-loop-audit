// pi-goal-list-loop-audit — auditor/main unification
// tests/hourly-auditor-backstop.test.ts
//
// Contract: a parked auditor retry-waiting claim rides the SAME :00:30
// ticker as main-model recovery. The auditor is just provider requests —
// the ladder timer stays the primary driver, and the ticker is the backstop
// when that timer dies (missed restore, cleared timer). The backstop fires
// only past the ladder deadline and never touches models.
//
// Source pins (first half) + an isolated child harness driving the
// production schedule/fire path (second half), mirroring
// hourly-quota-probe.test.ts.

import { runAuditorFallbackWithPolicy } from "../extensions/goal-loop-auditor-process.ts";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { readGoalRuntimeSource } from "./harness/goal-source.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOAL_SRC = readGoalRuntimeSource();
const RECOVERY_SRC = readFile("extensions/goal-recovery.ts");
const PROCESS_SRC = readFile("extensions/goal-loop-auditor-process.ts");

function readFile(rel: string): string {
  return readFileSync(join(here, "..", rel), "utf8");
}

const execFileAsync = promisify(execFile);
const RUNTIME_SCRIPT = join(here, "hourly-auditor-backstop-runtime.mjs");

async function runBackstopRuntime(): Promise<string> {
  const sandbox = mkdtempSync(join(tmpdir(), "glla-backstop-settings-"));
  const settingsPath = join(sandbox, "global-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ hourlyRetryProbe: true }));
  const result = await execFileAsync(process.execPath, [RUNTIME_SCRIPT], {
    cwd: join(here, ".."),
    env: { ...process.env, GLLA_GLOBAL_SETTINGS_PATH: settingsPath },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  return result.stdout;
}

test("unified: the shared ticker arms for a parked auditor claim with no main recovery", () => {
  assert.match(RECOVERY_SRC, /const auditorParked = state\.goal\?\.status === "paused"/);
  assert.match(RECOVERY_SRC, /pendingCompletion\?\.phase \?\? ""\) === "retry-waiting"/);
  assert.match(RECOVERY_SRC, /pauseReason \?\? ""\)\.startsWith\("auditor retry:"\)/);
  assert.match(RECOVERY_SRC, /if \(!mainParked && !auditorParked\) return;/);
});

test("unified: the backstop fires past-due auditor retries and never touches models", () => {
  assert.match(RECOVERY_SRC, /async function fireHourlyProbeForParkedAuditor/);
  assert.match(RECOVERY_SRC, /hourly_probe_auditor_backstop/);
  assert.match(RECOVERY_SRC, /await retryStoredCompletionAudit\("provider-retry"\)/);
  assert.match(RECOVERY_SRC, /Date\.parse\(goal\.pauseResumeAt\) > Date\.now\(\) \+ 60_000\) return;/);
});

test("unified: the ladder arms the ticker as its backstop", () => {
  assert.match(GOAL_SRC, /scheduleHourlyProbe\(liveCtx\);/);
  assert.match(GOAL_SRC, /Shared-ticker backstop rides along with the restored ladder timer/);
});

test("unified: one dead backend skips configured rungs while retaining the session last resort", async () => {
  const calls: string[] = [];
  const out = await runAuditorFallbackWithPolicy([
    { model: { provider: "a", id: "preferred" }, via: "setting" },
    { model: { provider: "a", id: "backup" }, via: "fallback-pin" },
    { model: { provider: "a", id: "session" }, via: "session-fallback" },
  ], async (candidate) => {
    calls.push(candidate.model.id);
    return candidate.model.id === "session"
      ? { approved: true, disapproved: false, output: "verified", model: "a/session" }
      : { approved: false, disapproved: false, output: "", model: "a/preferred", error: "HTTP 503 provider unavailable" };
  }, { sleep: async () => {} });
  // A named provider wall is not hammered twice before a configured
  // alternative is tried: the first backend-side failure advances the walk,
  // skipping the same-provider rung that the failed account would also refuse.
  assert.deepEqual(calls, ["preferred", "session"], "one dead backend burns one launch, not a per-rung retry ladder");
  assert.equal(calls.includes("backup"), false, "same-provider rungs stay skipped");
  assert.equal(out.result.approved, true, "the session last resort still produces the verdict");
});

test("unified: executable runtime regression covers arming, past-due fire, guards, and opt-out", async () => {
  const output = await runBackstopRuntime();
  assert.match(output, /auditor-backstop-runtime-ok/, "the isolated runtime harness completed every backstop assertion");
});
