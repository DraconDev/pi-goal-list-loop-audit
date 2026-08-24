// pi-goal-list-loop-audit — v0.35.55
// tests/state-root.test.ts
//
// Core/settings slice for the corrected PR #21 port. The state-root setting is
// global-only because project settings.json lives inside the selected root.
// workingDir remains the historical default; sessionDir is explicit opt-in.
// A pending sessionDir resolution is a write boundary: reads may fall back to
// cwd for compatibility, but no persistence call may recreate cwd/.pi-glla.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendLedger,
  clearQueueItemFiles,
  deleteQueueItemFile,
  ensureDirs,
  piGlaDir,
  readState,
  resolveRuntimeSessionDir,
  resumeAutoCommit,
  setRuntimeSessionDir,
  stateRootPending,
  writeGoalMd,
  writeQueueItemFile,
} from "../extensions/goal-loop-core.js";
import { loadSettings, projectSettingsPath, saveSettings, settingsProvenance } from "../extensions/goal-settings.js";

interface Fixture {
  cwd: string;
  sessionDir: string;
  globalFile: string;
  restore: () => void;
}

function fixture(stateRoot: "workingDir" | "sessionDir" = "workingDir"): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-state-cwd-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-state-session-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-state-global-"));
  const globalFile = path.join(globalDir, "settings.json");
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot }), "utf8");
  const priorGlobal = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const priorSessionFile = process.env.PI_SESSION_FILE;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  delete process.env.PI_SESSION_FILE;
  setRuntimeSessionDir(undefined);
  return {
    cwd,
    sessionDir,
    globalFile,
    restore: () => {
      setRuntimeSessionDir(undefined);
      if (priorGlobal === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
      else process.env.GLLA_GLOBAL_SETTINGS_PATH = priorGlobal;
      if (priorSessionFile === undefined) delete process.env.PI_SESSION_FILE;
      else process.env.PI_SESSION_FILE = priorSessionFile;
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(globalDir, { recursive: true, force: true });
    },
  };
}

afterEach(() => setRuntimeSessionDir(undefined));

test("workingDir remains the default root and persists under cwd", () => {
  const fx = fixture();
  try {
    assert.equal(stateRootPending(), false);
    assert.equal(piGlaDir(fx.cwd), path.join(fx.cwd, ".pi-glla"));
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "state", { goal: null, list: [], loop: null });
    assert.ok(fs.existsSync(path.join(fx.cwd, ".pi-glla", "goals")));
    assert.ok(fs.existsSync(path.join(fx.cwd, ".pi-glla", "active.jsonl")));
    assert.equal(fs.existsSync(path.join(fx.sessionDir, "pi-glla")), false);
    assert.deepEqual(readState(fx.cwd).list, []);
  } finally {
    fx.restore();
  }
});

test("sessionDir opt-in resolves to the registered top-level session directory", () => {
  const fx = fixture("sessionDir");
  try {
    setRuntimeSessionDir(fx.sessionDir);
    assert.equal(stateRootPending(), false);
    assert.equal(piGlaDir(fx.cwd), path.join(fx.sessionDir, "pi-glla"));
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "state", {
      goal: null,
      list: [{ id: "queued-1", objective: "keep this", addedAt: new Date().toISOString() }],
      loop: null,
    });
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false);
    assert.ok(fs.existsSync(path.join(fx.sessionDir, "pi-glla", "goals")));
    assert.equal(readState(fx.cwd).list?.length ?? 0, 1, "state reads through the selected root");
  } finally {
    fx.restore();
  }
});

test("pending sessionDir defers every core write and does not migrate the old cwd tree", () => {
  const fx = fixture("sessionDir");
  try {
    fs.mkdirSync(path.join(fx.cwd, ".pi-gla"), { recursive: true });
    fs.writeFileSync(path.join(fx.cwd, ".pi-gla", "legacy-marker"), "keep");
    assert.equal(stateRootPending(), true);
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "should_not_write", { ok: true });
    // Existing fallback directories must not make a deferred goal projection
    // look writable: writeGoalMd needs its own pre-write guard.
    fs.mkdirSync(path.join(fx.cwd, ".pi-glla", "goals"), { recursive: true });
    writeGoalMd(fx.cwd, {
      id: "pending-goal",
      objective: "must wait",
      status: "active",
      policy: "list",
      autoContinue: true,
      usage: { tokensUsed: 0, tokensLimit: 1000 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla", "goals", "pending-goal.md")), false);
    const queueWrite = writeQueueItemFile(fx.cwd, {
      id: "queued-pending",
      objective: "must wait",
      addedAt: new Date().toISOString(),
    });
    assert.equal(queueWrite.failed, true, "queue sidecar reports the deferred write");
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla", "active.jsonl")), false);
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla", "goals", "queued-pending.queue.json")), false);
    const oldQueue = path.join(fx.cwd, ".pi-glla", "goals", "old.queue.json");
    fs.writeFileSync(oldQueue, "old", "utf8");
    assert.equal(deleteQueueItemFile(fx.cwd, "old"), false);
    assert.deepEqual(clearQueueItemFiles(fx.cwd), { removed: 0, failed: [] });
    assert.ok(fs.existsSync(oldQueue), "pending mode does not delete fallback queue state");
    const sentinel = path.join(fx.cwd, ".pi-glla", ".pause-auto-commit");
    fs.writeFileSync(sentinel, "old", "utf8");
    assert.equal(resumeAutoCommit(fx.cwd), false);
    assert.ok(fs.existsSync(sentinel), "pending mode does not delete fallback sentinel");
    assert.ok(fs.existsSync(path.join(fx.cwd, ".pi-gla", "legacy-marker")), "legacy root is untouched");
    assert.equal(fs.existsSync(path.join(fx.sessionDir, "pi-glla")), false);
  } finally {
    fx.restore();
  }
});

test("PI_SESSION_FILE provides a worker-safe session-root fallback", () => {
  const fx = fixture("sessionDir");
  try {
    process.env.PI_SESSION_FILE = path.join(fx.sessionDir, "uuid-session.jsonl");
    assert.equal(resolveRuntimeSessionDir(), fx.sessionDir);
    assert.equal(piGlaDir(fx.cwd), path.join(fx.sessionDir, "pi-glla"));
  } finally {
    fx.restore();
  }
});

test("stateRoot is typed/global-only and project settings cannot override it", () => {
  const fx = fixture();
  try {
    saveSettings("global", fx.cwd, { stateRoot: "sessionDir" });
    assert.equal(loadSettings(fx.cwd).stateRoot, "sessionDir");
    assert.equal(settingsProvenance(fx.cwd).stateRoot?.source, "global");
    setRuntimeSessionDir(fx.sessionDir);
    saveSettings("project", fx.cwd, { stateRoot: "workingDir", notifyCmd: "notify-send $1" });
    const project = JSON.parse(fs.readFileSync(projectSettingsPath(fx.cwd), "utf8")) as Record<string, unknown>;
    assert.equal(project.notifyCmd, "notify-send $1");
    assert.equal("stateRoot" in project, false, "project scope cannot override the root selector");
    assert.equal(loadSettings(fx.cwd).stateRoot, "sessionDir");
  } finally {
    fx.restore();
  }
});
