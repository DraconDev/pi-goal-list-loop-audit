// pi-goal-list-loop-audit — current pi-subagents role override contract

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAgentOverrideMd,
  defaultAgentDir,
  CURRENT_SUBAGENT_AGENT_NAMES,
  KNOWN_PINNED_DEFAULT_AGENTS,
  OVERRIDABLE_AGENT_TYPES,
  SCOUT_DEFAULT_DESCRIPTION,
  SCOUT_DEFAULT_TOOLS,
  SUBAGENT_MANAGED_MARKER,
  syncSubagentModelOverrides,
} from "../extensions/goal-loop-subagents.ts";

function tmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-subagents-"));
}

function readOverride(agentDir: string, name: string): string | undefined {
  const file = path.join(agentDir, "agents", `${name}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
}

function installedAgent(name: string): string {
  const local = path.resolve("node_modules", "pi-subagents", "agents", `${name}.md`);
  assert.ok(fs.existsSync(local), `current pi-subagents definition is installed: ${name}`);
  return fs.readFileSync(local, "utf-8");
}

test("current package roles are the model override surface", () => {
  assert.deepEqual([...CURRENT_SUBAGENT_AGENT_NAMES], ["delegate", "oracle", "researcher", "reviewer", "scout", "worker"]);
  assert.deepEqual([...OVERRIDABLE_AGENT_TYPES], [...CURRENT_SUBAGENT_AGENT_NAMES, "Designer"]);
  assert.deepEqual([...KNOWN_PINNED_DEFAULT_AGENTS], []);
});

test("build: current scout definition is preserved and uses current frontmatter names", () => {
  const source = installedAgent("scout");
  const md = buildAgentOverrideMd("scout");
  assert.equal(/^model:/m.test(md), false, "no model pin is needed for inherit-parent");
  assert.ok(md.includes(`x-managed-by: ${SUBAGENT_MANAGED_MARKER}`));
  assert.ok(md.includes(`description: ${SCOUT_DEFAULT_DESCRIPTION}`));
  assert.ok(md.includes(`tools: ${SCOUT_DEFAULT_TOOLS}`));
  assert.match(md, /^systemPromptMode: replace$/m);
  assert.doesNotMatch(md, /^prompt_mode:/m);
  assert.ok(md.includes(source.split("---\n").slice(2).join("---\n").trim()), "the upstream scout prompt is not lost");
});

test("build: an explicit worker pin preserves its complete upstream definition", () => {
  const md = buildAgentOverrideMd("worker", "minimax/MiniMax-M3");
  assert.match(md, /^name: worker$/m);
  assert.match(md, /^model: minimax\/MiniMax-M3$/m);
  assert.match(md, /^defaultContext: fork$/m);
  assert.match(md, /^tools: read, grep, find, ls, bash, edit, write, contact_supervisor$/m);
  assert.ok(md.includes(`x-managed-by: ${SUBAGENT_MANAGED_MARKER}`));
});

test("build: unknown agent name throws", () => {
  assert.throws(() => buildAgentOverrideMd("Custom"), /no embedded default config/);
});

test("sync: no upstream model pin means only the GLLA Designer role is created", () => {
  const dir = tmpAgentDir();
  const result = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent" });
  assert.deepEqual(result.written, ["Designer"]);
  assert.equal(readOverride(dir, "scout"), undefined);
  assert.match(readOverride(dir, "Designer")!, /^systemPromptMode: replace$/m);
});

test("sync: explicit current-role pin wins over strategy and is idempotent", () => {
  const dir = tmpAgentDir();
  const first = syncSubagentModelOverrides({ agentDir: dir, strategy: "agent-default", overrides: { scout: "minimax/MiniMax-M3" } });
  assert.deepEqual(first.written, ["Designer", "scout"]);
  assert.match(readOverride(dir, "scout")!, /^model: minimax\/MiniMax-M3$/m);
  const second = syncSubagentModelOverrides({ agentDir: dir, strategy: "agent-default", overrides: { scout: "minimax/MiniMax-M3" } });
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.removed, []);
});

test("sync: clearing a current-role pin removes only GLLA-owned content", () => {
  const dir = tmpAgentDir();
  syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: { scout: "minimax/MiniMax-M3" } });
  const result = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent" });
  assert.deepEqual(result.removed, ["scout"]);
  assert.equal(readOverride(dir, "scout"), undefined);
  assert.ok(readOverride(dir, "Designer"));
});

test("sync: user-owned current role is never overwritten", () => {
  const dir = tmpAgentDir();
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  const file = path.join(dir, "agents", "scout.md");
  const userContent = "---\nname: scout\ndescription: my own scout\n---\n\nuser prompt\n";
  fs.writeFileSync(file, userContent);
  const result = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: { scout: "minimax/MiniMax-M3" } });
  assert.ok(result.skipped.some((entry) => entry.name === "scout"));
  assert.equal(fs.readFileSync(file, "utf-8"), userContent);
});

test("sync: legacy managed files are cleaned only when marked", () => {
  const dir = tmpAgentDir();
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  const legacy = path.join(dir, "agents", "Explore.md");
  fs.writeFileSync(legacy, "---\nx-managed-by: pi-goal-list-loop-audit\n---\n\nlegacy\n");
  const user = path.join(dir, "agents", "Plan.md");
  const userContent = "---\ndescription: mine\n---\n\nuser\n";
  fs.writeFileSync(user, userContent);
  const result = syncSubagentModelOverrides({ agentDir: dir, strategy: "agent-default" });
  assert.deepEqual(result.removed, ["Explore"]);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(user, "utf-8"), userContent);
});

test("sync: missing or altered Designer definitions are repaired and flagged", () => {
  const dir = tmpAgentDir();
  const first = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent" });
  assert.deepEqual(first.repaired, []);
  fs.unlinkSync(path.join(dir, "agents", "Designer.md"));
  const second = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent" });
  assert.deepEqual(second.repaired, ["Designer"]);
  fs.appendFileSync(path.join(dir, "agents", "Designer.md"), "\n# external edit\n");
  const third = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent" });
  assert.deepEqual(third.repaired, ["Designer"]);
});

test("defaultAgentDir follows PI_CODING_AGENT_DIR when the host overrides it", () => {
  const prior = process.env.PI_CODING_AGENT_DIR;
  const custom = path.join(os.tmpdir(), "glla-custom-agent-dir");
  process.env.PI_CODING_AGENT_DIR = custom;
  try { assert.equal(defaultAgentDir(), custom); }
  finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
  }
});

test("drift: every current built-in ships without a hidden model pin", () => {
  for (const name of CURRENT_SUBAGENT_AGENT_NAMES) {
    const content = installedAgent(name);
    assert.doesNotMatch(content, /^model:/m, `${name} unexpectedly pins a model`);
  }
  assert.equal(SCOUT_DEFAULT_DESCRIPTION, "Fast codebase recon that returns compressed context for handoff");
  assert.equal(SCOUT_DEFAULT_TOOLS, "read, grep, find, ls, bash, write");
});

test("build+sync: a thinking pin writes a thinking-only override that inherits the model", () => {
  const md = buildAgentOverrideMd("scout", undefined, "high");
  assert.match(md, /^thinking: high$/m, "the thinking key lands in frontmatter");
  assert.equal(/^model:/m.test(md), false, "no model pin — the session model is inherited");
  assert.match(md, /thinking pinned to high by glla subagentThinkingOverrides/, "the managed note names the source");

  const dir = tmpAgentDir();
  const first = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", thinking: { Designer: "high" } });
  assert.ok(first.written.includes("Designer"), "a thinking-only Designer pin materializes");
  const designer = readOverride(dir, "Designer")!;
  assert.match(designer, /^thinking: high$/m);
  assert.equal(/^model:/m.test(designer), false, "Designer still inherits the session model");

  const second = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", thinking: { Designer: "high" } });
  assert.equal(second.written.length, 0, "re-sync is idempotent");

  const cleared = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent" });
  assert.ok(cleared.written.includes("Designer"), "clearing the pin rewrites the inherit-model file");
  assert.doesNotMatch(readOverride(dir, "Designer")!, /^thinking:/m, "the thinking key is gone");
});
