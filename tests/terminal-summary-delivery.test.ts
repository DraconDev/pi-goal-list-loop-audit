import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { deliverTerminalSummary } from "../extensions/terminal-summary-delivery.js";
import { approvalRenderStorePath, persistApprovalRender, replayUndeliveredApprovalRenders } from "../extensions/approval-render-store.js";
import { tmpCwd } from "./harness/mock-pi.js";
import { MAX_RENDER_CHAT_LINES, MAX_RENDER_LINE_CHARS, MAX_TERMINAL_RECEIPT_BYTES } from "../extensions/terminal-summary-limits.js";

function host(cwd = tmpCwd()) {
  const file = path.join(cwd, "session.jsonl");
  const entries: any[] = [];
  const calls: any[] = [];
  let persist = true;
  let hasFile = true;
  const ctx = { cwd, sessionManager: { getBranch: () => entries, getSessionFile: () => hasFile ? file : undefined } };
  const pi = { sendMessage(message: any, options: any) {
    calls.push({ message, options });
    const entry = { type: "custom_message", id: String(calls.length), ...message };
    entries.push(entry); // Pi mutates branch before disk, even on write failure.
    if (persist && hasFile) fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } };
  const deliver = (goalId = "g1", content = "✓ done — fixed routing\nTests: routing suite passed\n— auditor approved.") =>
    deliverTerminalSummary(ctx as never, pi as never, "goal-event", goalId, content);
  return { cwd, ctx, pi, file, entries, calls, deliver, setPersist: (v: boolean) => { persist = v; }, setFile: (v: boolean) => { hasFile = v; } };
}

for (const idle of [true, false]) test(`visible summary persists without an LLM turn (idle=${idle})`, () => {
  const h = host();
  Object.assign(h.ctx, { isIdle: () => idle });
  assert.equal(h.deliver(), true);
  assert.equal(h.calls[0].message.display, true);
  assert.deepEqual(h.calls[0].options, { triggerTurn: false });
  assert.equal(h.deliver(), true);
  assert.equal(h.calls.length, 1);
});

test("branch-before-persist failure stays pending, suppresses duplicate, later persistence confirms", () => {
  const h = host(); h.setPersist(false);
  assert.equal(h.deliver(), false);
  assert.equal(h.deliver(), false);
  assert.equal(h.calls.length, 1);
  fs.writeFileSync(h.file, JSON.stringify(h.entries[0]) + "\n");
  assert.equal(h.deliver(), true);
  assert.equal(h.calls.length, 1);
});

test("no-file session never acknowledges but does not repeat the visible summary", () => {
  const h = host(); h.setFile(false);
  assert.equal(h.deliver(), false);
  assert.equal(h.deliver(), false);
  assert.equal(h.calls.length, 1);
});

test("outbox survives failed delivery and restart; acknowledged render never replays", () => {
  const h = host(); h.setPersist(false);
  const chatLines = ["✓ done — fixed routing", "Tests: routing suite passed", "— auditor approved."];
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "fix routing", chatLines });
  const replay = (target: ReturnType<typeof host>) => replayUndeliveredApprovalRenders(target.ctx, e => target.deliver(e.goalId, e.chatLines.join("\n")));
  assert.equal(replay(h), 0);
  assert.equal(JSON.parse(fs.readFileSync(approvalRenderStorePath(h.cwd), "utf8"))[0].deliveredAt, undefined);
  const restarted = host(h.cwd);
  assert.equal(replay(restarted), 1);
  assert.equal(replay(restarted), 0);
  assert.equal(restarted.calls.length, 1);
  // A repeated settlement cannot enqueue the same goal again.
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "fix routing", chatLines });
  assert.equal(replay(restarted), 0);
});

test("failed outbox acknowledgement does not duplicate an existing persisted branch summary", () => {
  const h = host(); assert.equal(h.deliver(), true);
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "routing", chatLines: h.calls[0].message.content.split("\n") });
  assert.equal(replayUndeliveredApprovalRenders(h.ctx, e => h.deliver(e.goalId, e.chatLines.join("\n"))), 1);
  assert.equal(h.calls.length, 1);
});

test("confirmation requires exact identity/content and complete JSONL, tolerates malformed tail", () => {
  const h = host(); h.setPersist(false); h.deliver();
  const entry = h.entries[0];
  for (const wrong of [{ ...entry, content: "other" }, { ...entry, id: "other" }, { ...entry, details: { terminalApprovalGoalId: "other" } }]) {
    fs.writeFileSync(h.file, JSON.stringify(wrong) + "\n");
    assert.equal(h.deliver(), false);
  }
  fs.writeFileSync(h.file, JSON.stringify(entry));
  assert.equal(h.deliver(), false, "partial trailing record is not confirmed");
  fs.writeFileSync(h.file, JSON.stringify(entry) + "\n{partial");
  assert.equal(h.deliver(), true);
});

test("bounded confirmation fails conservatively when receipt is outside tail", () => {
  const h = host(); assert.equal(h.deliver(), true);
  fs.appendFileSync(h.file, "x".repeat(MAX_TERMINAL_RECEIPT_BYTES + 1) + "\n");
  assert.equal(h.deliver(), false);
  assert.equal(h.calls.length, 1);
});

for (const character of ["x", "😀", "\u0000", "\\"]) {
  test(`maximum supported outbox receipt is acknowledged (${JSON.stringify(character)})`, () => {
    const h = host();
    const chatLines = Array(MAX_RENDER_CHAT_LINES).fill(character.repeat(MAX_RENDER_LINE_CHARS));
    assert.equal(persistApprovalRender(h.cwd, { goalId: "maximum-card", objective: "receipt", chatLines }), true);
    assert.equal(replayUndeliveredApprovalRenders(h.ctx, e => h.deliver(e.goalId, e.chatLines.join("\n"))), 1);
    assert.ok(fs.statSync(h.file).size < MAX_TERMINAL_RECEIPT_BYTES);
    assert.equal(replayUndeliveredApprovalRenders(h.ctx, e => h.deliver(e.goalId, e.chatLines.join("\n"))), 0);
    assert.equal(h.calls.length, 1);
  });
}

test("failed outbox acknowledgement write retries without resending the visible message", () => {
  const h = host();
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "routing", chatLines: ["✓ done — routing"] });
  const tmp = approvalRenderStorePath(h.cwd) + ".tmp";
  fs.mkdirSync(tmp);
  const replay = () => replayUndeliveredApprovalRenders(h.ctx, e => h.deliver(e.goalId, e.chatLines.join("\n")));
  assert.equal(replay(), 1);
  assert.equal(JSON.parse(fs.readFileSync(approvalRenderStorePath(h.cwd), "utf8"))[0].deliveredAt, undefined);
  fs.rmdirSync(tmp);
  assert.equal(replay(), 1);
  assert.equal(replay(), 0);
  assert.equal(h.calls.length, 1);
});

test("current settlement is not starved by older unconfirmed renders", () => {
  const h = host();
  for (let i = 0; i < 8; i++) persistApprovalRender(h.cwd, { goalId: `g${i}`, objective: "routing", chatLines: [`✓ done — routing ${i}`] });
  assert.equal(replayUndeliveredApprovalRenders(h.ctx, e => h.deliver(e.goalId, e.chatLines.join("\n")), "g7"), 1);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].message.content, /routing 7/);
});

test("persistently unconfirmed head rotates so a later render is attempted", () => {
  const h = host();
  for (let i = 0; i < 6; i++) persistApprovalRender(h.cwd, { goalId: `g${i}`, objective: "routing", chatLines: [`✓ done — routing ${i}`] });
  // The first five never confirm; only the sixth can land. Without fair
  // rotation the oldest-five window would pin the head forever and g5
  // would never be attempted in this session.
  const attempted: string[] = [];
  const replay = () => replayUndeliveredApprovalRenders(h.ctx, (e) => {
    attempted.push(e.goalId);
    return e.goalId === "g5" ? h.deliver(e.goalId, e.chatLines.join("\n")) : false;
  });
  assert.equal(replay(), 0);
  assert.deepEqual(attempted, ["g0", "g1", "g2", "g3", "g4"]);
  assert.equal(replay(), 1, "the sixth render is attempted on the next contact");
  assert.ok(attempted.includes("g5"));
  const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(h.cwd), "utf8"));
  assert.equal(stored.length, 6, "rotation drops no entry");
  assert.ok(stored.find((e: { goalId: string }) => e.goalId === "g5").deliveredAt !== undefined);
  assert.equal(stored.filter((e: { deliveredAt?: string }) => e.deliveredAt === undefined).length, 5);
});

test('host sendMessage reentrant enqueue remains pending after confirmed session delivery', () => {
  const h = host();
  persistApprovalRender(h.cwd, { goalId: 'first', objective: 'first', chatLines: ['first'] });
  const send = h.pi.sendMessage;
  let enqueued = false;
  h.pi.sendMessage = (message, options) => {
    if (!enqueued) {
      enqueued = true;
      assert.equal(persistApprovalRender(h.cwd, { goalId: 'second', objective: 'second', chatLines: ['second'] }), true);
    }
    send(message, options);
  };
  const replay = () => replayUndeliveredApprovalRenders(h.ctx, entry => h.deliver(entry.goalId, entry.chatLines.join('\n')));
  assert.equal(replay(), 1);
  const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(h.cwd), 'utf8'));
  assert.equal(stored.length, 2);
  assert.equal(stored.find((e: any) => e.goalId === 'second').deliveredAt, undefined);
  assert.equal(replay(), 1);
  assert.equal(replay(), 0);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(c => c.message.content), ['first', 'second']);
});
