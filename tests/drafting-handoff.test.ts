import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick, type MockCtx } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.js";
import { DRAFT_HANDOFF_CORRECTION } from "../extensions/drafting-handoff.js";

const pi = new MockPi();
activate(pi.api);
const manager = { name: "draft-handoff-session" };
let current: MockCtx | undefined;
afterEach(async () => {
  if (current) {
    // Exit via the real command path so the singleton draft gate cannot leak.
    await pi.command("goal", "start fixture cleanup. Done when: verified", current);
    await pi.command("goal", "cancel", current);
    await pi.fire("session_shutdown", { reason: "quit" }, current);
  }
  current = undefined;
  __testOnlyResetOwnerSession();
});

async function draft() {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd, { sessionManager: manager });
  current = ctx;
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.command("list", "Improve the search experience", ctx);
  await pi.fire("message_start", { message: { role: "user", content: "injected seed" } }, ctx);
  await pi.fire("tool_result", { toolName: "ask_user_question", details: { cancelled: false, answers: ["Website backend only"] } }, ctx);
  return ctx;
}

function ended(text: string) {
  return { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] };
}

test("draft-only handoff: a real question waits without an autonomous retry", async () => {
  const ctx = await draft();
  const sent = pi.userMessages.length;
  const custom = pi.sent.length;
  await pi.fire("agent_end", ended("Which search backend should we use? Please describe your requirements."), ctx);
  await tick(2800);
  assert.equal(pi.userMessages.length, sent);
  assert.equal(pi.sent.length, custom);
  assert.equal(readState(ctx.cwd).goal, null, "draft does not activate work");
});

test("field screenshot: answered promise-only draft delivers exactly one corrective follow-up", { timeout: 15000 }, async () => {
  const ctx = await draft();
  const sent = pi.userMessages.length;
  const custom = pi.sent.length;
  const event = ended("Two final policy choices will make the implementation contract concrete:");
  await pi.fire("agent_end", event, ctx);
  await tick(2800);
  assert.equal(pi.sent.length, custom + 1);
  assert.deepEqual(pi.sent.at(-1), {
    message: { customType: "draft-handoff-correction", content: DRAFT_HANDOFF_CORRECTION, display: true },
    options: { deliverAs: "followUp", triggerTurn: true },
  });
  await pi.fire("agent_end", event, ctx);
  await pi.fire("tool_result", { toolName: "ask_user_question", details: { cancelled: false, answers: ["yes"] } }, ctx);
  await pi.fire("agent_end", event, ctx);
  await tick(2800);
  assert.equal(pi.userMessages.length, sent, "correction never impersonates a human answer");
  assert.equal(pi.sent.length, custom + 1, "replays and later answers cannot repeat the correction");
  assert.equal(readState(ctx.cwd).goal, null, "draft remains unactivated");
});

for (const details of [{ cancelled: true, answers: [] }, {}, { cancelled: false, answers: [] }]) {
  test(`cancelled or missing answer suppresses stale handoff evidence: ${JSON.stringify(details)}`, async () => {
    const ctx = await draft();
    const sent = pi.sent.length;
    await pi.fire("tool_result", { toolName: "ask_user_question", details }, ctx);
    await pi.fire("agent_end", ended("Two final policy choices will make the implementation contract concrete:"), ctx);
    await tick(2800);
    assert.equal(pi.sent.length, sent);
  });
}

for (const action of ["cancel", "user", "busy", "pending", "shutdown", "new-draft"] as const) {
  test(`pending draft correction stands down on ${action}`, async () => {
    const ctx = await draft();
    const custom = pi.sent.length;
    await pi.fire("agent_end", ended("Two final policy choices will make the implementation contract concrete:"), ctx);
    if (action === "cancel") await pi.fire("tool_result", { toolName: "ask_user_question", details: { cancelled: true, answers: [] } }, ctx);
    if (action === "user") await pi.fire("message_start", { message: { role: "user", content: "Wait, change scope" } }, ctx);
    if (action === "busy") ctx.isIdle = () => false;
    if (action === "pending") ctx.hasPendingMessages = () => true;
    if (action === "shutdown") await pi.fire("session_shutdown", { reason: "reload" }, ctx);
    if (action === "new-draft") await pi.command("list", "Improve a different search experience", ctx);
    await tick(2800);
    assert.equal(pi.sent.length, custom, "no stale corrective send");
    ctx.isIdle = () => true;
    ctx.hasPendingMessages = () => false;
  });
}
