import { test } from "node:test";
import * as assert from "node:assert/strict";

import type { Goal } from "../extensions/goal-loop-core.ts";
import type { LoopState } from "../extensions/goal-loop-forever.ts";
import { continuationPrompt } from "../extensions/goal-continuation.ts";
import { measureContextGrowth } from "../extensions/context-growth.ts";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.ts";
import { state, replaceState } from "../extensions/goal-state.ts";
import * as fs from "node:fs";
import { makeMockCtx, MockPi, tmpCwd } from "./harness/mock-pi.js";
import {
  AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE,
  MAX_AUTHORITATIVE_CHECKPOINT_CHARS,
  buildAuthoritativeContextCheckpoint,
  projectBoundedGllaContext,
} from "../extensions/context-checkpoint.ts";

function goalFixture(): Goal {
  return {
    id: "goal-checkpoint-test",
    objective: "Preserve the authoritative objective while bounding repeated continuation context.",
    verificationContract: "Done when checkpoint projection is bounded, retains the current payload, and records audit/fence state.",
    status: "active",
    policy: "goal",
    autoContinue: true,
    revision: 7,
    taskList: {
      version: 1,
      tasks: [
        { id: "1", title: "Measure growth", status: "complete" },
        { id: "2", title: "Implement checkpoint", status: "in_progress" },
      ],
    },
    auditHistory: [{
      at: "2026-08-29T10:00:00.000Z",
      approved: false,
      disapproved: true,
      model: "fixture-auditor",
      revision: 7,
      report: "## Required fixes\nKeep the objective and verification contract visible after compaction.",
      regressionShieldPassed: true,
    }],
    pendingTasks: ["Add lifecycle regression coverage"],
    pendingCompletion: {
      at: "2026-08-29T10:01:00.000Z",
      phase: "recovery-pending",
      attemptId: "attempt-7",
      recoveryReason: "auditor transport failed",
      auditorFailureClass: "transport",
      auditorFailureCount: 1,
    },
    usage: { tokensUsed: 10, tokensLimit: 1000 },
    createdAt: "2026-08-29T09:00:00.000Z",
    updatedAt: "2026-08-29T10:01:00.000Z",
  };
}

function loopFixture(): LoopState {
  return {
    target: "Bound loop-only continuation context without losing the active loop objective.",
    measureCmd: "printf 17",
    direction: "min",
    iteration: 4,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 1,
    bestValue: 17,
    lastValue: 19,
    active: true,
    history: [
      { iteration: 3, value: 19, improved: false, at: "2026-08-29T10:03:00.000Z" },
    ],
    startedAt: "2026-08-29T10:00:00.000Z",
    tokenBudget: 20_000,
    tokensUsed: 2_000,
  };
}

function gllaPayload(index: number): Record<string, unknown> {
  return {
    role: "user",
    customType: "goal-event",
    content: `continuation-${index}`,
    display: false,
  };
}

test("authoritative checkpoint carries state, audit evidence, and lifecycle fences", () => {
  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: goalFixture(),
    sessionGeneration: 12,
    ownerSessionId: "session-owner-12",
  });

  assert.ok(checkpoint.length <= MAX_AUTHORITATIVE_CHECKPOINT_CHARS);
  assert.match(checkpoint, /goalId=goal-checkpoint-test/);
  assert.match(checkpoint, /Objective: Preserve the authoritative objective/);
  assert.match(checkpoint, /Verification contract: Done when checkpoint projection/);
  assert.match(checkpoint, /revision=7/);
  assert.match(checkpoint, /sessionGeneration=12/);
  assert.match(checkpoint, /ownerSession=session-owner-12/);
  assert.match(checkpoint, /label=disapproved/);
  assert.match(checkpoint, /Required fixes/);
  assert.match(checkpoint, /recovery-pending/);
  assert.match(checkpoint, /Implement checkpoint/);
  assert.match(checkpoint, /Add lifecycle regression coverage/);
});

test("real continuation payload growth is bounded after checkpoint projection", () => {
  const payload = continuationPrompt(goalFixture());
  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: goalFixture(),
    sessionGeneration: 12,
    ownerSessionId: "session-owner-12",
  });
  const baseline = [
    { role: "user", content: "start" },
    { role: "assistant", content: "working", stopReason: "stop" },
  ];
  const bounded = [5, 12, 25].map((count) => {
    const messages = [
      ...baseline,
      ...Array.from({ length: count }, () => ({
        role: "user",
        customType: "goal-event",
        content: payload,
        display: false,
      })),
    ];
    const projection = projectBoundedGllaContext(messages, checkpoint);
    const measurement = measureContextGrowth(projection.messages);
    return {
      count,
      messageCount: measurement.messageCount,
      serializedBytes: measurement.serializedBytes,
      gllaMessageCount: measurement.gllaMessageCount,
      repeatedPayloads: measurement.repeatedGllaPayloadCount,
      removedPayloads: projection.removedPayloads,
    };
  });

  assert.deepEqual(bounded, [
    { count: 5, messageCount: 4, serializedBytes: 25813, gllaMessageCount: 2, repeatedPayloads: 0, removedPayloads: 4 },
    { count: 12, messageCount: 4, serializedBytes: 25813, gllaMessageCount: 2, repeatedPayloads: 0, removedPayloads: 11 },
    { count: 25, messageCount: 4, serializedBytes: 25813, gllaMessageCount: 2, repeatedPayloads: 0, removedPayloads: 24 },
  ]);
});

test("projection removes old goal events, inserts one checkpoint, and keeps newest payload", () => {
  const original = [
    { role: "user", content: "ordinary user context" },
    { role: "assistant", content: "ordinary assistant context" },
    ...Array.from({ length: 25 }, (_, index) => gllaPayload(index)),
    { role: "toolResult", content: "tool result" },
  ];
  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: goalFixture(),
    sessionGeneration: 12,
    ownerSessionId: "session-owner-12",
  });
  const projected = projectBoundedGllaContext(original, checkpoint);

  assert.equal(projected.originalPayloads, 25);
  assert.equal(projected.removedPayloads, 24);
  assert.equal(projected.retainedPayloads, 1);
  assert.equal(projected.insertedCheckpoint, true);
  assert.equal(projected.messages.length, 5);
  assert.deepEqual(projected.messages[0], original[0]);
  assert.deepEqual(projected.messages[1], original[1]);
  assert.equal((projected.messages[2] as { customType?: unknown }).customType, AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE);
  assert.equal((projected.messages[3] as { content?: unknown }).content, "continuation-24");
  assert.deepEqual(projected.messages[projected.messages.length - 1], original[original.length - 1]);
  assert.equal(original.length, 28, "projection must not mutate the source transcript list");
});

test("one goal event is a no-op and does not inject a checkpoint", () => {
  const messages = [{ role: "user", customType: "goal-event", content: "current", display: false }];
  const result = projectBoundedGllaContext(messages, "checkpoint");

  assert.equal(result.messages, messages);
  assert.equal(result.removedPayloads, 0);
  assert.equal(result.insertedCheckpoint, false);
  assert.equal(result.retainedPayloads, 1);
});

test("zero-retention mode resynchronizes from the checkpoint without retaining payloads", () => {
  const messages = [gllaPayload(1), gllaPayload(2)];
  const result = projectBoundedGllaContext(messages, "authoritative", { maxRetainedPayloads: 0 });

  assert.equal(result.removedPayloads, 2);
  assert.equal(result.retainedPayloads, 0);
  assert.equal(result.messages.length, 1);
  assert.equal((result.messages[0] as { customType?: unknown }).customType, AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE);
  assert.equal((result.messages[0] as { content?: unknown }).content, "authoritative");
});

test("loop-only projection bounds repeated payloads and carries loop authority", () => {
  const loop = loopFixture();
  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: null,
    loop,
    sessionGeneration: 13,
    ownerSessionId: "loop-owner-13",
  });
  assert.match(checkpoint, /goalId=\(none\)/);
  assert.match(checkpoint, /loopTarget=Bound loop-only continuation context/);
  assert.match(checkpoint, /Loop target: Bound loop-only continuation context/);
  assert.match(checkpoint, /Loop measure: command=printf 17/);
  assert.match(checkpoint, /Loop bounds: maxIterations=50/);
  // Cache-stability invariant: volatile loop counters must NOT be rendered
  // into the checkpoint (it sits early in the per-send history, so any byte
  // change busts the provider prefix cache for every later token).
  assert.ok(!/iteration=4/.test(checkpoint), "checkpoint must not render live iteration");
  assert.ok(!/best=17/.test(checkpoint), "checkpoint must not render live best value");
  assert.ok(!/stall=1/.test(checkpoint), "checkpoint must not render live stall count");

  const messages = [
    { role: "user", content: "ordinary context" },
    ...Array.from({ length: 25 }, (_, index) => ({
      role: "user",
      customType: "goal-event",
      content: `loop-iteration-${index}-${"x".repeat(500)}`,
      display: false,
    })),
  ];
  const before = measureContextGrowth(messages);
  const projection = projectBoundedGllaContext(messages, checkpoint);
  const after = measureContextGrowth(projection.messages);

  assert.equal(projection.removedPayloads, 24);
  assert.equal(projection.retainedPayloads, 1);
  assert.equal(projection.insertedCheckpoint, true);
  assert.equal(after.messageCount, 3);
  assert.equal(after.gllaMessageCount, 2);
  assert.ok(after.serializedBytes < before.serializedBytes);
});

test("loop checkpoint is byte-stable across volatile loop progress (prefix-cache stability)", () => {
  const base = loopFixture();
  const next: LoopState = {
    ...base,
    iteration: 5,
    stallCount: 2,
    bestValue: 17,
    lastValue: 21,
    consecutiveNullMeasures: 1,
    consecutiveErrors: 1,
    tokensUsed: 9_000,
    lastIterationCompletedAt: "2026-08-29T10:04:00.000Z",
    refineHint: "try a different angle",
    history: [
      ...base.history,
      { iteration: 4, value: 21, improved: false, at: "2026-08-29T10:04:00.000Z" },
      { iteration: 5, value: null, improved: false, at: "2026-08-29T10:05:00.000Z" },
    ],
  };
  const input = { goal: null, sessionGeneration: 13, ownerSessionId: "loop-owner-13" } as const;
  const before = buildAuthoritativeContextCheckpoint({ ...input, loop: base });
  const after = buildAuthoritativeContextCheckpoint({ ...input, loop: next });
  assert.equal(after, before, "volatile loop counters must not change checkpoint bytes — the checkpoint is inserted early in history and any change busts the provider prefix cache for every later token");
  // Stable authority must still move the checkpoint when it genuinely changes.
  const retargeted = buildAuthoritativeContextCheckpoint({
    ...input,
    loop: { ...base, target: "a different loop target" },
  });
  assert.notEqual(retargeted, before);
});

test("context hook projects loop-only state and records loop authority", async () => {
  const cwd = tmpCwd();
  const previousState = { ...state };
  replaceState({ ...previousState, goal: null, loop: loopFixture() });
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyResetOwnerSession();
    const ctx = makeMockCtx(cwd, { sessionManager: { name: "loop-only-checkpoint" } });
    const handlers = (pi as unknown as { handlers: Map<string, (...args: unknown[]) => unknown> }).handlers;
    const handler = handlers.get("context");
    assert.ok(handler);

    const result = await handler({
      type: "context",
      messages: [gllaPayload(1), gllaPayload(2), gllaPayload(3)],
    }, ctx) as { messages?: unknown[] };
    assert.ok(result.messages);
    assert.equal(result.messages!.length, 2);
    const checkpoint = result.messages![0] as { customType?: unknown; content?: unknown };
    assert.equal(checkpoint.customType, AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE);
    assert.match(String(checkpoint.content), /Loop target: Bound loop-only continuation context/);
    assert.match(String(checkpoint.content), /policy=loop/);

    const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8")
      .split("\\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; value?: Record<string, unknown> });
    const event = ledger.find((entry) => entry.type === "context_checkpoint_projection");
    assert.ok(event);
    assert.equal(event!.value!.goalId, undefined);
    assert.equal(event!.value!.loopTarget, loopFixture().target);
    assert.equal(event!.value!.loopIteration, 4);
  } finally {
    replaceState(previousState);
  }
});

test("paused goal plus active loop preserves both authorities in the checkpoint", async () => {
  const cwd = tmpCwd();
  const previousState = { ...state };
  const pausedGoal: Goal = { ...goalFixture(), status: "paused" };
  const loop = loopFixture();
  replaceState({ ...previousState, goal: pausedGoal, loop });
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyResetOwnerSession();
    const ctx = makeMockCtx(cwd, { sessionManager: { name: "paused-goal-loop-checkpoint" } });
    const handlers = (pi as unknown as { handlers: Map<string, (...args: unknown[]) => unknown> }).handlers;
    const handler = handlers.get("context");
    assert.ok(handler);

    const result = await handler({
      type: "context",
      messages: [gllaPayload(1), gllaPayload(2), gllaPayload(3), gllaPayload(4)],
    }, ctx) as { messages?: unknown[] };
    assert.ok(result.messages);
    assert.equal(result.messages!.length, 2);
    const content = String((result.messages![0] as { content?: unknown }).content);
    assert.match(content, /status=paused/);
    assert.match(content, /Objective: Preserve the authoritative objective/);
    assert.match(content, /Loop target: Bound loop-only continuation context/);
    assert.match(content, /loopTarget=Bound loop-only continuation context/);

    const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8")
      .split("\\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; value?: Record<string, unknown> });
    const event = ledger.find((entry) => entry.type === "context_checkpoint_projection");
    assert.ok(event);
    assert.equal(event!.value!.goalId, pausedGoal.id);
    assert.equal(event!.value!.loopTarget, loop.target);
  } finally {
    replaceState(previousState);
  }
});

test("oversized paused goal plus active loop reserves required checkpoint fields", () => {
  const baseGoal = goalFixture();
  const oversizedGoal: Goal = {
    ...baseGoal,
    status: "paused",
    objective: "O".repeat(2_000),
    verificationContract: "C".repeat(2_000),
    auditHistory: [{
      at: "2026-08-29T10:00:00.000Z",
      approved: false,
      disapproved: true,
      model: "fixture-auditor",
      revision: 7,
      report: "A".repeat(2_000),
      regressionShieldPassed: true,
    }],
    taskList: {
      version: 1,
      tasks: Array.from({ length: 20 }, (_, index) => ({
        id: String(index + 1),
        title: `T${index}-` + "x".repeat(200),
        status: "complete" as const,
      })),
    },
  };
  const oversizedLoop: LoopState = {
    ...loopFixture(),
    target: "L".repeat(2_000),
    measureCmd: "M".repeat(1_200),
    history: Array.from({ length: 8 }, (_, index) => ({
      iteration: index + 1,
      value: index,
      improved: index > 0,
      at: `2026-08-29T10:0${index}:00.000Z`,
    })),
  };

  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: oversizedGoal,
    loop: oversizedLoop,
    sessionGeneration: 14,
    ownerSessionId: "oversized-owner-14",
  });

  assert.ok(checkpoint.length <= MAX_AUTHORITATIVE_CHECKPOINT_CHARS);
  assert.match(checkpoint, /Objective: O{100}/);
  assert.match(checkpoint, /Verification contract: C{100}/);
  assert.match(checkpoint, /Latest audit .*label=disapproved/s);
  assert.match(checkpoint, /Active loop authority/);
  assert.match(checkpoint, /Loop target: L{100}/);
  assert.match(checkpoint, /status=paused/);
  assert.match(checkpoint, /sessionGeneration=14/);
  assert.match(checkpoint, /ownerSession=oversized-owner-14/);
  assert.match(checkpoint, /Lifecycle fence:/);
});

test("context hook uses current durable state and records the projection", async () => {
  const cwd = tmpCwd();
  const previousGoal = state.goal;
  replaceState({ goal: goalFixture() });
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyResetOwnerSession();
    const ctx = makeMockCtx(cwd, { sessionManager: { name: "checkpoint-wiring" } });
    const handlers = (pi as unknown as { handlers: Map<string, (...args: unknown[]) => unknown> }).handlers;
    const handler = handlers.get("context");
    assert.ok(handler);

    const result = await handler({
      type: "context",
      messages: [gllaPayload(1), gllaPayload(2), gllaPayload(3)],
    }, ctx) as { messages?: unknown[] };
    assert.ok(result.messages);
    assert.equal(result.messages!.length, 2, "checkpoint plus newest payload");
    assert.equal((result.messages![0] as { customType?: unknown }).customType, AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE);
    assert.match(String((result.messages![0] as { content?: unknown }).content), /revision=7/);
    assert.equal((result.messages![1] as { content?: unknown }).content, "continuation-3");

    const ledgerPath = `${cwd}/.pi-glla/active.jsonl`;
    const ledger = fs.readFileSync(ledgerPath, "utf8")
      .split("\\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; value?: Record<string, unknown> });
    const event = ledger.find((entry) => entry.type === "context_checkpoint_projection");
    assert.ok(event);
    assert.equal(event!.value!.removedPayloads, 2);
    assert.equal(event!.value!.retainedPayloads, 1);
  } finally {
    replaceState({ goal: previousGoal });
  }
});
