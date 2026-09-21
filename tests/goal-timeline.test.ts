// pi-goal-list-loop-audit — v0.38.85
// tests/goal-timeline.test.ts
//
// /goal timeline: one "what happened and what's next" rendering per
// goal. Ledger events (goalId-scoped, plus salient unscoped events
// inside the goal's lifetime) merge with the auditHistory verdicts by
// timestamp; key types humanize, unknown types render compactly (never
// hidden); the footer names the single next action from live state.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { routeGoalArgs, readState } from "../extensions/goal-loop-core.js";
import { formatGoalTimeline } from "../extensions/goal-commands.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const H = 3_600_000;

function goal(overrides: Record<string, unknown> = {}): any {
  return {
    id: "g1",
    objective: "Fix the typo in the README header.",
    status: "active",
    policy: "goal",
    createdAt: iso(T0),
    ...overrides,
  };
}

function entry(type: string, at: number, value: Record<string, unknown> = {}): any {
  return { type, at: iso(at), value };
}

test("timeline: routes as a goal subcommand with optional count", () => {
  assert.deepEqual(routeGoalArgs("timeline"), { kind: "sub", name: "timeline", rest: "" });
  assert.deepEqual(routeGoalArgs("timeline 30"), { kind: "sub", name: "timeline", rest: "30" });
});

test("timeline: merges ledger events and verdicts in time order, humanized", () => {
  const out = formatGoalTimeline({
    goal: goal({
      auditHistory: [
        { at: iso(T0 + 3 * H), approved: false, disapproved: true, model: "m", report: "r" },
        { at: iso(T0 + 5 * H), approved: true, disapproved: false, model: "m2", report: "r2", auditTier: "full", challenge: "confirmed" },
      ],
    }),
    entries: [
      entry("goal_created", T0, { goalId: "g1", via: "draft-confirmed" }),
      entry("run_to_done_consented", T0 + H, { goalId: "g1", via: "draft-confirmed" }),
      entry("goal_paused", T0 + 2 * H, { reason: "decision gate" }),
      entry("goal_resumed", T0 + 4 * H, { goalId: "g1", via: "resume_goal" }),
    ],
    nowMs: T0 + 6 * H,
  });
  const lines = out.split("\n");
  assert.match(lines[0]!, /Timeline: Fix the typo .* \(active\)/);
  assert.ok(lines.findIndex((l) => /created/.test(l)) < lines.findIndex((l) => /run-to-done consented/.test(l)));
  assert.ok(lines.findIndex((l) => /run-to-done consented/.test(l)) < lines.findIndex((l) => /paused: decision gate/.test(l)));
  assert.ok(lines.findIndex((l) => /paused: decision gate/.test(l)) < lines.findIndex((l) => /audit #1: disapproved/.test(l)));
  assert.ok(lines.findIndex((l) => /audit #1: disapproved/.test(l)) < lines.findIndex((l) => /resumed/.test(l)));
  assert.ok(lines.findIndex((l) => /resumed/.test(l)) < lines.findIndex((l) => /audit #2: approved/.test(l) && /full/.test(l) && /confirmed/.test(l)));
  assert.match(out, /Next: working toward the contract\./);
});

test("timeline: unknown types render compactly, noise and foreign goals excluded", () => {
  const out = formatGoalTimeline({
    goal: goal(),
    entries: [
      entry("goal_created", T0, { goalId: "g1" }),
      entry("some_future_event", T0 + H, { goalId: "g1", foo: "barbaz" }),
      entry("state", T0 + 2 * H, { goalId: "g1" }),
      entry("goal_paused", T0 + 3 * H, { reason: "x" }),
      entry("goal_created", T0 + 4 * H, { goalId: "other" }),
      entry("goal_paused", T0 - H, { reason: "before this goal existed" }),
    ],
    nowMs: T0 + 5 * H,
  });
  assert.match(out, /some_future_event  foo=barbaz/, "unknown scoped types stay visible, compact");
  assert.doesNotMatch(out, /\bstate\b/, "snapshots are noise here");
  assert.match(out, /paused: x/, "unscoped salient events inside the lifetime count");
  assert.doesNotMatch(out, /before this goal existed/, "unscoped events before creation do not leak across goals");
  assert.doesNotMatch(out, /other/, "other goals' events never leak");
});

test("timeline: honors the limit with a truncation note", () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry("goal_tweaked", T0 + i * H, { goalId: "g1", n: i }));
  const out = formatGoalTimeline({ goal: goal(), entries, nowMs: T0 + 11 * H, limit: 3 });
  assert.match(out, /showing last 3 of 10/);
});

test("timeline: next action derives from live state", () => {
  const nextOf = (g: any): string => {
    const out = formatGoalTimeline({ goal: goal(g), entries: [], nowMs: T0 + H });
    return out.split("\n").at(-1)!;
  };
  assert.match(nextOf({ status: "paused", pauseKind: "decision" }), /Next: answer the pending decision \(\/goal decide\)\./);
  assert.match(nextOf({ status: "paused", pauseKind: "wait", pauseResumeAt: iso(T0 + 2 * H) }), /Next: auto-resumes at .* — or \/goal resume now\./);
  assert.match(nextOf({ status: "paused", pauseReason: "provider outage" }), /Next: \/goal resume to continue \(provider outage\)\./);
  assert.match(nextOf({ status: "auditing" }), /Next: audit in flight — wait for the verdict\./);
  assert.match(nextOf({ pendingCompletion: { at: iso(T0) } }), /Next: claim submitted — the audit is starting\./);
  assert.match(
    nextOf({ auditHistory: [{ at: iso(T0), approved: false, disapproved: true, model: "m" }] }),
    /Next: address 1 open objection, then re-submit\./,
  );
  assert.match(
    nextOf({ auditHistory: [{ at: iso(T0), approved: false, disapproved: true, model: "m", superseded: true }] }),
    /Next: working toward the contract\./,
    "superseded disapprovals are settled context, not live",
  );
  assert.match(nextOf({ status: "complete" }), /Next: nothing — complete\./);
});

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("timeline: /goal timeline renders the live goal end to end", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, autoResume: true }));
  seedState(cwd, { goal: seedGoal({ status: "active", policy: "goal", objective: "E2E timeline goal — done when pinned" }) });
  const id = (readState(cwd).goal as any).id as string;
  const ledger = [
    { type: "goal_created", at: iso(T0), value: { goalId: id, via: "draft-confirmed" } },
    { type: "goal_paused", at: iso(T0 + H), value: { reason: "decision gate" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), ledger);
  const pi = new MockPi();
  activate(pi.api);
  const ctx: MockCtx = makeMockCtx(cwd, { sessionManager: { name: `timeline-e2e-${Date.now()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  await pi.command("goal", "timeline", ctx);
  const msg = ctx.ui.notifies.at(-1)!.message;
  assert.match(msg, /Timeline: E2E timeline goal/);
  assert.match(msg, /created/);
  assert.match(msg, /Next: /);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});
