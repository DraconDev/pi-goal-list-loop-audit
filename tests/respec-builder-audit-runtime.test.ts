import { getRespecAuditLive, respecAuditLiveScope } from "../extensions/respec-builder-ui.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerRespecBuilderTools, runRespecBuilderAudit, respecProjectArchivePath, cancelRespecBuilderAudit, replayRespecCompletionSummary, __testOnlyRespecAuditorRuntime, respecBuilderAuditInFlight } from "../extensions/respec-builder-runtime.js";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyHeartbeatTick } from "../extensions/goal-heartbeat.js";
import { __testOnlySetLastActivityAt, __testOnlySetLastRealActivityAt } from "../extensions/loops/goal-ui.js";
import { clearLoopTimer, scheduleLoopTick, __testOnlyLoopInfrastructureScheduler } from "../extensions/goal-loop.js";
import { saveSettings } from "../extensions/goal-settings.js";
import { cleanupDeadAuditJobs } from "../extensions/goal-loop-auditor-process.js";
import { createRespecBuilder, adoptRespecRequirements, planRespecIncrement, claimRespecTask, beginRespecAudit } from "../extensions/respec-builder.js";
import { state, replaceState, persistStateLine } from "../extensions/goal-state.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, tmpCwd, makeMockCtx } from "./harness/mock-pi.js";
import { hangDeadlineMs, untilMs } from "./harness/host-budget.js";

const VERDICT_HELPER = path.join(path.dirname(new URL(import.meta.url).pathname), "harness", "fake-auditor-verdict.mjs");
const worker = `
import { readFile, writeFile, rename } from "node:fs/promises";
import { readVerdictKey, signVerdict } from ${JSON.stringify(VERDICT_HELPER)};
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const verdictKey = await readVerdictKey();
const req = JSON.parse(await readFile(dir + "/request.json", "utf8"));
async function atomic(file, data) { await writeFile(file + ".tmp", JSON.stringify(data)); await rename(file + ".tmp", file); }
await atomic(dir + "/progress.json", { protocolVersion: 1, attemptId: req.attemptId, requestHash: req.requestHash, phase: "running", elapsedMs: 1, lastActivityAt: Date.now(), toolCalls: [], recentOutput: [], ...(process.env.TOOL_WAIT ? { currentTool: "bash", currentToolStartedAt: Date.now(), toolTimeoutMs: 300000, currentToolTimeoutMs: 1200000, round: 2 } : {}) });
if (process.env.RESULT_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.RESULT_DELAY)));
const output = process.env.INCOMPLETE_EVIDENCE ? "Looks good\\n<approved/>" : (process.env.FAIL_ALL || process.env.FAIL_PRIMARY && req.model.includes("primary")) ? "no verdict from primary" : process.env.NEEDS_WORK ? "<evidence>\\nInvalid credentials accepted\\n</evidence>\\n<disapproved/>" : "<evidence>\\nartifact exists\\n</evidence>\\n<approved/>";
await atomic(dir + "/result.json", signVerdict({ protocolVersion: 1, attemptId: req.attemptId, requestHash: req.requestHash, goalRevision: req.goalRevision, ok: true, output, model: req.model, thinkingLevel: req.thinkingLevel, challenge: "confirmed", toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] }, verdictKey));
`;

function fixture(env: Record<string, string> = {}) {
  const cwd = tmpCwd(), pi = new MockPi(), ctx = makeMockCtx(cwd) as unknown as ExtensionContext;
  const file = path.join(cwd, "bounded-auditor-worker.mjs"); fs.writeFileSync(file, worker);
  const drafted = adoptRespecRequirements(createRespecBuilder("Build an artifact"), [{ id: "artifact", text: "Artifact", acceptance: "artifact exists" }]);
  const building = planRespecIncrement(drafted, [{ id: "task", text: "Build artifact", requirementIds: ["artifact"] }]);
  const builder = beginRespecAudit(claimRespecTask(building, "task"), "aabbccdd-1111-2222-3333-444455556666", "Artifact implemented");
  const original = { ...state };
  const startedAt = new Date().toISOString();
  replaceState({ goal: null, list: [], loop: { target: builder.vision, builder, active: true, startedAt, iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } });
  persistStateLine(cwd, state);
  const summaries: string[] = [], progress: string[] = [];
  const observations: NonNullable<ReturnType<typeof getRespecAuditLive>>[] = [];
  let wakes = 0, finishes = 0, owned = true, resolutions = 0;
  registerRespecBuilderTools(pi.api, { context: () => owned ? ctx : null, persist: () => env.PERSIST_FAIL ? false : persistStateLine(cwd, state), wake: () => { wakes++; }, finished: () => { finishes++; }, resolveModel: () => { resolutions++; return env.FAIL_PRIMARY ? { model: "test/primary", fallbackModels: [{ model: "test/backup", via: "configured fallback" }] } : { model: "test/provider-model" }; }, wrapTool: tool => tool,
    completed: (_ctx, _id, summary) => { if (env.SUMMARY_FAIL) throw new Error("Receipt failed"); summaries.push(summary); return true; },
    refresh: () => { const value = state.loop?.builder && getRespecAuditLive(state.loop.builder, respecAuditLiveScope(cwd, startedAt)); if (value) { progress.push(value.phase); observations.push({ ...value }); } },
    auditSleep: async () => { if (env.FREEZE_RETRY) { replaceState({ ...state, supervisorPausedAt: Date.now() }); persistStateLine(cwd, state); } },
    auditRuntime: { command: process.execPath, workerPath: file, homeDir: cwd, pollIntervalMs: 10, heartbeatNoProgressMs: hangDeadlineMs(5000), firstEventTimeoutMs: hangDeadlineMs(5000), env } });
  return { cwd, ctx, startedAt, original, builder, file, counts: () => ({ wakes, finishes }), summaries, progress, observations, disown: () => { owned = false; }, resolutions: () => resolutions };
}




/** The builder phase advances when the audit's verdict lands, which is after
 * the dispatch returns. Wait for the phase instead of racing it: on a loaded
 * host the worker needs longer to settle, and the assertion would then read
 * a perfectly healthy "auditing". */
async function waitForPhase(cwd: string, phase: string, timeoutMs = 20000): Promise<void> {
  const deadline = untilMs(timeoutMs);
  while (readState(cwd).loop?.builder?.phase !== phase) {
    if (Date.now() > deadline) throw new Error(`builder phase never reached ${phase}: ${JSON.stringify(readState(cwd).loop?.builder?.phase)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a stale audit wake does not resolve a model or launch a worker", async () => {
  const f = fixture();
  try {
    f.disown();
    await runRespecBuilderAudit(f.ctx);
    assert.equal(f.resolutions(), 0);
    assert.equal(fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), false);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
  } finally { replaceState(f.original); }
});

test("a time bound cancels an in-flight worker and retains unfinished requirements", async () => {
  const f = fixture({ RESULT_DELAY: "10000" });
  try {
    replaceState({ ...state, loop: { ...state.loop!, startedAt: new Date().toISOString(), timeLimitHours: 1 } });
    persistStateLine(f.cwd, state);
    assert.equal(respecBuilderAuditInFlight(f.cwd), false, "a saved claim is not a running dispatch");
    const pending = runRespecBuilderAudit(f.ctx);
    assert.equal(respecBuilderAuditInFlight(f.cwd), true);
    assert.equal(respecBuilderAuditInFlight(f.cwd + '-other'), false, "dispatch ownership includes the project root");
    const dispatched = state.loop!;
    replaceState({ ...state, loop: { ...dispatched, builder: { ...dispatched.builder!, audit: { ...dispatched.builder!.audit!, attemptId: "replacement-claim" } } } });
    assert.equal(respecBuilderAuditInFlight(f.cwd), false, "an old dispatch cannot protect a replacement claim");
    replaceState({ ...state, loop: dispatched });
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs");
    const deadline = untilMs(20000);
    while (!fs.existsSync(jobs) || !fs.readdirSync(jobs).some(name => fs.existsSync(path.join(jobs, name, "progress.json")))) {
      if (Date.now() > deadline) throw new Error("Worker did not publish progress");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fs.readdirSync(jobs).length > 0, "an actual worker was dispatched");
    // Exhaust the window only after real worker activity, independently of
    // provider/setup latency. The progress hook must contain the active job.
    replaceState({ ...state, loop: { ...state.loop!, timeLimitHours: 0 } });
    persistStateLine(f.cwd, state);
    await pending;
    assert.equal(respecBuilderAuditInFlight(f.cwd), false, "finished cancellation releases heartbeat protection");
    const saved = readState(f.cwd).loop!;
    assert.equal(saved.active, false);
    assert.match(saved.stopReason!, /time bound reached/);
    assert.equal(saved.builder!.phase, "auditing");
    assert.equal(saved.builder!.requirements[0]!.status, "open");
    assert.ok(fs.readdirSync(jobs).every(name => !fs.existsSync(path.join(jobs, name, "result.json"))));
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 0 });
  } finally { replaceState(f.original); }
});

test("real detached protocol approval archives the intended project before terminal handoff", async () => {
  const f = fixture();
  try {
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete", JSON.stringify(readState(f.cwd).loop));
    assert.equal(readState(f.cwd).loop!.active, false);
    const archive = JSON.parse(fs.readFileSync(respecProjectArchivePath(f.cwd, f.startedAt, f.builder.revision), "utf8"));
    assert.equal(archive.builder.requirements[0].status, "verified");
    assert.equal(archive.completionSummary, readState(f.cwd).loop!.completionSummary);
    assert.match(f.summaries[0]!, /What Changed/);
    assert.match(f.summaries[0]!, /artifact exists/);
    assert.ok(readState(f.cwd).loop!.builder!.summaryDeliveredAt);
    assert.ok(f.progress.includes("running"));
    assert.ok(f.observations.filter(p => p.phase === "starting").every(p => p.lastActivityAt === undefined), "parent startup is not worker activity");
    assert.ok(f.observations.some(p => p.phase === "running" && p.lastActivityAt !== undefined));
    assert.equal(getRespecAuditLive(f.builder, respecAuditLiveScope(f.cwd, f.startedAt)), undefined);
    assert.match(archive.builder.requirements[0].evidence.report, /artifact exists/);
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 1 });
  } finally { replaceState(f.original); }
});

test("real detached disapproval carries findings into a durable unfinished next cycle", async () => {
  const f = fixture({ NEEDS_WORK: "1" });
  try {
    await runRespecBuilderAudit(f.ctx);
    const saved = readState(f.cwd).loop!.builder!;
    assert.equal(saved.phase, "replanning", JSON.stringify(readState(f.cwd).loop));
    assert.equal(saved.requirements[0]!.status, "open");
    assert.match(saved.feedback.at(-1)!, /Invalid credentials/);
    assert.equal(saved.history!.at(-1)!.outcome, "needs-work");
    assert.deepEqual(f.counts(), { wakes: 1, finishes: 0 });
  } finally { replaceState(f.original); }
});

test("a semantic approval rejected by the regression shield reports needs work", async () => {
  const f = fixture({ INCOMPLETE_EVIDENCE: "1" });
  try {
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "replanning");
    assert.equal(readState(f.cwd).loop!.builder!.requirements[0]!.status, "open");
    const notifications = (f.ctx.ui as unknown as ReturnType<typeof makeMockCtx>["ui"]).notifies;
    assert.ok(notifications.some(n => /Increment needs work/.test(n.message) && n.type === "warning"));
    assert.ok(notifications.every(n => !/Increment verified/.test(n.message)));
    assert.deepEqual(f.counts(), { wakes: 1, finishes: 0 });
  } finally { replaceState(f.original); }
});

test("completed job is recovered after reloading an unsettled claim without another spawn", async () => {
  const f = fixture();
  try {
    await runRespecBuilderAudit(f.ctx);
    const jobs = fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs"));
    assert.equal(jobs.length, 1);
    replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined, builder: JSON.parse(JSON.stringify(f.builder)) } });
    persistStateLine(f.cwd, state);
    cleanupDeadAuditJobs(f.cwd, 0);
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), jobs, "startup-style cleanup retains the unsettled approval before recovery");
    fs.unlinkSync(f.file); // A new spawn would fail: only saved evidence can approve.
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete", fs.readFileSync(path.join(f.cwd, ".pi-glla", "active.jsonl"), "utf8"));
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), jobs);
  } finally { replaceState(f.original); }
});

test("pausing during an actual worker run prevents late approval from settling the project", async () => {
  const f = fixture({ RESULT_DELAY: "5000" });
  try {
    const pending = runRespecBuilderAudit(f.ctx);
    const deadline = untilMs(5000);
    while (!fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")) || !fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")).some(name => fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs", name, "progress.json")))) {
      if (Date.now() > deadline) throw new Error("Worker did not publish progress");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    replaceState({ ...state, loop: { ...state.loop!, active: false, stopReason: "paused by user" } });
    persistStateLine(f.cwd, state);
    cancelRespecBuilderAudit(f.cwd, f.startedAt);
    await pending;
    assert.equal(readState(f.cwd).loop!.active, false);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.equal(readState(f.cwd).loop!.builder!.requirements[0]!.status, "open");
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 0 });
    assert.ok(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")).every(name => !fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs", name, "result.json"))), "the paused worker is cancelled before it publishes approval");
  } finally { replaceState(f.original); }
});

test("archive failure preserves approval evidence for settlement retry instead of launching another audit", async () => {
  const f = fixture();
  try {
    const archivePath = respecProjectArchivePath(f.cwd, f.startedAt, f.builder.revision);
    fs.mkdirSync(archivePath, { recursive: true });
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.equal(readState(f.cwd).loop!.active, true);
    assert.ok(readState(f.cwd).loop!.builder!.audit!.infrastructureRetry);
    assert.deepEqual(f.counts(), { wakes: 1, finishes: 0 });
    const jobs = fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs"));
    fs.rmSync(archivePath, { recursive: true }); fs.unlinkSync(f.file);
    const restoreClock = __testOnlyRespecAuditorRuntime({ auditNow: () => state.loop!.builder!.audit!.infrastructureRetry!.nextRetryAt });
    replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined } });
    persistStateLine(f.cwd, state);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), jobs);
    assert.deepEqual(f.counts(), { wakes: 1, finishes: 1 });
    restoreClock();
  } finally { replaceState(f.original); }
});

test("concurrent wake paths dispatch only one worker for the exact durable claim", async () => {
  const f = fixture({ RESULT_DELAY: "100" });
  try {
    await Promise.all([runRespecBuilderAudit(f.ctx), runRespecBuilderAudit(f.ctx)]);
    assert.equal(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")).length, 1);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 1 });
  } finally { replaceState(f.original); }
});

test("respec uses the shared bounded retry/fallback policy and journals its candidate cursor", async () => {
  const f = fixture({ FAIL_PRIMARY: "1" });
  try {
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.equal(readState(f.cwd).loop!.builder!.requirements[0]!.evidence!.model, "test/backup");
    const requests = fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")).map(name => JSON.parse(fs.readFileSync(path.join(f.cwd, ".pi-glla", "audit-jobs", name, "request.json"), "utf8")));
    assert.equal(requests.filter(request => request.model === "test/primary").length, 2, "primary gets one bounded retry");
    assert.equal(requests.filter(request => request.model === "test/backup").length, 1);
    const journal = fs.readFileSync(path.join(f.cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(journal, /candidateRef.*test\/backup/);
    assert.match(journal, /attemptedRefs.*test\/primary/);
    assert.ok(f.progress.includes("retrying"));
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 1 });
  } finally { replaceState(f.original); }
});

test("an exhausted token bound holds the project before spawning an auditor or claiming completion", async () => {
  const f = fixture();
  try {
    replaceState({ ...state, loop: { ...state.loop!, tokenBudget: 10, tokensUsed: 10 } });
    persistStateLine(f.cwd, state);
    await runRespecBuilderAudit(f.ctx);
    const saved = readState(f.cwd).loop!;
    assert.equal(saved.active, false);
    assert.match(saved.stopReason!, /token budget exhausted/);
    assert.equal(saved.builder!.phase, "auditing");
    assert.equal(saved.builder!.requirements[0]!.status, "open");
    assert.equal(fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), false);
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 0 });
  } finally { replaceState(f.original); }
});

for (const resumeHeld of [false, true]) test(`actual project lifecycle reaches detached verification through ${resumeHeld ? "/glla resume of a stalled audit" : "agent_end"}`, async () => {
  const cwd = tmpCwd(), pi = new MockPi(), ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-full-lifecycle", getBranch: () => [], getSessionFile: () => undefined } });
  const previous = { ...state };
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  activate(pi.api); saveSettings("global", cwd, { autoAcceptDrafts: false });
  ctx.ui.customImpl = async () => "Yes";
  const file = path.join(cwd, "bounded-auditor-worker.mjs"); fs.writeFileSync(file, worker);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const restore = __testOnlyRespecAuditorRuntime({ resolveModel: () => ({ model: "test/provider-model" }), auditSleep: async () => {},
    auditRuntime: { command: process.execPath, workerPath: file, homeDir: cwd, pollIntervalMs: 10, heartbeatNoProgressMs: hangDeadlineMs(5000), firstEventTimeoutMs: hangDeadlineMs(5000), env: { RESULT_DELAY: "1500" } } });
  try {
    await pi.command("loop", "respec build the artifact", ctx); clearLoopTimer();
    await pi.runTool("propose_project_requirements", { requirements: [{ id: "artifact", text: "Artifact", acceptance: "artifact exists" }] }, ctx);
    await pi.runTool("plan_project_increment", { tasks: [{ id: "task", text: "Build artifact", requirementIds: ["artifact"] }] }, ctx);
    await pi.runTool("claim_project_task", { id: "task" }, ctx);
    await pi.runTool("audit_project_increment", { claim: "Artifact implemented" }, ctx);
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.status, "open");
    if (resumeHeld) {
      const retainedAttempt = state.loop!.builder!.audit!.attemptId;
      replaceState({ ...state, loop: { ...state.loop!, active: false, stopReason: "stalled: 5 continuation refires landed no turn" } });
      persistStateLine(cwd, state);
      await pi.command("glla", "resume", ctx);
      assert.equal(readState(cwd).loop!.active, true, "broad resume must recognise the stalled audit hold");
      assert.equal(readState(cwd).loop!.builder!.audit!.attemptId, retainedAttempt, "resume preserves the claim identity");
      const dispatchDeadline = untilMs(3000);
      while (!respecBuilderAuditInFlight(cwd)) {
        if (Date.now() > dispatchDeadline) throw new Error("Resume did not dispatch the retained audit");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } else {
      await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Increment ready for independent verification." }] }] }, ctx);
    }
    assert.equal(respecBuilderAuditInFlight(cwd), true, "production lifecycle dispatched the increment auditor");
    // Freeport/Junk Runner reproduction: the detached worker owns the wait
    // while the main session looks idle. Exercise the real heartbeat beyond
    // its five-refire threshold, rather than only checking source wiring.
    for (let i = 0; i < 6; i++) {
      const quietSince = Date.now() - 60 * 60_000;
      __testOnlySetLastActivityAt(quietSince);
      __testOnlySetLastRealActivityAt(quietSince);
      __testOnlyHeartbeatTick();
      assert.equal(state.loop!.active, true, "a dispatched auditor must not be parked as a missing main turn");
    }
    const journal = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(journal, /"type":"(?:heartbeat_refire|stall_escalated)"/);
    let compacts = 0;
    ctx.getContextUsage = () => ({ tokens: 315_000, contextWindow: 1_000_000, percent: 31.5 });
    ctx.compact = () => { compacts++; };
    await pi.fire("agent_settled", {}, ctx);
    assert.equal(compacts, 0, "settled-boundary compaction cannot interrupt an increment auditor's wait");
    const deadline = untilMs(5000);
    while (readState(cwd).loop!.builder!.phase !== "complete") {
      if (Date.now() > deadline) throw new Error(JSON.stringify(readState(cwd).loop));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const loop = readState(cwd).loop!;
    assert.equal(loop.active, false);
    assert.equal(loop.builder!.requirements[0]!.status, "verified");
    assert.ok(fs.existsSync(respecProjectArchivePath(cwd, loop.startedAt, loop.builder!.revision)));
    assert.ok(ctx.ui.matching("every intended requirement").length > 0);
    const receipt = pi.sent.find(entry => (entry.message as { details?: { terminalApprovalGoalId?: string } }).details?.terminalApprovalGoalId?.startsWith("respec:"));
    assert.ok(receipt, "production adapter posts the semantic summary receipt");
    assert.equal(receipt.message.content, loop.completionSummary);
  } finally { clearLoopTimer(); restore(); await pi.fire("session_shutdown", { reason: "test-end" }, ctx); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); replaceState(previous); }
});


test("terminal summary delivery failure preserves a replayable durable summary", async () => {
  const env = { SUMMARY_FAIL: "1" }, f = fixture(env);
  try {
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.ok(readState(f.cwd).loop!.completionSummary);
    assert.equal(readState(f.cwd).loop!.builder!.summaryDeliveredAt, undefined);
    delete (env as Record<string, string>).SUMMARY_FAIL;
    replayRespecCompletionSummary(f.ctx);
    replayRespecCompletionSummary(f.ctx);
    assert.equal(f.summaries.length, 1);
    assert.ok(readState(f.cwd).loop!.builder!.summaryDeliveredAt);
  } finally { replaceState(f.original); }
});


test("a failed builder journal commit restores the complete prior RAM state", async () => {
  const f = fixture({ PERSIST_FAIL: "1" });
  try {
    const before = JSON.stringify(state);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(JSON.stringify(state), before);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 0 });
  } finally { replaceState(f.original); }
});

test("a supervisor freeze prevents a new project audit dispatch", async () => {
  const f = fixture();
  try {
    replaceState({ ...state, supervisorPausedAt: Date.now() }); persistStateLine(f.cwd, state);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(f.resolutions(), 0);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.equal(fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), false);
  } finally { replaceState(f.original); }
});

test("rapid pause/resume discards the cancelled worker result and rearms the saved claim", async () => {
  const env: Record<string, string> = { RESULT_DELAY: "10000" }, f = fixture(env);
  try {
    const pending = runRespecBuilderAudit(f.ctx);
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs"), deadline = Date.now() + 20000;
    while (!fs.existsSync(jobs) || !fs.readdirSync(jobs).some(name => fs.existsSync(path.join(jobs, name, "progress.json")))) {
      if (Date.now() > deadline) throw new Error("Worker did not publish progress");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    replaceState({ ...state, loop: { ...state.loop!, active: false, stopReason: "paused by user (/loop pause)" } });
    cancelRespecBuilderAudit(f.cwd, f.startedAt);
    replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined } });
    persistStateLine(f.cwd, state);
    await pending;
    assert.equal(readState(f.cwd).loop!.active, true);
    assert.equal(readState(f.cwd).loop!.stopReason, undefined);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.deepEqual(f.counts(), { wakes: 1, finishes: 0 });
    delete env.RESULT_DELAY;
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.equal(f.counts().finishes, 1);
  } finally { replaceState(f.original); }
});


test("an undelivered project summary survives replacement by a new project", async () => {
  const env: Record<string, string> = { SUMMARY_FAIL: "1" }, f = fixture(env);
  try {
    await runRespecBuilderAudit(f.ctx);
    const summary = state.loop!.completionSummary;
    replaceState({ ...state, loop: undefined }); persistStateLine(f.cwd, state);
    delete env.SUMMARY_FAIL;
    replayRespecCompletionSummary(f.ctx);
    replayRespecCompletionSummary(f.ctx);
    assert.deepEqual(f.summaries, [summary]);
    assert.equal(state.loop, undefined);
  } finally { replaceState(f.original); }
});


test("freezing supervision between auditor attempts prevents retry and fallback dispatch", async () => {
  const f = fixture({ FAIL_PRIMARY: "1", FREEZE_RETRY: "1" });
  try {
    await runRespecBuilderAudit(f.ctx);
    assert.ok(readState(f.cwd).supervisorPausedAt);
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs");
    assert.equal(fs.readdirSync(jobs).length, 1);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.equal(f.counts().finishes, 0);
  } finally { replaceState(f.original); }
});

test("a corrupt summary outbox prevents terminal handoff and retains approved job evidence", async () => {
  const f = fixture();
  try {
    const store = path.join(f.cwd, ".pi-glla", "pending-approval-renders.json");
    fs.writeFileSync(store, "broken queue");
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.equal(f.counts().finishes, 0);
    assert.equal(fs.readFileSync(store, "utf8"), "broken queue");
    const jobs = fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs"));
    fs.unlinkSync(store); fs.unlinkSync(f.file);
    const restoreClock = __testOnlyRespecAuditorRuntime({ auditNow: () => state.loop!.builder!.audit!.infrastructureRetry!.nextRetryAt });
    replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined } });
    persistStateLine(f.cwd, state);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), jobs);
    assert.equal(f.summaries.length, 1);
    restoreClock();
  } finally { replaceState(f.original); }
});


test("project audit preserves live tool deadline and attempt clock through the real worker bridge", async () => {
  const f = fixture({ TOOL_WAIT: "1", RESULT_DELAY: "250" });
  try {
    await runRespecBuilderAudit(f.ctx);
    const observed = f.observations.find(p => p.phase === "running" && p.lastActivityAt !== undefined)!;
    assert.equal(observed.currentTool, "bash");
    assert.equal(observed.toolTimeoutMs, 1200000);
    assert.equal(observed.round, 2);
    assert.ok(typeof observed.currentToolStartedAt === "number");
    assert.ok(typeof observed.attemptStartedAt === "number");
  } finally { replaceState(f.original); fs.rmSync(f.cwd, { recursive: true, force: true }); }
});


test("project adapter survives 2105 paced infrastructure episodes then a real worker recovers", async () => {
  const f = fixture();
  let clock = Date.now(), calls = 0;
  const restore = __testOnlyRespecAuditorRuntime({ auditNow: () => clock, resolveModel: () => {
    calls++;
    if (calls % 3 === 0) throw new Error("local launch transport failure");
    return { model: undefined, error: calls % 2 ? "invalid authentication credentials" : "No auditor model available in configuration" };
  } });
  try {
    const originalClaim = JSON.stringify(f.builder.audit);
    for (let i = 0; i < 2105; i++) {
      await runRespecBuilderAudit(f.ctx);
      const loop = state.loop!, audit = loop.builder!.audit!, retry = audit.infrastructureRetry!;
      assert.equal(loop.active, true);
      assert.equal(retry.failures, i + 1);
      assert.ok(retry.nextRetryAt > clock && retry.nextRetryAt - clock <= 300000);
      assert.equal(retry.pendingEpisode, true);
      assert.equal(loop.iteration, 1);
      assert.deepEqual(loop.builder!.requirements, f.builder.requirements);
      assert.deepEqual(loop.builder!.tasks, f.builder.tasks);
      assert.equal(loop.builder!.history, undefined);
      const resolved = calls;
      await Promise.all([runRespecBuilderAudit(f.ctx), runRespecBuilderAudit(f.ctx)]);
      assert.equal(calls, resolved, "early concurrent wakes cannot resolve/spawn");
      clock = retry.nextRetryAt;
      if (i % 100 === 0) {
        replaceState(readState(f.cwd));
        assert.equal(state.loop!.builder!.audit!.infrastructureRetry!.nextRetryAt, clock);
      }
    }
    const saved = readState(f.cwd).loop!;
    assert.equal(saved.builder!.audit!.infrastructureRetry!.failures, 2105);
    assert.equal(saved.builder!.audit!.attemptId, JSON.parse(originalClaim).attemptId);
    assert.equal(fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), false);
    restore();
    const restoreClock = __testOnlyRespecAuditorRuntime({ auditNow: () => clock });
    try { await runRespecBuilderAudit(f.ctx); } finally { restoreClock(); }
    // The phase advances when the audit's verdict lands, which is after the
    // dispatch returns. Wait for it instead of racing it: on a loaded host the
    // worker needs longer to settle, and the assertion would then read a
    // perfectly healthy "auditing".
    await waitForPhase(f.cwd, "complete");
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.equal(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")).length, 1);
  } finally { restore(); replaceState(f.original); fs.rmSync(f.cwd, { recursive: true, force: true }); }
});

test("project retry admission rolls back on refusal and honors freeze, stop, bounds and ownership", async () => {
  const env: Record<string, string> = {}, f = fixture(env);
  let now = Date.now();
  const restore = __testOnlyRespecAuditorRuntime({ auditNow: () => now, resolveModel: () => ({ model: undefined, error: "auth failed" }) });
  try {
    env.PERSIST_FAIL = "1";
    const prior = JSON.stringify(state);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(JSON.stringify(state), prior);
    assert.equal(f.counts().wakes, 0);
    delete env.PERSIST_FAIL;
    await runRespecBuilderAudit(f.ctx);
    const waiting = { ...state }, claim = state.loop!.builder!;
    now = claim.audit!.infrastructureRetry!.nextRetryAt;
    env.PERSIST_FAIL = "1";
    await runRespecBuilderAudit(f.ctx);
    assert.equal(state.loop!.builder, claim, "cursor reset refuses unjournaled episode");
    delete env.PERSIST_FAIL;
    replaceState({ ...waiting, supervisorPausedAt: now });
    await runRespecBuilderAudit(f.ctx); assert.equal(state.loop!.builder, claim);
    replaceState({ ...waiting, loop: { ...waiting.loop!, active: false, stopReason: "stopped by user" } });
    await runRespecBuilderAudit(f.ctx); assert.equal(state.loop!.builder, claim);
    replaceState({ ...waiting, loop: { ...waiting.loop!, maxIterations: 1 } });
    await runRespecBuilderAudit(f.ctx); assert.equal(state.loop!.active, false);
    assert.match(state.loop!.stopReason!, /max iterations/);
    replaceState(waiting); f.disown();
    await runRespecBuilderAudit(f.ctx); assert.equal(state.loop!.builder, claim);
  } finally { restore(); replaceState(f.original); }
});

for (const mode of ["cold", "pre-due", "overdue", "legacy", "legacy-cold", "user-stop"] as const) test(`real project restore ${mode} obeys consent, due and exact timer ownership`, async () => {
  const f = fixture(), pi = new MockPi();
  let now = Date.now(), resolutions = 0;
  const retryAt = mode === "overdue" ? now - 1 : now + 5000;
  const audit = { ...f.builder.audit!, infrastructureRetry: { scopeId: f.builder.audit!.attemptId, failureClass: "auth" as const, failures: 2,
    firstFailureAt: now - 10000, lastFailureAt: now - 10000, nextRetryAt: retryAt, pendingEpisode: true } };
  replaceState({ ...state, loop: { ...state.loop!, active: !["legacy", "legacy-cold", "user-stop"].includes(mode), stopReason: mode === "user-stop" ? "stopped by user (/loop stop)" : mode.startsWith("legacy") ? "audit infrastructure: invalid credentials" : undefined,
    builder: { ...f.builder, audit: mode.startsWith("legacy") ? f.builder.audit : audit } } });
  persistStateLine(f.cwd, state);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  activate(pi.api);
  const globalSettings = fs.readFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, "utf8");
  saveSettings("global", f.cwd, { autoResume: !["cold", "legacy-cold"].includes(mode) });
  const timers: { callback: () => void; delay: number; handle: NodeJS.Timeout }[] = [];
  const restoreScheduler = __testOnlyLoopInfrastructureScheduler(() => now, (callback, delay) => {
    const handle = setTimeout(() => {}, 1_000_000); handle.unref();
    timers.push({ callback, delay, handle }); return handle;
  });
  let restoreRuntime = () => {};
  try {
    await pi.fire("session_start", { reason: "startup" }, f.ctx);
    restoreRuntime = __testOnlyRespecAuditorRuntime({ auditNow: () => now, resolveModel: () => { resolutions++; return { model: undefined, error: "auth failed" }; } });
    if (["cold", "legacy-cold", "user-stop"].includes(mode)) {
      assert.equal(state.loop!.active, false);
      assert.equal(timers.length, 0);
      await runRespecBuilderAudit(f.ctx); assert.equal(resolutions, 0);
      return;
    }
    assert.equal(state.loop!.active, true);
    assert.ok(readState(f.cwd).loop!.builder!.audit!.infrastructureRetry);
    assert.ok(timers.length > 0);
    const first = timers.at(-1)!;
    assert.ok(mode === "overdue" ? first.delay === 0 : first.delay > 0);
    // Early callback must rearm rather than dispatch even if already queued.
    if (mode !== "overdue") { first.callback(); await Promise.resolve(); assert.equal(resolutions, 0); }
    now = state.loop!.builder!.audit!.infrastructureRetry!.nextRetryAt;
    scheduleLoopTick(f.ctx);
    const stale = timers.at(-1)!;
    const currentLoop = state.loop!;
    replaceState({ ...state, loop: { ...currentLoop, builder: { ...currentLoop.builder!, audit: { ...currentLoop.builder!.audit!, attemptId: "superseding-claim" } } } });
    stale.callback(); assert.equal(resolutions, 0);
    replaceState({ ...state, loop: currentLoop });
    scheduleLoopTick(f.ctx);
    const due = timers.at(-1)!;
    due.callback(); due.callback();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(resolutions, 1, "same callback cannot dispatch twice");
    const after = readState(f.cwd).loop!;
    assert.equal(after.active, true);
    assert.ok(after.builder!.audit!.infrastructureRetry!.nextRetryAt > now);
    const shutdownCallback = timers.at(-1)!;
    await pi.fire("session_shutdown", { reason: "test-end" }, f.ctx);
    shutdownCallback.callback(); await Promise.resolve();
    assert.equal(resolutions, 1, "old session callback loses timer ownership");
  } finally {
    clearLoopTimer(); for (const timer of timers) clearTimeout(timer.handle);
    restoreRuntime(); restoreScheduler();
    fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, globalSettings);
    await pi.fire("session_shutdown", { reason: "test-end" }, f.ctx);
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); replaceState(f.original);
  }
});


for (const action of ["pause", "cancel"] as const) test(`legacy infrastructure-held project resumes, reloads a paced timeout retry, and honors /loop ${action}`, async () => {
  const f = fixture(), pi = new MockPi();
  let now = Date.now(), resolutions = 0;
  const legacyBuilder = { ...f.builder, audit: { ...f.builder.audit!, candidateRef: "test/provider-model", attemptedRefs: ["test/provider-model"] } };
  replaceState({ ...state, loop: { ...state.loop!, active: false,
    stopReason: "audit infrastructure: Auditor stalled: no activity/progress for 10m; auto-cancelled detached job",
    builder: legacyBuilder } });
  persistStateLine(f.cwd, state);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); activate(pi.api);
  const globalSettings = fs.readFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, "utf8");
  saveSettings("global", f.cwd, { autoResume: false });
  const timers: { callback: () => void; delay: number; handle: NodeJS.Timeout }[] = [];
  const restoreScheduler = __testOnlyLoopInfrastructureScheduler(() => now, (callback, delay) => {
    const handle = setTimeout(() => {}, 1_000_000); handle.unref();
    timers.push({ callback, delay, handle }); return handle;
  });
  let restoreRuntime = () => {};
  let pending: Promise<void> | undefined;
  const assertClaim = () => {
    const saved = readState(f.cwd).loop!;
    assert.equal(saved.builder!.phase, "auditing");
    assert.equal(saved.builder!.audit!.attemptId, f.builder.audit!.attemptId);
    assert.equal(saved.builder!.audit!.claim, f.builder.audit!.claim);
    assert.equal(saved.builder!.revision, f.builder.revision);
    assert.deepEqual(saved.builder!.requirements, f.builder.requirements);
    assert.deepEqual(saved.builder!.tasks, f.builder.tasks);
    assert.equal(saved.iteration, 1);
    assert.equal(saved.builder!.history, undefined);
  };
  try {
    await pi.fire("session_start", { reason: "startup" }, f.ctx);
    restoreRuntime = __testOnlyRespecAuditorRuntime({ auditNow: () => now,
      resolveModel: () => { resolutions++; return { model: "test/provider-model" }; }, auditSleep: async () => {},
      auditRuntime: { command: process.execPath, workerPath: f.file, homeDir: f.cwd, pollIntervalMs: 10,
        heartbeatNoProgressMs: 50, firstEventTimeoutMs: 5000, env: { RESULT_DELAY: "10000" } } });
    assert.equal(state.loop!.active, false, "cold restore needs consent");
    assert.equal(state.loop!.builder!.audit!.infrastructureRetry, undefined);
    await runRespecBuilderAudit(f.ctx); assert.equal(resolutions, 0);
    await pi.command("loop", "resume", f.ctx);
    assertClaim();
    const migrated = readState(f.cwd).loop!.builder!.audit!;
    assert.equal(state.loop!.active, true);
    assert.equal(state.loop!.stopReason, undefined);
    assert.equal(migrated.infrastructureRetry!.scopeId, migrated.attemptId);
    assert.equal(migrated.infrastructureRetry!.failures, 1);
    assert.equal(migrated.infrastructureRetry!.pendingEpisode, true);
    assert.ok(migrated.infrastructureRetry!.nextRetryAt > now);
    assert.deepEqual(migrated.attemptedRefs, legacyBuilder.audit.attemptedRefs, "migration retains the old cursor until due");
    await Promise.all([runRespecBuilderAudit(f.ctx), runRespecBuilderAudit(f.ctx)]);
    assert.equal(resolutions, 0, "early wakes neither resolve nor spawn");
    assert.equal(fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), false);
    now = migrated.infrastructureRetry!.nextRetryAt;
    await runRespecBuilderAudit(f.ctx);
    assert.equal(resolutions, 1, "due migration resets the exhausted legacy cursor and dispatches");
    assertClaim();
    const retry = readState(f.cwd).loop!.builder!.audit!.infrastructureRetry!;
    assert.equal(retry.failureClass, "timeout");
    assert.equal(retry.failures, 2);
    assert.equal(retry.pendingEpisode, true);
    assert.ok(retry.nextRetryAt > now);
    assert.match(retry.diagnostic!, /Auditor stalled/);
    assert.equal(state.loop!.active, true, "timeout must not return to legacy manual parking");
    assert.equal(respecBuilderAuditInFlight(f.cwd), false);
    const oldOwner = timers.at(-1)!;
    await pi.fire("session_shutdown", { reason: "reload" }, f.ctx);
    saveSettings("global", f.cwd, { autoResume: true });
    await pi.fire("session_start", { reason: "startup" }, f.ctx);
    assertClaim();
    assert.deepEqual(readState(f.cwd).loop!.builder!.audit!.infrastructureRetry, retry);
    assert.equal(state.loop!.active, true);
    now = retry.nextRetryAt;
    const beforeStale = fs.readFileSync(path.join(f.cwd, ".pi-glla", "active.jsonl"), "utf8");
    oldOwner.callback(); await Promise.resolve();
    assert.equal(resolutions, 1, "pre-reload owner cannot dispatch even after due");
    assert.equal(fs.readFileSync(path.join(f.cwd, ".pi-glla", "active.jsonl"), "utf8"), beforeStale);
    assert.equal(readState(f.cwd).loop!.completionSummary, undefined, "retry is not completion");
    restoreRuntime();
    restoreRuntime = __testOnlyRespecAuditorRuntime({ auditNow: () => now,
      resolveModel: () => { resolutions++; return { model: "test/provider-model" }; }, auditSleep: async () => {},
      auditRuntime: { command: process.execPath, workerPath: f.file, homeDir: f.cwd, pollIntervalMs: 10,
        heartbeatNoProgressMs: 5000, firstEventTimeoutMs: 5000, env: { RESULT_DELAY: "10000" } } });
    pending = runRespecBuilderAudit(f.ctx);
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs"), deadline = Date.now() + 10000;
    while (!fs.readdirSync(jobs).some(name => fs.existsSync(path.join(jobs, name, "progress.json")))) {
      if (Date.now() > deadline) throw new Error("Reloaded worker did not publish progress");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(resolutions, 2);
    await pi.command("loop", action, f.ctx);
    await pending; pending = undefined;
    assertClaim();
    assert.equal(readState(f.cwd).loop!.active, false);
    assert.match(readState(f.cwd).loop!.stopReason!, /(?:paused|stopped) by user/);
    assert.match(readState(f.cwd).loop!.completionSummary!, /Unresolved: (?:paused|stopped) by user/);
    assert.equal(respecBuilderAuditInFlight(f.cwd), false);
    assert.ok(fs.readdirSync(jobs).every(name => !fs.existsSync(path.join(jobs, name, "result.json"))), "cancelled worker cannot publish approval");
    await runRespecBuilderAudit(f.ctx); assert.equal(resolutions, 2, "explicit stop prevents another retry");
    assert.equal(fs.existsSync(respecProjectArchivePath(f.cwd, f.startedAt, f.builder.revision)), false);
  } finally {
    cancelRespecBuilderAudit(f.cwd, f.startedAt); await pending;
    clearLoopTimer(); for (const timer of timers) clearTimeout(timer.handle);
    restoreRuntime(); restoreScheduler();
    fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, globalSettings);
    await pi.fire("session_shutdown", { reason: "test-end" }, f.ctx);
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); replaceState(f.original);
    fs.rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("exhausted finite worker chain resets only at the next due admitted episode", async () => {
  const env: Record<string, string> = { FAIL_ALL: "1" }, f = fixture(env);
  let clock = Date.now();
  const restore = __testOnlyRespecAuditorRuntime({ auditNow: () => clock });
  try {
    await runRespecBuilderAudit(f.ctx);
    const exhausted = state.loop!.builder!.audit!;
    assert.deepEqual(exhausted.attemptedRefs, ["test/provider-model"]);
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs");
    assert.equal(fs.readdirSync(jobs).length, 2);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(state.loop!.builder!.audit, exhausted);
    assert.equal(fs.readdirSync(jobs).length, 2);
    clock = exhausted.infrastructureRetry!.nextRetryAt;
    await runRespecBuilderAudit(f.ctx);
    assert.equal(fs.readdirSync(jobs).length, 4);
    assert.equal(state.loop!.builder!.audit!.infrastructureRetry!.failures, 2);
    delete env.FAIL_ALL;
    clock = state.loop!.builder!.audit!.infrastructureRetry!.nextRetryAt;
    await runRespecBuilderAudit(f.ctx);
    await waitForPhase(f.cwd, "complete");
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.equal(fs.readdirSync(jobs).length, 5);
  } finally { restore(); replaceState(f.original); }
});

test("real stalled detached workers automatically journal a paced timeout episode", async () => {
  const f = fixture({ RESULT_DELAY: "10000" });
  const restore = __testOnlyRespecAuditorRuntime({ auditRuntime: { command: process.execPath, workerPath: f.file, homeDir: f.cwd,
    pollIntervalMs: 10, heartbeatNoProgressMs: 50, firstEventTimeoutMs: 5000, env: { RESULT_DELAY: "10000" } } });
  try {
    await runRespecBuilderAudit(f.ctx);
    const loop = readState(f.cwd).loop!;
    assert.equal(loop.active, true);
    assert.equal(loop.builder!.phase, "auditing");
    assert.equal(loop.builder!.audit!.infrastructureRetry!.failureClass, "timeout");
    assert.match(loop.builder!.audit!.infrastructureRetry!.diagnostic!, /Auditor stalled.*(?:activity|progress)/);
    replaceState(readState(f.cwd));
    assert.match(respecAuditStatus(state.loop!.builder!, Date.now()), /Auditor stalled/);
    assert.match(buildWidgetLines(state, null, Date.now(), undefined, 120, { maxWidgetLines: 20 })!.join("\n"), /cause: Auditor stalled/);
    assert.ok(loop.builder!.audit!.infrastructureRetry!.nextRetryAt > Date.now());
    assert.equal(loop.builder!.requirements[0]!.status, "open");
    assert.equal(respecBuilderAuditInFlight(f.cwd), false);
    assert.equal(f.counts().wakes, 1);
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs");
    // The process adapter deliberately removes owned no-result scratch on
    // cancellation. Distinct worker-confirmed attempt clocks prove two launches.
    assert.equal(new Set(f.observations.filter(p => p.workerPhase === "running" && p.lastActivityAt !== undefined).map(p => p.attemptStartedAt)).size, 2);
    assert.equal(fs.readdirSync(jobs).length, 0, "cancelled no-verdict jobs are cleaned, not retained as approvals");
  } finally { restore(); replaceState(f.original); }
});

import { buildWidgetLines, buildStatusText } from "../extensions/goal-loop-display.js";
import { respecAuditStatus } from "../extensions/respec-builder-ui.js";
test("project retry causes survive actual journal reload and production recovery UI without credentials", async () => {
  const f = fixture();
  let clock = Date.parse("2026-10-14T12:00:00Z");
  let error = "HTTP 401 model alpha scope denied; Authorization: Bearer PROJECT_SECRET";
  const restore = __testOnlyRespecAuditorRuntime({ auditNow: () => clock, resolveModel: () => {
    if (error.startsWith("transport")) throw new Error(error);
    return { error, model: undefined };
  } });
  try {
    for (const [message, cause] of [
      ["HTTP 401 model alpha scope denied; Authorization: Bearer PROJECT_SECRET", /HTTP 401 model alpha scope denied/],
      ["No auditor model beta configured; access_token=PROJECT_SECRET", /No auditor model beta configured/],
      ["transport timeout connecting to local auditor; password=PROJECT_SECRET", /transport timeout connecting to local auditor/],
    ] as const) {
      error = message;
      await runRespecBuilderAudit(f.ctx);
      replaceState(readState(f.cwd));
      const builder = state.loop!.builder!;
      assert.match(builder.audit!.infrastructureRetry!.diagnostic!, cause);
      assert.match(respecAuditStatus(builder, clock), cause);
      const rows = buildWidgetLines(state, null, clock, undefined, 120, { maxWidgetLines: 20 })!.join("\n");
      assert.match(rows, cause);
      assert.match(rows, /retry deadline: 2026-10-14/);
      const status = buildStatusText(state, null, clock, undefined, undefined, 120)!;
      assert.match(status, cause);
      const walk = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name), "utf8")).join("\n");
      assert.doesNotMatch(walk(path.join(f.cwd, ".pi-glla")), /PROJECT_SECRET/);
      assert.doesNotMatch(rows + status + JSON.stringify((f.ctx as any).ui), /PROJECT_SECRET/);
      clock = builder.audit!.infrastructureRetry!.nextRetryAt;
    }
  } finally { restore(); replaceState(f.original); fs.rmSync(f.cwd, { recursive: true, force: true }); }
});
