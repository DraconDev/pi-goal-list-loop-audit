import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "./extensions/loops/goal.js";
import { readState } from "./extensions/goal-loop-core.js";
import { guardGoalBeforeContinuation, resetContinuationDispatchState } from "./extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick } from "./tests/harness/mock-pi.js";
import { __testOnlyResetZombieAutoRetry } from "./extensions/loops/goal-activation.js";
import { __testOnlyResetZombieRunWatchdog } from "./extensions/goal-heartbeat.js";

test("debug suspicious audit settle", async () => {
  const pi = new MockPi(); activate(pi.api);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  __testOnlyResetZombieAutoRetry(); __testOnlyResetZombieRunWatchdog();
  const cwd = tmpCwd(); resetContinuationDispatchState(cwd);
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "Rework result filtering into quiet automatic mode. Evidence: tsc clean, 666 tests pass." }), list: [] });
  const binary = path.join(cwd, "auditor.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"tool_execution_start",toolCallId:"read",toolName:"read",args:{path:"README.md"}});
emit({type:"tool_execution_end",toolCallId:"read"});
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"<evidence>pinned</evidence>\\n<approved/>"}});
emit({type:"agent_settled"});
}, 350); });`);
  fs.chmodSync(binary, 0o700);
  process.env.GLLA_PI_BINARY = binary;
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "dbg" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  console.log("guard:", guardGoalBeforeContinuation(ctx, "dispatch"));
  const r = await pi.runTool("complete_goal", { completionSummary: "Outcome: x.\nChanged: y.\nEvidence: z.\nTests: t.\nUnresolved: none.\nNext: none.", verificationSummary: "pinned" }, ctx) as any;
  console.log("claim:", r.content[0].text.slice(0, 120));
  for (let i = 0; i < 8; i++) {
    await new Promise(rr => setTimeout(rr, 1000));
    const g = readState(cwd).goal;
    console.log(`t=${i+1}s status=`, g?.status ?? null, "phase=", (g?.pendingCompletion as any)?.phase ?? "-");
    if (!g) break;
  }
  const lines = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").trim().split("\n");
  console.log("LEDGER KEY:", lines.filter(l => /verdict|disapprov|approv|auditor|repair|replan|complete_goal|settle|pause/i.test(l)).join("\n").slice(0, 5000));
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  delete process.env.GLLA_PI_BINARY;
});
