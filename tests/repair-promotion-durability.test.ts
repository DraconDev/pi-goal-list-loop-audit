// Repair items are actionable replacements: their target metadata and head
// order must be the same durable shape in the sidecar and the state ledger.
// Reload must not screen the malformed original first, and an existing repair
// must be promoted durably too.

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
import {
  readQueueFromDisk,
  readState,
  writeQueueItemFile,
  type ListItem,
} from "../extensions/goal-loop-core.js";
import { compareQueueItems } from "../extensions/goal-loop-core.js";
import { buildRepairTaskObjective, assessSuspiciousObjective } from "../extensions/faulty-objective-recovery.js";
import { MockPi, makeMockCtx, seedState, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const originalGlobal = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: MockCtx } | null = null;

async function toolHarness(cwd: string) {
  fs.writeFileSync(GLOBAL, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `repair-promotion-${Date.now()}` } });
  __testOnlyRememberCtx(ctx as never);
  session = { pi, ctx };
  return { pi, ctx };
}

afterEach(() => {
  session = null;
  fs.writeFileSync(GLOBAL, originalGlobal);
});

test("a new repair item is durable at the head with target metadata in its first write", async () => {
  const cwd = tmpCwd();
  const malformed: ListItem = {
    id: "malformed-source",
    objective: "Item: every DECIDE finding has been recorded and surfaced",
    addedAt: "2026-09-20T10:00:00.000Z",
    queueOrder: 5,
  };
  seedState(cwd, { list: [malformed] });
  writeQueueItemFile(cwd, malformed);
  const { pi, ctx } = await toolHarness(cwd);
  const assessment = assessSuspiciousObjective(malformed.objective);
  assert.equal(assessment.suspicious, true);

  const res = await pi.runTool("list_activate", { n: 1 }, ctx);
  assert.match(res.content[0]!.text, /safe repair item was queued in its place/);
  const disk = readQueueFromDisk(cwd, new Set());
  assert.equal(disk.length, 2);
  const repair = disk[0]!;
  assert.equal(repair.objective, buildRepairTaskObjective({ policy: "list", objective: malformed.objective } as any, assessment));
  assert.equal(repair.repairTarget?.id, malformed.id);
  assert.ok((repair.queueOrder ?? 0) < (malformed.queueOrder ?? 0));
  assert.deepEqual([...disk].sort(compareQueueItems)[0]?.id, repair.id);
  assert.deepEqual(disk, readQueueFromDisk(cwd, new Set()), "sidecar is reload-stable");
});

test("list_activate hydrates a disk-only queue before resolving the requested position", async () => {
  const cwd = tmpCwd();
  const item: ListItem = { id: "disk-only", objective: "Recover this queued item", addedAt: "2026-09-23T00:00:00.000Z" };
  writeQueueItemFile(cwd, item);
  // Simulate the stale/torn-ledger shape: RAM has no queue, but the sidecar
  // is durable. The tool used to validate position #1 before hydration.
  seedState(cwd, { list: [] });
  const { pi, ctx } = await toolHarness(cwd);

  const res = await pi.runTool("list_activate", { n: 1 }, ctx);
  assert.match(res.content[0]!.text, /activated/i);
  assert.equal(readState(cwd).goal?.objective, item.objective);
  assert.equal(readQueueFromDisk(cwd, new Set([readState(cwd).goal!.id])).length, 0, "hydrated item sidecar consumed once");
});

test("an equivalent repair already in the queue is promoted to the durable head", async () => {
  const cwd = tmpCwd();
  const malformed: ListItem = {
    id: "malformed-existing",
    objective: "Item: every DECIDE finding has been recorded and surfaced",
    addedAt: "2026-09-20T10:00:00.000Z",
    queueOrder: 4,
  };
  const repairObjective = buildRepairTaskObjective({ policy: "list", objective: malformed.objective } as any, assessSuspiciousObjective(malformed.objective));
  const existingRepair: ListItem = {
    id: "existing-repair",
    objective: repairObjective,
    addedAt: "2026-09-20T10:01:00.000Z",
    queueOrder: 9,
  };
  seedState(cwd, { list: [malformed, existingRepair] });
  writeQueueItemFile(cwd, malformed);
  writeQueueItemFile(cwd, existingRepair);
  const { pi, ctx } = await toolHarness(cwd);

  const res = await pi.runTool("list_activate", { n: 1 }, ctx);
  assert.match(res.content[0]!.text, /safe repair item was queued in its place/);
  const disk = readQueueFromDisk(cwd, new Set()).sort(compareQueueItems);
  assert.equal(disk[0]?.id, existingRepair.id);
  assert.equal(disk[0]?.repairTarget?.id, malformed.id);
  assert.ok((disk[0]!.queueOrder ?? 0) < (malformed.queueOrder ?? 0));
  assert.equal(readQueueFromDisk(cwd, new Set()).length, 2, "promotion replaces rather than duplicates");
});
