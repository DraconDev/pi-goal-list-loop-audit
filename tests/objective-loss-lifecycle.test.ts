// pi-goal-list-loop-audit — v0.35.59
// tests/objective-loss-lifecycle.test.ts
//
// Regression coverage for the auditor's two objective-loss objections:
// production session_start must register the file-backed host session root,
// and durable state must be observed from an independent process rather than
// only through one module instance.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { appendLedger, piGlaDir, readState, resolveRuntimeSessionDir, setRuntimeSessionDir } from "../extensions/goal-loop-core.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const priorGlobalSettings = process.env.GLLA_GLOBAL_SETTINGS_PATH;
const priorSessionFile = process.env.PI_SESSION_FILE;

function goalState(objective: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    goal: {
      id: "restart-goal",
      objective,
      status: "active",
      policy: "goal",
      autoContinue: true,
      usage: { tokensUsed: 0, tokensLimit: 0 },
      createdAt: now,
      updatedAt: now,
    },
    list: [],
    loop: null,
  };
}

function childCoreScript(): string {
  const coreUrl = pathToFileURL(path.resolve("extensions/goal-loop-core.ts")).href;
  return `
    const core = await import(${JSON.stringify(coreUrl)});
    const action = process.argv[1];
    const cwd = process.argv[2];
    if (action === "write") {
      core.appendLedger(cwd, "state", ${JSON.stringify(goalState("survives a fresh process"))});
      process.exit(0);
    }
    if (action === "read") {
      process.stdout.write(JSON.stringify(core.readState(cwd).goal?.objective ?? null));
      process.exit(0);
    }
    throw new Error("unknown child action");
  `;
}

function runCoreChild(action: "write" | "read", cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ["-e", childCoreScript(), "--", action, cwd], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

afterEach(() => {
  replaceState({ goal: null, list: [], loop: undefined });
  setRuntimeSessionDir(undefined);
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  if (priorGlobalSettings === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
  else process.env.GLLA_GLOBAL_SETTINGS_PATH = priorGlobalSettings;
  if (priorSessionFile === undefined) delete process.env.PI_SESSION_FILE;
  else process.env.PI_SESSION_FILE = priorSessionFile;
});

test("production session_start registers the host session root before restore", async () => {
  const cwdA = tmpCwd();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-lifecycle-session-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-lifecycle-global-"));
  const globalFile = path.join(globalDir, "settings.json");
  const fileParent = fs.mkdtempSync(path.join(os.tmpdir(), "glla-lifecycle-file-parent-"));
  const sessionFile = path.join(fileParent, "host-session.jsonl");
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  delete process.env.PI_SESSION_FILE;
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot: "sessionDir" }), "utf8");
  setRuntimeSessionDir(undefined);

  const sessionManager = {
    getSessionDir: () => sessionDir,
    getSessionFile: () => sessionFile,
    buildSessionContext: () => ({ messages: [{ role: "user", content: "restored" }] }),
  };
  const ctx = makeMockCtx(cwdA, { sessionManager });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    assert.equal(resolveRuntimeSessionDir(), sessionDir);
    assert.equal(piGlaDir(cwdA), path.join(sessionDir, "pi-glla"));
    assert.equal(fs.existsSync(path.join(cwdA, ".pi-glla")), false);
    assert.equal(fs.existsSync(path.join(fileParent, "pi-glla")), false, "getSessionDir wins over imported session-file parent");
    appendLedger(cwdA, "state", goalState("lifecycle root is durable"));
    assert.equal(readState(cwdA).goal?.objective, "lifecycle root is durable");
  } finally {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(fileParent, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});

test("fresh processes reload session-root state across a cwd switch", () => {
  const cwdA = tmpCwd();
  const cwdB = tmpCwd();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-restart-session-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-restart-global-"));
  const globalFile = path.join(globalDir, "settings.json");
  const sessionFile = path.join(sessionDir, "host-session.jsonl");
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot: "sessionDir" }), "utf8");
  const childEnv = {
    ...process.env,
    GLLA_GLOBAL_SETTINGS_PATH: globalFile,
    PI_SESSION_FILE: sessionFile,
  };
  try {
    // The writer exits before the reader starts: no in-memory module state is
    // shared, which is the bounded fresh-process/restart boundary.
    runCoreChild("write", cwdA, childEnv);
    assert.equal(JSON.parse(runCoreChild("read", cwdB, childEnv)), "survives a fresh process");
    assert.ok(fs.existsSync(path.join(sessionDir, "pi-glla", "active.jsonl")));
  } finally {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});

test("cancel and wipe defer safely while sessionDir is unresolved", async () => {
  const cwd = tmpCwd();
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-pending-global-"));
  const globalFile = path.join(globalDir, "settings.json");
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  delete process.env.PI_SESSION_FILE;
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot: "sessionDir" }), "utf8");
  setRuntimeSessionDir(undefined);
  replaceState({ goal: goalState("pending objective").goal as any, list: [], loop: undefined });
  const ctx = makeMockCtx(cwd);
  try {
    await pi.command("glla", "cancel", ctx);
    await pi.command("glla", "wipe", ctx);
    assert.ok(state.goal, "pending destructive commands preserve the in-memory objective");
    assert.equal(fs.existsSync(path.join(cwd, ".pi-glla")), false, "pending commands do not recreate a cwd root");
    assert.equal(ctx.ui.matching("deferred").length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});

test("cancel and wipe archive live state under the registered session root", async () => {
  const cwd = tmpCwd();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-command-session-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-command-global-"));
  const globalFile = path.join(globalDir, "settings.json");
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  delete process.env.PI_SESSION_FILE;
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot: "sessionDir" }), "utf8");
  const sessionManager = {
    getSessionDir: () => sessionDir,
    buildSessionContext: () => ({ messages: [{ role: "user", content: "restored" }] }),
  };
  const ctx = makeMockCtx(cwd, { sessionManager });
  const cancelId = "cancel-root-goal";
  const wipeId = "wipe-root-goal";
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    replaceState({ goal: { ...(goalState("cancel root objective").goal as any), id: cancelId }, list: [], loop: undefined });
    await pi.command("glla", "cancel", ctx);
    assert.ok(fs.existsSync(path.join(sessionDir, "pi-glla", "archive", `${cancelId}.md`)));
    assert.equal(fs.existsSync(path.join(cwd, ".pi-glla")), false);

    replaceState({ goal: { ...(goalState("wipe root objective").goal as any), id: wipeId }, list: [{ id: "waiting", objective: "waiting item", addedAt: new Date().toISOString() }], loop: undefined });
    await pi.command("glla", "wipe", ctx);
    assert.ok(fs.existsSync(path.join(sessionDir, "pi-glla", "archive", `${wipeId}.md`)));
    assert.equal(state.goal, null);
    assert.deepEqual(state.list, []);
    assert.equal(fs.existsSync(path.join(cwd, ".pi-glla")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});
