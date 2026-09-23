// Draft/refine measure preflights validate process success as well as numeric
// stdout. A failed command that happens to print a number must not establish a
// false baseline or pass the user Confirm.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedLoop, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const originalGlobal = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: MockCtx } | null = null;

async function harness(cwd: string, autoResume: boolean) {
  fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume, aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `measure-exit-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick(50);
  session = { pi, ctx };
  return { pi, ctx };
}

afterEach(async () => {
  if (session) {
    const current = session;
    session = null;
    await current.pi.fire("session_shutdown", { reason: "test-end" }, current.ctx);
  }
  fs.writeFileSync(GLOBAL, originalGlobal);
});

test("propose_loop_draft rejects non-zero measure output even when stdout is numeric", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: false, stopReason: "paused by user (/loop pause)" }) });
  const { pi, ctx } = await harness(cwd, false);
  // Enter the production loop-drafting gate and satisfy the interview floor.
  await pi.command("loop", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
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
  const { pi, ctx } = await harness(cwd, true);
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
