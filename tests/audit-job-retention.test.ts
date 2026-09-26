// v0.38.72: retention sweep for finished audit-job dirs.
// Manual-only `/glla audits health cleanup` let 207 job dirs accumulate —
// 115 proven-dead plus 91 pre-convention finished audits (result.json on
// file, no worker lock ever written) that classified "ambiguous" forever.
// These tests pin the extended classification (missing lock + finished
// result reaps through the same retention gate) and the preserved
// conservative cases (fresh, unfinished, live, corrupt-lock).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  cleanupDeadAuditJobs,
  inspectAuditJobHealth,
} from "../extensions/goal-loop-auditor-process.ts";

const DAY_MS = 86_400_000;
const RETENTION_MS = 7 * DAY_MS;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-retention-"));
}

function jobDir(cwd: string, id: string): string {
  const dir = path.join(cwd, ".pi-glla", "audit-jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ageDir(dir: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, at, at);
}

function workerLock(dir: string, pid: number): void {
  fs.writeFileSync(
    path.join(dir, "lock"),
    JSON.stringify({ protocolVersion: 1, pid, role: "worker", workerPath: "/definitely/not-running" }),
    "utf8",
  );
}

function parentLock(dir: string, pid: number): void {
  fs.writeFileSync(
    path.join(dir, "lock"),
    JSON.stringify({ protocolVersion: 1, pid, role: "parent" }),
    "utf8",
  );
}

test("retention: pre-convention finished dirs (no lock, result on file) reap past the window", () => {
  const cwd = tmpdir();
  const old = jobDir(cwd, "audit-old-finished");
  fs.writeFileSync(path.join(old, "result.json"), "{}", "utf8");
  ageDir(old, 10 * DAY_MS);
  const fresh = jobDir(cwd, "audit-fresh-finished");
  fs.writeFileSync(path.join(fresh, "result.json"), "{}", "utf8");

  const health = inspectAuditJobHealth(cwd, Date.now(), RETENTION_MS);
  const entry = health.entries.find((e) => e.attemptId === "audit-old-finished");
  assert.equal(entry?.status, "dead", "missing lock + finished result classifies dead, not ambiguous");
  assert.match(entry?.reason ?? "", /no worker lock/);

  const cleaned = cleanupDeadAuditJobs(cwd, RETENTION_MS);
  assert.equal(fs.existsSync(old), false, "old finished dir reaped");
  assert.equal(fs.existsSync(fresh), true, "fresh finished dir kept for the review window");
  assert.equal(cleaned.total, 1);
});

test("retention: lockless UNFINISHED dirs stay ambiguous (interrupted creation)", () => {
  const cwd = tmpdir();
  const dir = jobDir(cwd, "audit-interrupted");
  fs.writeFileSync(path.join(dir, "request.json"), "{}", "utf8");
  ageDir(dir, 10 * DAY_MS);

  const health = inspectAuditJobHealth(cwd, Date.now(), RETENTION_MS);
  assert.equal(health.entries[0]?.status, "ambiguous");
  cleanupDeadAuditJobs(cwd, RETENTION_MS);
  assert.equal(fs.existsSync(dir), true, "no result, no reap — operator inspection preserved");
});

test("retention: corrupt (present-but-unparseable) locks stay ambiguous", () => {
  const cwd = tmpdir();
  const dir = jobDir(cwd, "audit-corrupt-lock");
  fs.writeFileSync(path.join(dir, "lock"), "not-json{", "utf8");
  fs.writeFileSync(path.join(dir, "result.json"), "{}", "utf8");
  ageDir(dir, 10 * DAY_MS);

  const health = inspectAuditJobHealth(cwd, Date.now(), RETENTION_MS);
  assert.equal(health.entries[0]?.status, "ambiguous", "atomic lock writes make corruption genuinely weird");
  cleanupDeadAuditJobs(cwd, RETENTION_MS);
  assert.equal(fs.existsSync(dir), true);
});

test("retention: crash before worker ownership reaps only when the parent is dead", () => {
  const cwd = tmpdir();
  const deadParent = jobDir(cwd, "audit-parent-dead");
  parentLock(deadParent, 999999);
  ageDir(deadParent, 10 * DAY_MS);
  const liveParent = jobDir(cwd, "audit-parent-live");
  parentLock(liveParent, process.pid);
  ageDir(liveParent, 10 * DAY_MS);

  const health = inspectAuditJobHealth(cwd, Date.now(), RETENTION_MS);
  assert.equal(health.entries.find((e) => e.attemptId === "audit-parent-dead")?.status, "dead");
  assert.equal(health.entries.find((e) => e.attemptId === "audit-parent-live")?.status, "ambiguous");
  const cleaned = cleanupDeadAuditJobs(cwd, RETENTION_MS);
  assert.equal(fs.existsSync(deadParent), false, "old pre-worker crash debris reaps");
  assert.equal(fs.existsSync(liveParent), true, "live parent window is preserved");
  assert.equal(cleaned.total, 1);
});

test("retention: proven-dead workers reap past the window, live pids never reap", () => {
  const cwd = tmpdir();
  const dead = jobDir(cwd, "audit-dead-worker");
  workerLock(dead, 999999);
  ageDir(dead, 10 * DAY_MS);
  const live = jobDir(cwd, "audit-live-worker");
  workerLock(live, process.pid);
  ageDir(live, 10 * DAY_MS);

  const cleaned = cleanupDeadAuditJobs(cwd, RETENTION_MS);
  assert.equal(fs.existsSync(dead), false, "dead pid + old reaps");
  assert.equal(fs.existsSync(live), true, "alive pid never reaps even when ancient");
  assert.equal(cleaned.total, 1);
});

test("retention: aged lockless dirs with neither request nor result reap as unowned debris", () => {
  // 2026-09-26 slow-audit hardening: hellhunter accumulated a 23-day-old
  // progress.json-only dir (no lock, no launch record, no result). No live
  // worker can exist without its lock (written before any progress), and
  // nothing launchable or finished remains — age-gated dead, not ambiguous.
  const cwd = tmpdir();
  const old = jobDir(cwd, "audit-old-debris");
  fs.writeFileSync(path.join(old, "progress.json"), JSON.stringify({ phase: "running" }), "utf8");
  ageDir(old, 10 * DAY_MS);
  const fresh = jobDir(cwd, "audit-fresh-debris");
  fs.writeFileSync(path.join(fresh, "progress.json"), JSON.stringify({ phase: "running" }), "utf8");

  const health = inspectAuditJobHealth(cwd, Date.now(), RETENTION_MS);
  assert.equal(health.entries.find((e) => e.attemptId === "audit-old-debris")?.status, "dead");
  assert.equal(health.entries.find((e) => e.attemptId === "audit-fresh-debris")?.status, "ambiguous", "fresh dirs keep the creation-race ambiguity");
  const cleaned = cleanupDeadAuditJobs(cwd, RETENTION_MS);
  assert.equal(fs.existsSync(old), false, "aged unowned debris reaps");
  assert.equal(fs.existsSync(fresh), true, "fresh debris survives until the window passes");
  assert.equal(cleaned.total, 1);
});
