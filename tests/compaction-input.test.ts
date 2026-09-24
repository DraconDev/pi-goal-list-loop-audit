import assert from "node:assert/strict";
import test from "node:test";
import { projectCompactionPreparation } from "../extensions/compaction-input.js";

const text = (value: string, max = 12_000) => value.repeat(Math.ceil(max / Math.max(1, value.length)) + 1).slice(0, max);
const id = (value: string) => value.repeat(32).slice(0, 32);

function assistantCall(callId: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "bash", arguments: args }],
  };
}

function toolResult(callId: string, value: string) {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [{ type: "text", text: value }],
  };
}

test("bounds successful assistant, tool-call, and tool-result content while preserving pairing", () => {
  const callId = id("call-");
  const prep = {
    messagesToSummarize: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text("reasoning ") },
          { type: "text", text: text("answer ") },
          { type: "toolCall", id: callId, name: "bash", arguments: { command: text("ls ", 8_000) } },
        ],
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        api: "openai-completions",
        provider: "openrouter",
        model: "test",
        timestamp: 1,
      },
      toolResult(callId, text("output ")),
    ],
    turnPrefixMessages: [],
  };

  const result = projectCompactionPreparation(prep);
  const assistant = result.messagesToSummarize[0];
  const blocks = assistant.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0].type, "thinking");
  assert.equal((blocks[0].thinking as string).length, 1024);
  assert.equal((blocks[1].text as string).length, 4096);
  assert.equal(typeof blocks[2].arguments, "string");
  assert.equal((blocks[2].arguments as string).length < 1536, true);
  const resultMessage = result.messagesToSummarize[1];
  assert.equal(resultMessage.toolCallId, callId);
  assert.equal((resultMessage.content[0] as Record<string, unknown>).text.length <= 4096, true);
  assert.equal(result.inputCharsAfter < result.inputCharsBefore, true);
  assert.equal(result.boundedMessages, 1);
  assert.equal(result.boundedFields >= 4, true);
});

test("retains the newest goal payload and marks older payloads without changing message order", () => {
  const prep = {
    messagesToSummarize: [
      { role: "user", content: "start" },
      { role: "custom", customType: "goal-event", content: text("old payload "), timestamp: 1 },
      { role: "user", content: "middle" },
      { role: "custom", customType: "goal-event", content: text("new payload "), timestamp: 2 },
    ],
    turnPrefixMessages: [],
  };

  const result = projectCompactionPreparation(prep);
  const events = result.messagesToSummarize.filter((message) => message.customType === "goal-event") as Array<Record<string, unknown>>;
  assert.equal(events.length, 2);
  assert.equal(events[0].content, "[GLLA goal-event payload omitted: older state superseded]");
  assert.equal((events[1].content as string).startsWith("new payload"), true);
  assert.equal(result.boundedGoalPayloads, 1);
  assert.equal(result.retainedGoalPayloads, 1);
  assert.equal(result.messagesToSummarize[1].content, "[GLLA goal-event payload omitted: older state superseded]");
  assert.equal(result.messagesToSummarize[3].content.startsWith("new payload"), true);
});

test("replaces image blocks while retaining the surrounding message structure", () => {
  const prep = {
    messagesToSummarize: [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image", data: "A".repeat(40_000), mimeType: "image/png" },
          { type: "text", text: "after" },
        ],
      },
    ],
    turnPrefixMessages: [],
  };

  const result = projectCompactionPreparation(prep);
  const content = result.messagesToSummarize[0].content as Array<Record<string, unknown>>;
  assert.equal(content[1].type, "text");
  assert.equal(content[1].text, "[image omitted from compaction input: image/png]");
  assert.equal(content[0].text, "before");
  assert.equal(content[2].text, "after");
  assert.equal(result.replacedImages, 1);
});

test("leaves preparation metadata and fileOps untouched", () => {
  const fileOps = {
    reads: [{ path: "src/a.ts", line: 1 }],
    edits: [{ path: "src/b.ts", line: 2 }],
  };
  const prep = {
    messagesToSummarize: [{ role: "assistant", content: [{ type: "text", text: text("message ") }] }],
    turnPrefixMessages: [{ role: "user", content: text("prefix ") }],
    firstKeptEntryId: "entry-1",
    isSplitTurn: true,
    previousSummary: "prior summary",
    tokensBefore: 123_456,
    settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
    fileOps,
  };

  const result = projectCompactionPreparation(prep);
  assert.equal(result.firstKeptEntryId, "entry-1");
  assert.equal(result.isSplitTurn, true);
  assert.equal(result.previousSummary, "prior summary");
  assert.equal(result.tokensBefore, 123_456);
  assert.deepEqual(result.settings, prep.settings);
  assert.equal(result.fileOps, fileOps);
});

test("applies one coordinated budget to summarize and turn-prefix arrays", () => {
  const prep = {
    messagesToSummarize: Array.from({ length: 12 }, (_, index) => ({ role: "assistant", content: text(`m${index} `, 4_000) })),
    turnPrefixMessages: Array.from({ length: 12 }, (_, index) => ({ role: "user", content: text(`p${index} `, 4_000) })),
  };

  const result = projectCompactionPreparation(prep);
  assert.equal(result.messagesToSummarize.length, 12);
  assert.equal(result.turnPrefixMessages.length, 12);
  assert.equal(result.inputCharsAfter <= 64_000, true);
  assert.equal(result.scale < 1, true);
  assert.equal(result.messagesToSummarize.every((message) => typeof message.content === "string" && message.content.length <= 4_096), true);
  assert.equal(result.turnPrefixMessages.every((message) => typeof message.content === "string" && message.content.length <= 4_096), true);
});

test("returns no compaction result and tolerates a missing preparation", () => {
  const missing = projectCompactionPreparation(undefined);
  assert.deepEqual(missing.messagesToSummarize, []);
  assert.deepEqual(missing.turnPrefixMessages, []);
  assert.equal(missing.changed, false);
  const result = projectCompactionPreparation({ messagesToSummarize: [], turnPrefixMessages: [] });
  assert.equal("compaction" in result, false);
  assert.equal("result" in result, false);
});
