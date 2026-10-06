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
    await pi.runTool("block_project_requirement", { kind: "external", id: "login", reason: "Credentials unavailable", summary: "Missing login credentials", owner: "Operator", nextAction: "Supply test credentials", expectedResult: "Login succeeds", whyAgentCannotProceed: "Only the operator can grant access" }, ctx);
    assert.equal(readState(cwd).loop!.active, false, "all-blocked work parks automation");
    assert.equal(readState(cwd).loop!.builder!.history!.at(-1)!.tasks[0]!.id, "auth");
    const beforeInspection = JSON.stringify(readState(cwd).loop);
    await pi.command("loop", "blockers", ctx);
    assert.match(ctx.ui.notifies.at(-1)!.message, /Credentials unavailable/);
    assert.match(ctx.ui.notifies.at(-1)!.message, /Supply test credentials/);
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


test("project blockers automatically show generic actions after journaling, without dispatch or implicit resolution", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  saveSettings("project", cwd, { autoAcceptDrafts: false });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "automatic-blocker-actions" } });
  ctx.ui.customImpl = async () => "Yes";
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec build service", ctx); clearLoopTimer();
    await pi.runTool("propose_project_requirements", { requirements: [
      { id: "access", text: "Service access", acceptance: "Can read service data" },
      { id: "dependency", text: "Import data", acceptance: "Import succeeds" },
    ] }, ctx);
    const blocker = { kind: "external", summary: "Missing service credentials", whyAgentCannotProceed: "The operator owns the service account", id: "access", reason: "Service credentials unavailable", owner: "Operator",
      nextAction: "Open the service settings and supply a read-only credential", expectedResult: "A read probe succeeds" };
    await pi.runTool("block_project_requirement", blocker, ctx);
    const messages = () => pi.sent.filter(s => s.message.customType === "glla-project-blockers");
    assert.equal(messages().length, 1, "no inspection command needed");
    assert.match(String(messages()[0]!.message.content), /Who can act: Operator/);
    assert.match(String(messages()[0]!.message.content), /Open the service settings/);
    assert.match(String(messages()[0]!.message.content), /A read probe succeeds/);
    assert.deepEqual(messages()[0]!.options, { triggerTurn: false });
    const rendered = pi.messageRenderers.get("glla-project-blockers")!(messages()[0]!.message, { outputPad: 1 },
      { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text }) as { render(width: number): string[] };
    assert.match(rendered.render(80).join("\n"), /GLLA · Action needed/);
    assert.match(rendered.render(80).join("\n"), /Resolved when: A read probe succeeds/);
    assert.equal(readState(cwd).loop!.active, true, "partial blockers leave other work available");
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.blockerAction!.nextAction, blocker.nextAction);
    await pi.runTool("block_project_requirement", blocker, ctx);
    assert.equal(messages().length, 1, "unchanged blocker cannot spam the action surface");
    await pi.runTool("block_project_requirement", { ...blocker, nextAction: "Use the account access page instead" }, ctx);
    assert.equal(messages().length, 2, "updated actions are shown");
    const beforeInvalid = JSON.stringify(readState(cwd).loop);
    const invalid = await pi.runTool("block_project_requirement", { kind: "external", id: "dependency", reason: "The test failed and acceptance is unmet" }, ctx);
    assert.match(invalid.content[0]!.text, /Blocker not recorded/);
    assert.equal(JSON.stringify(readState(cwd).loop), beforeInvalid, "vague reports cannot park project work");
    assert.equal(messages().length, 2);
    const oversized = await pi.runTool("block_project_requirement", { ...blocker, summary: "long report ".repeat(30) }, ctx);
    assert.match(oversized.content[0]!.text, /Blocker not recorded/);
    assert.equal(JSON.stringify(readState(cwd).loop), beforeInvalid, "a report cannot replace the short obstacle explanation");
    const dependency = { kind: "external", id: "dependency", reason: "Dependency unavailable", summary: "Upstream service is offline", owner: "Service administrator", nextAction: "Restore the upstream service", expectedResult: "Health check succeeds", whyAgentCannotProceed: "The service runs outside this project and the agent has no deployment access" };
    await pi.runTool("block_project_requirement", dependency, ctx);
    assert.equal(messages().length, 3);
    assert.match(String(messages()[2]!.message.content), /Restore the upstream service/);
    assert.equal(readState(cwd).loop!.active, false, "displaying actions cannot resume all-blocked work");
    pi.sendMessageError = new Error("display unavailable");
    await pi.runTool("block_project_requirement", { ...dependency, reason: "Dependency still unavailable; checked today" }, ctx);
    assert.equal(readState(cwd).loop!.builder!.requirements[1]!.blockedReason, "Dependency still unavailable; checked today", "display failure does not discard durable blocker");
    pi.sendMessageError = null;
    await pi.runTool("unblock_project_requirement", { id: "access", reason: "Read probe succeeded" }, ctx);
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.blockerAction, undefined);
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.status, "open");
    assert.equal(readState(cwd).loop!.active, false);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});


test("work obstacles keep building and mistaken blocker-only holds release without verifying scope", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  saveSettings("project", cwd, { autoAcceptDrafts: false });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "repair-obstacles" } });
  ctx.ui.customImpl = async () => "Yes";
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("loop", "respec build game", ctx); clearLoopTimer();
    await pi.runTool("propose_project_requirements", { requirements: [
      { id: "combat", text: "Playable combat", acceptance: "Targets take damage" },
      { id: "api", text: "Live API", acceptance: "API responds" },
    ] }, ctx);
    await pi.runTool("plan_project_increment", { tasks: [{ id: "combat-task", text: "Implement combat", requirementIds: ["combat"] }] }, ctx);
    const repair = { kind: "work", id: "combat", reason: "Combat probe shows the hero stuck at the map edge", nextAction: "Place a target at an interior point and measure approach distance" };
    const result = await pi.runTool("block_project_requirement", repair, ctx);
    assert.match(result.content[0]!.text, /keep building or refining in THIS turn/);
    assert.equal(readState(cwd).loop!.active, true);
    assert.equal(readState(cwd).loop!.builder!.phase, "replanning");
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.status, "open");
    assert.equal(readState(cwd).loop!.builder!.history!.at(-1)!.tasks[0]!.id, "combat-task");
    assert.match(readState(cwd).loop!.builder!.feedback.at(-1)!, /interior point/);
    assert.equal(pi.sent.filter(s => s.message.customType === "glla-project-blockers").length, 0);
    const external = { kind: "external", reason: "Access unavailable", summary: "Missing external access", owner: "Operator", nextAction: "Supply access", expectedResult: "Probe succeeds", whyAgentCannotProceed: "Operator controls the account" };
    await pi.runTool("block_project_requirement", { ...external, id: "api" }, ctx);
    assert.equal(readState(cwd).loop!.active, true, "remaining repair work proceeds around external dependency");
    await pi.runTool("block_project_requirement", { ...external, id: "combat" }, ctx);
    assert.equal(readState(cwd).loop!.active, false, "all external dependencies still hold");
    await pi.runTool("block_project_requirement", repair, ctx); clearLoopTimer();
    assert.equal(readState(cwd).loop!.active, true, "correcting a mistaken blocker releases only the blocker hold");
    assert.equal(readState(cwd).loop!.builder!.requirements[1]!.status, "blocked");
    assert.equal(readState(cwd).loop!.builder!.requirements[0]!.evidence, undefined);
    await pi.runTool("plan_project_increment", { tasks: [{ id: "probe", text: "Run positioning probe", requirementIds: ["combat"] }] }, ctx);
    assert.equal(readState(cwd).loop!.builder!.phase, "building");
    await pi.command("loop", "pause", ctx);
    await pi.runTool("block_project_requirement", { ...external, id: "combat" }, ctx);
    assert.match(readState(cwd).loop!.stopReason!, /paused by user/, "recording a dependency cannot overwrite a user hold");
    await pi.runTool("block_project_requirement", repair, ctx); clearLoopTimer();
    assert.equal(readState(cwd).loop!.active, false, "repair classification cannot override a user pause");
    assert.match(readState(cwd).loop!.stopReason!, /paused by user/);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
