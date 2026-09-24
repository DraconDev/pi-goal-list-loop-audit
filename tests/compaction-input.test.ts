import assert from "node:assert/strict";
import test from "node:test";
import { projectCompactionPreparation } from "../extensions/compaction-input.js";

const text = (value: string, max = 12_000) => value.repeat(Math.ceil(max / Math.max(1, value.length)) + 1).slice(0, max);
const id = (value: string) => value.repeat(32).slice(0, 32);

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as RecordValue;
}

function asBlocks(value: unknown): Array<RecordValue> {
  const record = asRecord(value);
  assert.ok(Array.isArray(record.content));
  return record.content as Array<RecordValue>;
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
  const blocks = asBlocks(result.messagesToSummarize[0]);
  const thinking = asRecord(blocks[0]);
  const answer = asRecord(blocks[1]);
  const toolCall = asRecord(blocks[2]);
  assert.equal(thinking.type, "thinking");
  assert.equal((thinking.thinking as string).length, 1024);
  assert.equal((answer.text as string).length, 4096);
  const projectedArgs = asRecord(toolCall.arguments);
  assert.equal(JSON.stringify(projectedArgs).length < 1536, true);
  const resultMessage = asRecord(result.messagesToSummarize[1]);
  assert.equal(resultMessage.toolCallId, callId);
  const resultBlocks = asBlocks(resultMessage);
  assert.equal((asRecord(resultBlocks[0]).text as string).length <= 4096, true);
  assert.equal(result.inputCharsAfter < result.inputCharsBefore, true);
  assert.equal(result.boundedMessages, 2);
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
  const messages = result.messagesToSummarize.map(asRecord);
  const events = messages.filter((message) => message.customType === "goal-event");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.content, "[GLLA continuation payload omitted from compaction input; durable state remains in .pi-glla]");
  assert.equal(typeof events[1]?.content, "string");
  assert.equal((events[1]?.content as string).startsWith("new payload"), true);
  assert.equal(result.boundedGoalPayloads, 1);
  assert.equal(result.retainedGoalPayloads, 1);
  assert.equal(messages[1]?.content, "[GLLA continuation payload omitted from compaction input; durable state remains in .pi-glla]");
  assert.equal(typeof messages[3]?.content, "string");
  assert.equal((messages[3]?.content as string).startsWith("new payload"), true);
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
  const content = asBlocks(result.messagesToSummarize[0]);
  assert.equal(content[1]?.type, "text");
  assert.equal(content[1]?.text, "[image omitted from compaction input; image remains in the session transcript: image/png]");
  assert.equal(content[0]?.text, "before");
  assert.equal(content[2]?.text, "after");
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

  projectCompactionPreparation(prep);
  assert.equal(prep.firstKeptEntryId, "entry-1");
  assert.equal(prep.isSplitTurn, true);
  assert.equal(prep.previousSummary, "prior summary");
  assert.equal(prep.tokensBefore, 123_456);
  assert.deepEqual(prep.settings, { reserveTokens: 16_384, keepRecentTokens: 20_000 });
  assert.equal(prep.fileOps, fileOps);
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
  assert.equal(result.messagesToSummarize.every((message) => {
    const content = asRecord(message).content;
    return typeof content === "string" && content.length <= 4_096;
  }), true);
  assert.equal(result.turnPrefixMessages.every((message) => {
    const content = asRecord(message).content;
    return typeof content === "string" && content.length <= 4_096;
  }), true);
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

test("preserves both preparation-array identities when projection is a no-op", () => {
  const messagesToSummarize = [{ role: "user", content: "short" }];
  const turnPrefixMessages = [{ role: "assistant", content: "also short" }];
  const prep = { messagesToSummarize, turnPrefixMessages };

  const result = projectCompactionPreparation(prep);

  assert.equal(result.changed, false);
  assert.equal(result.messagesToSummarize, messagesToSummarize);
  assert.equal(result.turnPrefixMessages, turnPrefixMessages);
  assert.equal(prep.messagesToSummarize, messagesToSummarize);
  assert.equal(prep.turnPrefixMessages, turnPrefixMessages);
});

test("preserves the untouched half when only one preparation array needs projection", () => {
  const history = [{ role: "user", content: "A".repeat(12_000) }];
  const prefix = [{ role: "user", content: "short" }];
  const prep = { messagesToSummarize: history, turnPrefixMessages: prefix };

  const result = projectCompactionPreparation(prep);

  assert.equal(result.changed, true);
  assert.notEqual(result.messagesToSummarize, history);
  assert.equal(result.turnPrefixMessages, prefix);
  assert.equal(prep.turnPrefixMessages, prefix);
});

test("bounds every supported preparation shape and preserves pairing/order", () => {
  const firstCall = id("first-");
  const secondCall = id("second-");
  const prep = {
    messagesToSummarize: [
      { role: "assistant", content: text("direct answer ", 12_000) },
      { role: "user", content: text("user request ", 12_000) },
      {
        role: "user",
        content: [
          { type: "text", text: text("user block ", 12_000) },
          { type: "image", data: "B".repeat(20_000), mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text("reasoning ", 12_000) },
          { type: "toolCall", id: firstCall, name: "bash", arguments: { command: text("ls ", 8_000) } },
        ],
        stopReason: "toolUse",
        timestamp: 1,
      },
      { role: "toolResult", toolCallId: firstCall, toolName: "bash", content: text("first output ", 12_000) },
      { role: "custom", customType: "glla-note", content: text("custom payload ", 12_000), display: false, timestamp: 2 },
      {
        role: "custom",
        customType: "glla-blocks",
        content: [{ type: "text", text: text("custom block ", 12_000) }],
        display: false,
        timestamp: 3,
      },
    ],
    turnPrefixMessages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: secondCall, name: "read", arguments: { path: "/repo/src/file.ts", nested: { value: text("x", 8_000) } } }],
        stopReason: "toolUse",
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: secondCall, toolName: "read", content: [{ type: "text", text: text("second output ", 12_000) }] },
      { role: "bashExecution", command: text("npm test ", 12_000), output: text("test output ", 12_000), exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
      { role: "branchSummary", summary: text("branch checkpoint ", 20_000), fromId: "branch-1", timestamp: 6 },
      { role: "compactionSummary", summary: text("compaction checkpoint ", 20_000), tokensBefore: 123, timestamp: 7 },
    ],
  };

  const result = projectCompactionPreparation(prep);
  const history = result.messagesToSummarize.map(asRecord);
  const prefix = result.turnPrefixMessages.map(asRecord);

  assert.equal(result.changed, true);
  assert.deepEqual(
    [...history, ...prefix].map((message) => message.role),
    [...prep.messagesToSummarize, ...prep.turnPrefixMessages].map((message) => asRecord(message).role),
  );
  assert.equal(result.inputCharsAfter <= 64_000, true);
  assert.equal((history[0]?.content as string).length <= 4_096, true);
  assert.equal((history[1]?.content as string).length <= 4_096, true);
  assert.equal((asBlocks(history[2])[0]?.text as string).length <= 4_096, true);
  assert.equal((asBlocks(history[3])[1]?.type), "toolCall");
  assert.equal(asRecord(asBlocks(history[3])[1]).id, firstCall);
  assert.equal(history[4]?.toolCallId, firstCall);
  assert.equal((prefix[0] && asRecord(asBlocks(prefix[0])[0]).id), secondCall);
  assert.equal(prefix[1]?.toolCallId, secondCall);
  assert.equal(typeof history[5]?.content, "string");
  assert.equal((history[5]?.content as string).length <= 4_096, true);
  assert.equal((asBlocks(history[6])[0]?.text as string).length <= 4_096, true);
  assert.equal((prefix[2]?.command as string).length <= 4_096, true);
  assert.equal((prefix[2]?.output as string).length <= 4_096, true);
  assert.equal((prefix[3]?.summary as string).length <= 8_192, true);
  assert.equal((prefix[4]?.summary as string).length <= 8_192, true);
  assert.equal(result.replacedImages, 1);
});

test("second projection is idempotent", () => {
  const prep = {
    messagesToSummarize: [{ role: "assistant", content: text("repeated ", 12_000) }],
    turnPrefixMessages: [{ role: "user", content: text("follow-up ", 12_000) }],
  };

  const first = projectCompactionPreparation(prep);
  const historyAfterFirst = prep.messagesToSummarize;
  const prefixAfterFirst = prep.turnPrefixMessages;
  const second = projectCompactionPreparation(prep);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.inputCharsBefore, first.inputCharsAfter);
  assert.equal(second.inputCharsAfter, first.inputCharsAfter);
  assert.equal(prep.messagesToSummarize, historyAfterFirst);
  assert.equal(prep.turnPrefixMessages, prefixAfterFirst);
});

test("contains malformed preparation records without changing their positions", () => {
  const prep = {
    messagesToSummarize: [
      null,
      "invalid",
      42,
      { role: "assistant" },
      { role: "assistant", content: [null, 42, { type: "text" }] },
      { role: "custom", customType: "goal-event", content: "usable" },
    ],
    turnPrefixMessages: [{ role: "user", content: "short" }],
  };

  const result = projectCompactionPreparation(prep);

  assert.equal(result.messagesToSummarize.length, 6);
  assert.equal(result.turnPrefixMessages.length, 1);
  assert.equal(Number.isFinite(result.inputCharsAfter), true);
});
