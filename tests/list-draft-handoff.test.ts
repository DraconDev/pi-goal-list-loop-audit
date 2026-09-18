import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick, type MockCtx } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.js";
import { DRAFT_HANDOFF_CORRECTION } from "../extensions/drafting-handoff.js";

const pi = new MockPi();
activate(pi.api);
const manager = { name: "list-draft-handoff-session" };
let current: MockCtx | undefined;
afterEach(async () => {
  if (current) {
    await pi.command("goal", "start fixture cleanup. Done when: verified", current);
    await pi.command("goal", "cancel", current);
    await pi.fire("session_shutdown", { reason: "quit" }, current);
  }
  current = undefined;
  __testOnlyResetOwnerSession();
});

/** Fresh drafting episode: grill guidance in effect, no Q&A yet. */
async function freshDraft() {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd, { sessionManager: manager });
  current = ctx;
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.command("list", "Improve the search experience", ctx);
  await pi.fire("message_start", { message: { role: "user", content: "injected seed" } }, ctx);
  return ctx;
}

/** Same, but one picker round already answered (interview evidence). */
async function answeredDraft() {
  const ctx = await freshDraft();
  await pi.fire("tool_result", { toolName: "ask_user_question", details: { cancelled: false, answers: ["Website backend only"] } }, ctx);
  return ctx;
}

function ended(text: string) {
  return { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] };
}

/** Field shape 125335: guidance present, no question asked, ends with commentary. */
const COMMENTARY_ALONE =
  "That self-check doesn't fit the current stage: we're drafting a list, not implementing changes yet. " +
  "We already have enough signal to choose priorities. " +
  "I also wouldn't add another storage item blindly — the existing title already covers it. " +
  "Requesting indexing before a change is deployed wouldn't verify anything.";

test("125335: fresh commentary-only draft end delivers exactly one bounded correction", { timeout: 15000 }, async () => {
  const ctx = await freshDraft();
  const sent = pi.userMessages.length;
  const custom = pi.sent.length;
  await pi.fire("agent_end", ended(COMMENTARY_ALONE), ctx);
  await tick(2800);
  assert.equal(pi.sent.length, custom + 1);
  assert.deepEqual(pi.sent.at(-1), {
    message: { customType: "draft-handoff-correction", content: DRAFT_HANDOFF_CORRECTION, display: true },
    options: { deliverAs: "followUp", triggerTurn: true },
  });
  await pi.fire("agent_end", ended(COMMENTARY_ALONE), ctx);
  await tick(2800);
  assert.equal(pi.userMessages.length, sent, "correction never impersonates a human answer");
  assert.equal(pi.sent.length, custom + 1, "replay cannot repeat the correction");
  assert.equal(readState(ctx.cwd).goal, null, "draft remains unactivated");
});

test("stated next dependent question is a legal drafting end: no correction", async () => {
  const ctx = await answeredDraft();
  const custom = pi.sent.length;
  await pi.fire(
    "agent_end",
    ended("Search backend settled — backend only, done this week. After you answer, I'll ask about the latency budget and where the index should live."),
    ctx,
  );
  await tick(2800);
  assert.equal(pi.sent.length, custom);
});

test("short ack without a question is not commentary: no correction", async () => {
  const ctx = await answeredDraft();
  const custom = pi.sent.length;
  await pi.fire("agent_end", ended("Understood."), ctx);
  await tick(2800);
  assert.equal(pi.sent.length, custom);
});

test("tool-unavailable fallback: the correction directs prose asking", () => {
  assert.match(DRAFT_HANDOFF_CORRECTION, /when available/i, "picker is conditional on availability");
  assert.match(DRAFT_HANDOFF_CORRECTION, /ask the genuinely free-form question in conversation/i);
});

test("confirmation gate untouched: correction never earns a proposal", { timeout: 15000 }, async () => {
  const ctx = await freshDraft();
  await pi.fire("agent_end", ended(COMMENTARY_ALONE), ctx);
  await tick(2800);
  const res = await pi.runTool("propose_goal_draft", { objective: "handoff must not earn this", verificationContract: "pinned" }, ctx);
  assert.match(String(res.content[0]?.text ?? ""), /repl|interview/i, "interview floor still blocks with zero user replies");
  assert.equal(readState(ctx.cwd).goal, null, "nothing created");
});
