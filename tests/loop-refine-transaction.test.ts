// A confirmed loop refinement is all-or-nothing across the spec file and
// live loop state. Inject an unwritable spec target and prove no RAM/durable
// target/measure/history mutation is reported as applied.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedLoop, seedState, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const original = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: MockCtx } | null = null;

afterEach(() => {
  session = null;
  fs.writeFileSync(GLOBAL, original);
});

test("failed spec refinement leaves loop state unchanged", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL, JSON.stringify({ autoAcceptDrafts: true, aggressiveMode: false }));
  const specFile = path.join(cwd, "SPEC.md");
  fs.writeFileSync(specFile, "# Spec\n- [ ] old item\n");
  const originalLoop = seedLoop({
    active: true,
    target: "old target",
    measureCmd: "echo 1",
    direction: "max",
    bestValue: 5,
    lastValue: 5,
    iteration: 3,
    specFile,
  });
  seedState(cwd, { loop: originalLoop });
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const { __testOnlyLoadState } = await import("../extensions/loops/goal.js");
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  (globalThis as any).extensionApi = pi.api;
  __testOnlyRegisterAgentTools(pi.api);
  pi.execHandler = () => ({ code: 0, stdout: "2", stderr: "" });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "refine-transaction" } });
  __testOnlyRememberCtx(ctx as never);
  session = { pi, ctx };

  // A directory at the spec path makes read/write fail without changing the
  // original file bytes (remove file, create same-name directory).
  fs.rmSync(specFile);
  fs.mkdirSync(specFile);

  const res = await pi.runTool("propose_loop_refine", {
    target: "new target",
    measureCmd: "echo 2",
    specText: "# replacement",
    rationale: "sharpen scope",
  }, ctx);
  assert.match(res.content[0]!.text, /No loop state changed/i);
  const after = readState(cwd).loop as { target: string; measureCmd?: string; bestValue?: number; refinements?: unknown[] };
  assert.equal(after.target, "old target");
  assert.equal(after.measureCmd, "echo 1");
  assert.equal(after.bestValue, 5);
  assert.deepEqual(after.refinements ?? [], []);
});
