// A repair goal must not detach from its source when durable source-sidecar
// deletion fails. Re-attaching repairTarget is a contract write, so verify
// the retry path remains attached after a reload.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState, writeQueueItemFile } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const original = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: MockCtx } | null = null;

afterEach(() => {
  session = null;
  fs.writeFileSync(GLOBAL, original);
});

test("failed repair-source deletion restores the durable repair link", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL, JSON.stringify({ aggressiveMode: false }));
  const source = { id: "repair-source", objective: "restore the saved work", addedAt: new Date().toISOString() };
  const repairTarget = { id: source.id, objective: source.objective, reasons: ["suspicious"], source: "list-activation" as const };
  seedState(cwd, {
    goal: seedGoal({ status: "active", policy: "list", revision: 3, objective: "repair placeholder", repairTarget }),
    list: [source],
  });
  writeQueueItemFile(cwd, source);
  // Make the sidecar path a directory: lstat sees a durable entry, unlink
  // fails, and the runtime must take the fail-closed repair path.
  const sidecar = path.join(cwd, ".pi-glla", "goals", `${source.id}.queue.json`);
  fs.rmSync(sidecar, { force: true });
  fs.mkdirSync(sidecar, { recursive: true });

  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "repair-source-fail" } });
  (ctx.ui as any).confirmImpl = async () => true;
  __testOnlyRememberCtx(ctx as never);
  session = { pi, ctx };

  const res = await pi.runTool("propose_task_list", {
    objective: "Restore the saved work. Done when: focused tests pass",
    tasks: [{ title: "Implement" }],
  }, ctx);
  assert.match(res.content[0]!.text, /repair link was restored/i);
  const after = readState(cwd);
  assert.equal(after.goal?.revision, 4, "accepted redraft remains revision-bound");
  assert.equal(after.goal?.repairTarget?.id, source.id, "retry follows the same repair source");
  assert.ok(after.list?.some((item) => item.id === source.id), "source remains queued");
});
