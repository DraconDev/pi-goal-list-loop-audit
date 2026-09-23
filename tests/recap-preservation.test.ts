// pi-goal-list-loop-audit — 2026-09-16 whole-work recap pin
//
// Field concern: after an auditor disapproval and a repair re-claim, the
// terminal summary read like the last repair step was the whole story.
// The whole-work recap from the ORIGINAL claim must survive into the
// approved terminal render and the archive record; the auditor's
// correction is context, not the headline.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry } from "../extensions/loops/goal-activation.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";

const pi = new MockPi(); activate(pi.api);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function waitFor(check: () => boolean, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error("settlement timeout"); await new Promise(r => setTimeout(r, 20)); }
}

const WHOLE_WORK = "Outcome: Shipped the search rollout end to end.\nChanged: search.ts and 3 call sites.\nEvidence: rollout doc plus full suite (/var/tmp/original-full-suite.log), commit abc123456; " + "long evidence ".repeat(1000) + "\nTests: bun test 2223 pass, 0 fail.\nUnresolved: none.\nNext: none.";

function auditorBinary(cwd: string, verdict: "approved" | "disapproved", report: string): string {
  const binary = path.join(cwd, `auditor-${verdict}.mjs`);
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"tool_execution_start",toolCallId:"read",toolName:"read",args:{path:"README.md"}});
emit({type:"tool_execution_end",toolCallId:"read"});
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:${JSON.stringify(verdict === "approved" ? "<evidence>pinned</evidence>\n<approved/>" : report + "\n<disapproved/>")}}});
emit({type:"agent_settled"});
}, 250); });`);
  fs.chmodSync(binary, 0o700);
  return binary;
}

test("repair re-claim preserves the whole-work recap in the approved render", { timeout: 25000 }, async () => {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  __testOnlyResetZombieAutoRetry(); __testOnlyResetZombieRunWatchdog();
  const cwd = tmpCwd(); resetContinuationDispatchState(cwd);
  const entries: any[] = [];
  const file = path.join(cwd, "session.jsonl");
  const mkCtx = () => makeMockCtx(cwd, { idle: true, sessionManager: { getBranch: () => entries, getSessionFile: () => file } });
  const previous = process.env.GLLA_PI_BINARY;
  const original = pi.api.sendMessage;
  const install = (binary: string) => {
    process.env.GLLA_PI_BINARY = binary;
  };
  const ctx = mkCtx();
  const originalSend = pi.api.sendMessage;
  pi.api.sendMessage = (message, options) => {
    originalSend(message, options);
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
  await pi.command("goal", "ship the search rollout — done when pinned", ctx);

  // First claim: the whole-work recap. The auditor disapproves one edge.
  install(auditorBinary(cwd, "disapproved", "Fix the empty-query edge case before shipping."));
  await pi.runTool("complete_goal", { completionSummary: WHOLE_WORK, verificationSummary: "pinned" }, ctx);
  await waitFor(() => readState(cwd).goal?.auditHistory?.at(-1)?.disapproved === true);
  assert.equal(readState(cwd).goal?.status, "active");

  // Repair turn: the agent re-claims after fixing the edge case. The new
  // claim text carries ONLY the correction (the field failure); the
  // whole-work recap from the first claim must still lead the terminal
  // render and survive in the archive.
  const DELTA_ONLY = "Outcome: Fixed the empty-query edge case.\nChanged: search.ts edge guard.\nEvidence: edge-case suite.\nTests: bun test 8 pass, 0 fail.\nUnresolved: none.\nNext: none.";
  await pi.runTool("complete_goal", { completionSummary: DELTA_ONLY, verificationSummary: "pinned" }, ctx);
  await waitFor(() => (readState(cwd).goal?.auditHistory?.filter(v => v.disapproved).length ?? 0) === 2);
  // A second repair must not replace the original whole-work claim.
  const STRUCTURED_REPAIR = DELTA_ONLY.replace("Fixed the empty-query edge case.", "Repaired another edge.\n## Guard\nTightened the guard.\n## Proof\nChecked the edge.");
  install(auditorBinary(cwd, "approved", ""));
  await pi.runTool("complete_goal", { completionSummary: STRUCTURED_REPAIR, verificationSummary: "pinned" }, ctx);
  await waitFor(() => entries.length === 1);
  const chat = entries[0]!.content as string;
  assert.match(chat, /^## Done — Shipped the search rollout end to end/);
  assert.match(chat, /• auditor approved/);
  assert.match(chat, /Shipped the search rollout end to end/, "the whole-work outcome leads the repair-approved render");
  assert.match(chat, /### Verification\n2 passed\./, "the whole-work verification survives as a compact aggregate");
  assert.doesNotMatch(chat, /2223 pass/, "test counts are supporting evidence, not the main chat narrative");
  assert.match(chat, /rollout doc plus full suite/, "the whole-work evidence survives");
  // Archive parity: the durable record's rich terminal section must carry
  // the same whole-work lead, not just the delta-only repair claim.
  const record = (chat.match(/• record: (\S+\.md)/) ?? [])[1];
  assert.ok(record, "chat carries the archive record pointer");
  const archiveMd = fs.readFileSync(path.join(cwd, record), "utf-8");
  assert.match(archiveMd, /## Terminal summary/);
  assert.ok(archiveMd.includes(WHOLE_WORK), "original raw claim is archived verbatim, without truncation or stripping");
  assert.doesNotMatch(chat.split("\n")[0]!, /Repaired another edge/);
  assert.match(archiveMd, /Shipped the search rollout end to end/, "the whole-work recap survives into the archived terminal section");
  assert.match(archiveMd, /2223 pass/, "the whole-work proof survives into the archive");
  assert.ok(JSON.parse(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8").trim().split("\n").at(-1)!));
});
