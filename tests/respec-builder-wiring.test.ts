import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { clearLoopTimer, loopPrompt } from "../extensions/goal-loop.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, tick } from "./harness/mock-pi.js";

afterEach(() => { clearLoopTimer(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

test("actual respec command and tools persist intended scope, batch and audit claim", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "builder-wiring" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec build login and export", ctx); await tick(100); clearLoopTimer();
    assert.equal(readState(cwd).loop?.builder?.vision, "build login and export");
    assert.equal(readState(cwd).loop?.builder?.phase, "drafting");
    assert.match(loopPrompt(readState(cwd).loop!, "", "", ""), /RESPEC PROJECT BUILDER/);
    const run = async (name: string, params: unknown) => pi.tools.get(name)!.execute(...["call", params, undefined, undefined, ctx] as never[]);
    await run("propose_project_requirements", { requirements: [{ id: "login", text: "Users can log in", acceptance: "Valid login succeeds; invalid login fails" }, { id: "export", text: "Users can export", acceptance: "Data round-trips" }] });
    assert.equal(readState(cwd).loop?.builder?.phase, "planning");
    await run("plan_project_increment", { tasks: [{ id: "auth", text: "Implement login", requirementIds: ["login"] }] });
    await run("claim_project_task", { id: "auth" });
    assert.equal(readState(cwd).loop?.builder?.requirements[0]!.status, "open");
    await run("audit_project_increment", { claim: "Login implemented and exercised" });
    const saved = readState(cwd).loop!.builder!;
    assert.equal(saved.phase, "auditing");
    assert.equal(saved.requirements.length, 2);
    assert.ok(saved.audit!.attemptId);
    assert.ok(saved.audit!.at);
    assert.equal(saved.tasks[0]!.status, "claimed");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("declining intended scope leaves the project drafting with no adopted requirements", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "builder-refusal" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); clearLoopTimer();
    ctx.ui.confirmImpl = async () => false;
    await pi.tools.get("propose_project_requirements")!.execute(...["call", { requirements: [{ id: "a", text: "Feature", acceptance: "Observable feature works" }] }, undefined, undefined, ctx] as never[]);
    assert.equal(readState(cwd).loop!.builder!.phase, "drafting");
    assert.equal(readState(cwd).loop!.builder!.requirements.length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
