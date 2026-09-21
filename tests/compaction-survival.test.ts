// pi-goal-list-loop-audit — v0.38.75
// tests/compaction-survival.test.ts
//
// Compaction chaos: multi-hour runs live or die at context compaction.
// Unit coverage exists for projection shape, in-flight suppression, and
// settle probes — but nothing proved a goal still COMPLETES after real
// session_compact events land mid-run. These tests fire genuine compacts
// (ledger, resync arming, settle timers and all) and then drive the full
// detached-audit completion flow.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const APPROVE_REPORT = "<evidence>pinned</evidence>\n<approved/>";

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function writeApprovingAuditor(cwd: string): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = ${JSON.stringify(APPROVE_REPORT)};
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
`);
  fs.chmodSync(script, 0o700);
  return script;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for post-compaction completion");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function bootActive(cwd: string): Promise<{ pi: MockPi; ctx: MockCtx }> {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, autoResume: true }));
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal", objective: "chaos objective — done when pinned" }) });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `compaction-survival-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return { pi, ctx };
}

test("compaction survival: three mid-run compacts, then the goal still completes approved", async () => {
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeApprovingAuditor(cwd);
  const { pi, ctx } = await bootActive(cwd);
  try {
    for (let i = 0; i < 3; i++) {
      await pi.fire("session_compact", {}, ctx);
      await tick(100);
    }
    assert.equal(readState(cwd).goal?.status, "active", "compactions must not wedge or park the goal");
    assert.equal(ledgerTypes(cwd).filter((t) => t === "session_compact").length, 3);
    await pi.runTool("complete_goal", { completionSummary: "Chaos done.", verificationSummary: "pinned." }, ctx);
    await waitUntil(() => {
      const types = ledgerTypes(cwd);
      return types.includes("goal_archived") && readState(cwd).goal === null;
    });
    const archived = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; value?: { status?: string } })
      .find((e) => e.type === "goal_archived");
    assert.equal(archived?.value?.status, "complete");
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("compaction survival: a compact around an in-flight audit still completes", async () => {
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeApprovingAuditor(cwd);
  const { pi, ctx } = await bootActive(cwd);
  try {
    await pi.runTool("complete_goal", { completionSummary: "Chaos done.", verificationSummary: "pinned." }, ctx);
    // Lands mid-audit or just after the verdict — either way the run must
    // survive it: no wedge, no lost audit, completion preserved.
    await pi.fire("session_compact", {}, ctx);
    await waitUntil(() => {
      const types = ledgerTypes(cwd);
      return types.includes("goal_archived") && readState(cwd).goal === null;
    });
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
