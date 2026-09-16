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

test("field screenshot: answered draft ending with promised questions needs one bounded handoff", async () => {
  const ctx = await draft();
  const sent = pi.userMessages.length;
  await pi.fire("agent_end", ended("Two final policy choices will make the implementation contract concrete:"), ctx);
  await tick(100);
  assert.equal(pi.userMessages.length, sent + 1, "GLLA should request the missing question, not leave an invisible wait");
  assert.equal(readState(ctx.cwd).goal, null, "repair is still drafting, never execution");
});
