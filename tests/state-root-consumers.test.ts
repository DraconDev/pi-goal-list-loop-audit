// pi-goal-list-loop-audit — v0.35.56
// tests/state-root-consumers.test.ts
//
// Consumer hardening for the corrected state-root port. WorkingDir remains
// default; sessionDir is opt-in. Pending sessionDir must defer every write
// that would otherwise recreate <cwd>/.pi-glla, and every resolved path
// must follow the selected root.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { piGlaDir, setRuntimeSessionDir, stateRootPending } from "../extensions/goal-loop-core.js";
import { dispatchRecordPath, persistDispatchRecord, readDispatchRecord } from "../extensions/goal-loop-dispatch.js";
import { writeReviewReport } from "../extensions/reviewer.js";
import { countOpenAuditFindings, topOpenAuditFinding } from "../extensions/goal-loop-forever.js";
import { rollupProject, discoverGllaProjects } from "../extensions/goal-loop-stats.js";

function fixture(stateRoot: "workingDir" | "sessionDir" = "workingDir") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-consumer-cwd-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-consumer-session-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-consumer-global-"));
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
    globalDir,
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

test("resolved consumers follow the selected root — dispatch, stats, audit findings", () => {
  const fx = fixture("sessionDir");
  try {
    setRuntimeSessionDir(fx.sessionDir);
    assert.equal(stateRootPending(), false);
    assert.equal(piGlaDir(fx.cwd), path.join(fx.sessionDir, "pi-glla"));
    assert.equal(dispatchRecordPath(fx.cwd), path.join(fx.sessionDir, "pi-glla", "continuation-dispatch.json"));
    // stats rollup reads from the selected root
    fs.mkdirSync(path.join(fx.sessionDir, "pi-glla"), { recursive: true });
    fs.writeFileSync(path.join(fx.sessionDir, "pi-glla", "active.jsonl"), `{"type":"goal_created","value":{},"at":"2026-08-24T00:00:00.000Z"}\n`);
    const rollup = rollupProject(fx.cwd);
    assert.ok(rollup, "rollup finds ledger via piGlaDir");
    assert.equal(rollup?.goalsCreated, 1);
    // audit findings helpers read via piGlaDir
    fs.mkdirSync(path.join(fx.sessionDir, "pi-glla", "audit-loop"), { recursive: true });
    fs.writeFileSync(path.join(fx.sessionDir, "pi-glla", "audit-loop", "findings.md"), "- [ ] HIGH: something\n");
    assert.equal(countOpenAuditFindings(fx.cwd), 1);
    assert.ok((topOpenAuditFinding(fx.cwd) ?? "").includes("HIGH"));
    // cwd fallback must stay empty
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false);
  } finally {
    fx.restore();
  }
});

test("pending sessionDir defers dispatch, reviewer, and audit writes — no cwd fallback tree", () => {
  const fx = fixture("sessionDir");
  try {
    // No session dir registered -> pending
    assert.equal(stateRootPending(), true);
    // dispatch
    const ok = persistDispatchRecord(fx.cwd, {
      version: 1,
      id: "test-id",
      generation: 1,
      ownerSessionId: "owner-1",
      kind: "goal",
      marker: "marker",
      sentAt: Date.now(),
      phase: "prepared",
      resync: false,
    });
    assert.equal(ok, false, "pending defers dispatch persist");
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false);
    assert.equal(readDispatchRecord(fx.cwd), null);
    // reviewer
    const deferred = writeReviewReport(fx.cwd, {
      goalId: "g1",
      at: new Date().toISOString(),
      mode: "auto",
      findings: [],
    } as any);
    assert.ok(deferred.includes("deferred.md"), "pending returns deferred path");
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false);
    // audit findings: pending reads still fallback to cwd (empty), not sessionDir
    assert.equal(countOpenAuditFindings(fx.cwd), 0);
  } finally {
    fx.restore();
  }
});

test("workingDir fallback and PI_SESSION_FILE fallback behave correctly", () => {
  const fx = fixture("sessionDir");
  try {
    // PI_SESSION_FILE fallback resolves session dir for workers
    process.env.PI_SESSION_FILE = path.join(fx.sessionDir, "session.jsonl");
    assert.equal(stateRootPending(), false);
    assert.equal(piGlaDir(fx.cwd), path.join(fx.sessionDir, "pi-glla"));
    // switching global back to workingDir returns to cwd even with PI_SESSION_FILE set
    fs.writeFileSync(fx.globalFile, JSON.stringify({ stateRoot: "workingDir" }), "utf8");
    assert.equal(piGlaDir(fx.cwd), path.join(fx.cwd, ".pi-glla"));
  } finally {
    fx.restore();
  }
});

test("source pins: raw cwd/.pi-glla hardcodings are gone from consumers", () => {
  const offenders: Array<{ file: string; bad: RegExp }> = [
    { file: "extensions/goal-loop-auditor-process.ts", bad: /path\.(join|resolve)\([^)]*\.pi-glla/ },
    { file: "extensions/goal-loop-dispatch.ts", bad: /path\.join\(cwd,\s*"\.pi-glla"/ },
    { file: "extensions/goal-loop.ts", bad: /path\.join\(ctx\.cwd,\s*"\.pi-glla"/ },
    { file: "extensions/reviewer.ts", bad: /path\.join\(cwd,\s*"\.pi-glla"/ },
    { file: "extensions/goal-loop-stats.ts", bad: /path\.join\(.*"\.pi-glla"/ },
    { file: "extensions/loops/goal-session.ts", bad: /path\.join\(cwd,\s*"\.pi-glla"/ },
  ];
  for (const { file, bad } of offenders) {
    const src = fs.readFileSync(file, "utf8");
    // allow the single fallback check in glla-state-root / core's migration guard
    if (file === "extensions/goal-loop-stats.ts" || file === "extensions/goal-loop-auditor-process.ts" || file === "extensions/goal-loop-dispatch.ts" || file === "extensions/reviewer.ts" || file === "extensions/loops/goal-session.ts") {
      // these files should now use piGlaDir
      assert.ok(src.includes("piGlaDir"), `${file} should route through piGlaDir`);
    }
    // ensure no raw cwd hardcoding remains (except the one intentional fallback in core and glla-state-root)
    if (file !== "extensions/goal-loop-stats.ts") {
      // stats previously had two raw joins, now should be gone
    }
    // For each file, verify the raw pattern is absent
    // (core's single fallback is allowed; consumers must not have it)
    const hasRaw = bad.test(src);
    assert.equal(hasRaw, false, `${file} still contains raw .pi-glla join`);
  }
  // loop-auditor and dispatch should have pending guards where they write
  assert.ok(fs.readFileSync("extensions/goal-loop-dispatch.ts", "utf8").includes("stateRootPending"), "dispatch should guard pending");
  assert.ok(fs.readFileSync("extensions/reviewer.ts", "utf8").includes("stateRootPending"), "reviewer should guard pending");
  assert.ok(fs.readFileSync("extensions/loops/goal-session.ts", "utf8").includes("stateRootPending"), "session should guard pending");
});
