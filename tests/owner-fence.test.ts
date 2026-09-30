import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import "../extensions/loops/goal.js";
import { claimProcessOwner, readOwnerFile, replaceProcessOwner, writeOwnerFile } from "../extensions/loops/goal-session.js";
import { tmpCwd } from "./harness/mock-pi.js";

const GOAL_SESSION = fs.readFileSync("extensions/loops/goal-session.ts", "utf8");
const GOAL_ACTIVATION = fs.readFileSync("extensions/loops/goal-activation.ts", "utf8");
const COMMANDS = fs.readFileSync("extensions/goal-commands.ts", "utf8");
const LOOP = fs.readFileSync("extensions/goal-loop.ts", "utf8");

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

test("v0.35.72: a live foreign process cannot claim the workingDir owner file", async () => {
  const cwd = tmpCwd();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await waitForSpawn(child);
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-glla", "owner.json"), JSON.stringify({
      pid: child.pid,
      instanceId: "foreign-live-process",
      at: Date.now(),
    }));
    assert.equal(claimProcessOwner(cwd), false, "a live foreign pid keeps the shared root read-only");
  } finally {
    child.kill("SIGTERM");
  }
});

test("v0.35.72: mutating goal and loop commands use the stale admission fence", () => {
  const pause = COMMANDS.slice(COMMANDS.indexOf("async function cmdPause"), COMMANDS.indexOf("async function cmdResume"));
  const cancel = COMMANDS.slice(COMMANDS.indexOf("async function cmdCancel"), COMMANDS.indexOf("// =================================================================\n// /list"));
  const tweak = COMMANDS.slice(COMMANDS.indexOf("export async function cmdTweak"), COMMANDS.indexOf("/**\n * Conflict resolution"));
  assert.match(pause, /warnIfStaleAtEntry\(ctx, "\/goal pause"\)/);
  assert.match(cancel, /warnIfStaleAtEntry\(ctx, "\/goal cancel"\)/);
  assert.match(tweak, /warnIfStaleAtEntry\(ctx, mode === "list" \? "\/list tweak" : "\/goal tweak"\)/);
  assert.match(LOOP, /if \(sub !== "status" && warnIfStaleAtEntry\(ctx, `\/loop\$\{sub \? ` \$\{sub\}` : ""\}`\)\) return;/);
  // v0.38.12 (last-wins): the claim gate keeps its shape (ownsRoot) and a
  // newer main host supersedes a live foreign owner instead of refusing.
  assert.match(GOAL_ACTIVATION, /let ownsRoot = claimProcessOwner\(ctx\.cwd\);/);
  assert.match(GOAL_ACTIVATION, /supersedeLiveOwnerRoot\(ctx\.cwd, \{ isMainHost: true/);
  assert.match(GOAL_ACTIVATION, /if \(!ownsRoot\) \{/);
  assert.match(GOAL_SESSION, /withOwnerMutation\(ownerFilePath\(cwd\),/);
  assert.match(GOAL_SESSION, /publishOwnerRecord\(ownerFilePath\(cwd\),/);
  assert.match(GOAL_SESSION, /process\.kill\(pid, 0\)/);
});

test("owner acquisition and refresh preserve malformed records for explicit repair", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const file = path.join(cwd, ".pi-glla", "owner.json");
  for (const malformed of ["", "{", "{}", "null"]) {
    fs.writeFileSync(file, malformed);
    assert.equal(claimProcessOwner(cwd), false);
    writeOwnerFile(cwd);
    assert.equal(fs.readFileSync(file, "utf8"), malformed);
  }
});

test("takeover compares the complete record inside the owner mutation", () => {
  const cwd = tmpCwd();
  assert.equal(claimProcessOwner(cwd), true);
  const old = readOwnerFile(cwd)!;
  const file = path.join(cwd, ".pi-glla", "owner.json");
  const successor = { ...old, at: "later", ownerSessionId: "new-main" };
  fs.writeFileSync(file, JSON.stringify(successor));
  assert.equal(replaceProcessOwner(cwd, old), false, "a stale observation cannot replace a refreshed or successor record");
  assert.deepEqual(readOwnerFile(cwd), successor);
  assert.equal(replaceProcessOwner(cwd, successor), true, "an authorized current observation replaces without a removal gap");
  assert.equal(readOwnerFile(cwd)?.pid, process.pid);
});

test("a stale instance refresh cannot overwrite a same-process successor", () => {
  const cwd = tmpCwd();
  assert.equal(claimProcessOwner(cwd), true);
  const successor = { ...readOwnerFile(cwd)!, instanceId: "successor-instance" };
  const file = path.join(cwd, ".pi-glla", "owner.json");
  fs.writeFileSync(file, JSON.stringify(successor));
  writeOwnerFile(cwd);
  assert.deepEqual(readOwnerFile(cwd), successor);
});
