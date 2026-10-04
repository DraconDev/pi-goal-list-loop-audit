import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerRespecBuilderTools, runRespecBuilderAudit, respecProjectArchivePath } from "../extensions/respec-builder-runtime.js";
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
const output = process.env.NEEDS_WORK ? "<evidence>\\nInvalid credentials accepted\\n</evidence>\\n<disapproved/>" : "<evidence>\\nartifact exists\\n</evidence>\\n<approved/>";
await atomic(dir + "/result.json", { protocolVersion: 1, attemptId: req.attemptId, requestHash: req.requestHash, goalRevision: req.goalRevision, ok: true, output, model: req.model, thinkingLevel: req.thinkingLevel, challenge: "confirmed", toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] });
`;

function fixture(env: Record<string, string> = {}) {
  const cwd = tmpCwd(), pi = new MockPi(), ctx = makeMockCtx(cwd) as unknown as ExtensionContext;
  const file = path.join(cwd, "bounded-auditor-worker.mjs"); fs.writeFileSync(file, worker);
  const drafted = adoptRespecRequirements(createRespecBuilder("Build an artifact"), [{ id: "artifact", text: "Artifact", acceptance: "artifact exists" }]);
  const building = planRespecIncrement(drafted, [{ id: "task", text: "Build artifact", requirementIds: ["artifact"] }]);
  const builder = beginRespecAudit(claimRespecTask(building, "task"), "aabbccdd-1111-2222-3333-444455556666", "Artifact implemented");
  const original = state;
  const startedAt = new Date().toISOString();
  replaceState({ goal: null, list: [], loop: { target: builder.vision, builder, active: true, startedAt, iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } });
  persistStateLine(cwd, state);
  let wakes = 0, finishes = 0;
  registerRespecBuilderTools(pi.api, { context: () => ctx, persist: () => persistStateLine(cwd, state), wake: () => { wakes++; }, finished: () => { finishes++; }, resolveModel: () => ({ model: "test/provider-model" }), wrapTool: tool => tool,
    auditRuntime: { command: process.execPath, workerPath: file, pollIntervalMs: 10, heartbeatNoProgressMs: 5000, firstEventTimeoutMs: 5000, env } });
  return { cwd, ctx, startedAt, original, builder, file, counts: () => ({ wakes, finishes }) };
}

test("real detached protocol approval archives the intended project before terminal handoff", async () => {
  const f = fixture();
  try {
    await runRespecBuilderAudit(f.ctx);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete", JSON.stringify(readState(f.cwd).loop));
    assert.equal(readState(f.cwd).loop!.active, false);
    const archive = JSON.parse(fs.readFileSync(respecProjectArchivePath(f.cwd, f.startedAt, f.builder.revision), "utf8"));
    assert.equal(archive.builder.requirements[0].status, "verified");
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
  const f = fixture({ RESULT_DELAY: "200" });
  try {
    const pending = runRespecBuilderAudit(f.ctx);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs")) || !fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")).some(name => fs.existsSync(path.join(f.cwd, ".pi-glla", "audit-jobs", name, "progress.json")))) {
      if (Date.now() > deadline) throw new Error("Worker did not publish progress");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    replaceState({ ...state, loop: { ...state.loop!, active: false, stopReason: "paused by user" } });
    persistStateLine(f.cwd, state);
    await pending;
    assert.equal(readState(f.cwd).loop!.active, false);
    assert.equal(readState(f.cwd).loop!.builder!.phase, "auditing");
    assert.equal(readState(f.cwd).loop!.builder!.requirements[0]!.status, "open");
    assert.deepEqual(f.counts(), { wakes: 0, finishes: 0 });
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
