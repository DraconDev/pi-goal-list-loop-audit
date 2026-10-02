import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyLoadState, __testOnlySetLastActivityAt } from "../extensions/loops/goal.js";
import { __testOnlyHeartbeatTick } from "../extensions/goal-heartbeat.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { archivedGoalPath, readState, type Goal, type State } from "../extensions/goal-loop-core.js";
import { buildWidgetLines, buildStatusText } from "../extensions/goal-loop-display.js";
import { auditorWorkerLiveForAttempt, completionAuditRecoveryIdentity, requestHash, readCompletedCompletionAudit, runDetachedGoalCompletionAuditor, buildGoalAuditorPrompt, workerProcessMatches } from "../extensions/goal-loop-auditor-process.js";
import { MockPi, makeMockCtx, invalidateHostSession, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

/** Spawn a stub whose cmdline passes workerProcessMatches for this job dir:
 * a live `node` process whose argv carries the --job-dir marker and the dir,
 * running with the test cwd. Returns the child plus a cleanup. */
function spawnWorkerStub(cwd: string, dir: string): { child: ChildProcess; cleanup: () => void } {
  // workerProcessMatches compares against the resolved dir; interpolate it
  // resolved so symlinked tmp roots (macOS /tmp) still match.
  const resolved = fs.realpathSync(dir);
  const child = spawn("node", ["-e", `setInterval(()=>{},60000) // --job-dir ${resolved}`], { cwd, stdio: "ignore" });
  child.unref?.();
  return { child, cleanup: () => { try { child.kill("SIGTERM"); } catch {} } };
}
function writeWorkerLock(dir: string, attemptId: string, pid: number): void {
  fs.writeFileSync(path.join(dir, "lock"), JSON.stringify({ protocolVersion: 1, attemptId, pid, role: "worker", workerPath: "node" }));
}

function goal(): Goal {
  return seedGoal({ status: "auditing", objective: "verify the artifact", verificationContract: "artifact exists", revision: 0,
    pendingCompletion: { at: new Date(Date.now() - 5000).toISOString(), phase: "running", attemptId: "saved-claim", completionSummary: "artifact delivered", verificationSummary: "artifact exists" },
  }) as unknown as Goal;
}
function job(cwd: string, g: Goal, options: { name?: string; at?: number; output?: string; legacy?: boolean; result?: boolean; extra?: Record<string, unknown> } = {}) {
  const name = options.name ?? "saved-claim-physical";
  const dir = path.join(cwd, ".pi-glla", "audit-jobs", name);
  fs.mkdirSync(dir, { recursive: true });
  const unsigned = { protocolVersion: 1, attemptId: name, createdAt: new Date(options.at ?? Date.now() - 2000).toISOString(), cwd,
    prompt: buildGoalAuditorPrompt(g, g.pendingCompletion!.completionSummary, g.pendingCompletion!.verificationSummary), model: "test/model", thinkingLevel: "off",
    goalRevision: { goalId: g.id, revision: g.revision ?? 0 },
    ...(!options.legacy ? { logicalAttemptId: g.pendingCompletion!.attemptId, recoveryIdentity: completionAuditRecoveryIdentity(g) } : {}),
  };
  const request = { ...unsigned, requestHash: requestHash(unsigned) };
  const result = { protocolVersion: 1, attemptId: name, requestHash: request.requestHash, ok: true,
    output: options.output ?? "<evidence>\nartifact exists\n</evidence>\n<approved/>", model: "test/model", thinkingLevel: "off", goalRevision: request.goalRevision,
    toolCalls: [{ name: "read", argsPrefix: "artifact", finishedAt: Date.now() - 1000 }], challenge: "confirmed", ...options.extra,
  };
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
  if (options.result !== false) fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
  return { dir, request, result };
}
function events(cwd: string) {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function boot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `completed-result-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120); return ctx;
}
afterEach(() => { __testOnlyResetAuditorSurface(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

for (const verdict of ["approved", "disapproved"] as const) {
  test(`legacy parked claim without phase consumes saved ${verdict} on the first restore`, async () => {
    const cwd = tmpCwd(), g = goal();
    g.status = "paused";
    delete g.pendingCompletion!.phase;
    seedState(cwd, { goal: g });
    job(cwd, g, { output: `<evidence>\nartifact inspected\n</evidence>\n<${verdict}/>` });
    const pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
    try {
      assert.equal(readState(cwd).goal?.pendingCompletion, undefined);
      assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1);
      assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
      if (verdict === "approved") assert.ok(fs.existsSync(archivedGoalPath(cwd, g.id)));
      else assert.equal(readState(cwd).goal?.auditHistory?.at(-1)?.disapproved, true);
    } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
  });
}

for (const verdict of ["approved", "disapproved", "missing"] as const) {
  test(`healthy host heartbeat reconciles an unarmed orphan: ${verdict}`, async () => {
    const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
    const g = goal(); seedState(cwd, { goal: g });
    if (verdict !== "missing") job(cwd, g, { output: `<evidence>\nartifact exists\n</evidence>\n<${verdict}/>` });
    __testOnlyLoadState(cwd);
    // Fresh empty host: no in-flight poller and no recovery-armed flag.
    __testOnlySetLastActivityAt(Date.now() - 100_000);
    try {
      __testOnlyHeartbeatTick(); await tick(120);
      const restored = readState(cwd).goal;
      assert.notEqual(restored?.status, "auditing", "an unowned audit cannot remain auditing forever");
      assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0, "heartbeat never launches another worker");
      if (verdict === "approved") {
        assert.ok(fs.existsSync(archivedGoalPath(cwd, g.id)));
      } else if (verdict === "disapproved") {
        assert.equal(restored?.auditHistory?.at(-1)?.disapproved, true);
      } else {
        assert.equal(restored?.pendingCompletion?.phase, "recovery-pending");
        assert.equal(restored?.pauseKind, "blocked");
      }
      __testOnlyHeartbeatTick(); await tick(20);
      assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, verdict === "missing" ? 0 : 1);
    } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
  });
}

for (const guard of ["in-flight", "recent", "frozen", "cold-held"] as const) {
  test(`heartbeat orphan recovery respects ${guard}`, async () => {
    const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
    const g = goal();
    const savedState = { goal: g, ...(guard === "frozen" ? { supervisorPausedAt: Date.now() } : {}),
      ...(guard === "cold-held" ? { loadHoldAt: Date.now() } : {}) };
    seedState(cwd, savedState);
    const saved = job(cwd, g, { output: "artifact missing\n<disapproved/>", ...(guard === "in-flight" ? { result: false } : {}) });
    __testOnlyLoadState(cwd);
    __testOnlySetLastActivityAt(guard === "recent" ? Date.now() : Date.now() - 100_000);
    // Use the existing runtime ownership slot to model a live poller.
    const runtime = globalThis as typeof globalThis & { completionAuditInFlight: boolean };
    runtime.completionAuditInFlight = guard === "in-flight";
    // A live in-flight worker owns a worker-role lock for a running process;
    // without it the claim is workerless and heartbeat must recover it.
    const stub = guard === "in-flight" ? spawnWorkerStub(cwd, saved.dir) : null;
    if (stub?.child.pid) writeWorkerLock(saved.dir, "saved-claim-physical", stub.child.pid);
    pi.sent.length = 0;
    try {
      if (guard === "in-flight") assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), true, "the stub models a live worker");
      __testOnlyHeartbeatTick(); await tick(120);
      const restored = readState(cwd).goal;
      if (guard === "cold-held") {
        assert.equal(restored?.auditHistory?.at(-1)?.disapproved, true);
        assert.equal(restored?.status, "paused", "reconcile evidence without permission to execute");
        assert.equal(pi.sent.length, 0);
      } else {
        assert.equal(restored?.status, "auditing");
        assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 0);
      }
    } finally {
      stub?.cleanup();
      runtime.completionAuditInFlight = false;
      await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    }
  });
}

// Real detached worker publishes its result; deliberately omit the parent
// application, then restore from durable state in a new session.
for (const verdict of ["approved", "disapproved"] as const) {
  test(`finished real worker, lost parent: restart applies ${verdict} exactly once without re-auditing`, async () => {
    const cwd = tmpCwd(), g = goal(); seedState(cwd, { goal: g });
    const fakePi = path.join(cwd, "fake-pi.mjs");
    fs.writeFileSync(fakePi, `#!/usr/bin/env node\nlet input=''; process.stdin.on('data',chunk=>{ input+=chunk; if(!input.includes('\\n'))return; const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n'); emit({type:'tool_execution_start',toolName:'read',toolCallId:'one',args:{path:'artifact'}}); emit({type:'tool_execution_end',toolName:'read',toolCallId:'one'}); emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'<evidence>\\nartifact exists\\n</evidence>\\n<${verdict}/>'}}); emit({type:'agent_settled'}); });`, { mode: 0o700 });
    const snapshots: Array<{ round?: 1 | 2; phase: string }> = [];
    const result = await runDetachedGoalCompletionAuditor({ cwd, goal: g, model: "test/model", thinkingLevel: "off",
      completionSummary: g.pendingCompletion!.completionSummary, verificationSummary: g.pendingCompletion!.verificationSummary,
      onProgress: progress => snapshots.push(progress),
      runtime: { piBinary: fakePi, logicalAttemptId: "saved-claim", attemptId: () => "saved-claim-real-worker", pollIntervalMs: 10 },
    });
    assert.equal(result[verdict], true, result.error ?? "worker verdict");
    if (verdict === "approved") assert.ok(snapshots.some(p => p.round === 2), "real worker round identity survives transport snapshots");
    assert.ok(readCompletedCompletionAudit(cwd, g), "the result is durable before any parent applies it");
    const pi = new MockPi(); activate(pi.api); let ctx = await boot(pi, cwd);
    try {
      assert.equal(readState(cwd).goal?.pendingCompletion, undefined, "the orphaned claim is consumed");
      assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1);
      assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0, "no replacement worker launches");
      if (verdict === "approved") assert.ok(fs.existsSync(archivedGoalPath(cwd, g.id)), `approval passes the normal archive settlement: ${JSON.stringify({ state: readState(cwd), notices: ctx.ui.notifies })}`);
      else {
        assert.equal(readState(cwd).goal?.auditHistory?.at(-1)?.disapproved, true, "disapproval reaches the normal history/rework path");
        assert.equal(readState(cwd).goal?.status, "paused", "cold restore holds rework for consent");
        assert.equal(pi.sent.length, 0, "recovering a verdict is not permission to dispatch executor work");
      }
      await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
      ctx = await boot(pi, cwd);
      assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1, "repeated restore cannot replay the verdict");
    } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
  });
}

for (const surface of ["manual", "agent"] as const) {
test(`${surface} resume consumes a completed parked claim instead of launching another auditor`, async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const g = goal(); g.status = "paused"; g.pendingCompletion!.phase = "recovery-pending";
  seedState(cwd, { goal: g }); job(cwd, g); __testOnlyLoadState(cwd);
  try {
    if (surface === "manual") await pi.command("goal", "resume", ctx);
    else {
      const response = await pi.runTool("resume_goal", { reason: "continue the stored claim" }, ctx);
      assert.doesNotMatch(response.content[0]!.text, /auditor is now running/);
    }
    await tick(120);
    assert.ok(fs.existsSync(archivedGoalPath(cwd, g.id)));
    assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1);
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
}

test("silent file-backed successor applies a finished verdict from the dead generation", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const g = goal(); seedState(cwd, { goal: g }); job(cwd, g); __testOnlyLoadState(cwd);
  invalidateHostSession(pi, ctx); __testOnlyHeartbeatTick(); await tick(120);
  pi.sendMessageError = null; pi.sessionNameError = null;
  const successor = makeMockCtx(cwd, { sessionManager: {
    getSessionFile: () => path.join(cwd, "successor-session.jsonl"), getSessionId: () => "completed-audit-successor",
  } });
  try {
    await pi.runTool("list_add", { items: ["follow-up after handoff"] }, successor); await tick(120);
    assert.ok(fs.existsSync(archivedGoalPath(cwd, g.id)), "the replacement settles the old worker's approval");
    assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1);
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, successor); }
});

test("legacy completed jobs bind the original goal, contract, and claim without new metadata", () => {
  const cwd = tmpCwd(), g = goal(); job(cwd, g, { legacy: true, output: "missing artifact\n<disapproved/>" });
  assert.equal(readCompletedCompletionAudit(cwd, g)?.result.disapproved, true);
  assert.equal(readCompletedCompletionAudit(cwd, { ...g, objective: "another objective" }), null);
  assert.equal(readCompletedCompletionAudit(cwd, { ...g, pendingCompletion: { ...g.pendingCompletion!, completionSummary: "different claim" } }), null);
});

test("newer unfinished candidate prevents replay of an older completed result", () => {
  const cwd = tmpCwd(), g = goal(); job(cwd, g, { at: Date.now() - 3000 });
  job(cwd, g, { name: "saved-claim-newer", at: Date.now() - 1000, result: false });
  assert.equal(readCompletedCompletionAudit(cwd, g), null);
});

for (const change of ["revision", "claim", "structured-claim", "hash", "result-identity", "cancelled-tool", "strict-challenge", "unsupported-tool"] as const) {
  test(`saved result refuses unsafe recovery: ${change}`, () => {
    const cwd = tmpCwd(); let g = goal(); const saved = job(cwd, g);
    if (change === "revision") g = { ...g, revision: 1 };
    if (change === "claim") g = { ...g, pendingCompletion: { ...g.pendingCompletion!, verificationSummary: "changed" } };
    if (change === "structured-claim") g = { ...g, pendingCompletion: { ...g.pendingCompletion!, leftOut: "different residual" } };
    if (change === "hash") fs.writeFileSync(path.join(saved.dir, "request.json"), JSON.stringify({ ...saved.request, model: "other/model" }));
    if (change === "result-identity") saved.result.attemptId = "another-job";
    if (change === "cancelled-tool") Object.assign(saved.result, { verificationIncomplete: true });
    if (change === "strict-challenge") saved.result.challenge = "skipped: failure";
    if (change === "unsupported-tool") saved.result.toolCalls[0]!.name = "write";
    fs.writeFileSync(path.join(saved.dir, "result.json"), JSON.stringify(saved.result));
    assert.equal(readCompletedCompletionAudit(cwd, g, change === "strict-challenge"), null);
  });
}

test("corrupt final progress identity refuses recovery without consuming the claim", () => {
  const cwd = tmpCwd(), g = goal(), saved = job(cwd, g);
  fs.writeFileSync(path.join(saved.dir, "progress.json"), JSON.stringify({ protocolVersion: 1, attemptId: saved.request.attemptId, requestHash: "wrong-hash" }));
  assert.equal(readCompletedCompletionAudit(cwd, g), null);
  assert.equal(g.pendingCompletion?.attemptId, "saved-claim");
});

test("saved approval still enforces the audit-tool floor and regression shield", () => {
  const cwd = tmpCwd(), g = goal(); const saved = job(cwd, g, { extra: { toolCalls: [] } });
  assert.equal(readCompletedCompletionAudit(cwd, g)?.result.approved, false);
  fs.writeFileSync(path.join(saved.dir, "result.json"), JSON.stringify({ ...saved.result, toolCalls: [{ name: "read", argsPrefix: "artifact", finishedAt: 1 }], output: "looks good\n<approved/>" }));
  assert.equal(readCompletedCompletionAudit(cwd, g)?.result.regressionShieldPassed, false);
});

test("second audit pass remains visible through thinking, tools, and report generation", () => {
  const g = goal(), state = { goal: g } as State, now = Date.now();
  for (const phase of ["thinking", "tool_executing", "producing_report", "running"] as const) {
    const progress = { round: 2 as const, phase, elapsedMs: 2000, lastActivityAt: now, toolCalls: [], recentOutput: [], ...(phase === "tool_executing" ? { currentTool: "read" } : {}) };
    assert.match((buildWidgetLines(state, progress, now) ?? []).join("\n"), /second audit pass/);
    assert.match(buildStatusText(state, progress, now) ?? "", /second audit pass/);
  }
});

test("days-old auditing orphan with a saved verdict recovers via heartbeat (SEO field case)", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const g = goal();
  // Field 2026-10-02: auditing/running since Sept 25, worker and owner PIDs
  // dead, completed disapproved result on disk. Age must not block recovery.
  const weekAgo = Date.now() - 7 * 86_400_000;
  g.pendingCompletion = { ...g.pendingCompletion!, at: new Date(weekAgo).toISOString(), lastActivityAt: new Date(weekAgo).toISOString() };
  seedState(cwd, { goal: g });
  job(cwd, g, { at: weekAgo + 482_132, output: "<evidence>\nartifact inspected\n</evidence>\n<disapproved/>" });
  __testOnlyLoadState(cwd);
  __testOnlySetLastActivityAt(weekAgo);
  try {
    __testOnlyHeartbeatTick(); await tick(120);
    const restored = readState(cwd).goal;
    assert.notEqual(restored?.status, "auditing", "a week-old orphan cannot remain auditing");
    assert.equal(restored?.auditHistory?.at(-1)?.disapproved, true, "saved disapproval reaches history");
    assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1);
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0, "heartbeat never launches another worker");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("workerless in-flight claim with a saved verdict reconciles without launching", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const g = goal(); seedState(cwd, { goal: g });
  // Finished worker transcript on disk, but the parent-side poller is gone:
  // in-flight is latched with no live worker behind it.
  job(cwd, g, { output: "<evidence>\nartifact exists\n</evidence>\n<approved/>" });
  __testOnlyLoadState(cwd);
  __testOnlySetLastActivityAt(Date.now() - 100_000);
  const runtime = globalThis as typeof globalThis & { completionAuditInFlight: boolean };
  runtime.completionAuditInFlight = true;
  try {
    assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), false, "a finished transcript is not a live worker");
    __testOnlyHeartbeatTick(); await tick(120);
    assert.ok(fs.existsSync(archivedGoalPath(cwd, g.id)), "saved approval settles through durable archive");
    assert.equal(events(cwd).filter(e => e.type === "audit_completed_result_recovered").length, 1);
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
  } finally {
    runtime.completionAuditInFlight = false;
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("S5: workerless in-flight claim parks under the stale latch via stale-latch-workerless", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const g = goal();
  g.pendingCompletion = { ...g.pendingCompletion!, phase: "starting" };
  seedState(cwd, { goal: g });
  // No job dir: the launch never created one — workerless. The stale latch
  // must not mask that: the park still lands, attributed to the latch.
  __testOnlyLoadState(cwd);
  __testOnlySetLastActivityAt(Date.now() - 100_000);
  invalidateHostSession(pi, ctx);
  const runtime = globalThis as typeof globalThis & { completionAuditInFlight: boolean };
  runtime.completionAuditInFlight = true;
  try {
    __testOnlyHeartbeatTick(); await tick(120);
    const restored = readState(cwd).goal;
    assert.equal(restored?.status, "paused");
    assert.equal(restored?.pendingCompletion?.phase, "recovery-pending");
    assert.ok(events(cwd).some(e => e.type === "stranded_audit_recovered" && (e.value as { via?: string }).via === "stale-latch-workerless"));
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
  } finally {
    runtime.completionAuditInFlight = false;
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("workerless in-flight claim without a verdict parks via workerless-in-flight", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  // Field 2026-10-02 (clean-web): auditing/starting, in-flight latched, but
  // the launch never created a job dir — no worker, no result, no error.
  const g = goal();
  g.pendingCompletion = { ...g.pendingCompletion!, phase: "starting" };
  seedState(cwd, { goal: g });
  __testOnlyLoadState(cwd);
  __testOnlySetLastActivityAt(Date.now() - 100_000);
  const runtime = globalThis as typeof globalThis & { completionAuditInFlight: boolean };
  runtime.completionAuditInFlight = true;
  try {
    assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), false, "no job dir means no worker");
    __testOnlyHeartbeatTick(); await tick(120);
    const restored = readState(cwd).goal;
    assert.equal(restored?.status, "paused");
    assert.equal(restored?.pendingCompletion?.phase, "recovery-pending");
    assert.ok(events(cwd).some(e => e.type === "stranded_audit_recovered" && (e.value as { via?: string }).via === "workerless-in-flight"));
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
  } finally {
    runtime.completionAuditInFlight = false;
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("auditorWorkerLiveForAttempt: only a matching live worker counts", () => {
  const cwd = tmpCwd(), g = goal();
  assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), false, "no job dirs, no worker");
  const saved = job(cwd, g, { result: false });
  assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), false, "a lockless job dir is not a live worker");
  fs.writeFileSync(path.join(saved.dir, "lock"), JSON.stringify({ protocolVersion: 1, attemptId: "saved-claim-physical", pid: process.pid, role: "parent" }));
  assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), false, "a parent-role lock is not a worker");
  writeWorkerLock(saved.dir, "saved-claim-physical", 999_999_999);
  assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), false, "a dead pid is not a live worker");
  const stub = spawnWorkerStub(cwd, saved.dir);
  try {
    if (stub.child.pid) writeWorkerLock(saved.dir, "saved-claim-physical", stub.child.pid);
    assert.equal(auditorWorkerLiveForAttempt(cwd, "saved-claim"), true, "a matching live process is a live worker");
    assert.equal(auditorWorkerLiveForAttempt(cwd, "other-claim"), false, "other attempts do not match");
  } finally { stub.cleanup(); }
});

test("unreadable saved transcript returns null but ledgers the reason", () => {
  const cwd = tmpCwd(), g = goal();
  seedState(cwd, { goal: g });
  const saved = job(cwd, g);
  fs.writeFileSync(path.join(saved.dir, "result.json"), "{truncated");
  assert.equal(readCompletedCompletionAudit(cwd, g), null);
  const hit = events(cwd).filter(e => e.type === "completed_audit_recovery_unreadable");
  assert.equal(hit.length, 1);
  assert.equal((hit[0].value as { logicalAttemptId?: string }).logicalAttemptId, "saved-claim");
});

test("workerProcessMatches darwin branch reads identity via ps", () => {
  // The darwin branch shells to `ps -o command=`, which also exists on
  // Linux, so inject the platform to exercise it anywhere.
  const cwd = tmpCwd(), g = goal();
  const saved = job(cwd, g, { result: false });
  assert.equal(workerProcessMatches(cwd, 999_999_999, saved.dir, "darwin"), false, "dead pid fails closed");
  const stub = spawnWorkerStub(cwd, saved.dir);
  try {
    if (stub.child.pid) writeWorkerLock(saved.dir, "saved-claim-physical", stub.child.pid);
    assert.equal(workerProcessMatches(cwd, stub.child.pid!, saved.dir, "darwin"), true, "live stub matches via ps cmdline");
    const other = job(cwd, g, { name: "saved-claim-other-physical", result: false });
    if (stub.child.pid) writeWorkerLock(other.dir, "saved-claim-other-physical", stub.child.pid);
    assert.equal(workerProcessMatches(cwd, stub.child.pid!, other.dir, "darwin"), false, "same pid, other job dir does not match");
  } finally { stub.cleanup(); }
});

test("auditing claim stuck in starting with no worker parks for recovery via heartbeat", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  const g = goal();
  // Crash inside the launch window: phase starting, no lastActivityAt (no
  // worker event ever arrived), no job dir, no in-flight owner.
  g.pendingCompletion = { ...g.pendingCompletion!, phase: "starting", lastActivityAt: undefined };
  seedState(cwd, { goal: g });
  __testOnlyLoadState(cwd);
  __testOnlySetLastActivityAt(Date.now() - 100_000);
  try {
    __testOnlyHeartbeatTick(); await tick(120);
    const restored = readState(cwd).goal;
    assert.equal(restored?.status, "paused", "a workerless starting claim parks");
    assert.equal(restored?.pendingCompletion?.phase, "recovery-pending");
    assert.equal(restored?.pauseKind, "blocked");
    assert.equal(events(cwd).filter(e => e.type === "audit_started").length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
