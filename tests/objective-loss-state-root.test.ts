// pi-goal-list-loop-audit — v0.35.57
// tests/objective-loss-state-root.test.ts
//
// Objective-loss report: "wez crashed and some objectives were no longer live,
// i had to make new ones, i wonder if just version switch or what, but we
// should not guess but investigate" (note.md Now). This test determines
// whether the report is distinct from the already-shipped state-root fix.
//
// The durable objective lives in `piGlaDir(cwd)/active.jsonl` + the goal `.md`.
// In `workingDir` mode (default) a `cwd` switch changes `piGlaDir` and the
// old objective is invisible from the new cwd — expected, not a corruption.
// In `sessionDir` opt-in the same switch keeps the objective visible because
// `piGlaDir` resolves to the same top-level session directory.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { piGlaDir, setRuntimeSessionDir, stateRootPending, appendLedger, readState } from "../extensions/goal-loop-core.js";

function fixture(stateRoot: "workingDir" | "sessionDir" = "workingDir") {
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "glla-loss-a-"));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "glla-loss-b-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-loss-session-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-loss-global-"));
  const globalFile = path.join(globalDir, "settings.json");
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot }), "utf8");
  const priorGlobal = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const priorSessionFile = process.env.PI_SESSION_FILE;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  delete process.env.PI_SESSION_FILE;
  setRuntimeSessionDir(undefined);
  return {
    cwdA,
    cwdB,
    sessionDir,
    globalFile,
    globalDir,
    restore: () => {
      setRuntimeSessionDir(undefined);
      if (priorGlobal === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
      else process.env.GLLA_GLOBAL_SETTINGS_PATH = priorGlobal;
      if (priorSessionFile === undefined) delete process.env.PI_SESSION_FILE;
      else process.env.PI_SESSION_FILE = priorSessionFile;
      fs.rmSync(cwdA, { recursive: true, force: true });
      fs.rmSync(cwdB, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(globalDir, { recursive: true, force: true });
    },
  };
}

afterEach(() => setRuntimeSessionDir(undefined));

test("workingDir default: cwd switch makes old objective invisible from new cwd (expected)", () => {
  const fx = fixture("workingDir");
  try {
    assert.equal(stateRootPending(), false);
    appendLedger(fx.cwdA, "state", { goal: { id: "g1", objective: "keep me", status: "active", policy: "goal", autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 1000 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, list: [], loop: null });
    const fromA = readState(fx.cwdA);
    const fromB = readState(fx.cwdB);
    assert.equal(fromA.goal?.objective, "keep me");
    assert.equal(fromB.goal, null, "new cwd has empty state — not a corruption, just a different root");
    assert.notEqual(piGlaDir(fx.cwdA), piGlaDir(fx.cwdB));
  } finally {
    fx.restore();
  }
});

test("sessionDir opt-in: same cwd switch keeps objective visible via shared sessionDir", () => {
  const fx = fixture("sessionDir");
  try {
    setRuntimeSessionDir(fx.sessionDir);
    assert.equal(stateRootPending(), false);
    appendLedger(fx.cwdA, "state", { goal: { id: "g2", objective: "keep me session", status: "active", policy: "goal", autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 1000 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, list: [], loop: null });
    const fromA = readState(fx.cwdA);
    const fromB = readState(fx.cwdB);
    assert.equal(fromA.goal?.objective, "keep me session");
    assert.equal(fromB.goal?.objective, "keep me session", "sessionDir shares the same pi-glla across cwds");
    assert.equal(piGlaDir(fx.cwdA), piGlaDir(fx.cwdB));
    assert.equal(piGlaDir(fx.cwdA), path.join(fx.sessionDir, "pi-glla"));
  } finally {
    fx.restore();
  }
});

test("evidence: no destructive migration and pending defers writes — Wez crash / version switch does not delete old root", () => {
  const fx = fixture("sessionDir");
  try {
    // old workingDir root with legacy data
    fs.mkdirSync(path.join(fx.cwdA, ".pi-glla", "goals"), { recursive: true });
    fs.writeFileSync(path.join(fx.cwdA, ".pi-glla", "legacy-proof"), "old");
    // pending sessionDir must not delete or migrate it
    assert.equal(stateRootPending(), true);
    // (no write)
    assert.ok(fs.existsSync(path.join(fx.cwdA, ".pi-glla", "legacy-proof")));
    assert.equal(fs.existsSync(path.join(fx.sessionDir, "pi-glla")), false);
    // once sessionDir resolves, writes go to sessionDir, old tree untouched
    setRuntimeSessionDir(fx.sessionDir);
    appendLedger(fx.cwdA, "state", { goal: null, list: [], loop: null });
    assert.ok(fs.existsSync(path.join(fx.cwdA, ".pi-glla", "legacy-proof")), "old root untouched after sessionDir becomes resolvable");
    assert.ok(fs.existsSync(path.join(fx.sessionDir, "pi-glla", "active.jsonl")));
  } finally {
    fx.restore();
  }
});
