import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { archivedGoalPath, readState, type Goal, type State } from "../extensions/goal-loop-core.js";
import { buildWidgetLines, buildStatusText } from "../extensions/goal-loop-display.js";
import { completionAuditRecoveryIdentity, requestHash, readCompletedCompletionAudit, runDetachedGoalCompletionAuditor, buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor-process.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

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

// Real detached worker publishes its result; deliberately omit the parent
// application, then restore from durable state in a new session.
for (const verdict of ["approved", "disapproved"] as const) {
  test(`finished real worker, lost parent: restart applies ${verdict} exactly once without re-auditing`, async () => {
    const cwd = tmpCwd(), g = goal(); seedState(cwd, { goal: g });
    const fakePi = path.join(cwd, "fake-pi.mjs");
    fs.writeFileSync(fakePi, `#!/usr/bin/env node\nlet input=''; process.stdin.on('data',chunk=>{ input+=chunk; if(!input.includes('\\n'))return; const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n'); emit({type:'tool_execution_start',toolName:'read',toolCallId:'one',args:{path:'artifact'}}); emit({type:'tool_execution_end',toolName:'read',toolCallId:'one'}); emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'<evidence>\\nartifact exists\\n</evidence>\\n<${verdict}/>'}}); emit({type:'agent_settled'}); });`, { mode: 0o700 });
    const result = await runDetachedGoalCompletionAuditor({ cwd, goal: g, model: "test/model", thinkingLevel: "off",
      completionSummary: g.pendingCompletion!.completionSummary, verificationSummary: g.pendingCompletion!.verificationSummary,
      runtime: { piBinary: fakePi, logicalAttemptId: "saved-claim", attemptId: () => "saved-claim-real-worker", pollIntervalMs: 10 },
    });
    assert.equal(result[verdict], true, result.error ?? "worker verdict");
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

for (const change of ["revision", "claim", "hash", "result-identity", "cancelled-tool", "strict-challenge", "unsupported-tool"] as const) {
  test(`saved result refuses unsafe recovery: ${change}`, () => {
    const cwd = tmpCwd(); let g = goal(); const saved = job(cwd, g);
    if (change === "revision") g = { ...g, revision: 1 };
    if (change === "claim") g = { ...g, pendingCompletion: { ...g.pendingCompletion!, verificationSummary: "changed" } };
    if (change === "hash") fs.writeFileSync(path.join(saved.dir, "request.json"), JSON.stringify({ ...saved.request, model: "other/model" }));
    if (change === "result-identity") saved.result.attemptId = "another-job";
    if (change === "cancelled-tool") Object.assign(saved.result, { verificationIncomplete: true });
    if (change === "strict-challenge") saved.result.challenge = "skipped: failure";
    if (change === "unsupported-tool") saved.result.toolCalls[0]!.name = "write";
    fs.writeFileSync(path.join(saved.dir, "result.json"), JSON.stringify(saved.result));
    assert.equal(readCompletedCompletionAudit(cwd, g, change === "strict-challenge"), null);
  });
}

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
