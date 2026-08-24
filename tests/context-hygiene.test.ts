// pi-goal-list-loop-audit — v0.35.52
// tests/context-hygiene.test.ts
//
// note.md Now: "failed requests add to the context, while clearly adding
// nothing of value". Field evidence (polis, 2026-08-23): exhausted-retry
// failed turns (stopReason "error" assistants) accumulate forever — pi
// strips them from live state only for mid-flight retries; the final failed
// assistant persists in state AND session, is included unfiltered in every
// outgoing context, and is summarized by compaction. polis reached 122.7%
// of a 200k window and auto-compaction aborted on its own bloated input.
//
// Fix under test (extensions/context-hygiene.ts): a durable bounded rule —
// drop error-only assistant turns (stopReason "error", NO tool-call blocks)
// from the effective context EXCEPT the most recent one (retry continuity);
// the same rule prunes the compaction summarization input in place.
// "aborted" turns are user-intent boundaries and are never touched; tool-
// call-carrying error turns own paired toolResults and stay intact; the
// session transcript on disk is never modified.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { dropFailedErrorOnlyTurns, isFailedErrorOnlyTurn, pruneCompactionPreparation, DEFAULT_KEEP_RECENT_ERROR_TURNS } from "../extensions/context-hygiene.js";
import { tmpCwd, MockPi, makeMockCtx } from "./harness/mock-pi.js";

function failedTurn(errorMessage: string, blocks: unknown[] = []): Record<string, unknown> {
  return { role: "assistant", content: blocks, stopReason: "error", errorMessage };
}
function okTurn(text: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}
function userTurn(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text }] };
}

// ── (1) the predicate ────────────────────────────────────────────────────

test("predicate: error-only turns are droppable; tool-carrying, aborted, and healthy turns are not", () => {
  assert.equal(isFailedErrorOnlyTurn(failedTurn("503 status code (no body)")), true);
  assert.equal(isFailedErrorOnlyTurn(failedTurn("Provider finish_reason: network_error", [{ type: "text", text: "partial" }])), true, "partial text from a dead stream is still droppable");
  assert.equal(
    isFailedErrorOnlyTurn(failedTurn("error mid-tooluse", [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }])),
    false,
    "a tool-call-carrying error turn owns paired toolResults — never dropped",
  );
  assert.equal(isFailedErrorOnlyTurn({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "user interrupt" }), false, "aborted = user-intent boundary");
  assert.equal(isFailedErrorOnlyTurn(okTurn("healthy")), false);
  assert.equal(isFailedErrorOnlyTurn(userTurn("hello")), false);
  assert.equal(isFailedErrorOnlyTurn(null), false);
  assert.equal(isFailedErrorOnlyTurn("string message"), false);
});

// ── (2) the bounded drop rule ────────────────────────────────────────────

test("drop rule: keeps the most recent failed turn, drops older ones, preserves everything else", () => {
  const first = failedTurn("503 status code (no body)");
  const second = failedTurn("Provider finish_reason: network_error");
  const healthy = okTurn("real work");
  const newest = failedTurn("Retry failed after 3 attempts: Retry cancelled");
  const messages = [userTurn("go"), first, userTurn("again"), second, healthy, newest];
  const result = dropFailedErrorOnlyTurns(messages);
  assert.equal(result.dropped.length, 2, "the two older failures are dropped");
  assert.equal(result.kept, 1, "the newest failure stays for retry continuity");
  assert.equal(result.dropped[0]!.messageIndex, 1);
  assert.equal(result.dropped[1]!.messageIndex, 3);
  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.includes(healthy), "healthy content untouched");
  assert.ok(result.messages.includes(newest), "newest failure kept");
  assert.equal(result.dropped[0]!.errorMessage, "503 status code (no body)", "drop record carries the error for forensics");
});

test("drop rule: identity preserved when at or under the keep window; window is configurable", () => {
  const single = [failedTurn("e1")];
  const atWindow = dropFailedErrorOnlyTurns(single, { keepRecentErrorTurns: DEFAULT_KEEP_RECENT_ERROR_TURNS });
  assert.equal(atWindow.dropped.length, 0, "one failure == the keep window: nothing to drop");
  assert.equal(atWindow.messages, single, "no-op must not copy");
  const messages = [failedTurn("e1"), failedTurn("e2")];
  const zero = dropFailedErrorOnlyTurns(messages, { keepRecentErrorTurns: 0 });
  assert.equal(zero.dropped.length, 2, "keepRecent 0 drops every failed turn");
  assert.equal(zero.messages.length, 0);
});

test("drop rule: SEADED BLOAT — 60 failed turns collapse to the keep window; normal turns survive verbatim", () => {
  const healthy = okTurn("the actual conversation");
  const messages: unknown[] = [userTurn("start")];
  for (let i = 0; i < 60; i++) messages.push(failedTurn(`503 status code (no body) #${i}`));
  messages.push(healthy, userTurn("still there?"));
  const result = dropFailedErrorOnlyTurns(messages);
  assert.equal(result.dropped.length, 59);
  assert.equal(result.kept, 1);
  assert.equal(result.messages.length, 4, "user + newest failure + healthy + trailing user");
  assert.ok(result.messages.includes(healthy));
});

// ── (3) compaction input pruning (in-place, shared preparation) ─────────

test("compaction pruning: reassigns both message arrays in place and counts drops", () => {
  const preparation: { messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; firstKeptEntryId: string } = {
    messagesToSummarize: [userTurn("old"), failedTurn("503"), failedTurn("503 again"), okTurn("work")],
    turnPrefixMessages: [failedTurn("network_error"), userTurn("recent")],
    firstKeptEntryId: "keep-me",
  };
  const dropped = pruneCompactionPreparation(preparation);
  assert.equal(dropped, 1, "2 failures with keep=1 → 1 drop; the single turn-prefix failure stays");
  assert.equal(preparation.messagesToSummarize.length, 3, "the older failed turn is pruned from the summarization input");
  assert.equal(preparation.turnPrefixMessages.length, 2, "the single prefix failure is inside the keep window — untouched");
  assert.equal(preparation.firstKeptEntryId, "keep-me", "the keep boundary is never touched");
  assert.equal(pruneCompactionPreparation(undefined), 0, "shape surprises are no-ops");
  assert.equal(pruneCompactionPreparation({}), 0);
});

// ── (4) behavioral wiring through the extension ──────────────────────────

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("wiring: the context event drops accumulated error turns and ledgeres the hygiene pass", async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `hygiene-${Date.now()}` } });
  const handlers = (pi as unknown as { handlers: Map<string, (...a: unknown[]) => unknown> }).handlers;
  const handler = handlers.get("context");
  assert.ok(handler, "activate() registers the context-event handler");

  const healthy = okTurn("real work");
  const bloated: unknown[] = [userTurn("go")];
  for (let i = 0; i < 12; i++) bloated.push(failedTurn(`503 status code (no body) #${i}`));
  bloated.push(healthy, userTurn("retry"));

  const result = await handler({ type: "context", messages: bloated }, ctx) as { messages?: unknown[] };
  assert.ok(result?.messages, "projected list returned");
  assert.equal(result!.messages!.length, 4, "12 failures collapse to the newest one");
  assert.ok(result!.messages!.includes(healthy), "healthy content survives");
  assert.ok(result!.messages!.some((m) => isFailedErrorOnlyTurn(m)), "the newest failure stays visible");

  const events = ledger(cwd).filter((e) => e.type === "context_hygiene_dropped");
  assert.equal(events.length, 1, "one durable hygiene entry");
  assert.equal(events[0]!.value!.dropped, 11);
  assert.match(String(events[0]!.value!.lastError), /503/);

  // Clean history: no drops, no ledger noise.
  const before = ledger(cwd).length;
  const clean = await handler({ type: "context", messages: [userTurn("hi"), okTurn("hello")] }, ctx) as { messages?: unknown[] };
  assert.equal(clean?.messages, undefined, "clean histories pass through unprojected");
  assert.equal(ledger(cwd).length, before);
});

test("wiring: session_before_compact prunes the preparation the runner will summarize", async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `compact-${Date.now()}` } });
  const handlers = (pi as unknown as { handlers: Map<string, (...a: unknown[]) => unknown> }).handlers;
  const handler = handlers.get("session_before_compact");
  assert.ok(handler, "activate() registers the session_before_compact handler");

  const preparation = {
    messagesToSummarize: [userTurn("old"), failedTurn("503"), failedTurn("network_error"), okTurn("work")],
    turnPrefixMessages: [userTurn("recent")],
    firstKeptEntryId: "e42",
  };
  await handler({ type: "session_before_compact", preparation, branchEntries: [], reason: "auto" }, ctx);
  assert.equal(preparation.messagesToSummarize.length, 3, "the runner's shared preparation is pruned in place");
  assert.equal(preparation.firstKeptEntryId, "e42");
  const events = ledger(cwd).filter((e) => e.type === "context_hygiene_compaction_input");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.value!.dropped, 1);

  // Idempotent second pass: no further drops, no ledger spam.
  const before = ledger(cwd).length;
  await handler({ type: "session_before_compact", preparation, branchEntries: [], reason: "auto" }, ctx);
  assert.equal(ledger(cwd).length, before);
});
