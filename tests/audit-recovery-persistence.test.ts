// Context-free stale-audit parking is a durable transaction, not a RAM-only
// status projection. A failed state append must return false so heartbeat
// cannot claim that the stored claim is safe when restart still says auditing.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parkCompletionAuditRecovery } from "../extensions/goal-recovery.ts";
import { readState } from "../extensions/goal-loop-core.ts";
import { __testOnlyLoadState } from "../extensions/loops/goal.js";
import { seedGoal, seedState, tmpCwd } from "./harness/mock-pi.ts";

const originalCwd = process.cwd();
const originalSessionFile = process.env.PI_SESSION_FILE;
const originalGlobal = process.env.GLLA_GLOBAL_SETTINGS_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSessionFile === undefined) delete process.env.PI_SESSION_FILE;
  else process.env.PI_SESSION_FILE = originalSessionFile;
  if (originalGlobal === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
  else process.env.GLLA_GLOBAL_SETTINGS_PATH = originalGlobal;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("context-free audit recovery returns false and leaves restart state auditing when append fails", () => {
  const cwd = tmpCwd();
  const goal = seedGoal({
    status: "auditing",
    objective: "durable recovery pending",
    pendingCompletion: {
      at: new Date().toISOString(),
      phase: "running",
      completionSummary: "claim",
      verificationSummary: "proof",
    } as never,
  });
  seedState(cwd, { goal });
  __testOnlyLoadState(cwd);

  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-recovery-settings-"));
  const globalFile = path.join(globalDir, "settings.json");
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot: "sessionDir", aggressiveMode: false }));
  tempDirs.push(globalDir);
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  delete process.env.PI_SESSION_FILE;

  const parked = parkCompletionAuditRecovery(cwd, "stale-latch-recovery");
  assert.equal(parked, false, "pending sessionDir makes the durable transaction fail");
  assert.equal(readState(cwd).goal?.status, "auditing", "restart still recovers the original durable state");
});
