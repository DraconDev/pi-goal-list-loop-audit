import { test } from "node:test";
import assert from "node:assert/strict";
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
const output = process.env.NEEDS_WORK ? "<evidence>Invalid credentials accepted</evidence><disapproved/>" : "<evidence>" + req.goal.verificationContract + "</evidence><approved/>";
await atomic(dir + "/result.json", { protocolVersion: 1, attemptId: req.attemptId, requestHash: req.requestHash, ok: true, output, model: req.model, thinkingLevel: req.thinkingLevel, challenge: "confirmed", toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] });
`;

function fixture(env: Record<string, string> = {}) {
  const cwd = tmpCwd(), pi = new MockPi(), ctx = makeMockCtx(cwd);
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
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
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
    assert.equal(saved.phase, "replanning");
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
    assert.equal(readState(f.cwd).loop!.builder!.phase, "complete");
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, ".pi-glla", "audit-jobs")), jobs);
  } finally { replaceState(f.original); }
});
