import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlySetContinuationRetryBackoff,
  __testOnlySetContinuationStartTimeout,
} from "../extensions/loops/goal.js";
import {
  clearContinuationStartSelfHeal,
  resetContinuationDispatchState,
} from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

let lastCwd = "";
afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  resetContinuationDispatchState(lastCwd);
  clearContinuationStartSelfHeal();
  __testOnlySetContinuationStartTimeout(null);
  __testOnlySetContinuationRetryBackoff(null);
  pi.sent.length = 0;
});

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the unacknowledged settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("unacknowledged park with broken storage warns instead of claiming safety", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(400);
  __testOnlySetContinuationRetryBackoff(400);
  const cwd = tmpCwd();
  lastCwd = cwd;
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  const ctx: MockCtx = makeMockCtx(cwd, { sessionManager: { name: `unack-durability-${Date.now()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("goal", "unacknowledged durability target — done when pinned", ctx);
    await tick();
    // Let the dispatch and its one automatic retry land while storage is healthy.
    await waitUntil(() => pi.sent.length >= 2);
    // Break durable storage before the watchdog settles the park.
    const line = path.join(cwd, ".pi-glla", "active.jsonl");
    fs.rmSync(line, { force: true });
    fs.mkdirSync(line, { recursive: true });
    await waitUntil(() => ctx.ui.notifies.some((n) => n.message.includes("no observable turn-start")));
    const notices = ctx.ui.notifies.map((n) => n.message).join("\n");
    assert.match(notices, /could not be fully persisted/, "the park proves it landed before claiming safety");
    assert.doesNotMatch(notices, /The work is safe in \.pi-glla/, "no unconditional safety claim on degraded storage");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
