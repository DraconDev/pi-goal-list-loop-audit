// propose_task_list is a transaction: the task list / repair redraft must be
// durable before any success message or repair-source consumption. A pending
// sessionDir gives a deterministic write-boundary failure without touching
// repository permissions or mutating a shared settings file.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { setRuntimeSessionDir } from "../extensions/goal-loop-core.js";
import { writeQueueItemFile } from "../extensions/goal-loop-core.js";
import {
  MockPi,
  makeMockCtx,
  seedGoal,
  seedState,
  tmpCwd,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const originalGlobal = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: MockCtx } | null = null;

function writePendingSessionDirSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-task-pending-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ stateRoot: "sessionDir", aggressiveMode: false }));
  process.env.GLLA_GLOBAL_SETTINGS_PATH = file;
  setRuntimeSessionDir(undefined);
  return dir;
}

async function boot(cwd: string, goal = seedGoal({ status: "active", objective: "Persist this task list" })) {
  fs.writeFileSync(GLOBAL, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, { goal, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyLoadState(cwd);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `task-persist-${Date.now()}` } });
  __testOnlyRememberCtx(ctx);
  __testOnlyRegisterAgentTools(pi.api);
  ctx.ui.confirmImpl = async () => true;
  ctx.ui.selectImpl = async (_title, options) => options[0];
  ctx.ui.customStubMode = true;
  session = { pi, ctx };
  return { pi, ctx };
}

afterEach(async () => {
  session = null;
  setRuntimeSessionDir(undefined);
  fs.writeFileSync(GLOBAL, originalGlobal);
});

test("normal task-list proposal reports failure and stores no task list", async () => {
  const cwd = tmpCwd();
  const { pi, ctx } = await boot(cwd);
  setRuntimeSessionDir(undefined);
  const prior = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const globalDir = writePendingSessionDirSettings();
  try {
    const before = ctx.ui.notifies.length;
    const res = await pi.runTool("propose_task_list", {
      tasks: [{ title: "Must not land" }],
    }, ctx);
    assert.match(res.content[0]!.text, /Task list was not persisted/);
    assert.ok(ctx.ui.notifies.slice(before).some((notice) => notice.message.includes("Persistence degraded")));
    // The live object may be RAM-only under degradation, but the confirmed
    // behavior is that no success response is emitted. Reload from the last
    // durable line proves the task list was not consumed as accepted.
    const cwdState = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(cwdState, /"title":"Must not land"/);
  } finally {
    if (prior === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = prior;
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});

test("repair proposal preserves the source sidecar and queue when the task list cannot persist", async () => {
  const cwd = tmpCwd();
  const sourceId = "source-fragment";
  const source = { id: sourceId, objective: "Item: every DECIDE finding has been recorded", addedAt: new Date().toISOString() };
  const goal = seedGoal({
    status: "active",
    policy: "list",
    objective: "Repair the blocked list item from saved intent",
    repairTarget: {
      id: sourceId,
      objective: source.objective,
      reasons: ["verification-fragment"],
      source: "list-activation",
    },
  });
  const { pi, ctx } = await boot(cwd, goal);
  writeQueueItemFile(cwd, source);
  const prior = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const globalDir = writePendingSessionDirSettings();
  try {
    const res = await pi.runTool("propose_task_list", {
      objective: "Restore a durable task list for the blocked queue item",
      tasks: [{ title: "Must not consume source" }],
    }, ctx);
    assert.match(res.content[0]!.text, /Repair task list was not persisted/);
    assert.equal(fs.existsSync(path.join(cwd, ".pi-glla", "queue", `${sourceId}.json`)), true, "source sidecar survives");
    const durable = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(durable, /faulty_objective_source_consumed/);
    assert.doesNotMatch(durable, /Must not consume source/);
  } finally {
    if (prior === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = prior;
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});
