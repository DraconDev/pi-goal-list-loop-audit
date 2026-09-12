// pi-goal-list-loop-audit — context-growth measurement fixture
//
// This is intentionally a measurement test, not a context-reduction test.
// It uses the exact continuationPrompt() payload that sendContinuation sends
// as a goal-event, repeats it as a synthetic long-running history, and reports
// the marginal/repeated bytes separately from ordinary messages. The next
// list item owns the bounded checkpoint implementation.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { continuationPrompt } from "../extensions/goal-continuation.ts";
import {
  captureProviderTokenUsage,
  diffContextGrowth,
  measureContextGrowth,
} from "../extensions/context-growth.ts";

function goalForMeasurement(): any {
  return {
    id: "context-growth-measurement",
    objective: "Measure the context cost of repeated GLLA continuation payloads.",
    verificationContract: "Done when the measurement is reproducible and the repeated payload cost is explicit.",
    status: "active",
    policy: "goal",
    startedAt: "2026-08-29T00:00:00.000Z",
    auditHistory: [],
    taskList: { tasks: [] },
  };
}

function userMessage(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function gllaMessage(content: string): Record<string, unknown> {
  return { role: "user", customType: "goal-event", content, display: false };
}

// A provider-shaped raw usage trace exercises the exact pi-ai fields without
// pretending that the offline fixture contacted a provider. Production
// agent_end samples are captured through the same fields.
function providerMessage(index: number): Record<string, unknown> {
  const input = 8_000 + index * 2_000;
  const output = 100 + index;
  const cacheRead = index * 10;
  const cacheWrite = index % 3;
  return {
    role: "assistant",
    stopReason: "stop",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
    },
  };
}

function providerMessages(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => providerMessage(index));
}

test("fixture: repeated real continuation payloads grow context linearly and are isolated", () => {
  const payload = continuationPrompt(goalForMeasurement());
  assert.match(payload, /\[GOAL CHECKPOINT goalId=context-growth-measurement\]/);

  const baselineMessages = [
    userMessage("start the long-running task"),
    assistantMessage("I am working on the task."),
  ];
  const one = measureContextGrowth(
    [...baselineMessages, gllaMessage(payload)],
    { providerMessages: providerMessages(1) },
  );
  const twelve = measureContextGrowth(
    [
      ...baselineMessages,
      ...Array.from({ length: 12 }, () => gllaMessage(payload)),
    ],
    { providerMessages: providerMessages(12) },
  );

  // The continuation template includes the durable judgment tool guidance;
  // these values are the current deterministic fixture, not a provider-token
  // claim. Update them deliberately when the template changes.
  // v0.36.3: the prompt's role names changed from Explore/general-purpose
  // to scout/reviewer; refresh the deterministic byte fixture with that
  // intentional prompt change rather than hiding the drift.
  // Completion-communication guidance: pending claims are nonterminal and
  // the approved summary is posted after verify — +543 bytes per payload
  // (+539 chars template, +4 serialization). User-voice summary-shape
  // guidance (Codex-style outcome-first, clause-boundary cuts) — +344 bytes
  // per payload (+340 chars, +2 multibyte). Deliberate-non-do guidance
  // (complete_goal leftOut + closing-bullet voice) — +87 bytes per payload
  // (+85 chars, +2 multibyte from the em-dash). Codex-close claim guidance
  // (90-char values, human proof only, one concrete Next) — +388 bytes per
  // payload (+388 chars, +4 multibyte: … and — ×2). Layered prompts
  // (skeleton + on-demand detail): the clean measurement fixture carries no
  // disapproval, survey, or resync trigger, so all three detail bodies stay
  // unloaded — −2,603 bytes per payload (−2,546 chars template, −57
  // serialization escapes). Firing predicates re-add exactly their own
  // bodies (see tests/prompt-layers.test.ts exact-delta tests). Task-batch
  // and pending-gate prompt guidance (update_task_batch, refusal before
  // audit, rich-section voice) — +771 bytes per payload (+769 chars incl.
  // one em dash; +775 serialized with the new quote escapes). Grouped-
  // terminal guidance (complete_goal findingGroups: area groups, Lead/body
  // with path:line tokens, table at 4+ groups, flat fallback) — +430 bytes
  // per payload (+426 chars incl. one em dash; +430 serialized). Gate-
  // inventory and per-finding test guidance (complete_goal gateRows +
  // parallel tests: Quality Gate | Scope | Status | Notes table, Test
  // Results sub-lines, derived statuses) — +608 bytes per payload (+602
  // chars incl. three em dashes; +608 serialized, no quote escapes).
  // Linear
  // growth is preserved: repeated bytes stay an exact multiple of the
  // single-payload bytes.
  assert.equal(payload.length, 23_598);
  assert.equal(new TextEncoder().encode(payload).byteLength, 23_708);
  assert.deepEqual(one, {
    messageCount: 3,
    serializedBytes: 24_239,
    textChars: 23_650,
    estimatedTokens: 5_913,
    gllaMessageCount: 1,
    gllaSerializedBytes: 24_056,
    gllaTextChars: 23_598,
    gllaEstimatedTokens: 5_900,
    uniqueGllaPayloadCount: 1,
    repeatedGllaPayloadCount: 0,
    repeatedGllaSerializedBytes: 0,
    failedErrorOnlyCount: 0,
    unserializableMessageCount: 0,
    provider: {
      sampleCount: 1,
      inputTokens: 8_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 8_100,
      firstInputTokens: 8_000,
      latestInputTokens: 8_000,
      inputTokenDelta: 0,
      incompleteSampleCount: 0,
    },
  });
  assert.equal(one.messageCount, 3);
  assert.equal(one.gllaMessageCount, 1);
  assert.equal(one.uniqueGllaPayloadCount, 1);
  assert.equal(one.repeatedGllaPayloadCount, 0);
  assert.ok(one.gllaSerializedBytes > 15_000, `expected the real continuation payload to be material: ${one.gllaSerializedBytes}`);

  assert.equal(twelve.messageCount, 14);
  assert.equal(twelve.gllaMessageCount, 12);
  assert.equal(twelve.uniqueGllaPayloadCount, 1);
  assert.equal(twelve.repeatedGllaPayloadCount, 11);
  assert.ok(twelve.gllaTextChars >= one.gllaTextChars * 12, "each continuation remains in the effective context");
  assert.ok(twelve.repeatedGllaSerializedBytes >= one.gllaSerializedBytes * 10, "repeated GLLA bytes dominate the marginal growth");
  assert.equal(twelve.failedErrorOnlyCount, 0);
  assert.deepEqual(twelve, {
    messageCount: 14,
    serializedBytes: 288_855,
    textChars: 283_228,
    estimatedTokens: 70_807,
    gllaMessageCount: 12,
    gllaSerializedBytes: 288_672,
    gllaTextChars: 283_176,
    gllaEstimatedTokens: 70_794,
    uniqueGllaPayloadCount: 1,
    repeatedGllaPayloadCount: 11,
    repeatedGllaSerializedBytes: 264_616,
    failedErrorOnlyCount: 0,
    unserializableMessageCount: 0,
    provider: {
      sampleCount: 12,
      inputTokens: 228_000,
      outputTokens: 1_266,
      cacheReadTokens: 660,
      cacheWriteTokens: 12,
      totalTokens: 229_938,
      firstInputTokens: 8_000,
      latestInputTokens: 30_000,
      inputTokenDelta: 22_000,
      incompleteSampleCount: 0,
    },
  });

  const delta = diffContextGrowth(one, twelve);
  assert.equal(delta.messageCount, 11);
  assert.equal(delta.gllaMessageCount, 11);
  assert.equal(delta.uniqueGllaPayloadCount, 0, "the additional entries are repeats, not new payload shapes");
  assert.equal(delta.repeatedGllaPayloadCount, 11);
  assert.ok(delta.serializedBytes > 150_000, `expected visible cumulative growth: ${delta.serializedBytes}`);
  assert.deepEqual(delta.provider, {
    sampleCount: 11,
    inputTokens: 220_000,
    outputTokens: 1_166,
    cacheReadTokens: 660,
    cacheWriteTokens: 12,
    totalTokens: 221_838,
    firstInputTokens: 8_000,
    latestInputTokens: 30_000,
    inputTokenDelta: 22_000,
    incompleteSampleCount: 0,
  });
});

test("reported checkpoint shape stays pinned across all probe sizes", () => {
  const payload = continuationPrompt(goalForMeasurement());
  const baselineMessages = [
    userMessage("start the long-running task"),
    assistantMessage("I am working on the task."),
  ];
  const rows = [0, 1, 5, 12, 25].map((continuations) => {
    const measured = measureContextGrowth(
      [
        ...baselineMessages,
        ...Array.from({ length: continuations }, () => gllaMessage(payload)),
      ],
      { providerMessages: providerMessages(continuations) },
    );
    return {
      continuations,
      messageCount: measured.messageCount,
      serializedBytes: measured.serializedBytes,
      textChars: measured.textChars,
      estimatedTokens: measured.estimatedTokens,
      gllaMessageCount: measured.gllaMessageCount,
      gllaSerializedBytes: measured.gllaSerializedBytes,
      gllaTextChars: measured.gllaTextChars,
      gllaEstimatedTokens: measured.gllaEstimatedTokens,
      repeatedGllaPayloadCount: measured.repeatedGllaPayloadCount,
      repeatedGllaSerializedBytes: measured.repeatedGllaSerializedBytes,
      provider: measured.provider,
    };
  });

  assert.deepEqual(rows, [
    {
      continuations: 0,
      messageCount: 2,
      serializedBytes: 183,
      textChars: 52,
      estimatedTokens: 13,
      gllaMessageCount: 0,
      gllaSerializedBytes: 0,
      gllaTextChars: 0,
      gllaEstimatedTokens: 0,
      repeatedGllaPayloadCount: 0,
      repeatedGllaSerializedBytes: 0,
      provider: {
        sampleCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        firstInputTokens: null,
        latestInputTokens: null,
        inputTokenDelta: null,
        incompleteSampleCount: 0,
      },
    },
    {
      continuations: 1,
      messageCount: 3,
      serializedBytes: 24_239,
      textChars: 23_650,
      estimatedTokens: 5_913,
      gllaMessageCount: 1,
      gllaSerializedBytes: 24_056,
      gllaTextChars: 23_598,
      gllaEstimatedTokens: 5_900,
      repeatedGllaPayloadCount: 0,
      repeatedGllaSerializedBytes: 0,
      provider: {
        sampleCount: 1,
        inputTokens: 8_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 8_100,
        firstInputTokens: 8_000,
        latestInputTokens: 8_000,
        inputTokenDelta: 0,
        incompleteSampleCount: 0,
      },
    },
    {
      continuations: 5,
      messageCount: 7,
      serializedBytes: 120_463,
      textChars: 118_042,
      estimatedTokens: 29_511,
      gllaMessageCount: 5,
      gllaSerializedBytes: 120_280,
      gllaTextChars: 117_990,
      gllaEstimatedTokens: 29_498,
      repeatedGllaPayloadCount: 4,
      repeatedGllaSerializedBytes: 96_224,
      provider: {
        sampleCount: 5,
        inputTokens: 60_000,
        outputTokens: 510,
        cacheReadTokens: 100,
        cacheWriteTokens: 4,
        totalTokens: 60_614,
        firstInputTokens: 8_000,
        latestInputTokens: 16_000,
        inputTokenDelta: 8_000,
        incompleteSampleCount: 0,
      },
    },
    {
      continuations: 12,
      messageCount: 14,
      serializedBytes: 288_855,
      textChars: 283_228,
      estimatedTokens: 70_807,
      gllaMessageCount: 12,
      gllaSerializedBytes: 288_672,
      gllaTextChars: 283_176,
      gllaEstimatedTokens: 70_794,
      repeatedGllaPayloadCount: 11,
      repeatedGllaSerializedBytes: 264_616,
      provider: {
        sampleCount: 12,
        inputTokens: 228_000,
        outputTokens: 1_266,
        cacheReadTokens: 660,
        cacheWriteTokens: 12,
        totalTokens: 229_938,
        firstInputTokens: 8_000,
        latestInputTokens: 30_000,
        inputTokenDelta: 22_000,
        incompleteSampleCount: 0,
      },
    },
    {
      continuations: 25,
      messageCount: 27,
      serializedBytes: 601_583,
      textChars: 590_002,
      estimatedTokens: 147_501,
      gllaMessageCount: 25,
      gllaSerializedBytes: 601_400,
      gllaTextChars: 589_950,
      gllaEstimatedTokens: 147_488,
      repeatedGllaPayloadCount: 24,
      repeatedGllaSerializedBytes: 577_344,
      provider: {
        sampleCount: 25,
        inputTokens: 800_000,
        outputTokens: 2_800,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 24,
        totalTokens: 805_824,
        firstInputTokens: 8_000,
        latestInputTokens: 56_000,
        inputTokenDelta: 48_000,
        incompleteSampleCount: 0,
      },
    },
  ]);
});

test("provider capture preserves exact pi-ai usage and rejects partial data", () => {
  assert.deepEqual(captureProviderTokenUsage(providerMessage(3)), {
    inputTokens: 14_000,
    outputTokens: 103,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    totalTokens: 14_133,
  });
  assert.equal(captureProviderTokenUsage({ role: "assistant", usage: { input: 14_000 } }), null);
  assert.equal(captureProviderTokenUsage({ role: "assistant", usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }), null);
});

test("measurement: failed turns and ordinary conversation remain separate from GLLA payload bytes", () => {
  const payload = continuationPrompt(goalForMeasurement());
  const measured = measureContextGrowth([
    userMessage("keep the real conversation"),
    { role: "assistant", content: [], stopReason: "error", errorMessage: "503" },
    gllaMessage(payload),
  ]);

  assert.equal(measured.messageCount, 3);
  assert.equal(measured.gllaMessageCount, 1);
  assert.equal(measured.failedErrorOnlyCount, 1);
  assert.ok(measured.serializedBytes > measured.gllaSerializedBytes);
  assert.ok(measured.textChars > measured.gllaTextChars);
  assert.equal(measured.unserializableMessageCount, 0);
  assert.deepEqual(measured.provider, {
    sampleCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    firstInputTokens: null,
    latestInputTokens: null,
    inputTokenDelta: null,
    incompleteSampleCount: 0,
  });
});
