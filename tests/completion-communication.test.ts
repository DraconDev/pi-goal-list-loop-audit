import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry } from "../extensions/loops/goal-activation.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { readState, archiveIntentPath } from "../extensions/goal-loop-core.js";
import { approvalRenderStorePath } from "../extensions/approval-render-store.js";
import { MockPi, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";

const pi = new MockPi(); activate(pi.api);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
const summary = "Outcome: Fixed routing.\nChanged: router.ts.\nEvidence: routing fixture.\nTests: routing suite passed.\nUnresolved: none.\nNext: await audit.";
async function waitFor(check: () => boolean, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error("settlement timeout"); await new Promise(r => setTimeout(r, 20)); }
}
async function setup(verdict: "approved" | "disapproved", idle = true) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  __testOnlyResetZombieAutoRetry(); __testOnlyResetZombieRunWatchdog();
  const cwd = tmpCwd(); resetContinuationDispatchState(cwd);
  const binary = path.join(cwd, "auditor.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"tool_execution_start",toolCallId:"read",toolName:"read",args:{path:"README.md"}});
emit({type:"tool_execution_end",toolCallId:"read"});
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:${JSON.stringify(verdict === "approved" ? "<evidence>pinned</evidence>\n<approved/>" : "Fix routing edge case.\n<disapproved/>")}}});
emit({type:"agent_settled"});
}, 350); });`);
  fs.chmodSync(binary, 0o700);
  const previous = process.env.GLLA_PI_BINARY; process.env.GLLA_PI_BINARY = binary;
  const entries: any[] = [];
  const file = path.join(cwd, "session.jsonl");
  const ctx = makeMockCtx(cwd, { idle, sessionManager: { getBranch: () => entries, getSessionFile: () => file } });
  const original = pi.api.sendMessage;
  pi.api.sendMessage = (message, options) => {
    original(message, options);
    if (options?.triggerTurn === false) {
      const entry = { type: "custom_message", id: String(entries.length), ...message };
      entries.push(entry); fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    }
  };
  cleanup = async () => {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    resetContinuationDispatchState(cwd); __testOnlyResetZombieRunWatchdog(); __testOnlyResetZombieAutoRetry();
    pi.api.sendMessage = original;
    if (previous === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = previous;
  };
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return { cwd, ctx, entries };
}

for (const idle of [true, false]) test(`pending is nonterminal; approval delivers durable concrete summary (idle=${idle})`, async () => {
  const { cwd, ctx, entries } = await setup("approved", idle);
  await pi.command("goal", "fix routing — done when pinned", ctx);
  const result = await pi.runTool("complete_goal", { completionSummary: summary, verificationSummary: "pinned" }, ctx) as any;
  assert.match(result.content[0].text, /AUDIT PENDING — nonterminal/);
  assert.doesNotMatch(result.content[0].text, /Do not (claim|give|wait)/, "pending states facts, never agent imperatives (field 2026-09-08)");
  assert.match(result.content[0].text, /Ending this turn now is correct/, "pending names the correct next step");
  assert.deepEqual(result.details, { status: "audit-pending", terminal: false });
  assert.equal(result.terminate, true, "stop the acknowledgement-only batch, not the goal");
  assert.equal(readState(cwd).goal?.status, "auditing");
  assert.equal(entries.length, 0);
  await waitFor(() => readState(cwd).goal === null);
  assert.equal(entries.length, 1);
  assert.match(entries[0].content, /^## Done — Fixed routing/);
  assert.match(entries[0].content, /1\. \*\*Changed\*\* — router\.ts/);
  assert.match(entries[0].content, /\| Tests \| PASS \| routing suite passed/);
  assert.doesNotMatch(entries[0].content, /Next:|await audit|Acknowledge briefly/);
  assert.match(entries[0].content, /• auditor approved \(1 verdict\)\./);
  assert.ok(JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), "utf8"))[0].deliveredAt);
  assert.equal(ctx.ui.matching("## Done").length, 0, "no duplicate toast summary");
  await pi.fire("agent_settled", {}, ctx);
  await pi.command("goal", "status", ctx);
  assert.equal(entries.length, 1, "settle and contact do not duplicate summary");
});

test("complete_goal leftOut renders the deliberate-non-do bullet end to end", async () => {
  const { ctx, entries } = await setup("approved");
  await pi.command("goal", "fix routing — done when pinned", ctx);
  await pi.runTool("complete_goal", { completionSummary: summary, verificationSummary: "pinned", leftOut: "the walkthrough artifact surface" }, ctx);
  await waitFor(() => entries.length === 1);
  assert.equal(entries.length, 1);
  assert.match(entries[0].content, /- \*\*Left out\*\* — the walkthrough artifact surface/);
  const lines = entries[0].content.split("\n");
  assert.ok(lines.every((l: string) => l.startsWith("## ") || l.startsWith("### ") || l.startsWith("• ") || l === "" || /^\d+\. \*\*/.test(l) || l.startsWith("| ") || l.startsWith("- **")), "posted summary is one rich voice: headline, sections, table, trailer");
  const numbered = lines.filter((l: string) => /^\d+\. \*\*/.test(l));
  assert.ok(numbered.length >= 1 && numbered.length <= 8, `posted summary carries numbered findings plus the trailer, got ${numbered.length}`);
  assert.ok(lines[lines.length - 1]!.startsWith("• record:"), "record pointer stays last");
});

test("disapproval remains unfinished, no final success is posted", async () => {
  const { cwd, ctx, entries } = await setup("disapproved");
  await pi.command("goal", "fix routing — done when pinned", ctx);
  await pi.runTool("complete_goal", { completionSummary: summary, verificationSummary: "pinned" }, ctx);
  await waitFor(() => readState(cwd).goal?.auditHistory?.at(-1)?.disapproved === true);
  assert.equal(readState(cwd).goal?.status, "active");
  assert.equal(entries.length, 0);
  assert.equal(fs.existsSync(approvalRenderStorePath(cwd)), false);
});

test("archive write failure never emits a terminal success", async () => {
  const { cwd, ctx, entries } = await setup("approved");
  await pi.command("goal", "fix routing — done when pinned", ctx);
  await pi.runTool("complete_goal", { completionSummary: summary, verificationSummary: "pinned" }, ctx);
  // Block the archive-intent write while leaving live state writable.
  fs.mkdirSync(archiveIntentPath(cwd));
  await waitFor(() => readState(cwd).goal?.status === "paused");
  assert.match(readState(cwd).goal?.pauseReason ?? "", /archive persistence failed/);
  assert.equal(entries.length, 0);
  assert.equal(fs.existsSync(approvalRenderStorePath(cwd)), false);
});

test("approval summary does not replace independent next-item continuation", { timeout: 25000 }, async () => {
  const { cwd, ctx, entries } = await setup("approved");
  await pi.runTool("list_add", { items: ["first item — done when pinned", "second item — done when pinned"] }, ctx);
  await pi.runTool("complete_goal", { completionSummary: summary, verificationSummary: "pinned" }, ctx);
  await waitFor(() => readState(cwd).goal?.objective.includes("second item") === true);
  const nextId = readState(cwd).goal!.id;
  assert.equal(readState(cwd).goal?.status, "active");
  assert.equal(entries.length, 1);
  await waitFor(() => pi.sent.some(s => s.message.content?.includes(nextId) && (s.options as any)?.triggerTurn !== false), 20000);
});

test("outbox write failure warns without claiming summary delivery", async () => {
  const { cwd, ctx, entries } = await setup("approved");
  await pi.command("goal", "fix routing — done when pinned", ctx);
  fs.mkdirSync(approvalRenderStorePath(cwd));
  await pi.runTool("complete_goal", { completionSummary: summary, verificationSummary: "pinned" }, ctx);
  await waitFor(() => readState(cwd).goal === null);
  assert.equal(entries.length, 0);
  assert.ok(ctx.ui.matching("chat summary could not be persisted").length > 0);
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /"terminal_completion_notice_sent"/);
});
