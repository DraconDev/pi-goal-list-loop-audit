import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { activeSupervisionPlanes, ContinuousSupervisor, SUPERVISION_MAX_POLL_MS, SUPERVISION_MIN_POLL_MS } from "../extensions/continuous-supervision.js";
import { buildLoopCompletionSummary, isTerminalLoopStopReason } from "../extensions/completion-summary.js";
import type { State } from "../extensions/goal-loop-core.js";

const empty = (): State => ({ goal: null, list: [] });

function goal(policy: "goal" | "list", status: "active" | "auditing" | "aborted" = "active"): any {
  return {
    id: "20260828000000-supervision",
    objective: "long-running work",
    status,
    policy,
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

test("v0.36.0: activeSupervisionPlanes covers every GLLA work plane without inventing activity", () => {
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("goal") }), ["goal"]);
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("list"), list: [{ id: "q", objective: "queued" }] as any }), ["list", "queue"]);
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("list", "auditing"), list: [{ id: "q", objective: "queued" }] as any, loop: { active: true } as any, mainModelRecovery: { primary: "p", attempted: [], attempts: 0, reason: "retry", kind: "loop" } as any }, 2), ["list", "auditor", "loop", "queue", "provider-recovery", "subagent"]);
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("goal", "aborted"), list: [] }), []);
});

test("v0.36.0: checker reacts to durable transitions across every work plane", () => {
  const state: State = {
    goal: {
      ...goal("list", "auditing"),
      revision: 4,
      pendingCompletion: { phase: "running", attemptId: "audit-1", at: "2026-08-28T00:00:00.000Z" },
    } as any,
    list: [{ id: "queue-1", objective: "queued work", addedAt: "2026-08-28T00:00:00.000Z" }] as any,
    loop: { active: true, target: "measure progress", iteration: 2, bestValue: 1, history: [] } as any,
    mainModelRecovery: { primary: "provider/primary", attempted: [], attempts: 1, reason: "retry" } as any,
  };
  const supervisor = new ContinuousSupervisor();
  const first = supervisor.check(state, 2);
  assert.equal(first.cause, "durable-state");
  assert.equal(first.pollMs, 0, "the first durable observation is inspected immediately");
  assert.deepEqual(first.planes, ["list", "auditor", "loop", "queue", "provider-recovery", "subagent"]);
  assert.deepEqual(first.signals.map((signal) => signal.plane), first.planes);

  const fallback = supervisor.check(state, 2);
  assert.equal(fallback.cause, "fallback");
  assert.equal(fallback.pollMs, SUPERVISION_MIN_POLL_MS);

  const changed = {
    ...state,
    goal: { ...state.goal!, revision: 5 },
    list: [{ ...state.list![0]!, objective: "queue progress recorded", addedAt: "2026-08-28T00:00:00.000Z" }],
    loop: { ...state.loop!, iteration: 3 },
    mainModelRecovery: { ...state.mainModelRecovery!, attempts: 2 },
  } as State;
  const durable = supervisor.check(changed, 2);
  assert.equal(durable.cause, "durable-state");
  assert.equal(durable.pollMs, 0);
  assert.deepEqual(new Set(durable.signals.map((signal) => signal.plane)), new Set(first.planes));
});

test("v0.36.0: lifecycle signals route immediately for every declared plane", () => {
  const state: State = {
    goal: { ...goal("list", "auditing"), pendingCompletion: { phase: "running", attemptId: "audit-2", at: "2026-08-28T00:00:00.000Z" } } as any,
    list: [{ id: "queue-2", objective: "queued", addedAt: "2026-08-28T00:00:00.000Z" }] as any,
    loop: { active: true, target: "loop", iteration: 1, history: [] } as any,
    mainModelRecovery: { primary: "provider/primary", attempted: [], attempts: 0, reason: "recover" } as any,
  };
  const supervisor = new ContinuousSupervisor();
  supervisor.check(state, 1); // consume the initial durable observation
  const kinds: Record<string, "start" | "progress" | "complete" | "recover" | "block"> = {
    goal: "progress",
    list: "start",
    loop: "complete",
    auditor: "complete",
    subagent: "progress",
    "provider-recovery": "recover",
    queue: "block",
  };
  for (const plane of ["goal", "list", "loop", "auditor", "subagent", "provider-recovery", "queue"] as const) {
    supervisor.signal({ plane, kind: kinds[plane]!, source: `e2e:${plane}` });
    const cycle = supervisor.check(state, 1);
    assert.equal(cycle.cause, "event", `${plane} signal is event-driven`);
    assert.equal(cycle.pollMs, 0, `${plane} signal does not wait for a fallback slot`);
    assert.deepEqual(cycle.signals, [{ plane, kind: kinds[plane]!, source: `e2e:${plane}` }]);
  }
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.lastSignals["provider-recovery"]?.kind, "recover");
  assert.equal(snapshot.lastSignals.auditor?.kind, "complete");
  assert.equal(snapshot.lastSignals.queue?.kind, "block");
});

test("v0.36.0: a child and recovery transition are durable signals, not guessed waits", () => {
  const supervisor = new ContinuousSupervisor();
  const before: State = { ...empty(), list: [{ id: "queued", objective: "pending", addedAt: "2026-08-28T00:00:00.000Z" }] as any };
  supervisor.check(before, 1);
  const after: State = { ...empty(), list: [{ id: "queued", objective: "pending", addedAt: "2026-08-28T00:00:00.000Z" }] as any, mainModelRecovery: { primary: "p", attempted: ["p"], attempts: 1, retryAt: "2026-08-28T00:01:00.000Z", reason: "provider retry" } as any };
  const recovery = supervisor.check(after, 1);
  assert.equal(recovery.cause, "durable-state");
  assert.equal(recovery.pollMs, 0);
  assert.ok(recovery.signals.some((signal) => signal.plane === "provider-recovery"));
  const childDone = supervisor.check(after, 0);
  assert.equal(childDone.cause, "durable-state");
  assert.equal(childDone.pollMs, 0);
  assert.ok(childDone.signals.some((signal) => signal.plane === "subagent"));
  const completion = supervisor.check(empty(), 0);
  assert.equal(completion.cause, "durable-state", "the disappearance of active work is observed immediately");
  assert.equal(completion.planes.length, 0);
  const idle = supervisor.check(empty(), 0);
  assert.equal(idle.cause, "fallback");
  assert.equal(idle.pollMs, SUPERVISION_MAX_POLL_MS);
});

test("v0.36.0: fallback polling adapts from 250ms to the 15s safety cadence", () => {
  const supervisor = new ContinuousSupervisor();
  supervisor.observeState({ ...empty(), goal: goal("goal") });
  assert.deepEqual(
    [supervisor.nextPollMs(true), supervisor.nextPollMs(true), supervisor.nextPollMs(true), supervisor.nextPollMs(true)],
    [SUPERVISION_MIN_POLL_MS, 500, 1000, 2000],
  );
  for (let i = 0; i < 8; i++) supervisor.nextPollMs(true);
  assert.equal(supervisor.nextPollMs(true), SUPERVISION_MAX_POLL_MS);
  assert.equal(supervisor.nextPollMs(false), SUPERVISION_MAX_POLL_MS);
});

test("v0.36.0: a real event resets fallback backoff instead of waiting for the old slot", () => {
  const supervisor = new ContinuousSupervisor();
  supervisor.observeState({ ...empty(), goal: goal("goal") });
  assert.equal(supervisor.nextPollMs(true), SUPERVISION_MIN_POLL_MS);
  assert.equal(supervisor.nextPollMs(true), 500);
  supervisor.signal({ plane: "goal", kind: "progress", source: "agent_end" });
  assert.equal(supervisor.nextPollMs(true), SUPERVISION_MIN_POLL_MS);
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.lastSignals.goal?.source, "agent_end");
});

test("v0.36.0: loop terminal outcomes receive a durable user-facing recap", () => {
  assert.equal(isTerminalLoopStopReason("plateau — no improvement"), true);
  assert.equal(isTerminalLoopStopReason("held: restored in a fresh session"), false);
  assert.equal(isTerminalLoopStopReason("main model recovery — retrying"), false);
  const summary = buildLoopCompletionSummary({ target: "polish the metric", stopReason: "plateau — no improvement", iteration: 4, bestValue: 2, historyLength: 4 });
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(summary, new RegExp(`^${label}`, "m"));
  assert.match(summary, /best=2/);
});

test("v0.36.0: production heartbeat is event-first with adaptive timeout fallback", () => {
  const heartbeat = fs.readFileSync(path.resolve("extensions/goal-heartbeat.ts"), "utf8");
  const activation = fs.readFileSync(path.resolve("extensions/loops/goal-activation.ts"), "utf8");
  const orchestrator = fs.readFileSync(path.resolve("extensions/loops/goal-orchestrator.ts"), "utf8");
  assert.match(heartbeat, /ContinuousSupervisor/);
  assert.match(heartbeat, /setTimeout\(/);
  assert.doesNotMatch(heartbeat, /setInterval\(heartbeatTick/);
  assert.match(heartbeat, /signalSupervisionEvent/);
  assert.match(activation, /source: "agent_end"/);
  assert.match(activation, /source: "subagents:completed"/);
  assert.match(orchestrator, /isTerminalLoopStopReason\(loop\.stopReason\)/);
  assert.match(orchestrator, /const nextSummary = buildLoopCompletionSummary\(/);
  assert.match(orchestrator, /loop\.completionSummary = nextSummary/);
});


test("respec audit phase and register changes are observed without inventing a worker", () => {
  const supervisor = new ContinuousSupervisor();
  const state = { ...empty(), loop: { active: true, target: "Build project", iteration: 1, builder: { phase: "building", revision: 1, cycle: 1 } } } as unknown as State;
  supervisor.check(state);
  assert.equal(supervisor.check(state).cause, "fallback");
  const auditing = { ...state, loop: { ...state.loop!, builder: { ...state.loop!.builder!, phase: "auditing", audit: { attemptId: "claim" } } } } as State;
  assert.ok(activeSupervisionPlanes(auditing).includes("auditor"));
  assert.equal(supervisor.check(auditing).cause, "durable-state");
  const refined = { ...auditing, loop: { ...auditing.loop!, builder: { ...auditing.loop!.builder!, phase: "replanning", revision: 2, audit: undefined } } } as State;
  assert.equal(supervisor.check(refined).cause, "durable-state");
});
