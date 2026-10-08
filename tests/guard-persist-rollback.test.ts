import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import { __testOnlyLoadState } from "../extensions/loops/goal-ui.js";
import { guardGoalBeforeContinuation } from "../extensions/goal-continuation.js";
import { state } from "../extensions/goal-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MockPi, makeMockCtx, seedState, seedGoal, tmpCwd, tick } from "./harness/mock-pi.js";

afterEach(() => { __testOnlyResetProcessState(); });

const SUSPICIOUS = "Rework result filtering into quiet automatic mode. Evidence: tsc clean, 666 tests pass.";

test("guard with broken storage holds the dispatch and rolls memory back to active", async () => {
  __testOnlyResetProcessState();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "guard-rollback" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(100);
  // Seed after startup settles so no startup dispatch pauses the goal first.
  seedState(cwd, { goal: seedGoal({ status: "active", objective: SUSPICIOUS }) });
  __testOnlyLoadState(cwd);
  assert.equal(state.goal?.status, "active");
  // Break durable storage before the guard stages its pause/repair.
  const line = path.join(cwd, ".pi-glla", "active.jsonl");
  fs.rmSync(line, { force: true });
  fs.mkdirSync(line, { recursive: true });
  const ok = guardGoalBeforeContinuation(ctx as unknown as ExtensionContext, "test-guard-rollback");
  await tick(50);
  assert.equal(ok, false, "dispatch is held when the guard cannot persist");
  assert.equal(state.goal?.status, "active", "memory rolls back instead of diverging from disk");
  assert.ok(ctx.ui.notifies.some((n) => n.message.includes("could not persist")), "the hold names persistence, not the heuristic");
});
