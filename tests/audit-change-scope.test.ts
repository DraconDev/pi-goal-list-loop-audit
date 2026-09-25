// pi-goal-list-loop-audit — v0.38.100
// tests/audit-change-scope.test.ts
//
// The audit must be pertinent to the changes: execution records the touched
// paths behind the fileWrites counter, and the detached-audit brief scopes
// itself to that change set (start there, not with open-ended exploration).
// The list scopes the START of the audit, never its boundary — subagent
// writes, shell redirections, and deletions bypass capture, so a fence
// would blind the audit instead of focusing it.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { state } from "../extensions/goal-state.js";
import {
  MAX_TELEMETRY_FILES,
  extractTelemetryFilePath,
  recordTelemetryFile,
  type Goal,
} from "../extensions/goal-loop-core.ts";
import { buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor.ts";
import { buildRecordedFactsCompletionSummary } from "../extensions/completion-summary.js";
import { MockPi, makeMockCtx, seedGoal, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

// ---- 1. the pure extractor pins the arg shapes ----

test("change-scope: extractor reads file_path/path and drops everything else", () => {
  assert.equal(extractTelemetryFilePath({ path: "src/a.ts" }), "src/a.ts");
  assert.equal(extractTelemetryFilePath({ file_path: "src/b.ts" }), "src/b.ts");
  assert.equal(extractTelemetryFilePath({ file_path: "src/c.ts", path: "src/d.ts" }), "src/c.ts", "file_path wins");
  assert.equal(extractTelemetryFilePath({ command: "bun test" }), undefined, "a command is not a touched path");
  assert.equal(extractTelemetryFilePath({ pattern: "foo" }), undefined, "a pattern is not a touched path");
  assert.equal(extractTelemetryFilePath({ path: 42 }), undefined, "non-strings are not paths");
  assert.equal(extractTelemetryFilePath({}), undefined);
  assert.equal(extractTelemetryFilePath(undefined), undefined);
  assert.equal(extractTelemetryFilePath("src/e.ts"), undefined, "a bare string is not an arg object");
  assert.equal(extractTelemetryFilePath({ path: "  " }), undefined, "blank paths are dropped");
  assert.equal(extractTelemetryFilePath({ path: "src/\nf.ts" }), "src/f.ts", "control chars are stripped, never kept");
  assert.equal(extractTelemetryFilePath({ path: "x".repeat(513) }), undefined, "over-long paths are dropped, never truncated");
  assert.equal(extractTelemetryFilePath({ path: "x".repeat(512) })?.length, 512, "the 512 boundary itself is kept");
});

// ---- 2. the recorder dedupes, orders, and caps ----

test("change-scope: recorder keeps first-seen order, dedupes, and counts overflow", () => {
  const t: NonNullable<Goal["telemetry"]> = { turns: 0, fileWrites: 0, bashCalls: 0 };
  recordTelemetryFile(t, "b.ts");
  recordTelemetryFile(t, "a.ts");
  recordTelemetryFile(t, "b.ts");
  assert.deepEqual(t.files, ["b.ts", "a.ts"]);
  assert.equal(t.filesOverflow, undefined, "no overflow below the cap");
  for (let i = 0; i < MAX_TELEMETRY_FILES; i++) recordTelemetryFile(t, `f${i}.ts`);
  assert.equal(t.files!.length, MAX_TELEMETRY_FILES);
  assert.equal(t.filesOverflow, 2, "the two paths past the cap count as overflow");
  assert.ok(!t.files!.includes("f99.ts"), "past-cap paths never enter the list");
});

// ---- 3. live capture on tool_call ----

async function activeGoalCtx(): Promise<{ pi: MockPi; ctx: MockCtx; cwd: string }> {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx: MockCtx = makeMockCtx(cwd, { sessionManager: { name: `change-scope-${Date.now()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.command("goal", "touched paths are recorded — done when pinned", ctx);
  return { pi, ctx, cwd };
}

test("change-scope: write tool calls record their paths on the active goal", async () => {
  const { pi, ctx } = await activeGoalCtx();
  try {
    await pi.fire("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }, ctx);
    await pi.fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { file_path: "src/b.ts" } }, ctx);
    await pi.fire("tool_call", { toolName: "multi_edit", toolCallId: "m1", args: { path: "src/c.ts" } }, ctx);
    await pi.fire("tool_call", { toolName: "write_file", toolCallId: "w2", input: { path: "src/a.ts" } }, ctx);
    await tick(50);
    assert.deepEqual(state.goal?.telemetry?.files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("change-scope: reads, bash, junk, and inactive goals record nothing", async () => {
  const { pi, ctx } = await activeGoalCtx();
  try {
    await pi.fire("tool_call", { toolName: "read", toolCallId: "r1", input: { file_path: "src/unread.ts" } }, ctx);
    await pi.fire("tool_call", { toolName: "bash", toolCallId: "b1", input: { command: "echo hi > src/shell.ts" } }, ctx);
    await pi.fire("tool_call", { toolName: "write", toolCallId: "w9", input: { command: "no path here" } }, ctx);
    await pi.fire("tool_call", { toolName: "write", toolCallId: "w8" }, ctx);
    await tick(50);
    assert.equal(state.goal?.telemetry?.files, undefined, "no path arg, no tool match, no record");
    await pi.command("goal", "pause", ctx);
    await pi.fire("tool_call", { toolName: "write", toolCallId: "w7", input: { path: "src/paused.ts" } }, ctx);
    await tick(50);
    assert.equal(state.goal?.telemetry?.files, undefined, "a paused goal records nothing");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

// ---- 4. the brief scopes itself to the change set ----

test("change-scope: the audit brief names the recorded paths first", () => {
  const goal = seedGoal({
    objective: "scoped audit — done when pinned",
    telemetry: { turns: 9, fileWrites: 3, bashCalls: 1, files: ["src/a.ts", "src/b.ts"] },
  }) as unknown as Goal;
  const brief = buildGoalAuditorPrompt(goal, "Outcome: x.\nChanged: y.\nEvidence: z.\nTests: t.\nUnresolved: none.\nNext: none.", "pinned");
  assert.match(brief, /<changed_files>/);
  assert.match(brief, /- src\/a\.ts/);
  assert.match(brief, /- src\/b\.ts/);
  assert.match(brief, /verify THESE first/);
  assert.match(brief, /scopes the START of the audit, never its boundary/);
  assert.doesNotMatch(brief, /past the .* list cap/, "no overflow line without overflow");
});

test("change-scope: the brief reports overflow and escapes paths as data", () => {
  const goal = seedGoal({
    objective: "scoped audit — done when pinned",
    telemetry: { turns: 9, fileWrites: 150, bashCalls: 1, files: ["src/<evil>.ts"], filesOverflow: 48 },
  }) as unknown as Goal;
  const brief = buildGoalAuditorPrompt(goal, "Outcome: x.\nChanged: y.\nEvidence: z.\nTests: t.\nUnresolved: none.\nNext: none.", undefined);
  assert.match(brief, /48 further touched paths were recorded past the 100-path list cap/);
  assert.match(brief, /src\/&lt;evil&gt;\.ts/, "paths are escaped payloads, like every other brief input");
  assert.doesNotMatch(brief, /src\/<evil>\.ts/);
});

test("change-scope: no recorded paths keeps the previous brief shape", () => {
  for (const telemetry of [undefined, { turns: 9, fileWrites: 0, bashCalls: 1 }, { turns: 9, fileWrites: 4, bashCalls: 1 }]) {
    const goal = seedGoal({ objective: "unscoped audit — done when pinned", telemetry }) as unknown as Goal;
    const brief = buildGoalAuditorPrompt(goal, "Outcome: x.\nChanged: y.\nEvidence: z.\nTests: t.\nUnresolved: none.\nNext: none.", undefined);
    assert.doesNotMatch(brief, /changed_files/, `no section without paths: ${JSON.stringify(telemetry)}`);
  }
});

// ---- 5. the recorded-facts fallback names the paths too ----

test("change-scope: the fallback summary names recorded paths, bounded", () => {
  const withFiles = buildRecordedFactsCompletionSummary({
    goal: seedGoal({ objective: "shipped thing", telemetry: { turns: 9, fileWrites: 2, bashCalls: 0, files: ["src/a.ts", "src/b.ts"] } }) as any,
    status: "complete",
  });
  assert.match(withFiles, /2 file-write signal\(s\) touched: src\/a\.ts, src\/b\.ts/);
  const many = buildRecordedFactsCompletionSummary({
    goal: seedGoal({ objective: "shipped thing", telemetry: { turns: 9, fileWrites: 130, bashCalls: 0, files: Array.from({ length: 100 }, (_, i) => `f${i}.ts`), filesOverflow: 30 } }) as any,
    status: "complete",
  });
  assert.match(many, /\(\+110 more\)/, "past-20 list entries plus overflow collapse into one count");
  const legacy = buildRecordedFactsCompletionSummary({
    goal: seedGoal({ objective: "shipped thing", telemetry: { turns: 9, fileWrites: 2, bashCalls: 0 } }) as any,
    status: "complete",
  });
  assert.match(legacy, /changed paths were not captured/, "pre-tracking goals keep the old sentence");
});
