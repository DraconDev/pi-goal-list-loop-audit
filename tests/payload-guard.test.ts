// pi-goal-list-loop-audit — v0.35.51
// tests/payload-guard.test.ts
//
// note.md Now: "req body too large due to images in context". Generated
// images accumulate in history as inline base64 until the provider rejects
// the request with 413 ("Downloaded image content cannot exceed 30MB" /
// "Request Entity Too Large"); every main-model-recovery probe re-sent the
// same bloated history so recovery could never classify the failure.
//
// Fix under test (two layers):
//  1. extensions/payload-guard.ts — pure policy: bound cumulative inline
//     image bytes on the outgoing projection, evicting OLDEST images first
//     and always keeping the newest few; each evicted block becomes a short
//     text placeholder. Disk history untouched (per-send projection).
//  2. Wiring in goal-activation.ts — a `context`-event handler applies the
//     projection before EVERY LLM call (ordinary turns AND recovery probes)
//     and ledgeres payload_guard_eviction when it fires.
//  3. classifyMainModelFailure — 413/payload-size texts classify as
//     "transient" (retryable in place) instead of "unknown" (useless
//     fallback-chain rotation: every provider caps request size).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { collectImageBlocks, evictStaleImages, isInlineImageBlock, DEFAULT_IMAGE_BUDGET_BYTES } from "../extensions/payload-guard.js";
import { classifyMainModelFailure } from "../extensions/main-model-recovery.js";
import { tmpCwd, tick, MockPi, makeMockCtx } from "./harness/mock-pi.js";

function imageBlock(kb: number): { type: string; data: string; mimeType: string } {
  return { type: "image", data: "A".repeat(kb * 1024), mimeType: "image/png" };
}
function textBlock(text: string): { type: string; text: string } {
  return { type: "text", text };
}
function userMessage(...blocks: unknown[]): { role: string; content: unknown[] } {
  return { role: "user", content: blocks };
}

// ── (1) pure policy ──────────────────────────────────────────────────────

test("payload guard: under-budget histories pass through with the SAME identity", () => {
  const messages = [userMessage(textBlock("hello")), userMessage(imageBlock(64))];
  const result = evictStaleImages(messages, { imageBudgetBytes: DEFAULT_IMAGE_BUDGET_BYTES });
  assert.equal(result.evicted.length, 0);
  assert.equal(result.messages, messages, "no-op must not copy");
  assert.equal(result.totalImageBytes, 64 * 1024);
});

test("payload guard: over-budget histories evict OLDEST first and keep the newest two", () => {
  const messages = [
    userMessage(imageBlock(900)), // oldest — evicted
    userMessage(textBlock("middle turn"), imageBlock(900)), // evicted (block 1)
    userMessage(imageBlock(900)), // kept (newest #2)
    userMessage(imageBlock(900)), // kept (newest #1)
  ];
  const result = evictStaleImages(messages, { imageBudgetBytes: 1024 * 1024, keepRecentImages: 2 });
  assert.equal(result.evicted.length, 2, "the two oldest images are evicted");
  assert.equal(result.evicted[0]!.messageIndex, 0);
  assert.equal(result.evicted[1]!.messageIndex, 1);
  assert.ok(result.remainingImageBytes <= 2 * 900 * 1024, `floor held: ${result.remainingImageBytes} (the two kept images)`);
  const keptContent = (result.messages[3] as { content: Array<{ type: string }> }).content;
  assert.equal(keptContent[0]!.type, "image", "newest image survives");
  const evictedContent = (result.messages[0] as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(evictedContent[0]!.type, "text", "evicted block becomes a text placeholder");
  assert.match(evictedContent[0]!.text, /image evicted by glla payload guard/);
  assert.match(evictedContent[0]!.text, /session transcript/, "placeholder points at the intact disk history");
});

test("payload guard: the keep-recent floor holds even when the budget cannot be met", () => {
  const messages = [userMessage(imageBlock(500)), userMessage(imageBlock(500)), userMessage(imageBlock(500))];
  const result = evictStaleImages(messages, { imageBudgetBytes: 1024, keepRecentImages: 2 });
  assert.equal(result.evicted.length, 1, "eviction stops at the floor — best effort, not a destructive sweep");
  assert.equal(collectImageBlocks(result.messages).length, 2);
});

test("payload guard: projection is idempotent and never touches non-image content", () => {
  const messages = [userMessage(imageBlock(900), textBlock("keep me")), { role: "assistant", content: "plain string" }];
  const first = evictStaleImages(messages, { imageBudgetBytes: 512 * 1024, keepRecentImages: 0 });
  assert.equal(first.evicted.length, 1);
  const text = ((first.messages[0] as { content: Array<{ text?: string }> }).content[0] as { text?: string }).text;
  const second = evictStaleImages(first.messages, { imageBudgetBytes: 1024 * 1024, keepRecentImages: 0 });
  assert.equal(second.evicted.length, 0, "placeholders are not re-evicted");
  assert.equal(second.messages, first.messages, "second pass is a no-op");
  assert.equal((first.messages[0] as { content: Array<{ text?: string }> }).content[1], messages[0]!.content[1], "sibling text block untouched");
  assert.equal(first.messages[1], messages[1], "string-content message untouched");
  assert.ok(isInlineImageBlock(messages[0]!.content[0]));
});

// ── (2) behavioral wiring: the context-event handler ─────────────────────

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("wiring: the context event projects bloated histories before EVERY LLM call and ledgeres the eviction", async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `guard-${Date.now()}` } });

  // A bloated history: three ~9MB images (27MB) cross the default 16MB
  // budget; the oldest is evicted, the newest two are floor-kept.
  const bloated = [
    userMessage(imageBlock(9 * 1024)),
    userMessage(imageBlock(9 * 1024)),
    userMessage(imageBlock(9 * 1024)),
    userMessage(textBlock("current turn")),
  ];
  // MockPi.fire returns void; invoke the registered handler directly to
  // capture the projection it hands back to the runtime.
  const handlers = (pi as unknown as { handlers: Map<string, (...a: unknown[]) => unknown> }).handlers;
  const handler = handlers.get("context");
  assert.ok(handler, "activate() registers the context-event handler");
  const result = await handler!({ type: "context", messages: bloated }, ctx) as { messages?: Array<{ content: Array<{ type: string; text?: string }> }> };
  assert.ok(result?.messages, "the handler returns a projected message list");
  const projected = result!.messages!;
  assert.equal(collectImageBlocks(projected).length, 2, "the newest two images survive the projection");
  assert.match((projected[0]!.content[0] as { text: string }).text, /image evicted by glla payload guard/);
  assert.equal(projected[3]!.content[0]!.type, "text", "the current turn's text is intact");

  const evictions = ledger(cwd).filter((e) => e.type === "payload_guard_eviction");
  assert.equal(evictions.length, 1, "one durable eviction entry for forensics");
  assert.equal(evictions[0]!.value!.evicted, 1);
  assert.ok((evictions[0]!.value!.bytesFreed as number) >= 9 * 1024);

  // Under budget: no projection, no ledger noise.
  const before = ledger(cwd).length;
  const small = await handler!({ type: "context", messages: [userMessage(imageBlock(64))] }, ctx) as { messages?: unknown[] };
  assert.equal(small?.messages, undefined, "under-budget histories pass through unprojected");
  assert.equal(ledger(cwd).length, before, "no ledger entry when nothing was evicted");
});

// ── (3) 413 classification: retryable in place, not chain rotation ───────

test("classifyMainModelFailure: 413 payload-size texts are transient, not unknown", () => {
  const observed = [
    `413: {"message":"Downloaded image content cannot exceed 30MB","code":413,"metadata":{"provider_name":null}}`,
    `413: {"code":"413","message":"Request Entity Too Large"}`,
    `Error: request payload too large for model`,
  ];
  for (const raw of observed) {
    const failure = classifyMainModelFailure(raw);
    assert.equal(failure.kind, "transient", `retryable in place: ${raw.slice(0, 60)}`);
  }
  // The payload guard — not a model switch — heals the size, so 413 must NOT
  // be context-overflow either (rotation cannot shrink a bloated history).
  const overflow = classifyMainModelFailure(`413: Request Entity Too Large`, { isContextOverflow: true });
  assert.equal(overflow.kind, "transient");
});
