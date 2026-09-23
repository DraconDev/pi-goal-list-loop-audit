// Field 2026-09-23: Pi emits session_compact_failed when a summary hits the
// output cap. GLLA must settle its in-flight marker immediately, rotate a
// configured larger-context model, or durably park work with /new + resume.
// Leaving the marker armed makes the UI claim WORKING/BUSY for up to 30m.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlySetCompactionInFlight,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tick, tmpCwd } from "./harness/mock-pi.ts";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const original = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: any } | null = null;

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function boot(cwd: string, settings: Record<string, unknown>, model = "provider/small") {
  fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume: true, aggressiveMode: false, ...settings }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `compact-fail-${Date.now()}-${Math.random()}` } });
  (ctx as any).model = { provider: model.split("/")[0], id: model.split("/")[1] };
  (ctx as any).modelRegistry = {
    find: (provider: string, id: string) => ({ provider, id }),
    hasConfiguredAuth: () => true,
  };
  (ctx as any).getContextUsage = () => ({ tokens: 202_000, contextWindow: 200_000, percent: 101 });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick(80);
  session = { pi, ctx };
  return { pi, ctx };
}

afterEach(async () => {
  if (session) {
    const current = session;
    session = null;
    __testOnlySetCompactionInFlight(null);
    await current.pi.fire("session_shutdown", { reason: "test-end" }, current.ctx).catch(() => {});
  }
  fs.writeFileSync(GLOBAL, original);
});

test("failed compaction settles in-flight state and rotates before any phantom rearm", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "survive failed compaction" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: ["provider/large"] });

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "overflow",
    errorMessage: "Context overflow recovery failed: Summarization failed: generation hit the token cap",
    aborted: false,
    willRetry: false,
    fromExtension: false,
  }, ctx);
  await tick(80);

  assert.ok(pi.modelSelections.length > 0, "configured larger-context fallback is selected");
  assert.ok(ledger(cwd).some((e) => e.type === "session_compact_failed"));
  assert.equal(ledger(cwd).filter((e) => e.type === "compaction_inflight_start").length, 1);
  assert.equal(ledger(cwd).filter((e) => e.type === "compaction_refire").length, 0, "no session_compact resume path was faked");
  const ctxAfter = (ctx as any);
  assert.equal(ctxAfter.isIdle(), true, "host returns idle after the failed compaction");
  assert.equal(readState(cwd).goal?.status, "active", "successful fallback keeps work moving");
});

test("failed compaction without a usable fallback parks an active goal durably", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "park after failed compaction" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: [] });

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "overflow",
    errorMessage: "Context overflow recovery failed: summary incomplete",
    aborted: false,
    willRetry: false,
  }, ctx);

  const goal = readState(cwd).goal as { status?: string; pauseKind?: string; pauseReason?: string; pauseSuggestedAction?: string };
  assert.equal(goal.status, "paused");
  assert.equal(goal.pauseKind, "blocked");
  assert.match(goal.pauseReason ?? "", /compaction failed/i);
  assert.match(goal.pauseSuggestedAction ?? "", /\/new[\s\S]*\/goal resume/);
  assert.equal(pi.sent.filter((s) => String(s.message.content ?? "").includes("[GOAL CHECKPOINT")).length, 0, "no impossible hot-context retry");
});

test("failed compaction parks a branch loop instead of leaving it active", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, iteration: 4, target: "loop survives compaction failure" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: [] });

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "threshold",
    errorMessage: "Auto-compaction failed: generation hit the token cap",
    aborted: false,
    willRetry: false,
  }, ctx);

  const loop = readState(cwd).loop as { active?: boolean; stopReason?: string; iteration?: number };
  assert.equal(loop.active, false);
  assert.match(loop.stopReason ?? "", /compaction failed/i);
  assert.equal(loop.iteration, 4, "history is preserved for /loop resume");
  assert.ok(ledger(cwd).some((e) => e.type === "loop_stopped" && e.value?.cause === "compaction_failed"));
});
