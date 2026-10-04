import { getRespecAuditLive } from "../extensions/respec-builder-ui.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerRespecBuilderTools, runRespecBuilderAudit, respecProjectArchivePath, cancelRespecBuilderAudit, replayRespecCompletionSummary, __testOnlyRespecAuditorRuntime } from "../extensions/respec-builder-runtime.js";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { clearLoopTimer } from "../extensions/goal-loop.js";
import { saveSettings } from "../extensions/goal-settings.js";
import { createRespecBuilder, adoptRespecRequirements, planRespecIncrement, claimRespecTask, beginRespecAudit } from "../extensions/respec-builder.js";
import { state, replaceState, persistStateLine } from "../extensions/goal-state.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, tmpCwd, makeMockCtx } from "./harness/mock-pi.js";

const worker = `
import { readFile, writeFile, rename } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const req = JSON.parse(await readFile(dir + "/request.json", "utf8"));
async function atomic(file, data) { await writeFile(file + ".tmp", JSON.stringify(data)); await rename(file + ".tmp", file); }
await atomic(dir + "/progress.json", { protocolVersion: 1, attemptId: req.attemptId, requestHash: req.requestHash, phase: "running", elapsedMs: 1, lastActivityAt: Date.now(), toolCalls: [], recentOutput: [] });
if (process.env.RESULT_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.RESULT_DELAY)));
const output = process.env.INCOMPLETE_EVIDENCE ? "Looks good\\n<approved/>" : process.env.FAIL_PRIMARY && req.model.includes("primary") ? "no verdict from primary" : process.env.NEEDS_WORK ? "<evidence>\\nInvalid credentials accepted\\n</evidence>\\n<disapproved/>" : "<evidence>\\nartifact exists\\n</evidence>\\n<approved/>";
await atomic(dir + "/result.json", { protocolVersion: 1, attemptId: req.attemptId, requestHash: req.requestHash, goalRevision: req.goalRevision, ok: true, output, model: req.model, thinkingLevel: req.thinkingLevel, challenge: "confirmed", toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] });
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
    refresh: () => { const value = state.loop?.builder && getRespecAuditLive(state.loop.builder); if (value) { progress.push(value.phase); observations.push({ ...value }); } },
    auditSleep: async () => {},
    auditRuntime: { command: process.execPath, workerPath: file, homeDir: cwd, pollIntervalMs: 10, heartbeatNoProgressMs: 5000, firstEventTimeoutMs: 5000, env } });
  return { cwd, ctx, startedAt, original, builder, file, counts: () => ({ wakes, finishes }), summaries, progress, observations, disown: () => { owned = false; }, resolutions: () => resolutions };
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
    const pending = runRespecBuilderAudit(f.ctx);
    const jobs = path.join(f.cwd, ".pi-glla", "audit-jobs");
    const deadline = Date.now() + 20000;
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
    assert.equal(getRespecAuditLive(f.builder), undefined);
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
    const deadline = Date.now() + 5000;
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
    assert.equal(readState(f.cwd).loop!.active, false);
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 0 });
    const jobs = fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs"));
    fs.rmSync(archivePath, { recursive: true }); fs.unlinkSync(f.file);
    replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined } });
    persistStateLine(f.cwd, state);
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), jobs);
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 1 });
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

test("actual installer, command, tools and agent_end carry a project through detached verification", async () => {
  const cwd = tmpCwd(), pi = new MockPi(), ctx = makeMockCtx(cwd, { sessionManager: { name: "respec-full-lifecycle", getBranch: () => [], getSessionFile: () => undefined } });
  const previous = { ...state };
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  activate(pi.api); saveSettings("project", cwd, { autoAcceptDrafts: false });
  ctx.ui.customImpl = async () => "Yes";
  const file = path.join(cwd, "bounded-auditor-worker.mjs"); fs.writeFileSync(file, worker);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const restore = __testOnlyRespecAuditorRuntime({ resolveModel: () => ({ model: "test/provider-model" }), auditSleep: async () => {},
    auditRuntime: { command: process.execPath, workerPath: file, homeDir: cwd, pollIntervalMs: 10, heartbeatNoProgressMs: 5000, firstEventTimeoutMs: 5000 } });
  try {
    await pi.command("loop", "respec build the artifact", ctx); clearLoopTimer();
    await pi.runTool("propose_project_requirements", { requirements: [{ id: "artifact", text: "Artifact", acceptance: "artifact exists" }] }, ctx);
    await pi.runTool("plan_project_increment", { tasks: [{ id: "task", text: "Build artifact", requirementIds: ["artifact"] }] }, ctx);
    await pi.runTool("claim_project_task", { id: "task" }, ctx);
    await pi.runTool("audit_project_increment", { claim: "Artifact implemented" }, ctx);
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.status, "open");
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Increment ready for independent verification." }] }] }, ctx);
    const deadline = Date.now() + 5000;
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
