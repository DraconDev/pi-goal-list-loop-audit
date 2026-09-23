// Draft/refine measure preflights validate process success as well as numeric
// stdout. A failed command that happens to print a number must not establish a
// false baseline or pass the user Confirm.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedLoop, seedState, tmpCwd, type MockCtx } from "./harness/mock-pi.js";
import { state } from "../extensions/goal-state.js";

/** Test bridge for the internal drafting target. It mirrors what the real
 * `/loop` no-arg command does before asking the model questions. */
function startLoopDraftingForTest(_ctx: MockCtx): void {
  state.goal = null;
  // The actual tool's own guard reads this process-global via the runtime
  // bridge. Setting it directly is intentionally test-only and local.
  (globalThis as any).draftingTarget = "loop";
  (globalThis as any).draftingUserReplies = 1;
}

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const originalGlobal = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: MockCtx } | null = null;

async function harness(cwd: string) {
  fs.writeFileSync(GLOBAL, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `measure-exit-${Date.now()}` } });
  // The harness API intentionally exposes tools, not slash commands. Install
  // the minimal real loop-entry bridge after ctx exists.
  (pi as unknown as { commands: Map<string, unknown> }).commands.set("loop", {
    handler: async () => { startLoopDraftingForTest(ctx); },
  });
  __testOnlyRememberCtx(ctx as never);
  session = { pi, ctx };
  return { pi, ctx };
}

afterEach(() => {
  session = null;
  fs.writeFileSync(GLOBAL, originalGlobal);
});

test("propose_loop_draft rejects non-zero measure output even when stdout is numeric", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: false, stopReason: "paused by user (/loop pause)" }) });
  const { pi, ctx } = await harness(cwd);
  // Enter the real loop drafting gate and satisfy the interview floor.
  await pi.command("loop", "", ctx);
  pi.execHandler = () => ({ code: 7, stdout: "42\n", stderr: "measure exploded" });

  const res = await pi.runTool("propose_loop_draft", {
    target: "numeric false baseline",
    measureCmd: "echo 42; exit 7",
    direction: "max",
  }, ctx);
  assert.match(res.content[0]!.text, /Measure test-run FAILED/);
  assert.match(res.content[0]!.text, /exited with code 7/);
});

test("propose_loop_refine rejects non-zero measure output and leaves the live loop unchanged", async () => {
  const cwd = tmpCwd();
  const original = seedLoop({
    active: true,
    target: "original target",
    measureCmd: "echo 1",
    direction: "max",
    bestValue: 10,
    lastValue: 10,
  });
  seedState(cwd, { loop: original });
  const { pi, ctx } = await harness(cwd);
  pi.execHandler = () => ({ code: 9, stdout: "99\n", stderr: "refine probe failed" });

  const res = await pi.runTool("propose_loop_refine", {
    target: "changed target",
    measureCmd: "echo 99; exit 9",
    rationale: "sharpen the metric",
  }, ctx);
  assert.match(res.content[0]!.text, /New measure command FAILED/);
  assert.match(res.content[0]!.text, /exited with code 9/);
  const current = JSON.parse(fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8").trim().split("\n").at(-1)!).value.loop;
  assert.equal(current.target, original.target);
  assert.equal(current.measureCmd, original.measureCmd);
  assert.equal(current.bestValue, original.bestValue);
});
