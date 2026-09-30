// Crash-consistency regressions for the durable projections introduced by the
// full-project freeze audit. These tests exercise the filesystem boundaries
// directly so a source-shape change cannot silently restore resurrection bugs.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  appendLedger,
  appendStateSnapshot,
  archiveIntentPath,
  archivedGoalPath,
  clearArchiveIntent,
  clearQueueItemFiles,
  deleteQueueItemFileResult,
  finalizeArchiveIntent,
  goalMdPath,
  ledgerPath,
  ledgerSegmentDir,
  readArchiveIntent,
  readLedgerTail,
  readState,
  rotateLedgerIfNeeded,
  scanLedgerRecords,
  writeArchiveIntent,
  writeGoalMd,
  writeQueueItemFile,
  queueItemPath,
  type Goal,
  type State,
} from "../extensions/goal-loop-core.ts";
import {
  AUDIT_JOB_CLEANUP_MIN_AGE_MS,
  cleanupDeadAuditJobs,
  inspectAuditJobHealth,
} from "../extensions/goal-loop-auditor-process.ts";
import { persistApprovalRender, replayUndeliveredApprovalRenders } from "../extensions/approval-render-store.js";

function tmpdir(prefix = "glla-recovery-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function goal(id: string, status: Goal["status"] = "active"): Goal {
  const at = "2026-08-31T10:00:00.000Z";
  return {
    id,
    objective: "durable recovery fixture",
    status,
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

function state(g: Goal | null): State {
  return { goal: g, list: [] };
}

test("archive summary obligation survives every projection boundary and outbox failure", () => {
  for (const boundary of ["prepared", "published", "state-persisted", "live-cleared", "outbox-written"] as const) {
    const cwd = tmpdir();
    try {
      const live = goal(`summary-${boundary}`);
      const terminal = { ...live, status: "complete" as const };
      const render = { goalId: live.id, objective: live.objective, chatLines: ["Approved work", "Evidence: verified"] };
      assert.equal(appendStateSnapshot(cwd, state(live)), true);
      writeGoalMd(cwd, live);
      assert.equal(writeArchiveIntent(cwd, {
        goalId: live.id, status: "complete", terminalGoal: terminal,
        phase: boundary === "prepared" ? "prepared" : "published", terminalRender: render,
      }), true);
      const enqueue = (entry: typeof render) => persistApprovalRender(cwd, entry);
      if (boundary === "prepared") {
        assert.equal(finalizeArchiveIntent(cwd, live.id, enqueue), false);
        assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => { throw new Error("unpublished summary"); }), 0);
        assert.ok(fs.existsSync(goalMdPath(cwd, live.id)));
        continue;
      }
      fs.writeFileSync(archivedGoalPath(cwd, live.id), "# published terminal archive\n");
      if (boundary === "state-persisted") appendStateSnapshot(cwd, state(terminal));
      if (boundary === "live-cleared") appendStateSnapshot(cwd, state(null));
      if (boundary === "outbox-written") assert.equal(enqueue(render), true);
      // Drop all caller state: recover only the journal a new process reads.
      const recovered = readArchiveIntent(cwd)!;
      assert.deepEqual(recovered.terminalRender, render);
      assert.equal(finalizeArchiveIntent(cwd, live.id, () => false), false);
      assert.ok(fs.existsSync(archiveIntentPath(cwd)), "failed transfer retains the obligation");
      assert.ok(fs.existsSync(goalMdPath(cwd, live.id)), "failed transfer retains the active projection");
      assert.equal(finalizeArchiveIntent(cwd, live.id, enqueue), true);
      assert.equal(fs.existsSync(archiveIntentPath(cwd)), false);
      let delivered = 0;
      assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => {
        assert.deepEqual(entry.chatLines, render.chatLines); delivered++; return true;
      }), 1);
      assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => { delivered++; return true; }), 0);
      assert.equal(delivered, 1, "transfer retry never duplicates delivery");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
});

test("SIGKILL before outbox transfer recovers the summary in a cold Node process", { skip: process.platform === "win32", timeout: 60_000 }, () => {
  const jiti = pathToFileURL(path.resolve("node_modules/jiti/lib/jiti.mjs")).href;
  for (const boundary of ["archive-published", "live-cleared", "outbox-written"]) {
    const cwd = tmpdir();
    try {
      const load = `import fs from 'node:fs'; import {createJiti} from ${JSON.stringify(jiti)};
        const jiti=createJiti(import.meta.url); const core=await jiti.import(${JSON.stringify(path.resolve("extensions/goal-loop-core.ts"))});
        const outbox=await jiti.import(${JSON.stringify(path.resolve("extensions/approval-render-store.ts"))});
        const cwd=${JSON.stringify(cwd)};`;
      const live = goal(`cold-${boundary}`);
      const producer = spawnSync("node", ["--input-type=module", "-e", `${load}
        const live=${JSON.stringify(live)}; const terminal={...live,status:'complete'};
        const render={goalId:live.id,objective:live.objective,chatLines:['Durable summary']};
        if(!core.appendStateSnapshot(cwd,{goal:live,list:[]})) throw new Error('seed failed');
        core.writeGoalMd(cwd,live);
        if(!core.writeArchiveIntent(cwd,{goalId:live.id,status:'complete',terminalGoal:terminal,phase:'published',terminalRender:render})) throw new Error('intent failed');
        fs.writeFileSync(core.archivedGoalPath(cwd,live.id),'# durable archive');
        ${boundary === "live-cleared" ? "core.appendStateSnapshot(cwd,{goal:null,list:[]});" : ""}
        ${boundary === "outbox-written" ? "if(!outbox.persistApprovalRender(cwd,render)) throw new Error('outbox failed');" : ""}
        process.kill(process.pid,'SIGKILL');`], { encoding: "utf8", timeout: 15_000 });
      assert.equal(producer.signal, "SIGKILL", producer.stderr);
      const recovery = spawnSync("node", ["--input-type=module", "-e", `${load}
        const intent=core.readArchiveIntent(cwd);
        if(!intent || !core.finalizeArchiveIntent(cwd,intent.goalId,render=>outbox.persistApprovalRender(cwd,render))) throw new Error('recovery failed');
        let count=0; outbox.replayUndeliveredApprovalRenders({cwd},()=>{count++;return true;});
        outbox.replayUndeliveredApprovalRenders({cwd},()=>{count++;return true;});
        if(count!==1 || fs.existsSync(core.archiveIntentPath(cwd))) throw new Error('duplicated or lost obligation');
        console.log('recovered exactly once');`], { encoding: "utf8", timeout: 15_000 });
      assert.equal(recovery.status, 0, recovery.stderr);
      assert.match(recovery.stdout, /recovered exactly once/);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
});

test("archive intent prevents a published archive from resurrecting its active goal", () => {
  const cwd = tmpdir();
  const live = goal("archive-recovery");
  const terminal = { ...live, status: "complete" as const, stopReason: "approved" };

  assert.equal(appendStateSnapshot(cwd, state(live)), true);
  writeGoalMd(cwd, live);
  assert.equal(writeArchiveIntent(cwd, {
    goalId: live.id,
    status: "complete",
    stopReason: terminal.stopReason,
    terminalGoal: terminal,
    phase: "published",
  }), true);
  fs.writeFileSync(archivedGoalPath(cwd, live.id), "# durable archive\n", "utf8");

  assert.equal(readArchiveIntent(cwd)?.phase, "published");
  assert.equal(readState(cwd).goal?.status, "complete", "startup reads the terminal journal projection");

  // The journal is not cleared until the terminal state has landed. If a
  // process dies here, the next read still sees the terminal projection.
  assert.equal(appendStateSnapshot(cwd, state(terminal)), true);
  assert.equal(finalizeArchiveIntent(cwd, live.id), true);
  assert.equal(fs.existsSync(goalMdPath(cwd, live.id)), false);
  assert.equal(fs.existsSync(archiveIntentPath(cwd)), false);
  assert.equal(readState(cwd).goal?.status, "complete");
});

test("a prepared archive intent without an archive is safe to discard", () => {
  const cwd = tmpdir();
  const live = goal("archive-prepared");
  assert.equal(appendStateSnapshot(cwd, state(live)), true);
  assert.equal(writeArchiveIntent(cwd, {
    goalId: live.id,
    status: "aborted",
    terminalGoal: { ...live, status: "aborted" },
    phase: "prepared",
  }), true);
  assert.equal(readState(cwd).goal?.status, "active");
  assert.equal(clearArchiveIntent(cwd), true);
  assert.equal(readState(cwd).goal?.status, "active");
});

test("ledger rotation keeps a bounded active snapshot and retains forensic history", () => {
  const cwd = tmpdir();
  assert.equal(appendStateSnapshot(cwd, state(goal("rotation-old"))), true);
  assert.equal(appendLedger(cwd, "forensic-marker", { payload: "x".repeat(256) }), true);
  const newest = goal("rotation-new");
  assert.equal(appendStateSnapshot(cwd, state(newest)), true);
  const activeLines = fs.readFileSync(ledgerPath(cwd), "utf8").trim().split("\n");
  const latestStateLine = activeLines.at(-1)!;

  assert.equal(rotateLedgerIfNeeded(cwd, latestStateLine, 1), true);
  const segments = fs.readdirSync(ledgerSegmentDir(cwd)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(segments.length, 1);
  assert.equal(fs.readFileSync(ledgerPath(cwd), "utf8").trim(), latestStateLine);
  assert.equal(readState(cwd).goal?.id, "rotation-new");

  const records: string[] = [];
  scanLedgerRecords(cwd, (entry) => records.push(entry.type));
  assert.ok(records.includes("forensic-marker"), "rotation preserves old forensic events");
  assert.deepEqual(readLedgerTail(cwd, 2).map((entry) => entry.type), ["state", "state"]);
});

test("readState recovers when a process dies after segment rename but before active rewrite", () => {
  const cwd = tmpdir();
  assert.equal(appendStateSnapshot(cwd, state(goal("rename-window"))), true);
  const active = ledgerPath(cwd);
  const segmentDir = ledgerSegmentDir(cwd);
  fs.mkdirSync(segmentDir, { recursive: true });
  fs.renameSync(active, path.join(segmentDir, "segment-9999999999999-crash.jsonl"));
  assert.equal(readState(cwd).goal?.id, "rename-window");
});

test("queue deletion distinguishes absent sidecars from failed destructive cleanup", () => {
  const cwd = tmpdir();
  const absent = deleteQueueItemFileResult(cwd, "missing-item");
  assert.deepEqual({ present: absent.present, removed: absent.removed, failed: absent.failed }, { present: false, removed: false, failed: false });

  const item = { id: "blocked-item", objective: "must remain recoverable", addedAt: "2026-08-31T10:00:00.000Z" };
  assert.equal(writeQueueItemFile(cwd, item).wrote, true);
  const sidecar = queueItemPath(cwd, item.id);
  fs.unlinkSync(sidecar);
  fs.mkdirSync(sidecar); // unlinkSync(directory) fails with EISDIR on POSIX.
  const failed = deleteQueueItemFileResult(cwd, item.id);
  assert.equal(failed.present, true);
  assert.equal(failed.removed, false);
  assert.equal(failed.failed, true);
  assert.ok(clearQueueItemFiles(cwd).failed.includes(`${item.id}.queue.json`));
});

test("audit-job health reports proven-dead workers and preserves ambiguous scratch", () => {
  const cwd = tmpdir();
  const root = path.join(cwd, ".pi-glla", "audit-jobs");
  const deadDir = path.join(root, "dead-attempt");
  const ambiguousDir = path.join(root, "ambiguous-attempt");
  fs.mkdirSync(deadDir, { recursive: true });
  fs.mkdirSync(ambiguousDir, { recursive: true });
  fs.writeFileSync(path.join(deadDir, "lock"), JSON.stringify({ role: "worker", pid: 999999, workerPath: "/definitely/not-running" }), "utf8");
  fs.writeFileSync(path.join(deadDir, "result.json"), "x", "utf8");
  fs.writeFileSync(path.join(ambiguousDir, "notes"), "keep me", "utf8");
  const old = new Date(Date.now() - AUDIT_JOB_CLEANUP_MIN_AGE_MS - 1_000);
  fs.utimesSync(deadDir, old, old);

  const report = inspectAuditJobHealth(cwd);
  assert.equal(report.total, 2);
  assert.equal(report.dead, 1);
  assert.equal(report.ambiguous, 1);
  assert.ok(report.bytes >= 1);
  const cleaned = cleanupDeadAuditJobs(cwd, 0);
  assert.equal(cleaned.dead, 0);
  assert.equal(cleaned.ambiguous, 1);
  assert.equal(fs.existsSync(deadDir), false);
  assert.equal(fs.existsSync(ambiguousDir), true);
});
