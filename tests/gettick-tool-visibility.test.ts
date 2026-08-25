// pi-goal-list-loop-audit — v0.35.60
// Regression coverage for the gettick-stuck field report:
// an external tool allowlist could remove glla tools after session_start, so
// the model's valid pause_goal call was answered "Tool pause_goal not found"
// and the interrupted objective remained parked until a reload.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";


test("v0.35.60: glla tools are reactivated at the pre-turn boundary", async () => {
  __testOnlyResetOwnerSession();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "gettick-main-session" } });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const api = pi.api as any;
    assert.ok(api.getActiveTools().includes("pause_goal"), "session_start initially exposes pause_goal");

    // Simulate a modlist/allowlist extension replacing the active tool set
    // after lifecycle restore but before the next model turn.
    api.setActiveTools(["read", "write"]);
    pi.tools.clear();
    assert.ok(!api.getActiveTools().includes("pause_goal"));
    assert.equal(pi.tools.has("pause_goal"), false, "the simulated replacement also reset Pi's tool registry");

    await pi.fire("before_agent_start", {
      type: "before_agent_start",
      prompt: "continue the parked objective",
      systemPrompt: "",
      systemPromptOptions: {},
    }, ctx);

    assert.ok(api.getActiveTools().includes("pause_goal"), "pre-turn self-heal restores pause_goal before the model runs");
    assert.ok(pi.tools.has("pause_goal"), "pre-turn self-heal re-registers definitions after a replacement registry reset");
    const result = await pi.runTool("pause_goal", { reason: "visibility probe", kind: "blocked" }, ctx);
    assert.equal(result.content[0]?.text, "No active goal.", "the restored tool is callable rather than missing");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    __testOnlyResetOwnerSession();
  }
});
