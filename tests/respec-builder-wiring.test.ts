import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { clearLoopTimer, loopPrompt } from "../extensions/goal-loop.js";
import { readState } from "../extensions/goal-loop-core.js";
import { saveSettings } from "../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tmpCwd, tick } from "./harness/mock-pi.js";

afterEach(() => { clearLoopTimer(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

test("actual respec command and tools persist intended scope, batch and audit claim", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  saveSettings("project", cwd, { autoAcceptDrafts: false });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "builder-wiring" } });
  ctx.ui.customImpl = async () => "Yes";
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec build login and export", ctx); await tick(100); clearLoopTimer();
    assert.equal(readState(cwd).loop?.builder?.vision, "build login and export");
    assert.equal(readState(cwd).loop?.builder?.phase, "drafting");
    await pi.command("loop", "finish looks done", ctx);
    assert.equal(readState(cwd).loop?.active, true, "finish cannot bypass requirement verification");
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
    await pi.command("loop", "status", ctx);
    const status = ctx.ui.notifies.at(-1)!.message;
    assert.match(status, /login \[open\]: Users can log in/);
    assert.match(status, /Done when: Valid login succeeds; invalid login fails/);
    assert.match(status, /export \[open\]: Users can export/);
    assert.match(status, /waiting for dispatch/);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("declining intended scope leaves the project drafting with no adopted requirements", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  saveSettings("project", cwd, { autoAcceptDrafts: false });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "builder-refusal" } });
  ctx.ui.customImpl = async () => "Yes";
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec", ctx); clearLoopTimer();
    ctx.ui.customImpl = async () => "No";
    await pi.tools.get("propose_project_requirements")!.execute(...["call", { requirements: [{ id: "a", text: "Feature", acceptance: "Observable feature works" }] }, undefined, undefined, ctx] as never[]);
    assert.equal(readState(cwd).loop!.builder!.phase, "drafting");
    assert.equal(readState(cwd).loop!.builder!.requirements.length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("registered blocker and refinement tools preserve work and require consent to change scope", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  saveSettings("project", cwd, { autoAcceptDrafts: false });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "builder-refinement" } });
  ctx.ui.customImpl = async () => "Yes";
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec build login", ctx); clearLoopTimer();
    await pi.runTool("propose_project_requirements", { requirements: [{ id: "login", text: "Login", acceptance: "Valid credentials succeed" }] }, ctx);
    await pi.runTool("plan_project_increment", { tasks: [{ id: "auth", text: "Implement login", requirementIds: ["login"] }] }, ctx);
    await pi.runTool("block_project_requirement", { id: "login", reason: "Credentials unavailable" }, ctx);
    assert.equal(readState(cwd).loop!.active, false, "all-blocked work parks automation");
    assert.equal(readState(cwd).loop!.builder!.history!.at(-1)!.tasks[0]!.id, "auth");
    const beforeInspection = JSON.stringify(readState(cwd).loop);
    await pi.command("loop", "blockers", ctx);
    assert.match(ctx.ui.notifies.at(-1)!.message, /Credentials unavailable/);
    assert.match(ctx.ui.notifies.at(-1)!.message, /Recheck these blockers/);
    assert.match(ctx.ui.notifies.at(-1)!.message, /unblock_project_requirement/);
    assert.equal(JSON.stringify(readState(cwd).loop), beforeInspection, "inspection cannot clear a blocker, resume work or change the contract");
    await pi.command("loop", "resume", ctx); clearLoopTimer();
    assert.equal(readState(cwd).loop!.active, false, "unresolved all-blocked project cannot resume into a no-progress loop");
    await pi.runTool("unblock_project_requirement", { id: "login", reason: "Credentials supplied and validated" }, ctx);
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.status, "open");
    assert.equal(readState(cwd).loop!.active, false, "unblocking preserves explicit pause until resume");
    const before = JSON.stringify(readState(cwd).loop!.builder);
    ctx.ui.customImpl = async () => "No";
    const proposal = { reason: "Add two-factor authentication", requirements: [{ id: "login", text: "Two-factor login", acceptance: "Password and second factor required" }] };
    await pi.runTool("propose_project_refinement", proposal, ctx);
    assert.equal(JSON.stringify(readState(cwd).loop!.builder), before, "declining scope keeps every durable requirement");
    ctx.ui.customImpl = async () => "Yes";
    await pi.runTool("propose_project_refinement", proposal, ctx);
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.acceptance, "Password and second factor required");
    assert.equal(readState(cwd).loop!.builder!.revision, 2);
    assert.equal(readState(cwd).loop!.active, false);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
