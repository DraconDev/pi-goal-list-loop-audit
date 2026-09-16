import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick, type MockCtx } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.js";

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
  await pi.fire("agent_end", ended("Which search backend should we use? Please describe your requirements."), ctx);
  await tick(100);
  assert.equal(pi.userMessages.length, sent);
  assert.equal(readState(ctx.cwd).goal, null, "draft does not activate work");
});

test("field screenshot: answered promise-only draft emits one visible notice, never a retry", async () => {
  const ctx = await draft();
  const sent = pi.userMessages.length;
  const custom = pi.sent.length;
  const notices = () => ctx.ui.notifies.filter(n => n.message.includes("Drafting needs attention"));
  const event = ended("Two final policy choices will make the implementation contract concrete:");
  await pi.fire("agent_end", event, ctx);
  await tick(100);
  assert.equal(notices().length, 1, "unfinished handoff is visible");
  await pi.fire("agent_end", event, ctx);
  await pi.fire("tool_result", { toolName: "ask_user_question", details: { cancelled: false, answers: ["yes"] } }, ctx);
  await pi.fire("agent_end", event, ctx);
  assert.equal(notices().length, 1, "replays and later answers cannot repeat the notice in this draft");
  assert.equal(pi.userMessages.length, sent, "no synthetic user send");
  assert.equal(pi.sent.length, custom, "no alternate-channel continuation");
  assert.equal(readState(ctx.cwd).goal, null, "draft remains unactivated");
});

for (const details of [{ cancelled: true, answers: [] }, {}, { cancelled: false, answers: [] }]) {
  test(`cancelled or missing answer suppresses stale handoff evidence: ${JSON.stringify(details)}`, async () => {
    const ctx = await draft();
    await pi.fire("tool_result", { toolName: "ask_user_question", details }, ctx);
    await pi.fire("agent_end", ended("Two final policy choices will make the implementation contract concrete:"), ctx);
    assert.equal(ctx.ui.notifies.filter(n => n.message.includes("Drafting needs attention")).length, 0);
  });
}
