import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyGetSubagentRpcGeneration } from "../extensions/goal-heartbeat.js";
import { MockPi, makeMockCtx, tick, tmpCwd } from "./harness/mock-pi.js";

afterEach(() => { __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

test("S6: a claim-raised session generation re-binds the subagent RPC host", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  // A predecessor owned this root at generation 41: the claim must adopt 42
  // (previousGeneration + 1), raising the boot-time generation.
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi-glla", "session-owner.json"),
    JSON.stringify({ pid: process.pid - 1, at: new Date(Date.now() - 60_000).toISOString(), generation: 41, ownerSessionId: "predecessor-session" }),
  );
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `s6-rebind-${Math.random()}` } });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120);
    const runtime = globalThis as typeof globalThis & { sessionGeneration: number };
    assert.equal(runtime.sessionGeneration, 42, "the claim raised the session generation");
    assert.equal(__testOnlyGetSubagentRpcGeneration(), 42, "the RPC stop capability re-bound to the claimed generation (pre-fix it kept the boot-time generation and every stop read stale)");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
