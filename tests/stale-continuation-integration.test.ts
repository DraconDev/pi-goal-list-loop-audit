// pi-goal-list-loop-audit — v0.37.2
// Integration: stale queued custom message is sanitized at delivery (message_end)
// and does not persist raw prompt source.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { state, replaceState } from "../extensions/goal-state.js";
import { buildAbortedAssistantNotice } from "../extensions/action-reminder.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value: Record<string, unknown> });
}

afterEach(() => {
  replaceState({ goal: null, list: [], loop: null } as any);
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  try { fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false })); } catch {}
});

test("integration: stale goal continuation is sanitized at message_end and ledgered, raw source dropped", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  // Start with an active goal, then simulate archival by clearing it
  const gid = "20260901171431-fkz8a2";
  seedState(cwd, { goal: seedGoal({ id: gid, status: "active", objective: "integration stale test" }) });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "test-sm", getSessionFile: () => path.join(cwd, "sm.jsonl"), getSessionId: () => "test-sm" } } as any);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  // Verify active
  assert.ok((state as any).goal, "goal active after session_start");
  // Simulate archival: clear goal (as archiveCurrentGoal does) — keep ledger clean
  replaceState({ goal: null, list: [], loop: null } as any);
  // Build a raw continuation payload identical to the observed leak
  const raw = `// pi-goal-list-loop-audit — v0.1.0\n// prompts/goal-loop-continuation.md\n[GOAL CHECKPOINT goalId=${gid}]\nState: ACTIVE — not yet auditor-approved.\nWork the goal.`;
  const handler = pi.handlers.get("message_end");
  assert.ok(handler, "message_end handler registered");
  const result: any = await (handler as any)({ message: { role: "custom", customType: "goal-event", content: raw, display: false } }, ctx);
  assert.ok(result?.message, "stale message was sanitized (handler returned replacement)");
  assert.match(result.message.content, /discarded stale continuation/, "sanitized content indicates discard");
  assert.match(result.message.content, /no active goal/, "reason mentions no active goal");
  assert.doesNotMatch(result.message.content, /\/\/ pi-goal-list-loop-audit/, "raw source header not preserved in sanitized content");
  assert.equal(result.message.display, false, "sanitized remains hidden");
  assert.equal(result.message.role, "custom", "role preserved");
  assert.equal(result.message.customType, "goal-event", "customType preserved");
  // Ledger must contain the sanitization event with original preview but not raw leak in persisted state
  const ledger = readLedger(cwd);
  const sanitized = ledger.find((e) => e.type === "stale_continuation_sanitized");
  assert.ok(sanitized, "ledger contains stale_continuation_sanitized");
  assert.equal(sanitized!.value.goalId, gid);
  assert.ok(String(sanitized!.value.originalPreview).includes(gid), "original preview retains goal id for audit");
  assert.ok(String(sanitized!.value.originalPreview).length <= 200, "preview is truncated to 200 chars");
});

test("integration: a GLLA pause abort becomes an actionable assistant message", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  const goal = seedGoal({ status: "paused", pauseKind: "blocked", pauseReason: "The native popup needs observation.", pauseSuggestedAction: "Open the popup, then /goal resume." });
  seedState(cwd, { goal });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "pause-sm", getSessionFile: () => path.join(cwd, "sm.jsonl"), getSessionId: () => "pause-sm" } } as any);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  replaceState({ goal, list: [], loop: null } as any);
  const handler = pi.handlers.get("message_end");
  assert.ok(handler, "message_end handler registered");
  const result: any = await (handler as any)({ message: { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted", content: [] } }, ctx);
  assert.ok(result?.message, "pause abort is replaced");
  const text = result.message.content?.[0]?.text ?? "";
  assert.match(text, /GLLA paused this turn safely/);
  assert.match(text, /Open the popup/);
  assert.doesNotMatch(text, /Operation aborted/);
  assert.equal(result.message.stopReason, "stop");
});

test("integration: fresh continuation for active goal is NOT sanitized", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  setGlobalAutoResume(true);
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  const gid = "fresh-123";
  seedState(cwd, { goal: seedGoal({ id: gid, status: "active" }) });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "test-sm2", getSessionFile: () => path.join(cwd, "sm2.jsonl"), getSessionId: () => "sm2" } } as any);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  // session_start with autoResume:true keeps the goal active; ensure it
  replaceState({ goal: seedGoal({ id: gid, status: "active" }), list: [], loop: null } as any);
  const raw = `[GOAL CHECKPOINT goalId=${gid}] continue work`;
  const handler = pi.handlers.get("message_end");
  const result: any = await (handler as any)({ message: { role: "custom", customType: "goal-event", content: raw, display: false } }, ctx);
  assert.equal(result, undefined, "fresh continuation must not be sanitized (handler returns undefined)");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "stale_continuation_sanitized").length, 0, "no sanitization ledger for fresh message");
  setGlobalAutoResume(false);
});

test("integration: foreign ctx never sanitizes (subagent isolation)", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  // No active goal, but foreign ctx should be ignored
  seedState(cwd, { goal: null });
  const foreignCtx = makeMockCtx(cwd, { sessionManager: { name: "foreign-sm", getSessionFile: () => path.join(cwd, "foreign.jsonl"), getSessionId: () => "foreign" } } as any);
  // First, establish owner session with a different cwd to make this ctx foreign
  const ownerCwd = tmpCwd();
  seedState(ownerCwd, { goal: seedGoal({ status: "active" }) });
  const owner = makeMockCtx(ownerCwd, { sessionManager: { name: "owner-sm", getSessionFile: () => path.join(ownerCwd, "owner.jsonl"), getSessionId: () => "owner" } } as any);
  await pi.fire("session_start", { reason: "startup" }, owner);
  // Now foreign ctx is different cwd // same pi, so isForeignCtx will be true
  const handler = pi.handlers.get("message_end");
  const raw = "[GOAL CHECKPOINT goalId=any] stale";
  const result: any = await (handler as any)({ message: { role: "custom", customType: "goal-event", content: raw, display: false } }, foreignCtx);
  assert.equal(result, undefined, "foreign ctx must not be sanitized");
});
