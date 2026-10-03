import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { __testOnlyResetProcessState, __testOnlyLoadState } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, seedLoop } from "./harness/mock-pi.js";
import { HELD_ON_RESTORE } from "../extensions/goal-loop-forever.js";
import { readState } from "../extensions/goal-loop-core.js";
afterEach(() => __testOnlyResetProcessState());
function boot(state: Parameters<typeof seedState>[1]) {
 __testOnlyResetProcessState();
 const pi = new MockPi(); activate(pi.api);
 const cwd = tmpCwd(); seedState(cwd, state); __testOnlyLoadState(cwd);
 const ctx = makeMockCtx(cwd, { sessionManager: { name: "ui-command-review" } });
 return { pi, ctx };
}
test("held loop status preserves its meaning and names the actual resume command", async () => {
 const { pi, ctx } = boot({ loop: seedLoop({ active: false, stopReason: HELD_ON_RESTORE }) });
 const before = readState(ctx.cwd);
 await pi.command("loop", "status", ctx);
 const text = ctx.ui.notifies.map(n => n.message).join("\n");
 assert.match(text, /Loop: held/); assert.match(text, /\/loop resume/);
 assert.deepEqual(readState(ctx.cwd), before, "inspecting a held loop must not resume it");
});
test("compact settling status reports archive debt instead of worker silence", async () => {
 const ago = new Date(Date.now() - 3600000).toISOString();
 const { pi, ctx } = boot({ goal: seedGoal({ status: "auditing", pendingCompletion: { phase: "settling", at: ago, startedAt: ago, verdictAt: ago, attemptId: "stored-approval" } }) });
 await pi.command("glla", "status", ctx);
 const text = ctx.ui.notifies.map(n => n.message).join("\n");
 assert.match(text, /archive owed/); assert.doesNotMatch(text, /no progress/);
});
test("paused goal status includes its saved next action without inventing one", async () => {
 const { pi, ctx } = boot({ goal: seedGoal({ status: "paused", pauseKind: "blocked", pauseReason: "Verification failed", pauseSuggestedAction: "Resolve the failing check, then /goal resume" }) });
 await pi.command("goal", "status", ctx);
 assert.match(ctx.ui.notifies.map(n => n.message).join("\n"), /Next: Resolve the failing check, then \/goal resume/);
});
