// pi-goal-list-loop-audit — current pi-subagents integration polish

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAgentOverrideMd,
  resolveEffectiveSubagentModel,
  syncSubagentModelOverrides,
  isSafeManagedAgentName,
  OVERRIDABLE_AGENT_TYPES,
} from "../extensions/goal-loop-subagents.ts";
import { isSubagentProviderFailure } from "../extensions/quota-retry.ts";

test("current pi-subagents roles expose complete model-pin definitions", () => {
  assert.deepEqual([...OVERRIDABLE_AGENT_TYPES].sort(), ["Designer", "delegate", "oracle", "researcher", "reviewer", "scout", "worker"]);
  const worker = buildAgentOverrideMd("worker", "minimax/MiniMax-M3");
  assert.match(worker, /model: minimax\/MiniMax-M3/);
  assert.match(worker, /systemPromptMode: replace/);
  assert.match(worker, /defaultContext: fork/);
  assert.match(worker, /x-managed-by: pi-goal-list-loop-audit/);
});

test("strategy-driven sync writes only the GLLA-owned Designer role", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subagent-"));
  const sync = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(sync.written, ["Designer"]);
  assert.ok(fs.existsSync(path.join(dir, "agents", "Designer.md")));
  assert.ok(!fs.existsSync(path.join(dir, "agents", "scout.md")), "scout already inherits the parent in current pi-subagents");
  const sync2 = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: { scout: "minimax/MiniMax-M3" } });
  assert.deepEqual(sync2.written, ["scout"]);
  assert.match(fs.readFileSync(path.join(dir, "agents", "scout.md"), "utf-8"), /model: minimax\/MiniMax-M3/);
});

test("managed sync rejects path traversal from settings and corrupt sync state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subagent-traversal-"));
  const agents = path.join(dir, "agents");
  fs.mkdirSync(agents, { recursive: true });
  const outside = path.join(dir, "outside.md");
  fs.writeFileSync(outside, "x-managed-by: pi-goal-list-loop-audit\nuser data\n");
  fs.writeFileSync(path.join(agents, ".glla-subagent-sync.json"), JSON.stringify({ written: ["../outside"] }));
  const sync = syncSubagentModelOverrides({
    agentDir: dir,
    strategy: "inherit-parent",
    overrides: { "../outside": "provider/model" },
  });
  assert.equal(fs.existsSync(outside), true, "corrupt state cannot unlink outside agents/");
  assert.equal(fs.existsSync(path.join(dir, "outside.md")), true);
  assert.ok(sync.skipped.some((row) => row.name.includes("..")));
  assert.equal(isSafeManagedAgentName("scout"), true);
  for (const unsafe of ["../outside", "a/b", "a\\b", "..", ".", "a\0b"]) {
    assert.equal(isSafeManagedAgentName(unsafe), false, unsafe);
  }
});

test("repair detection: externally deleted/altered Designer files are re-written and flagged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subagent-repair-"));
  const first = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(first.written, ["Designer"]);
  assert.deepEqual(first.repaired, []);
  const noop = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(noop.written, []);
  const syncState = JSON.parse(fs.readFileSync(path.join(dir, "agents", ".glla-subagent-sync.json"), "utf8"));
  assert.deepEqual(syncState.written, ["Designer"]);
  fs.unlinkSync(path.join(dir, "agents", "Designer.md"));
  const second = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(second.written, ["Designer"]);
  assert.deepEqual(second.repaired, ["Designer"]);
  fs.appendFileSync(path.join(dir, "agents", "Designer.md"), "\n# user scribble\n");
  const third = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(third.repaired, ["Designer"]);
});

test("effective resolution: per-type pin > inherit-parent > current agent default", () => {
  assert.equal(
    resolveEffectiveSubagentModel("worker", { subagentModelOverrides: { worker: "x/y" } }, "p/s"),
    "x/y (per-type pin)",
  );
  assert.equal(
    resolveEffectiveSubagentModel("worker", { subagentModelStrategy: "inherit-parent" }, "p/s"),
    "p/s (inherits session)",
  );
  assert.equal(
    resolveEffectiveSubagentModel("scout", { subagentModelStrategy: "agent-default" }),
    "(agent default)",
  );
});

test("subagent provider failure: any failed Agent payload, without classification", () => {
  assert.equal(isSubagentProviderFailure("Agent", true, "Error: 403 Key limit exceeded"), true);
  assert.equal(isSubagentProviderFailure("Agent", true, JSON.stringify({ error: "429 rate limit" })), true);
  assert.equal(isSubagentProviderFailure("Agent", true, "file not found"), true);
  assert.equal(isSubagentProviderFailure("Agent", false, "403 Key limit exceeded"), false);
  assert.equal(isSubagentProviderFailure("bash", true, "403 Key limit exceeded"), false);
});

test("v0.38.16: failed current-tool spawns take the provider-failure path too", () => {
  assert.equal(isSubagentProviderFailure("subagent", true, "Error: 403 Key limit exceeded"), true);
  assert.equal(isSubagentProviderFailure("subagent_wait", true, "launch failed: no model available"), true);
  assert.equal(isSubagentProviderFailure("subagent", false, "Error: 403 Key limit exceeded"), false);
  assert.equal(isSubagentProviderFailure("bash", true, "Error: 403 Key limit exceeded"), false);
});

test("v0.38.16: model-facing text speaks the current subagent dialect", () => {
  for (const file of [
    "prompts/goal-loop-forever.md",
    "prompts/goal-loop-forever-metricless.md",
    "prompts/goal-loop-continuation.md",
  ]) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /`Agent`/, `${file} no longer names the dead tintinweb tool`);
    assert.match(text, /`subagent`/, `${file} names the current tool`);
  }
  const continuation = fs.readFileSync("prompts/goal-loop-continuation.md", "utf8");
  assert.doesNotMatch(continuation, /get_subagent_result/, "settle guidance no longer names the dead wait tool");
  assert.match(continuation, /bg_wait/, "settle guidance names the live wait");
  const availableTools = continuation.match(/## Available tools[\s\S]*?## EXECUTION DISCIPLINE/)?.[0] ?? "";
  assert.match(availableTools, /`bg_wait`/, "the declared tool grant includes the wait primitive used below");
  const panel = fs.readFileSync("extensions/goal-agents-panel.ts", "utf8");
  assert.match(panel, /via the `subagent` tool/, "agents panel points at the live tool");
  const continuationSrc = fs.readFileSync("extensions/goal-continuation.ts", "utf8");
  assert.match(continuationSrc, /Use the `subagent` tool with agent `Designer`/, "designer checkpoint uses the live tool");
});
