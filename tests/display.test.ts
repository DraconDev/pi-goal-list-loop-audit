// pi-goal-list-loop-audit — v0.9.0
// tests/display.test.ts
//
// Unit tests for the live-TUI display builders: status line + widget lines.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  buildStatusText,
  buildWidgetLines,
  meter,
  fmtElapsed,
  fmtTokens,
  truncate,
  MAIN_HOST_LABEL,
  WORKER_TEXT_SPACER,
} from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";
import type { LoopState } from "../extensions/goal-loop-forever.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const NOW = Date.parse("2026-07-21T12:00:00Z");
const LOOP = fs.readFileSync("extensions/goal-loop.ts", "utf-8");
const GOAL_UI = fs.readFileSync("extensions/loops/goal-ui.ts", "utf-8");

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260721120000-abcdef",
    objective: "Create x.txt containing ok",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-07-21T11:57:00Z",
    updatedAt: "2026-07-21T11:57:00Z",
    ...overrides,
  };
}

// ---- formatters ----

test("fmtElapsed", () => {
  assert.equal(fmtElapsed(500), "0s");
  assert.equal(fmtElapsed(45_000), "45s");
  assert.equal(fmtElapsed(180_000), "3m 00s");
  assert.equal(fmtElapsed(3_900_000), "1h 05m");
});

test("fmtTokens", () => {
  assert.equal(fmtTokens(500), "500");
  assert.equal(fmtTokens(12_400), "12.4k");
  assert.equal(fmtTokens(1_000_000), "1000k");
});

test("truncate", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a much longer string", 8), "a much …");
});

test("display projections remove terminal and zero-width control characters without changing stored state", () => {
  const hostile = "safe\u001b[31m\nspoof\u0007\u202Ehidden\u200B";
  assert.equal(truncate(hostile, 200), "safe spoof hidden");
  const g = goalOf({ objective: hostile, pauseReason: hostile });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  const rendered = lines.join("\n");
  const controls = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  assert.ok(!lines.some((line) => controls.test(line)));
  assert.ok(!rendered.includes("\u001b"));
  assert.equal(g.objective, hostile, "display rendering must not mutate persisted objective data");
});

// ---- buildStatusText ----

test("empty state → undefined (segment cleared)", () => {
  assert.equal(buildStatusText({ goal: null, list: [] }, null, NOW), undefined);
});

test("active goal shows a compact state capsule + elapsed", () => {
  const s = buildStatusText({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(s, /glla: \[ACTIVE\] total 3m/);
  assert.doesNotMatch(s, /glla: goal/, 'v0.34.1: the status line drops the policy word — the widget owns type naming');
});

test("repair cards show the preserved target and the concrete one-turn recovery", () => {
  const g = goalOf({
    policy: "list",
    repairTarget: {
      id: "original-item",
      objective: "Audit the saved intent and preserve its complete target",
      reasons: ["dangling-fragment"],
      source: "list-activation",
    },
  });
  const lines = buildWidgetLines({ goal: g, list: [{ id: "waiting", objective: "next item", addedAt: "2026-07-21T11:59:00Z" }] }, null, NOW)!;
  const rendered = lines.join("\\n");
  assert.match(rendered, /REPLAN REQUIRED/);
  assert.match(rendered, /Audit the saved intent/);
  assert.match(rendered, /propose_task_list/);
  assert.match(rendered, /1 waiting · up next: next item/);
});

test("repair cards with a sent bootstrap show the explicit retry action", () => {
  const g = goalOf({
    policy: "list",
    repairTarget: {
      id: "original-item",
      objective: "Audit the saved intent",
      reasons: ["dangling-fragment"],
      source: "list-activation",
      replanPromptedAt: "2026-07-21T11:59:00Z",
    },
  });
  const rendered = buildWidgetLines({ goal: g, list: [] }, null, NOW)!.join("\\n");
  assert.ok(rendered.includes("/list resume retries one bounded replan turn"));
});

test("active status does not make first-turn or long-idle gaps look green", () => {
  const state = { goal: goalOf(), list: [] };
  const awaiting = buildWidgetLines(state, null, NOW, undefined, undefined, { activity: "awaiting-first-turn" })!;
  assert.match(buildStatusText(state, null, NOW, undefined, { activity: "awaiting-first-turn" })!, /AWAITING FIRST TURN/);
  assert.ok(awaiting.some((line) => line.includes("· active ·")));
  assert.doesNotMatch(awaiting.join("\n"), /AWAITING FIRST TURN|LIVE WORK/);

  const idle = buildWidgetLines(state, null, NOW, undefined, undefined, { activity: "idle", lastActivityAt: NOW - 2 * 60_000 })!;
  assert.match(buildStatusText(state, null, NOW, undefined, { activity: "idle", lastActivityAt: NOW - 2 * 60_000 })!, /IDLE/);
  assert.ok(idle.some((line) => line.includes("· active ·")));
  assert.doesNotMatch(idle.join("\n"), /IDLE|last activity 2m/);
});

test("stream-proven work uses one compact status-bar HUD; the card stays quiet", () => {
  const state = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:58:51Z" }),
    list: [1, 2, 3].map((id) => ({ id: `next-${id}`, objective: `next ${id}`, addedAt: "z" })),
  };
  const stream = { activity: "working" as const, lastStreamActivityAt: NOW - 11_000 };
  const status = buildStatusText(state, null, NOW, undefined, stream)!;
  assert.match(status, /^glla: \[[▁▂▄▆█]{6} LIVE · WORKING\] total 1m 09s · last stream 11s ago · 3 queued$/);
  const lines = buildWidgetLines(state, null, NOW, undefined, undefined, stream)!;
  assert.match(lines[0]!, /^● /);
  assert.match(lines[0]!, /· active ·/);
  assert.doesNotMatch(lines.join("\n"), /LIVE WORK|last stream 11s ago/);

  const busy = buildStatusText(state, null, NOW, undefined, { activity: "busy", lastStreamActivityAt: NOW - 20_000 })!;
  assert.match(busy, /glla: \[BUSY\] total 1m 09s · last stream 20s ago · 3 queued/);
  assert.doesNotMatch(busy, /WORKING/);

  const queued = buildStatusText(state, null, NOW, undefined, { activity: "queued" })!;
  assert.match(queued, /glla: \[QUEUED\] total 1m 09s · 3 queued/);
  assert.doesNotMatch(queued, /WORKING/);

  // v0.34.124: the QUEUED "why" — an accepted-but-unstarted dispatch and
  // the last real activity age. A ticking timer with no freshness told the
  // user nothing (note.md 221249 "time ticking but nothing else").
  const queuedPending = buildStatusText(state, null, NOW, undefined, { activity: "queued", turnPending: true, lastActivityAt: NOW - 180_000 })!;
  assert.match(queuedPending, /\[QUEUED\] total 1m 09s · turn pending · last host activity 3m 00s ago · 3 queued/);
  // turnPending WITHOUT a known last-activity epoch still names the pending turn.
  const queuedPendingNoAge = buildStatusText(state, null, NOW, undefined, { activity: "queued", turnPending: true })!;
  assert.match(queuedPendingNoAge, /\[QUEUED\] total 1m 09s · turn pending · 3 queued/);
  // No turnPending (scheduled-but-not-yet-sent) stays the plain QUEUED line.
  const queuedScheduled = buildStatusText(state, null, NOW, undefined, { activity: "queued" })!;
  assert.doesNotMatch(queuedScheduled, /turn pending/);

  const goldenQueued = {
    goal: goalOf({ createdAt: "2026-07-21T11:59:16Z" }),
    list: Array.from({ length: 18 }, (_, i) => ({ id: `queued-${i}`, objective: "queued", addedAt: "z" })),
  };
  assert.equal(
    buildStatusText(goldenQueued, null, NOW, undefined, { activity: "queued" }),
    "glla: [QUEUED] total 44s · 18 queued",
  );
});

// v0.34.95: when the goal is queued AND state.mainModelRecovery is set
// (the bounded envelope is parked), the status line names the blocker —
// `parked on provider wall` follows the queue depth. No chat spam, no
// extra prompt — just truth on the existing status line. v0.34.125: the
// old `waiting for quota reset at HH:MM` claim is gone — the window is
// not a guaranteed reset and the :00:30 hourly probe picks work up
// earlier (note.md 2026-08-10).
// Field evidence: Screenshot_20260808_014303 darklord LIST-AUDIT-COLLECT
// showed `[QUEUED] 12m 26s` with no WHY.
test("v0.34.95: queued + parked recovery surfaces 'parked on provider recovery' on the status line", () => {
  const queuedWithRecovery = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:59:16Z" }),
    list: Array.from({ length: 18 }, (_, i) => ({ id: `queued-${i}`, objective: "queued", addedAt: "z" })),
    mainModelRecovery: {
      primary: "minimax/MiniMax-M3",
      active: "minimax/MiniMax-M3",
      attempted: ["minimax/MiniMax-M3"],
      attempts: 1,
      reason: "main model quota: 429 rate limit",
      kind: "goal" as const,
      firstFailureAt: "2026-07-21T11:55:00.000Z",
      autoRetryUntil: "2026-07-22T11:55:00.000Z",
      retryAt: "2026-07-21T12:30:00.000Z",
    },
  };
  // The recovery envelope retains retryAt, but this surface intentionally
  // renders the relative next-probe wording rather than an absolute clock.
  const status = buildStatusText(queuedWithRecovery, null, NOW, undefined, { activity: "queued" })!;
  assert.match(status, /\[QUEUED\]/);
  assert.match(status, /18 queued/);
  assert.match(status, /parked on provider recovery/);
  assert.doesNotMatch(status, /quota reset/);
});

test("v0.34.95: queued WITHOUT a parked recovery does NOT show quota text (no false signal)", () => {
  const queuedNoRecovery = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:59:16Z" }),
    list: [{ id: "queued-0", objective: "queued", addedAt: "z" }],
  };
  const status = buildStatusText(queuedNoRecovery, null, NOW, undefined, { activity: "queued" })!;
  assert.equal(status, "glla: [QUEUED] total 44s · 1 queued");
  assert.doesNotMatch(status, /quota/);
});

test("v0.34.95: parked recovery on a LIVE working goal does NOT show quota text (only queued needs the WHY)", () => {
  // The QUEUED state is the one the user sees without context — the
  // LIVE/WORKING state already names the work via the live stream badge.
  // Showing quota text on top of LIVE would be noise.
  const liveWithRecovery = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:58:51Z" }),
    list: [{ id: "next-1", objective: "next", addedAt: "z" }],
    mainModelRecovery: {
      primary: "minimax/MiniMax-M3",
      attempted: ["minimax/MiniMax-M3"],
      attempts: 1,
      reason: "main model quota: 429 rate limit",
      kind: "goal" as const,
      retryAt: "2026-07-21T12:30:00.000Z",
    },
  };
  const status = buildStatusText(liveWithRecovery, null, NOW, undefined, { activity: "working", lastStreamActivityAt: NOW - 11_000 })!;
  assert.match(status, /LIVE · WORKING/);
  assert.doesNotMatch(status, /waiting for quota reset/);
});

// v0.34.97: while the post-compaction grace window is open, the status
// line paints "⏳ compacting…" so the user knows the session just shrank.
// Field evidence: Screenshot_20260808_003007/003024 ai-auto-writer 222,368
// tokens compacted; the user only saw "[compaction]" on RELOAD because no
// in-process UI surface told them what just happened. The chip survives
// reload because lastCompactionAt is persisted on State.
test("v0.34.97: status line shows '⏳ compacting…' during the post-compaction grace window", () => {
  const state = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:58:51Z" }),
    list: [],
    lastCompactionAt: NOW - 30_000, // 30s ago — well within the 3-minute grace
  };
  const status = buildStatusText(state, null, NOW, undefined, { activity: "active" })!;
  assert.match(status, /⏳ compacting… \(30s ago\)/, "compacting chip with elapsed time");
});

test("v0.34.97: compacting chip is GONE after the 3-minute grace window", () => {
  const state = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:58:51Z" }),
    list: [],
    lastCompactionAt: NOW - 200_000, // 200s ago — past the 3-minute grace
  };
  const status = buildStatusText(state, null, NOW, undefined, { activity: "active" })!;
  assert.doesNotMatch(status, /compacting/, "no compacting chip past grace");
});

test("v0.34.97: no compacting chip when lastCompactionAt is absent", () => {
  const state = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:58:51Z" }),
    list: [],
  };
  const status = buildStatusText(state, null, NOW, undefined, { activity: "active" })!;
  assert.doesNotMatch(status, /compacting/, "no chip when state has no lastCompactionAt");
});

test("live capsule shows a compact animated signal and truthful freshness text", () => {
  const state = { goal: goalOf(), list: [] };
  const first = buildStatusText(state, null, NOW, undefined, {
    activity: "working",
    lastStreamActivityAt: NOW - 1_000,
  })!;
  const next = buildStatusText(state, null, NOW + 751, undefined, {
    activity: "working",
    lastStreamActivityAt: NOW - 249,
  })!;
  assert.match(first, /glla: \[[▁▂▄▆█]{6} LIVE · WORKING\]/);
  assert.match(next, /glla: \[[▁▂▄▆█]{6} LIVE · WORKING\]/);
  assert.notEqual(first.slice(0, first.indexOf(" LIVE")), next.slice(0, next.indexOf(" LIVE")), "the signal visibly advances while live");
  assert.match(first, /last stream 1s ago/);
  assert.doesNotMatch(first, /%|complete|progress/i, "the signal is not a fake completion meter");
});

test("live capsule keeps semantic colors without decorative noise", () => {
  const calls: string[] = [];
  const theme = {
    fg(color: string, text: string) {
      calls.push(`${color}:${text}`);
      return `<${color}>${text}</${color}>`;
    },
  };
  const status = buildStatusText(
    { goal: goalOf(), list: [] },
    null,
    NOW,
    theme,
    { activity: "working", lastStreamActivityAt: NOW - 1_000 },
  )!;
  assert.match(status, /<dim>\[<\/dim>(?:<muted>[▁]<\/muted>|<accent>[▂▄▆]<\/accent>|<success>[█]<\/success>){6}<dim> <\/dim><success>LIVE<\/success><dim> · <\/dim><accent>WORKING<\/accent><dim>\]<\/dim>/);
  assert.ok(calls.some((call) => call.startsWith("success:LIVE")), "LIVE remains semantically highlighted");
  assert.ok(calls.some((call) => call.startsWith("accent:WORKING")), "WORKING remains semantically highlighted");
  assert.ok(calls.some((call) => call.startsWith("success:█")), "the signal peak is semantically highlighted");
  assert.ok(calls.some((call) => call.startsWith("accent:▆")), "the signal body remains visible");
});

test("active goal with tasks shows progress", () => {
  const g = goalOf({
    taskList: {
      version: 1,
      tasks: [
        { id: "1", title: "a", status: "complete" },
        { id: "2", title: "b", status: "pending" },
      ],
    },
  });
  assert.match(buildStatusText({ goal: g, list: [] }, null, NOW)!, /1\/2 tasks/);
});

test("stale interrupted goal is visibly orphaned, not normally active", () => {
  const g = goalOf({
    policy: "list",
    interruptedAt: "2026-07-21T11:59:00Z",
    interruptedReason: "extension api stale (heartbeat probe)",
  });
  const status = buildStatusText({ goal: g, list: [{ id: "next", objective: "next", addedAt: "z" }] }, null, NOW)!;
  assert.match(status, /interrupted — stale handle/);
  const lines = buildWidgetLines({ goal: g, list: [{ id: "next", objective: "next", addedAt: "z" }] }, null, NOW)!;
  assert.match(lines[0]!, /⚠ .* · interrupted · /);
  assert.ok(lines.some((line) => line.includes("host session lost — waiting for fresh session_start")));
  assert.ok(lines.some((line) => line.includes("/new to rebind") && line.includes("/list resume")));
  assert.ok(!lines.some((line) => /· active ·/.test(line)), "stale work must not look normally active");
});

test("accepted continuation without a turn-start proof is not mislabeled as a lost host session", () => {
  const g = goalOf({
    policy: "list",
    interruptedAt: "2026-07-21T11:59:00Z",
    interruptedReason: "continuation start acknowledgement timed out (dispatch-1)",
  });
  const status = buildStatusText({ goal: g, list: [] }, null, NOW)!;
  assert.match(status, /turn start not observed — automatic retry held/);
  assert.doesNotMatch(status, /stale handle/);
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.ok(lines.some((line) => line.includes("continuation was accepted, but pi did not start a turn")));
  assert.ok(lines.some((line) => line.includes("automatic re-sends are stopped") && line.includes("/list resume")));
  assert.ok(!lines.some((line) => line.includes("host session lost")), "trigger failure must not claim the host disappeared");
});

test("lifecycle interruption keeps durable auditor disapproval feedback visible", () => {
  const report = "## Required fixes\n- preserve this required-fixes excerpt after lifecycle failure\n<disapproved/>";
  for (const [interruptedReason, lifecycleText] of [
    ["continuation start acknowledgement timed out (dispatch-1)", "continuation was accepted, but pi did not start a turn"],
    ["extension api stale (heartbeat probe)", "host session lost — waiting for fresh session_start"],
  ] as const) {
    const g = goalOf({
      interruptedAt: "2026-07-21T11:59:00Z",
      interruptedReason,
      pauseReason: "auditor disapproved",
      auditHistory: [{
        at: "2026-07-21T11:58:30Z",
        approved: false,
        disapproved: true,
        model: "auditor",
        report,
      }],
    });
    const widget = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
    const rendered = widget.join("\\n");
    assert.ok(rendered.includes(lifecycleText), `lifecycle marker missing: ${rendered}`);
    assert.ok(rendered.includes("auditor disapproved — durable required fixes"), rendered);
    assert.ok(rendered.includes("required-fixes excerpt after lifecycle failure"), rendered);
    assert.ok(rendered.includes("/goal resume"), rendered);
  }
});

test("widget truncation is width-aware (v0.22.2)", () => {
  const longObjective = "x".repeat(200);
  const g = goalOf({ objective: longObjective });
  // No width (tests/RPC): floor cap applies. v0.33.0: the head also carries
  // the status segments after the objective — assert the objective part is
  // floor-capped and the segments follow.
  const narrow = buildWidgetLines({ goal: g, list: [] }, null, NOW)![0]!;
  assert.match(narrow, /^● x{47}… · /); // icon + space + 47 chars + ellipsis, then segments
  // Wide terminal: the head uses the room instead of cutting at the floor.
  const wide = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 160)![0]!;
  assert.ok(wide.length > 100, `wide head should exceed 100 chars, got ${wide.length}`);
  // Narrow terminal: v0.33.1 — the objective budget shrinks to fit the
  // fixed segments (floor 16), so a tiny width yields a shorter head.
  const tiny = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 50)![0]!;
  assert.ok(tiny.length < narrow.length, `tiny (${tiny.length}) should be narrower than narrow (${narrow.length})`);
  assert.ok(tiny.length <= 70, `tiny head must stay near the terminal width, got ${tiny.length}`);
});

test("widget lines reserve pi-tui's horizontal padding", () => {
  const g = goalOf({
    status: "auditing",
    policy: "list",
    objective: "x".repeat(240),
    createdAt: "2026-07-21T11:59:10Z",
  });
  const lines = buildWidgetLines(
    { goal: g, list: [] },
    { phase: "running", label: "running", currentTool: "bash" },
    NOW,
    undefined,
    80,
  )!;
  // pi wraps string-array widget lines inside Text(paddingX=1), so the
  // extension must keep every source line within width - 2.
  assert.ok(lines.every((line) => line.length <= 78), lines.join("\\n"));
  assert.match(lines[0]!, / · list item · auditing · total 50s/);
  assert.ok(!lines.includes("50s"), "elapsed segment must not wrap onto its own line");
});

test("list policy footer: queued count, no duplicated 'list'", () => {
  const s = buildStatusText(
    { goal: goalOf({ policy: "list" }), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  // v0.24.7: was "glla: list ● 3m 00s · list 1" — policy label and queue
  // counter both said "list".
  assert.match(s, /^glla: /);
  assert.doesNotMatch(s, /^glla: list /, 'v0.34.1: policy word dropped — no list/list-item doubling with the widget chip');
  assert.match(s, /· 1 queued$/);
  assert.ok(!/list .+ list /.test(s), `no duplicated 'list … list': ${s}`);
});

test("goal policy footer says 'N queued' (v0.28.11 U10 — was the cryptic 'list N')", () => {
  const s = buildStatusText(
    { goal: goalOf(), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  assert.match(s, /^glla: /);
  assert.doesNotMatch(s, /^glla: goal /, 'v0.34.1: policy word dropped');
  assert.match(s, /· 1 queued$/);
});

test("widget names a list item as such and points at /list, not /goal", () => {
  const lines = buildWidgetLines(
    {
      goal: goalOf({ policy: "list", usage: undefined }),
      list: [
        { id: "a", objective: "one", addedAt: "z" },
        { id: "b", objective: "two", addedAt: "z" },
      ],
    },
    null,
    NOW,
  )!;
  assert.match(lines[0]!, /· list item · active · /); // v0.33.0: type named in the head segments
  assert.equal(lines[lines.length - 1], "└─ 2 queued · /list · /glla");
  assert.ok(!lines.some(l => l.includes("/goal status")), "list item must not hint /goal status");
});

test("long-running list card shows a truthful queue trail and immediate next item", () => {
  const lines = buildWidgetLines(
    {
      goal: goalOf({ policy: "list", usage: undefined }),
      list: [
        { id: "a", objective: "write the next focused improvement", addedAt: "2026-07-21T11:55:00Z" },
        { id: "b", objective: "later item", addedAt: "2026-07-21T11:58:00Z" },
      ],
    },
    null,
    NOW,
  )!;
  assert.ok(lines.some((line) => line.includes("↳ 2 waiting · up next: write the next focused improvement")));
  assert.ok(lines.some((line) => line.includes("waiting 5m")), "valid queue timestamps get a wait age");
  assert.equal(lines[lines.length - 1], "└─ 2 queued · /list · /glla");
});

test("widget list item, last in queue: no '0 queued'", () => {
  const lines = buildWidgetLines(
    { goal: goalOf({ policy: "list", usage: undefined }), list: [] },
    null,
    NOW,
  )!;
  assert.equal(lines[lines.length - 1], "└─ /list · /glla");
});

test("widget goal policy keeps /goal status hint + list N prefix", () => {
  const lines = buildWidgetLines(
    {
      goal: goalOf({ usage: undefined }),
      list: [{ id: "a", objective: "one", addedAt: "z" }],
    },
    null,
    NOW,
  )!;
  assert.match(lines[0]!, /^● Create x.txt containing ok · active · /); // v0.33.0: plain goal — icon + status in the head
  assert.equal(lines[lines.length - 1], "└─ 1 queued · /goal status · /glla");
});

test("paused shows the reason", () => {
  const g = goalOf({ status: "paused", pauseReason: "auditor disapproved: missing tests" });
  assert.match(buildStatusText({ goal: g, list: [] }, null, NOW)!, /paused ⏸ auditor disapproved/);
});

test("paused runtime projection carries goal-scoped activity into the display extras", () => {
  assert.match(GOAL_UI, /if \(goal\.status !== "active"\) return \{ lastActivityAt, lastStreamActivityAt: streamAt \};/);
  assert.match(GOAL_UI, /Guard by goal creation so a previous item's activity cannot leak/);
});

test("paused lifecycle projection names owner, queue, last activity, and next transition", () => {
  const retryAt = new Date(NOW + 20 * 60_000).toISOString();
  const state = {
    goal: goalOf({
      policy: "list",
      status: "paused",
      pauseKind: "wait",
      pauseReason: "main model recovery — retrying",
      pauseResumeAt: retryAt,
    }),
    list: [{ objective: "next one" }, { objective: "next two" }],
    mainModelRecovery: {
      primary: "minimax/MiniMax-M3",
      attempted: ["minimax/MiniMax-M3"],
      attempts: 1,
      retryAt,
      reason: "provider unavailable",
      kind: "goal",
    },
  } as State;
  const extras = { lastActivityAt: NOW - 2 * 60_000 };
  const status = buildStatusText(state, null, NOW, undefined, extras)!;
  assert.match(status, /owner: main-model recovery/);
  assert.match(status, /2 queued/);
  assert.match(status, /last host activity 2m 00s ago/);
  assert.match(status, /next: retrying automatically/);
  const widget = buildWidgetLines(state, null, NOW, undefined, undefined, extras)!;
  assert.ok(widget.some((line) => line.includes("lifecycle: safely parked") && line.includes("owner: main-model recovery") && line.includes("2 queued")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("last host activity 2m 00s ago") && line.includes("next: retrying automatically")), widget.join("\\n"));
});

test("active/in-flight main-model recovery keeps full chain state on status and widget", () => {
  const state = {
    goal: goalOf({ status: "active", objective: "continue on the selected model — done when pinned" }),
    list: [],
    mainModelRecovery: {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 1,
      pendingModelSwitch: "provider/backup-two",
      skipped: [{ ref: "provider/backup-one", reason: "unregistered" as const }],
      reason: "model switch in flight",
      kind: "goal" as const,
    },
  } as State;
  const extras = { mainModelFallbacks: ["provider/backup-one", "provider/backup-two"] };
  const status = buildStatusText(state, null, NOW, undefined, extras)!;
  const widget = buildWidgetLines(state, null, NOW, undefined, undefined, extras)!;
  for (const surface of [status, widget.join("\\n")]) {
    assert.ok(surface.includes("Order: provider/primary → provider/backup-one → provider/backup-two"), surface);
    assert.ok(surface.includes("Pending switch: provider/backup-two"), surface);
    assert.ok(surface.includes("Attempted: provider/primary"), surface);
    assert.ok(surface.includes("Skipped: provider/backup-one (unregistered)"), surface);
  }
});

test("standalone main-model recovery remains visible when no goal is active", () => {
  const state = {
    goal: null,
    list: [],
    mainModelRecovery: {
      primary: "provider/primary",
      active: "provider/backup-one",
      attempted: ["provider/primary", "provider/backup-one"],
      attempts: 2,
      retryAt: new Date(NOW + 60_000).toISOString(),
      pendingModelSwitch: "provider/backup-two",
      reason: "account usage limit",
      kind: "goal",
    },
  } as State;
  const status = buildStatusText(state, null, NOW);
  assert.match(status ?? "", /main-model recovery/);
  const widget = buildWidgetLines(state, null, NOW)!;
  assert.ok(widget.some((line) => line.includes("main-model recovery")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("provider/backup-two")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("provider/primary, provider/backup-one")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("Order: provider/primary")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("provider/backup-two")), widget.join("\\n"));
});

test("loop recovery remains visible while the loop is parked", () => {
  const loop = {
    active: false,
    target: "repair the audit findings",
    iteration: 4,
    startedAt: new Date(NOW - 60_000).toISOString(),
    maxIterations: 20,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: 2,
    lastValue: 2,
    history: [],
  } as unknown as LoopState;
  const state = {
    goal: null,
    list: [],
    loop,
    mainModelRecovery: {
      primary: "provider/primary",
      active: "provider/backup-one",
      attempted: ["provider/primary", "provider/backup-one"],
      attempts: 2,
      retryAt: new Date(NOW + 60_000).toISOString(),
      pendingModelSwitch: "provider/backup-two",
      reason: "account usage limit",
      kind: "loop",
    },
  } as State;
  const extras = { mainModelFallbacks: ["provider/backup-one", "provider/backup-two"] };
  const status = buildStatusText(state, null, NOW, undefined, extras)!;
  assert.match(status, /loop recovery/);
  assert.match(status, /provider\/backup-two/);
  const widget = buildWidgetLines(state, null, NOW, undefined, undefined, extras)!;
  assert.match(widget.join("\\n"), /loop parked/);
  assert.match(widget.join("\\n"), /Order: provider\/primary → provider\/backup-one → provider\/backup-two/);
  assert.match(widget.join("\\n"), /Attempted: provider\/primary, provider\/backup-one/);
});

test("passed provider retryAt stays parked until recovery state clears", () => {
  const retryAt = new Date(NOW - 60_000).toISOString();
  const state = {
    goal: goalOf({
      policy: "goal",
      status: "paused",
      pauseKind: "wait",
      pauseReason: "main model recovery — retrying",
      pauseResumeAt: retryAt,
    }),
    list: [],
    mainModelRecovery: {
      primary: "provider/session-model",
      attempted: ["provider/session-model"],
      attempts: 1,
      retryAt,
      reason: "provider unavailable",
      kind: "goal",
    },
  } as State;

  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /main-model recovery — retrying automatically/);
  assert.match(status, /next: retrying automatically/);
  assert.doesNotMatch(status, /next: resuming now/);

  const widget = buildWidgetLines(state, null, NOW)!;
  assert.ok(widget.some((line) => line.includes("main-model recovery — retrying automatically")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("next: retrying automatically")), widget.join("\\n"));
});

test("paused decision without activity says no turn was observed and names the manual path", () => {
  const state = {
    goal: goalOf({
      policy: "goal",
      status: "paused",
      usage: undefined,
      pauseKind: "decision",
      pauseReason: "choose the deployment target",
      pauseSuggestedAction: "Choose one, then /goal resume.",
      pauseOptions: ["staging", "production"],
      pauseRecommended: 1,
    }),
    list: [],
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /owner: user decision/);
  assert.match(status, /last host activity not observed/);
  assert.match(status, /next: user decision → \/goal resume/);
  const widget = buildWidgetLines(state, null, NOW)!;
  const joined = widget.join("\\n");
  assert.match(joined, /lifecycle: safely parked · owner: user decision · queue empty/);
  assert.match(joined, /last host activity not observed · next: user decision → \/goal resume/);
  assert.match(joined, /1\. staging/);
});

test("auditing shows the auditor's current tool", () => {
  const g = goalOf({ status: "auditing" });
  const s = buildStatusText({ goal: g, list: [] }, { currentTool: "read" }, NOW)!;
  assert.match(s, /auditor ▶ running/);
  assert.match(s, /read/);
});

test("v0.34.89: completed goal shows a dim one-line summary instead of a loud status claim", () => {
  const s = buildStatusText({ goal: goalOf({ status: "complete" }), list: [] }, null, NOW)!;
  assert.match(s, /✓ done/);
  assert.match(s, /0s/, "goalOf createdAt === updatedAt → wall duration 0 (compact '· 0s' on the status line)");
  assert.doesNotMatch(s, /✓ complete/, "the loud '✓ complete' claim is gone");
});

// ---- v0.34.89: terminal-goal summary line (replaces the v0.34.65 card) ----

test("v0.34.89: completed goal widget is ONE dim summary line (objective + duration, no verdict card)", () => {
  const g = goalOf({
    status: "complete",
    createdAt: "2026-07-21T10:00:00Z",
    updatedAt: "2026-07-21T11:45:00Z",
    auditHistory: [{ at: "2026-07-21T11:44:00Z", approved: true, disapproved: false, model: "minimax-m3" }],
  });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.ok(lines, "a completed goal still leaves a trace in the widget");
  assert.equal(lines.length, 1, "the completion card collapsed to a single summary line");
  assert.match(lines[0]!, /✓ done/);
  assert.match(lines[0]!, /took 1h 45m/);
  assert.doesNotMatch(lines.join("\n"), /auditor approved/, "the verdict stays in the archive + /goal status, not the widget");
});

// ---- v0.34.91: the end-of-goal summary says WHAT HAPPENED ----

test("v0.34.91: completed goal summary shows the agent's completion recap, not the objective echo", () => {
  const g = goalOf({
    status: "complete",
    createdAt: "2026-07-21T10:00:00Z",
    updatedAt: "2026-07-21T11:45:00Z",
    completionSummary: "Audited all 9 deathrun routes at the surface level, deep-dived /welcome, /play and the main cube, and shipped the prioritized plan.",
  });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.equal(lines.length, 1, "still ONE dim line");
  assert.match(lines[0]!, /✓ done/);
  assert.match(lines[0]!, /Audited all 9 deathrun routes/, "the recap tells what happened");
  assert.doesNotMatch(lines.join("\n"), /Create x\.txt/, "the objective echo is gone — it read like a ticket title, not a recap");
  assert.match(lines[0]!, /took 1h 45m/);
});

test("v0.34.91: whitespace-only completion summary falls back to the objective", () => {
  const g = goalOf({ status: "complete", createdAt: "2026-07-21T10:00:00Z", updatedAt: "2026-07-21T11:45:00Z", completionSummary: "   " });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.match(lines.join("\n"), /Create x\.txt/, "empty recap → objective fallback");
});

test("v0.34.89: aborted goal summary names the reason + duration on one line", () => {
  const g = goalOf({
    status: "aborted",
    createdAt: "2026-07-21T11:30:00Z",
    updatedAt: "2026-07-21T11:58:00Z",
    stopReason: "cancelled by user",
  });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.equal(lines.length, 1, "aborted goals also collapse to one line");
  assert.match(lines[0]!, /✗ aborted/);
  assert.match(lines[0]!, /took 28m/);
  assert.match(lines.join("\n"), /cancelled by user/);
});

test("v0.34.89: completed goal without a verdict does not fabricate one on the summary", () => {
  const g = goalOf({ status: "complete", createdAt: "2026-07-21T10:00:00Z", updatedAt: "2026-07-21T11:45:00Z" });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.match(lines.join("\n"), /✓ done/);
  assert.doesNotMatch(lines.join("\n"), /approved|no stored verdict/, "the summary neither claims a verdict nor explains one away — the archive is the record");
});

test("active loop shows iteration + best + stall", () => {
  const loop: LoopState = {
    target: "reduce TODOs",
    measureCmd: "grep -c TODO x",
    direction: "min",
    iteration: 12,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 2,
    bestValue: 41,
    lastValue: 43,
    active: true,
    history: [],
    startedAt: "2026-07-21T11:00:00Z",
  };
  const s = buildStatusText({ goal: null, list: [], loop }, null, NOW)!;
  assert.match(s, /loop ↓ iter 12\/50/);
  assert.match(s, /best 41/);
  assert.match(s, /stall 2\/5/);
});

test("v0.29.15 — audit-loop widget names the metric instead of showing the raw grep (\"that weird line\")", () => {
  // The audit measure is orchestrator-owned shell (c=$(grep -cE ...) —
  // unreadable as widget furniture. kind:"audit" gets a friendly label;
  // user-authored measures keep showing raw.
  const auditLoop: LoopState = {
    target: "audit the project",
    measureCmd: "c=$(grep -cE '^- \\[[xX]\\]' .pi-glla/audit-loop/findings.md 2>/dev/null); echo ${c:-0}",
    direction: "max",
    iteration: 1,
    maxIterations: 0,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: null,
    lastValue: 4,
    active: true,
    kind: "audit",
    history: [],
    startedAt: "2026-07-30T11:00:00Z",
  };
  const lines = buildWidgetLines({ goal: null, list: [], loop: auditLoop }, null, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /metric: closed findings · \/loop stop/); // v0.33.0 slim footer
  assert.ok(!joined.includes("grep -cE"), "raw shell hidden for audit loops");
});

// ---- buildWidgetLines ----

test("widget: nothing supervised → undefined", () => {
  assert.equal(buildWidgetLines({ goal: null, list: [] }, null, NOW), undefined);
});

test("widget: goal lines include objective, status, tokens, footer", () => {
  const lines = buildWidgetLines({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(lines[0]!, /● Create x.txt containing ok/);
  assert.match(lines[0]!, /12\.4k\/1000k ▰/); // v0.33.0: budget segment carries a meter
  assert.ok(lines.some((l) => l.includes("/goal status")));
});

test("widget: paused goal shows reason + suggestion", () => {
  const g = goalOf({
    status: "paused",
    pauseReason: "no tests found",
    pauseSuggestedAction: "add tests dir",
  });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("no tests found")));
  assert.ok(lines.some((l) => l.includes("add tests dir")));
});

test("widget: auditing shows auditor progress", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-1" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, { label: "verifying contract", currentTool: "grep", elapsedMs: 42_000 }, NOW)!;
  assert.ok(lines.some((l) => l.includes("verifying contract")));
  assert.ok(lines.some((l) => l.includes("grep")));
  assert.ok(lines.some((l) => l.includes("42s")));
  assert.match(buildStatusText({ goal: g, list: [] }, { currentTool: "grep" }, NOW)!, /auditor ▶ running(?: \S+)? · grep/);
});

test("widget: interrupted completion claims render recovery-pending, not auditor-running", () => {
  const claim = { at: "2026-07-21T11:59:00Z", completionSummary: "done" };
  const g = goalOf({ status: "auditing", pendingCompletion: claim }); // legacy claim has no phase
  const state = { goal: g, list: [] };
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /audit recovery pending/);
  assert.doesNotMatch(status, /auditing…/);
  const lines = buildWidgetLines(state, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("recovery pending — previous audit was interrupted")));
  assert.ok(lines.some((l) => l.includes("stored completion claim is safe")));
  assert.ok(!lines.some((l) => l.includes("auditor: running")));
});

test("widget: a durable running claim without observed progress says awaiting verdict", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-2" } });
  const state = { goal: g, list: [] };
  const lines = buildWidgetLines(state, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("auditor: awaiting verdict")));
  assert.ok(lines.some((l) => l.includes("waiting for detached verdict")));
  assert.match(buildStatusText(state, null, NOW)!, /auditor ✓ awaiting verdict/);
  assert.ok(!lines.some((l) => l.includes("recovery pending")));
});

test("auditor progress phases are explicit and retain worker activity", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-3" } });
  const queued = buildWidgetLines({ goal: g, list: [] }, { label: "queued" }, NOW)!;
  assert.ok(queued.some((l) => l.includes("MAIN HOST · SUPERVISING · auditor: queued")));
  assert.ok(queued.some((l) => l.includes("completion claim is durable")));

  const running = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "grep",
    elapsedMs: 42_000,
    lastActivityAt: NOW - 30_000,
  }, NOW)!;
  assert.ok(running.some((l) => l.includes("auditor: last observed tool")));
  assert.ok(running.some((l) => l.includes("tool: grep")));
  assert.ok(running.some((l) => l.includes("worker activity 30s ago")));

  const quiet = buildWidgetLines({ goal: g, list: [] }, {
    phase: "thinking",
    elapsedMs: 600_000,
    lastActivityAt: NOW - 7 * 60_000,
  }, NOW)!;
  assert.ok(quiet.some((l) => l.includes("auditor: quiet")));
  assert.ok(quiet.some((l) => l.includes("auditor quiet 7m") && l.includes("worker activity 7m")));

  const blocked = buildStatusText({ goal: g, list: [] }, { label: "infra error — retrying once" }, NOW)!;
  assert.match(blocked, /auditor ⛔ blocked/);
});

test("worker-timeout display demotes stale progress to quiet without claiming LIVE", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-timeout-display" } });
  const stale = {
    phase: "tool_executing" as const,
    currentTool: "read",
    elapsedMs: 10 * 60_000,
    lastActivityAt: NOW - 4 * 60_000,
  };
  const status = buildStatusText({ goal: g, list: [] }, stale, NOW)!;
  assert.match(status, /auditor ◌ quiet/);
  assert.match(status, /worker activity 4m 00s ago · stale/);
  assert.match(status, /next: worker event or \/goal cancel/);
  assert.doesNotMatch(status, /AUDITOR · DETACHED · LIVE/);
  const widget = buildWidgetLines({ goal: g, list: [] }, stale, NOW)!.join("\\n");
  assert.match(widget, /auditor: quiet · detached worker/);
  assert.doesNotMatch(widget, /LIVE/);
});

test("detached auditor status names phase, evidence, freshness, verdict wait, and next transition without pausing MAIN", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-contract" } });
  const liveAudit = {
    phase: "tool_executing" as const,
    currentTool: "read",
    recentOutput: ["checked the contract"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 6_000 }],
    reportBytes: 2_048,
    elapsedMs: 42_000,
    lastActivityAt: NOW - 5_000,
  };
  const liveStatus = buildStatusText({ goal: g, list: [] }, liveAudit, NOW)!;
  assert.match(liveStatus, /MAIN HOST · SUPERVISING/);
  assert.match(liveStatus, /auditor ▶ tool executing/);
  assert.match(liveStatus, / · read/);
  assert.match(liveStatus, /evidence: report stream observed · 2\.0 KB report · 1 audit call/);
  assert.match(liveStatus, /elapsed 42s/);
  assert.match(liveStatus, /worker activity 5s ago · fresh/);
  assert.match(liveStatus, /next: worker completion → verdict/);
  assert.match(liveStatus, /detached worker/);
  assert.doesNotMatch(liveStatus, /paused/);
  const liveWidget = buildWidgetLines({ goal: g, list: [] }, liveAudit, NOW)!.join("\\n");
  assert.match(liveWidget, /auditor: tool executing · detached worker/);
  assert.match(liveWidget, /tool: read/);
  assert.match(liveWidget, /evidence: report stream observed · 2\.0 KB report · 1 audit call/);
  assert.doesNotMatch(liveWidget, /paused/);

  const completeAudit = {
    phase: "complete" as const,
    recentOutput: ["## Audit result", "<approved>"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 2_000 }],
    elapsedMs: 45_000,
  };
  const verdictStatus = buildStatusText({ goal: g, list: [] }, completeAudit, NOW)!;
  assert.match(verdictStatus, /auditor ✓ awaiting verdict/);
  assert.match(verdictStatus, /last tool: grep/);
  assert.match(verdictStatus, /evidence: final report · 1 audit call/);
  assert.match(verdictStatus, /elapsed 45s/);
  assert.match(verdictStatus, /worker finished/);
  assert.match(verdictStatus, /next: apply detached verdict/);
  assert.match(verdictStatus, /detached worker/);
  assert.doesNotMatch(verdictStatus, /paused/);
  const verdictWidget = buildWidgetLines({ goal: g, list: [] }, completeAudit, NOW)!.join("\\n");
  assert.match(verdictWidget, /auditor: awaiting verdict · detached worker/);
  assert.match(verdictWidget, /last tool: grep/);
  assert.match(verdictWidget, /waiting for detached verdict/);
});

test("detached auditor elapsed time keeps ticking between worker progress events", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-clock" } });
  const audit = {
    phase: "thinking" as const,
    elapsedMs: 42_000,
    startedAt: NOW - 2 * 60_000,
    lastActivityAt: NOW - 20_000,
  };
  const status = buildStatusText({ goal: g, list: [] }, audit, NOW)!;
  assert.match(status, /elapsed 2m 00s/);
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW)!;
  assert.ok(lines.some((line) => line.includes("2m 00s in detached worker")), lines.join("\\n"));
});

test("detached recent auditor output is sanitized in live and awaiting-verdict widget paths", () => {
  const g = goalOf({
    status: "auditing",
    pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-provider-output" },
  });
  const liveAudit = {
    phase: "tool_executing" as const,
    currentTool: "read",
    recentOutput: [
      "worker note",
      '403 {"error":{"message":"upstream denied"},"request_id":"secret-403"}',
    ],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 5_000,
  };
  const liveState = { goal: g, list: [] };
  const liveWidget = buildWidgetLines(liveState, liveAudit, NOW, undefined, undefined, { auditorSilent: false })!.join("\\n");
  const liveStatus = buildStatusText(liveState, liveAudit, NOW)!;
  assert.doesNotMatch(`${liveWidget}\\n${liveStatus}`, /403|upstream denied|secret-403/);
  assert.match(liveWidget, /diagnostic redacted/);

  const awaitingAudit = {
    phase: "complete" as const,
    recentOutput: [
      "429",
      "{",
      '  "account": "secret-account",',
      '  "message": "Token Plan rate limit reached"',
      "}",
      "<disapproved/>",
    ],
    elapsedMs: 45_000,
  };
  const awaitingWidget = buildWidgetLines(liveState, awaitingAudit, NOW)!.join("\\n");
  const awaitingStatus = buildStatusText(liveState, awaitingAudit, NOW)!;
  assert.doesNotMatch(`${awaitingWidget}\\n${awaitingStatus}`, /429|Token Plan|secret-account|rate limit/);
  assert.match(awaitingWidget, /diagnostic redacted/);
});

test("v0.34.86: silent audits show a fine phase label (reading source… / writing report…)", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-fine" } });
  const audit = { phase: "producing_report" as const, elapsedMs: 300_000, lastActivityAt: NOW - 5_000 };

  const widget = buildWidgetLines({ goal: g, list: [] }, audit, NOW)!;
  assert.ok(widget.some((l) => l.includes("writing report…")), "card names what the worker is doing");
  assert.ok(widget.some((l) => l.includes("auditor: writing report…")), "the fine label replaces the coarse one");

  const status = buildStatusText({ goal: g, list: [] }, { ...audit, phase: "thinking" }, NOW)!;
  assert.match(status, /auditor ▶ reading source…/, "status line carries the fine phase");
});

test("v0.34.86: silent audits show a report byte-counter instead of a dead timer", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-bytes" } });
  const audit = {
    phase: "producing_report" as const,
    elapsedMs: 300_000,
    lastActivityAt: NOW - 5_000,
    recentOutput: ["Audit summary: the goal is complete."],
    reportBytes: 12_678,
  };
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW)!;
  assert.ok(
    lines.some((l) => l.includes("report stream muted — 12.4 KB written · final text at verdict")),
    "silent mode shows the growing byte counter: " + lines.join(" | "),
  );
  assert.ok(!lines.some((l) => l.includes("latest: Audit summary")), "the prose tail stays hidden in silent mode");
});

test("v0.34.86: auditorProgressSignals off restores the plain timer-only card", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-optout" } });
  const audit = {
    phase: "producing_report" as const,
    elapsedMs: 300_000,
    lastActivityAt: NOW - 5_000,
    recentOutput: ["Audit summary: the goal is complete."],
    reportBytes: 12_678,
  };
  const extras = { auditorProgressSignals: false };
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW, undefined, undefined, extras)!;
  assert.ok(!lines.some((l) => l.includes("writing report…")), "no fine phase label when opted out");
  assert.ok(lines.some((l) => l.includes("auditor: producing report")), "the coarse label returns when opted out");
  assert.ok(lines.some((l) => l.includes("report stream muted — final text at verdict")), "the pre-v0.34.86 silent line returns");
  const status = buildStatusText({ goal: g, list: [] }, audit, NOW, undefined, extras)!;
  assert.doesNotMatch(status, /reading source…|writing report…/, "status line opts out too");
});

test("v0.34.86: live tail (auditorSilent off) is unaffected by the byte counter", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-live" } });
  const audit = {
    phase: "producing_report" as const,
    elapsedMs: 42_000,
    lastActivityAt: NOW - 5_000,
    recentOutput: ["Audit summary: the goal is complete."],
    reportBytes: 5_000,
  };
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW, undefined, undefined, { auditorSilent: false })!;
  assert.ok(lines.some((l) => l.includes("latest: Audit summary")), "live tail still renders");
  assert.ok(!lines.some((l) => l.includes("report stream muted")), "no muted line in live mode");
});

test("H-code: HUD liveness gate rejects clock-skewed lastActivityAt (future timestamps must not claim LIVE)", () => {
  // DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md action code H:
  // "the UI must ignore currentTool* after phase: complete" + "status rendering
  // should gate LIVE/BUSY on a non-terminal phase plus fresh process/heartbeat
  // evidence". A lastActivityAt in the future (worker clock ahead / clock skew)
  // is NOT a fresh heartbeat; the HUD must not render LIVE or "0s ago" forever.
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-skew" } });

  // lastActivityAt 10s in the future: currently the HUD renders LIVE + "0s ago"
  // because Math.max(0, now - lastActivityAt) clamps to 0 and any non-positive
  // age passes the <= LIVE_ACTIVITY_MS check.
  const skewedStatus = buildStatusText({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "bash",
    lastActivityAt: NOW + 10_000,
  }, NOW)!;
  assert.doesNotMatch(skewedStatus, /AUDITOR · DETACHED · LIVE/, "future timestamp must not render LIVE badge");
  assert.doesNotMatch(skewedStatus, /worker activity 0s ago/, "future timestamp must not render misleading 0s ago");

  const skewedWidget = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "bash",
    lastActivityAt: NOW + 10_000,
  }, NOW)!;
  assert.ok(!skewedWidget.some((l) => /worker activity 0s ago/.test(l)), "widget must not render worker activity 0s ago for future timestamp");
  // When not LIVE, the auditor tool should fall back to "last observed tool".
  assert.ok(skewedWidget.some((l) => l.includes("last observed tool")) || !skewedWidget.some((l) => /LIVE|worker activity 0s/.test(l)),
    "non-LIVE worker should not surface a freshness claim");

  // Sanity: a current timestamp (NOW) IS live and renders "0s ago".
  const currentStatus = buildStatusText({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "bash",
    lastActivityAt: NOW,
  }, NOW)!;
  assert.match(currentStatus, /AUDITOR · DETACHED · LIVE/);
  assert.match(currentStatus, /worker activity 0s ago/);

  // Sanity: a genuinely stale timestamp (> LIVE_ACTIVITY_MS old) is NOT live.
  const staleStatus = buildStatusText({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "bash",
    lastActivityAt: NOW - 60_000,
  }, NOW)!;
  assert.doesNotMatch(staleStatus, /AUDITOR · DETACHED · LIVE/);
});

test("auditor widget shows concrete worker observations without exposing think blocks", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-live" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md", command: "do not display this" }),
    currentToolStartedAt: NOW - 2_000,
    recentOutput: ["<think>private reasoning</think>", "inspected README.md"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 3_000 }],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /auditor: tool executing/);
  assert.match(joined, /tool: read → README\.md/);
  // v0.34.66: the stream is SILENT by default — no live tail while the
  // worker runs; the report text surfaces at the verdict.
  assert.doesNotMatch(joined, /latest: inspected README\.md/);
  assert.match(joined, /report stream muted — final text at verdict/);
  assert.doesNotMatch(joined, /private reasoning|do not display this/);
  assert.match(joined, /worker activity 1s ago/);

  // auditorSilent: false restores the live per-token tail.
  const liveTail = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolStartedAt: NOW - 2_000,
    recentOutput: ["inspected README.md"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 3_000 }],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW, undefined, undefined, { auditorSilent: false })!;
  assert.match(liveTail.join("\n"), /latest: inspected README\.md/, "auditorSilent off shows the live tail");

  const cumulativeReport = buildWidgetLines({ goal: g, list: [] }, {
    phase: "producing_report",
    recentOutput: ["Audit summary: checked", "Next line now"],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW, undefined, undefined, { auditorSilent: false })!;
  assert.match(cumulativeReport.join("\n"), /latest: Next line now/);
  assert.doesNotMatch(cumulativeReport.join("\n"), /latest: (?:checked|:)/);

  const liveAuditStatus = buildStatusText({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  assert.match(liveAuditStatus, /MAIN HOST · SUPERVISING/);
  assert.match(liveAuditStatus, /auditor ▶ tool executing \S+ \[[▁▂▄▆█]{6} AUDITOR · DETACHED · LIVE\] · read/);

  const streamedThink = buildWidgetLines({ goal: g, list: [] }, {
    phase: "thinking",
    recentOutput: ["<think>", "private streamed reasoning"],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  assert.doesNotMatch(streamedThink.join("\n"), /private streamed reasoning/);
});

test("v0.34.119: repeated auditor tool telemetry does not render a tool-name history", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-dedup" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolStartedAt: NOW - 2_000,
    toolCalls: [
      { name: "read", argsPrefix: "{}", finishedAt: NOW - 4_000 },
      { name: "read", argsPrefix: "{}", finishedAt: NOW - 3_000 },
      { name: "read", argsPrefix: "{}", finishedAt: NOW - 2_000 },
    ],
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  const toolLines = lines.filter((line) => /tool:|last tool:/.test(line));
  assert.equal(toolLines.length, 1, "the card shows one current observation, not all repeated tool calls");
  assert.match(toolLines[0]!, /tool: read/);
});

test("v0.34.66: auditor stream is SILENT by default — no live tail, muted note instead", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-silent-default" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "producing_report",
    recentOutput: ["Audit summary: checked", "Next line now"],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /latest:/, "the live per-token tail is hidden by default");
  assert.match(joined, /report stream muted — final text at verdict/);
});

test("v0.34.66: at the verdict the FINAL report shows even when silent", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-final-only" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "complete",
    recentOutput: ["Verification contract checked:", "1. display path honors the toggle ✓"],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /latest: 1\. display path honors the toggle/);
  assert.doesNotMatch(joined, /report stream muted/);
});

test("v0.34.67: worker/subagent text paragraph gets breathing room — invisible NBSP spacer between observations and the card footer", () => {
  assert.equal(WORKER_TEXT_SPACER, "\u00A0", "spacer is a non-breaking space: invisible, never collapsed, never skipped");
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-spacing" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
    currentToolStartedAt: NOW - 2_000,
    recentOutput: ["inspected README.md"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 3_000 }],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  const obsIdx = lines.findIndex((l) => /tool: read → README\.md/.test(l));
  const footerIdx = lines.findIndex((l) => /42s in detached worker/.test(l));
  assert.ok(obsIdx >= 0, "observation paragraph present");
  assert.ok(footerIdx > obsIdx, "footer follows the observations");
  const gap = lines.slice(obsIdx + 1, footerIdx);
  assert.ok(gap.length >= 2, `text + spacer between observations and footer: ${gap.join("|")}`);
  assert.equal(gap.at(-1)!, "\u00A0", "the gap ends with the invisible NBSP spacer");
  assert.match(gap[0]!, /report stream muted/, "the observation text precedes the spacer");
});

test("v0.34.67: no spacer is invented when there is no worker text", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-no-obs" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "running",
    label: "queued",
  }, NOW)!;
  assert.ok(lines.some((l) => /detached worker queued/.test(l)));
  assert.ok(!lines.includes("\u00A0"), "no spacer without an observations paragraph");
});

test("v0.34.56: unmatched tool-event counts render ONLY with evidence (never a zero-fact observation)", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-gate" } });
  const base = {
    phase: "tool_executing" as const,
    currentTool: "read",
    currentToolStartedAt: NOW - 2_000,
    recentOutput: ["inspected README.md"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 3_000 }],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  };
  // Evidence present: both counts surface exactly.
  const withFacts = buildWidgetLines({ goal: g, list: [] }, {
    ...base,
    unmatchedToolStarts: 2,
    unmatchedToolEnds: 1,
  }, NOW)!.join("\n");
  assert.match(withFacts, /unmatched tool events: 2 start \/ 1 end — explicitly unpaired, never falsely matched/);
  // No evidence: the observation must not exist at all — zero is not a fact.
  for (const audit of [
    { ...base },                        // fields absent (old worker protocol)
    { ...base, unmatchedToolStarts: 0, unmatchedToolEnds: 0 },
  ]) {
    const joined = buildWidgetLines({ goal: g, list: [] }, audit, NOW)!.join("\n");
    assert.doesNotMatch(joined, /unmatched tool events/, `no invented fact for ${JSON.stringify(audit)}`);
  }
  // Start-only facts still count as evidence (an orphaned start is a fact).
  const startOnly = buildWidgetLines({ goal: g, list: [] }, { ...base, unmatchedToolStarts: 3, unmatchedToolEnds: 0 }, NOW)!.join("\n");
  assert.match(startOnly, /unmatched tool events: 3 start \/ 0 end/);
});

test("stale auditor snapshots show the last tool, not a fake current tool", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-stale" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
    currentToolStartedAt: NOW - 20_000,
    lastActivityAt: NOW - 20_000,
  }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /auditor: last observed tool/);
  assert.match(joined, /last tool: read/);
  assert.doesNotMatch(joined, /tool: read → README\.md/);
  assert.doesNotMatch(joined, /READ-ONLY · LIVE/);
});

test("auditor startup does not claim worker activity before the first RPC event", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-starting" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, { phase: "starting", elapsedMs: 2_000 }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /auditor: starting/);
  assert.match(joined, /waiting for first worker event/);
  assert.doesNotMatch(joined, /last activity|worker activity/);
});

test("widget: loop lines include measure + metric state", () => {
  const loop: LoopState = {
    target: "reduce TODOs",
    measureCmd: "grep -c TODO src.txt | head -1",
    direction: "min",
    iteration: 3,
    maxIterations: 12,
    plateauWindow: 3,
    stallCount: 1,
    bestValue: 2,
    lastValue: 3,
    active: true,
    history: [],
    startedAt: "2026-07-21T11:00:00Z",
    branchName: "pi-glla-loop/20260721-reduce-todos",
  };
  const lines = buildWidgetLines({ goal: null, list: [], loop }, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("reduce TODOs")));
  assert.ok(lines.some((l) => l.includes("iter 3/12")));
  assert.ok(lines.some((l) => l.includes("best 2")));
  assert.ok(lines.some((l) => l.includes("pi-glla-loop/20260721-reduce-todos")));
});

// ---- v0.28.17: held loops are always visible ----

function heldLoopOf(overrides: Partial<LoopState> = {}): LoopState {
  return {
    target: "improve search ranking",
    measureCmd: "bun test --score",
    direction: "max",
    iteration: 7,
    maxIterations: 0,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: 88,
    lastValue: 85,
    active: false,
    stopReason: "held: restored in a fresh session",
    history: [],
    startedAt: "2026-07-21T10:00:00Z",
    ...overrides,
  };
}

test("held loop alone → status segment + widget card (before: BOTH vanished)", () => {
  const state = { goal: null, list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /loop ⏸ held/);
  assert.match(s, /iter 7/);
  assert.match(s, /\/loop to resume/);
  const w = buildWidgetLines(state, null, NOW)!;
  assert.ok(w, "widget shows the held-loop card");
  assert.match(w[0]!, /improve search ranking/);
  assert.match(w[1]!, /loop held · iter 7/);
  assert.match(w[2]!, /restore gate/);
});

test("held loop + paused goal → both visible (status suffix + widget trailing line)", () => {
  const state = { goal: goalOf({ status: "paused", pauseReason: "user paused" }), list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /paused/);
  assert.match(s, /loop⏸held/, "held-loop suffix rides the paused-goal status");
  const w = buildWidgetLines(state, null, NOW)!;
  assert.match(w.join("\n"), /loop held · iter 7 — \/loop to resume/);
});

test("held loop + active goal → status suffix present", () => {
  const state = { goal: goalOf(), list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /glla: \[ACTIVE\]/); // v0.34.1: policy word dropped from the status line
  assert.match(s, /loop⏸held/);
});

test("v0.34.89: held loop + completed goal → dim summary shows, held loop stays visible via suffix", () => {
  const state = { goal: goalOf({ status: "complete" }), list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /✓ done/);
  assert.match(s, /loop⏸held/, "the held loop stays visible as a status suffix");
  assert.match(buildWidgetLines(state, null, NOW)![0]!, /✓ done/);
});

test("active loop unchanged; stopped loop stays invisible", () => {
  const active = { goal: null, list: [], loop: heldLoopOf({ active: true, stopReason: undefined }) };
  const s = buildStatusText(active, null, NOW)!;
  assert.match(s, /loop ↑ iter 7/, "active loop renders exactly as before");
  assert.doesNotMatch(s, /held/);
  const stopped = { goal: null, list: [], loop: heldLoopOf({ stopReason: "stopped by user (/loop stop)" }) };
  assert.equal(buildStatusText(stopped, null, NOW), undefined, "a genuinely stopped loop stays invisible");
  assert.equal(buildWidgetLines(stopped, null, NOW), undefined);
});

// ---- v0.28.22: pause-kind rendering (decision / error / wait) ----

test("decision pause: banner + numbered options + recommended flagged (widget + status)", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "decision",
    pauseReason: "The auditor disapproved completion — SUPERSEDED rows don't match the objective text.",
    pauseOptions: ["surgical Done when: clause", "deliver the missing polish (~2-3 hours)", "reword objective to accept SUPERSEDED"],
    pauseRecommended: 3,
    pauseSuggestedAction: "Pick one, then /goal resume.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("decision needed — your call unblocks this")), `decision banner: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("1. surgical Done when: clause")), "option 1 numbered");
  assert.ok(w.some((l) => l.includes("3. reword objective to accept SUPERSEDED ◂ recommended")), "recommended flagged");
  const s = buildStatusText(state as never)!;
  assert.ok(s.includes("decision needed"), `status: ${s}`);
  assert.ok(!s.includes("SUPERSEDED rows"), "status names the actionability, not the reason");
});

test("error pause: ACTION NEEDED banner, action line popped (widget + status)", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "error",
    pauseReason: "send-retry storm: 5m of 50ms re-arms — the session never went idle",
    pauseSuggestedAction: "Press Escape, then /goal resume.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("action needed — this won't fix itself")), `error banner: ${w.join("\n")}`);
  const s = buildStatusText(state as never)!;
  assert.ok(s.includes("action needed"), `status: ${s}`);
});

test("active auditor infrastructure failure is visible as blocked, not green progress", () => {
  const g = goalOf({
    status: "active",
    pauseReason: "auditor infrastructure (retried once): pi exited without an agent_settled RPC event",
    pauseSuggestedAction: "Fix the auditor model, then /goal resume.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.match(w[0]!, /auditor blocked — no verdict/);
  assert.ok(w.some((l) => l.includes("completion claim was not evaluated")), `widget: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("Fix the auditor model")), `action: ${w.join("\n")}`);
  const s = buildStatusText(state as never)!;
  assert.match(s, /auditor blocked — no verdict/);
  assert.doesNotMatch(s, /glla: ●/);
});

test("v0.34.87: paused auditor no-verdict is parked, not host-bearing (surface separation)", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "completion audit blocked — no verdict: silent host successor",
    pauseSuggestedAction: "The completion claim is stored; /goal resume starts exactly one fresh auditor.",
    pendingCompletion: {
      at: "2026-07-21T11:59:00Z",
      phase: "recovery-pending",
      attemptId: "audit-no-verdict",
      completionSummary: "stored claim",
    },
  });
  const state = { goal: g, list: [], loop: null };
  const widget = buildWidgetLines(state as never)!;
  assert.ok(widget.some((line) => line.includes("auditor: parked — no verdict")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("completion claim was not evaluated")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("/goal resume")), widget.join("\\n"));
  // v0.34.87: "blocked" read as live failure next to "⏸ paused"; "MAIN
  // host remains attached" claimed session activity the parked state lacks.
  assert.ok(!widget.some((line) => line.includes("blocked — no verdict")), widget.join("\\n"));
  assert.ok(!widget.some((line) => line.includes("MAIN host remains attached")), widget.join("\\n"));
  const status = buildStatusText(state as never)!;
  // Surface separation: the status line leads with the pause and names the
  // resume action — glla's "session idle, awaiting /goal resume" — and
  // never claims the MAIN host is supervising a parked item.
  assert.match(status, /⏸ paused · auditor parked — no verdict · \/goal resume/);
  assert.doesNotMatch(status, /MAIN HOST|DETACHED/);
});

test("v0.34.87: a paused LIST item's parked line names /list resume and the queue", () => {
  const g = goalOf({
    policy: "list",
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "completion audit blocked — no verdict: silent host successor",
    pendingCompletion: {
      at: "2026-07-21T11:59:00Z",
      phase: "recovery-pending",
      attemptId: "audit-list-parked",
      completionSummary: "stored claim",
    },
  });
  const status = buildStatusText({ goal: g, list: [{ objective: "next queued item" }], loop: null } as never)!;
  assert.match(status, /⏸ paused · auditor parked — no verdict · \/list resume · 1 queued/);
  assert.doesNotMatch(status, /SUPERVISING|working/);
});

test("MAIN activity is never represented as detached — the detached marker belongs only to the live auditor badge", () => {
  // MAIN actively working (status active, no audit in flight): no detached
  // representation anywhere — the host stays attached and unnamed as such.
  const active = goalOf({ status: "active", objective: "active main work — done when pinned" });
  const activeState = { goal: active, list: [], loop: null };
  const activeWidget = buildWidgetLines(activeState as never)!;
  const activeStatus = buildStatusText(activeState as never)!;
  assert.doesNotMatch(activeWidget.join("\n"), /DETACHED|detached/, "MAIN activity never renders as detached (widget)");
  assert.doesNotMatch(activeStatus, /DETACHED|detached/, "MAIN activity never renders as detached (status)");

  // Auditing MAIN: the ONLY detached marker in the whole projection is the
  // live auditor activity badge; the host projection is MAIN HOST · SUPERVISING.
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-host-invariant" } });
  const state = { goal: g, list: [], loop: null };
  const status = buildStatusText(state as never, { phase: "tool_executing", currentTool: "read", lastActivityAt: NOW - 1_000 }, NOW)!;
  assert.match(status, /MAIN HOST · SUPERVISING/);
  const detachedCount = (status.match(/DETACHED/g) ?? []).length;
  assert.equal(detachedCount, 1, `exactly one detached marker, inside the auditor badge: ${status}`);
  const badgeIndex = status.indexOf("AUDITOR · DETACHED · LIVE");
  const hostIndex = status.indexOf("MAIN HOST · SUPERVISING");
  assert.ok(hostIndex >= 0 && badgeIndex > hostIndex, "the host names MAIN first; the detached auditor badge follows");
});

test("v0.34.57: MAIN host label is pinned to SUPERVISING by the MAIN_HOST_LABEL constant guard", () => {
  // OPEN-ISSUES bug #1.8 (tasklist item #2): the MAIN host must ALWAYS render
  // as SUPERVISING, never DETACHED. The constant MAIN_HOST_LABEL is the
  // one-line guard. This test pins the invariant across every host-bearing
  // state so a future refactor cannot accidentally regress it.
  assert.equal(MAIN_HOST_LABEL, "MAIN HOST · SUPERVISING", "the guard constant is the single source of truth for the MAIN host label");

  // 1. Auditing state: the host projection is "MAIN HOST · SUPERVISING".
  const auditing = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-guard" } });
  const auditingState = { goal: auditing, list: [], loop: null };
  const auditingStatus = buildStatusText(auditingState as never)!;
  assert.match(auditingStatus, /MAIN HOST · SUPERVISING/);
  const auditingWidget = buildWidgetLines(auditingState as never)!;
  assert.ok(auditingWidget.some((l) => l.includes("MAIN HOST · SUPERVISING")), "widget uses the guard label");

  // 2. No-verdict state: NOT host-bearing anymore (v0.34.87 surface
  // separation — a parked item's status line names the pause and the resume
  // action, never claims the MAIN host is supervising). The guard constant
  // itself is unchanged; the paused state simply renders no host label.
  const noVerdict = goalOf({
    status: "paused",
    pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "recovery-pending", attemptId: "audit-noverdict" },
    pauseKind: "blocked",
    pauseReason: "auditor blocked — no verdict",
  });
  const noVerdictState = { goal: noVerdict, list: [], loop: null };
  const noVerdictStatus = buildStatusText(noVerdictState as never)!;
  assert.match(noVerdictStatus, /⏸ paused · auditor parked — no verdict/);
  assert.doesNotMatch(noVerdictStatus, /MAIN HOST/, "a parked item must not claim the host is supervising");
  assert.doesNotMatch(noVerdictStatus, /MAIN HOST · DETACHED/, "MAIN HOST must never render as DETACHED");

  // 3. Invariant: wherever "MAIN HOST" appears in any host-bearing rendering,
  // it is followed by " · SUPERVISING" — never " · DETACHED".
  for (const text of [auditingStatus, auditingWidget.join("\n")]) {
    assert.match(text, /MAIN HOST · SUPERVISING/, `MAIN HOST must render as SUPERVISING: ${text}`);
    assert.doesNotMatch(text, /MAIN HOST · DETACHED/, `MAIN HOST must never render as DETACHED: ${text}`);
  }
});

test("active auditor verdicts never masquerade as infrastructure no-verdict", () => {
  const shield = goalOf({
    status: "active",
    pauseReason: "regression shield: auditor approved, but evidence never referenced 1 contract item(s)",
    pauseSuggestedAction: "Call complete_goal again with evidence for the missing item.",
  });
  const shieldState = { goal: shield, list: [], loop: null };
  const shieldWidget = buildWidgetLines(shieldState as never)!;
  assert.match(shieldWidget[0]!, /regression shield — evidence gap/);
  assert.ok(shieldWidget.some((l) => l.includes("auditor approved; regression shield found missing evidence")), `shield: ${shieldWidget.join("\\n")}`);
  assert.doesNotMatch(shieldWidget.join("\\n"), /no verdict|claim was not evaluated/);
  assert.match(buildStatusText(shieldState as never)!, /regression shield — evidence gap/);

  const disapproved = goalOf({
    status: "active",
    pauseReason: "auditor disapproved",
    pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
    auditHistory: [{
      at: "2026-07-21T11:59:30Z",
      approved: false,
      disapproved: true,
      model: "auditor",
      report: "## Required fixes\n- update assets-manifest to v1.0.0-image-regen\n<disapproved/>",
    }],
  });
  const disapprovalState = { goal: disapproved, list: [], loop: null };
  const disapprovalWidget = buildWidgetLines(disapprovalState as never)!;
  assert.match(disapprovalWidget[0]!, /auditor disapproved — fix the gap/);
  assert.ok(disapprovalWidget.some((l) => l.includes("auditor verdict: disapproved")), `disapproval: ${disapprovalWidget.join("\\n")}`);
  assert.ok(disapprovalWidget.some((l) => l.includes("v1.0.0-image-regen")), `feedback: ${disapprovalWidget.join("\\n")}`);
  assert.doesNotMatch(disapprovalWidget.join("\\n"), /no verdict|claim was not evaluated/);
  assert.match(buildStatusText(disapprovalState as never)!, /auditor disapproved — fix the gap/);
});

test("provider payloads stay out of durable disapproval widget feedback", () => {
  const disapproved = goalOf({
    status: "active",
    pauseReason: "auditor disapproved",
    pauseSuggestedAction: "Inspect the required fixes, then /goal resume.",
    auditHistory: [{
      at: "2026-07-21T11:59:30Z",
      approved: false,
      disapproved: true,
      model: "auditor",
      report: [
        "## Required fixes",
        "- provider returned 429 Token Plan request_id=secret-request",
        "403",
        "{",
        '  "account": "secret-account",',
        '  "message": "Token Plan rate limit reached"',
        "}",
        "<disapproved/>",
      ].join("\n"),
    }],
  });
  const widget = buildWidgetLines({ goal: disapproved, list: [], loop: null } as never)!.join("\n");
  assert.doesNotMatch(widget, /403|429|Token Plan|secret-request|secret-account|rate limit/);
  assert.match(widget, /diagnostic redacted/);
});

test("v0.34.64: retry-class pause shows uniform auto-retrying countdown; no QUOTA WALL anywhere", () => {
  // v0.34.64: the QUOTA WALL display concept is gone. Every retry-class pause
  // (wait/blocked with a recovery timer) renders the same "auto-retrying ·
  // next probe in X" line — quota, billing, 429, transient — regardless of
  // the underlying reason. Raw 429 JSON stays out of the card; the durable
  // reason lives in the ledger for forensics.
  const g = goalOf({
    status: "paused",
    policy: "list",
    pauseKind: "wait",
    pauseReason: 'main model recovery — retrying in 15m (main model quota: 429 {"message":"Token Plan usage limit reached"})',
    pauseResumeAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
    pauseSuggestedAction: "The provider/quota wall is being retried automatically; /list resume retries immediately.",
  });
  const state = { goal: g, list: [{ id: "next", objective: "later", addedAt: "z" }], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("auto-retrying") && l.includes("next probe in")), `countdown: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("saved —")), `saved state: ${w.join("\n")}`);
  assert.doesNotMatch(w.join("\n"), /QUOTA WALL/, "the QUOTA WALL banner is gone");
  assert.doesNotMatch(w.join("\n"), /manual resume required/, "manual-resume wording is gone");
  assert.doesNotMatch(w.join("\n"), /main model quota: 429|Token Plan usage limit reached.*message/, "raw provider JSON stays out of the card");
  const s = buildStatusText(state as never)!;
  assert.match(s, /auto-retrying/);
  assert.match(s, /1 queued/);
  assert.doesNotMatch(s, /QUOTA WALL/, "status text never says QUOTA WALL");
});

test("v0.34.64: ambiguous (transient 503) recovery is shown with the same auto-retrying badge — no special 'wall' label", () => {
  // v0.34.64: every retry-class pause renders identically. A 503 transient
  // gets the same uniform treatment as a 429 quota wall — the card never
  // claims a wall exists; it only says "we're retrying at X".
  const g = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "main model recovery — retrying in 15m (main model transient: 503 temporarily unavailable)",
    pauseResumeAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.doesNotMatch(w.join("\\n"), /QUOTA WALL/, "no QUOTA WALL banner ever");
  assert.match(w.join("\\n"), /auto-retrying/, "uses the uniform auto-retrying line");
  const s = buildStatusText(state as never)!;
  assert.match(s, /auto-retrying/);
  assert.doesNotMatch(s, /waiting(?! for)/, "old `waiting` badge is gone");
});

test("v0.34.102: paused goal parked on mainModelRecovery renders as RECOVERING, not paused (widget head + card)", () => {
  // Field: dracon-platform 2026-08-08 090343 "working while displaying
  // paused here" — the goal was parked on the provider wall (rearm storm
  // streak 19 firing) but the widget head chip read ⏸ paused. With
  // state.mainModelRecovery.retryAt present, the head must say
  // recovering (⏳), never contradict the status line.
  const g = goalOf({
    status: "paused",
    policy: "goal",
    pauseKind: "wait",
    pauseReason: "main model recovery — retrying (429)",
    pauseResumeAt: new Date(Date.now() + 42 * 60_000).toISOString(),
    pauseSuggestedAction: "Auto-retry continues.",
  });
  const state = {
    goal: g,
    list: [],
    loop: null,
    mainModelRecovery: {
      primary: "minimax/MiniMax-M3",
      active: "minimax/MiniMax-M3",
      attempted: ["minimax/MiniMax-M3"],
      attempts: 2,
      retryAt: new Date(Date.now() + 42 * 60_000).toISOString(),
      reason: "main model quota: 429",
    },
  };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("recovering")), `head says recovering: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("main-model recovery — retrying automatically")), `card names the park without a reset-time claim: ${w.join("\n")}`);
  assert.doesNotMatch(w.join("\n"), /⏸ paused/, "the head chip no longer reads paused");
  assert.doesNotMatch(w.join("\n"), /quota reset/, "no guaranteed-reset time claim on the card");
  const s = buildStatusText(state as never)!;
  assert.ok(s.includes("main-model recovery — retrying automatically"), `status names the blocker without a reset-time claim: ${s}`);
  assert.ok(!s.includes("auto-retrying"), "auto-retrying promise is gone for the parked case (it read as live retry)");
});

test("v0.34.102: wait pause WITHOUT mainModelRecovery keeps the uniform auto-retrying shape", () => {
  // The v0.34.64 uniform shape survives when the pause is NOT a recovery
  // park (no state.mainModelRecovery) — e.g. a plain timed wait.
  const g = goalOf({
    status: "paused",
    policy: "goal",
    pauseKind: "wait",
    pauseReason: "user timed wait",
    pauseResumeAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  const state = { goal: g, list: [], loop: null };
  const s = buildStatusText(state as never)!;
  assert.match(s, /auto-retrying/);
  assert.ok(!s.includes("parked on provider wall"), "plain wait is not a provider park");
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("auto-retrying")), "plain wait keeps the uniform countdown line");
});
  const goalSrc = readGoalRuntimeSource();
test("v0.34.64: 24h horizon holds render as a paused card with the suggested action; no manual-resume wording", () => {
  // v0.34.58: an upstream reset hint beyond the 5h probe budget falls back to
  // the bounded cadence; it no longer produces a quota-only manual hold.
  const goalSrc = readGoalRuntimeSource();
  assert.ok(!goalSrc.includes("mainModelHintExceedsProbeBudget"), "quota-only parking gate gone from goal.ts");
  assert.ok(!goalSrc.includes("provider supplied a reset beyond"), "over-budget hint hold reason gone");

  // v0.34.64: the 24h horizon is a paused goal with kind=blocked and no
  // pauseResumeAt. The card wraps the pauseReason and pops the suggested
  // action; it never brands this state as a "QUOTA WALL · manual resume
  // required" (that wording is gone) and never tells the user "manual
  // resume" is the only path.
  const g = goalOf({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "main model recovery — automatic probes stopped (the 24h automatic recovery horizon was reached) · main model quota: 429 reset in 1 week",
    pauseSuggestedAction: "Check the provider reset, then /goal resume to start a fresh bounded window.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.doesNotMatch(w.join("\\n"), /QUOTA WALL/, "no QUOTA WALL banner ever");
  assert.doesNotMatch(w.join("\\n"), /manual resume required/, "manual-resume wording is gone");
  // The reason DOES wrap in the card (no retryAt → reason dump), so the
  // 24h horizon line is visible — it explains the situation honestly.
  // The wrap helper splits long reasons across multiple lines, so match
  // a permissive "24h" + "automatic recovery horizon" pair:
  assert.match(w.join("\\n"), /24h[\s\S]*automatic recovery horizon/);
  // The suggested action is the recovery path the card surfaces:
  assert.match(w.join("\\n"), /\/goal resume/);
});

test("main-model recovery manual hold does not claim a non-quota block", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "main model recovery — automatic probes stopped (the recovery horizon was reached) · main model quota: 429",
    pauseSuggestedAction: "Check the provider or switch /model, then /goal resume.",
  });
  const state = {
    goal: g,
    list: [],
    loop: null,
    mainModelRecovery: {
      primary: "minimax/MiniMax-M3",
      attempted: ["minimax/MiniMax-M3"],
      attempts: 3,
      reason: "main model quota: 429",
      manualResumeRequired: true,
      kind: "goal" as const,
    },
  };
  const widget = buildWidgetLines(state as never, null, NOW)!;
  const widgetText = widget.join("\\n");
  assert.match(widgetText, /manual recovery hold — automatic probes stopped/);
  assert.doesNotMatch(widgetText, /blocked — waiting on a non-quota condition/);
  const status = buildStatusText(state as never, null, NOW)!;
  assert.match(status, /manual recovery hold/);
  assert.doesNotMatch(status, /action needed/);
});

test("v0.34.51: a passed quota resumeAt says resuming…, never the old 'retrying now'", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "main model recovery — retrying in 15m (main model quota: 429 Token Plan usage limit)",
    pauseResumeAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const state = { goal: g, list: [], loop: null };
  const s = buildStatusText(state as never)!;
  assert.match(s, /resuming…/);
  assert.doesNotMatch(s, /retrying now/);
});

test("legacy pause (no kind): flat card unchanged; error-regex still classifies the status line", () => {
  const g = goalOf({ status: "paused", pauseReason: "user paused for review", pauseSuggestedAction: "/goal resume" });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(!w.some((l) => l.includes("unblocks this") || l.includes("won't fix itself") || l.includes("nothing for you to do")), "no banner without a kind");
  const g2 = goalOf({ status: "paused", pauseReason: "token limit exceeded (10 > 5)" });
  const s2 = buildStatusText({ goal: g2, list: [], loop: null } as never)!;
  assert.ok(s2.includes("action needed"), `legacy error reason → action needed: ${s2}`);
});

test("v0.28.30: the widget card status line ALWAYS names the type (goal · / list item ·)", () => {
  // User note: "I don't always see the type — I'd need to scroll up to see
  // if goal/list/loop." Before, only list items were named on the card.
  const goalLines = buildWidgetLines({ goal: goalOf({}), list: [] }, null, NOW)!;
  assert.match(goalLines[0]!, /^● /); // goal card icon
  assert.match(goalLines[0]!, / · active · /);
  const listLines = buildWidgetLines({ goal: goalOf({ policy: "list" }), list: [] }, null, NOW)!;
  assert.match(listLines[0]!, /· list item · active · /); // v0.33.0: named in the head segments
  const SRC = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
  assert.match(SRC, /if \(isList\) headSegs\.push\("list item"\);/);
});

test("v0.33.0: slim card — meter rounding guard, folded status segments, last-action line", () => {
  // Meter guard (command-code's rule): never empty unless 0, never full unless 1.
  assert.equal(meter(0), "▱▱▱▱▱");
  assert.equal(meter(1), "▰▰▰▰▰");
  assert.equal(meter(0.01), "▰▱▱▱▱");
  assert.equal(meter(0.99), "▰▰▰▰▱");
  assert.equal(meter(0.5), "▰▰▰▱▱"); // round(2.5)=3
  // Slim head: status + tasks meter fold into the head line as middot segments.
  const g = goalOf({ taskList: { version: 1, tasks: [
    { id: "t1", title: "done one", status: "complete" },
    { id: "t2", title: "fix the thing", status: "pending" },
    { id: "t3", title: "another", status: "pending" },
  ] } });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 120, {
    recent: [{ name: "edit", arg: "goal.ts", ms: 12_000, ok: true }],
  })!;
  assert.match(lines[0]!, / · active · /);
  assert.match(lines[0]!, /1\/3 ▰▰▱▱▱/); // round(1.67)=2
  // Last-action line: Claude's done-row format + the next pending task.
  assert.match(lines[1]!, /^├─ ✓ edit goal\.ts \(12s\) · next: fix the thing/);
  assert.match(lines[lines.length - 1]!, /^└─ /);
  // Failed action renders ✗; no ms → no time suffix.
  const failed = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 120, {
    recent: [{ name: "bash", arg: "bun test", ms: 0, ok: false }],
  })!;
  assert.match(failed[1]!, /^├─ ✗ bash bun test(?! \()/);
  // v0.34.124: the recent-action ring is NOT goal-scoped — entries from a
  // PREVIOUS goal outlive activation. The card must drop actions stamped
  // before the current goal was created (note.md 221249: the new goal's
  // card showed the old goal's ✓ complete_goal (0s) for 14 minutes).
  const staleRing = buildWidgetLines({ goal: goalOf({ createdAt: "2026-07-21T11:59:16Z" }), list: [] }, null, NOW, undefined, 120, {
    recent: [
      { name: "complete_goal", arg: undefined, ms: 0, ok: true, at: Date.parse("2026-07-21T11:59:10Z") },
      { name: "read", arg: "new-goal.md", ms: 0, ok: true, at: Date.parse("2026-07-21T11:59:20Z") },
    ],
  })!;
  assert.match(staleRing.join("\n"), /✓ read new-goal\.md/, "the newest action from THIS goal is shown");
  assert.doesNotMatch(staleRing.join("\n"), /complete_goal/, "a pre-goal action must never leak onto the card");
  const allStale = buildWidgetLines({ goal: goalOf({ createdAt: "2026-07-21T11:59:16Z" }), list: [] }, null, NOW, undefined, 120, {
    recent: [{ name: "complete_goal", arg: undefined, ms: 0, ok: true, at: Date.parse("2026-07-21T11:59:10Z") }],
  })!;
  assert.doesNotMatch(allStale.join("\n"), /complete_goal/, "all-pre-goal actions vanish entirely (no stale last-action line)");
  // Unstamped entries (legacy rings / fixtures) remain visible.
  const legacyRing = buildWidgetLines({ goal: goalOf({ createdAt: "2026-07-21T11:59:16Z" }), list: [] }, null, NOW, undefined, 120, {
    recent: [{ name: "edit", arg: "old.ts", ms: 12_000, ok: true }],
  })!;
  assert.match(legacyRing.join("\n"), /✓ edit old\.ts \(12s\)/, "unstamped legacy entries stay visible");
  // Slim loop card: ∞ icon + folded iter/meter segments + metricless footer.
  const loopLines = buildWidgetLines({ goal: null, list: [], loop: {
    active: true, target: "endless-td audit", iteration: 12, maxIterations: 100,
    stallCount: 0, plateauWindow: 5, startedAt: "2026-07-21T11:57:00Z", history: [],
  } as any }, null, NOW, undefined, 120, { recent: [{ name: "read", arg: "tiles.ts", ms: 8_000, ok: true }] })!;
  assert.match(loopLines[0]!, /^∞ endless-td audit · iter 12\/100 ▰▱▱▱▱ · /);
  assert.match(loopLines[1]!, /^├─ ✓ read tiles\.ts \(8s\)/);
  assert.match(loopLines[2]!, /^└─ metricless \(no plateau\) · \/loop stop · \/loop refine/); // v0.33.2: /loop refine is a real verb now
  const SRC = readGoalRuntimeSource();
const LOOP = fs.readFileSync("extensions/goal-loop.ts", "utf-8");
  assert.match(SRC, /noteToolCall\(event\); \/\/ v0\.33\.0/);
  assert.match(SRC, /noteToolResult\(event\); \/\/ v0\.33\.0/);
});

test("v0.33.1: audit-batch — sanitize, head fits width, last restored, flag lifecycle", () => {
  const SRC = readGoalRuntimeSource();
  const CONT = fs.readFileSync("extensions/goal-continuation.ts", "utf-8"); // decomposition step 5 (v0.34.113)
  const HB = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
  // A1: tool args are control-char-stripped before reaching a widget line.
  assert.match(SRC, /\[\\x00-\\x1f\\x7f-\\x9f\]\/g/);
  // sweep-F1: a rebound session can go terminal again.
  assert.match(SRC, /staleTerminalDone = false; \/\/ v0\.33\.1/);
  // sweep-F2: the loop path's null-ctx re-arm probes + backs off (was a flat 50ms spin).
  assert.match(LOOP, /if \(probeExtensionApiStale\(\)\) return;\s*\n\s*flags\.loopRearmStreak\+\+;/); // flag accessor re-spelling (decomposition step 2)
  // compact F1/F2 + sweep-F3: the compact debt/resync die with the goal/loop and on rebind.
  assert.match(HB, /if \(!isSupervising\(\) && \(flags\.postCompactResumeOwed \|\| flags\.postCompactResyncPending\)\)/);
  assert.match(SRC, /postCompactResumeOwed = false; \/\/ v0\.33\.1: a compact from a previous session/);
  // compact-F3: builder throws are contained.
  assert.match(CONT, /try \{ resync = buildPostCompactResync\(\); \} catch/); // decomposition step 5 (v0.34.113): sendContinuation moved
  // sweep-F6: per-goal module state resets at activation.
  assert.match(SRC, /countedTokenMessages\.clear\(\);\n  recentActions\.length = 0;/);
  // B1: the head fits the terminal — wide width yields a longer objective than narrow.
  const longObjective = "y".repeat(200);
  const g = goalOf({ objective: longObjective });
  const w100 = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 100)![0]!;
  const w160 = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 160)![0]!;
  assert.ok(w160.length > w100.length, "objective absorbs the extra width");
  assert.ok(w100.length <= 110, `head at width 100 stays near the terminal, got ${w100.length}`);
  // B3a: metric loops show best AND last again.
  const loopLines = buildWidgetLines({ goal: null, list: [], loop: {
    active: true, target: "audit", iteration: 3, maxIterations: 0, measureCmd: "m",
    bestValue: 4, lastValue: 5, stallCount: 2, plateauWindow: 5,
    startedAt: "2026-07-21T11:57:00Z", history: [], direction: "min",
  } as any }, null, NOW, undefined, 120)!;
  assert.match(loopLines[0]!, /best 4 · last 5 · stall 2\/5/);
  // sweep-F4: the auditor's abort listener is removed in finally.
  // v0.34.108: the listener lived on the removed in-process session; the
  // production equivalent is the detached worker's abort listener cleanup.
  const AUD = fs.readFileSync("extensions/goal-loop-auditor-process.ts", "utf-8");
  assert.match(AUD, /args\.signal\?\.removeEventListener\("abort", abort\)/);
});

test("v0.33.2: loop proactiveness + respec machinery", () => {
  const SRC = fs.readFileSync("extensions/goal-loop.ts", "utf-8");
  const GOAL = readGoalRuntimeSource(); // propose_loop_refine tool def stays in goal.ts
  // Reprieve names the top open finding, not just the count.
  assert.match(SRC, /topOpenAuditFinding\(ctx\.cwd\)/);
  assert.match(SRC, /Top open: \$\{topFinding\}/);
  // Saturated metric → the loop suggests propose_loop_refine itself.
  assert.match(SRC, /flat at best — if the spec no longer captures 'better'/);
  // Hypothesis feedback closes the loop into the next prompt.
  assert.match(SRC, /Last iteration you predicted: /);
  assert.match(SRC, /loop\.lastHypothesis = hypothesis;/);
  // /loop refine is a real subcommand (the footer's verb exists).
  assert.match(SRC, /if \(sub === "refine" \|\| sub === "polish"\)/);
  assert.match(SRC, /state\.loop!\.refineHint = hint\.slice\(0, 300\);/);
  // propose_loop_refine carries specText/specAppend; the orchestrator owns the write.
  assert.match(GOAL, /specText: Type\.Optional/);
  assert.match(GOAL, /fs\.writeFileSync\(loop\.specFile/);
  // Spec drift detection + checkbox progress emission (spec_item_progress is now emitted).
  assert.match(SRC, /appendLedger\(ctx\.cwd, "spec_updated", \{ via: "external"/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "spec_item_progress", \{ iteration: loop\.iteration, newlyChecked/);
  // LoopState carries the spec + feedback fields.
  const FOREVER = fs.readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.match(FOREVER, /specFile\?: string;/);
  assert.match(FOREVER, /hypothesisFeedback\?: string;/);
  assert.match(FOREVER, /refineHint\?: string;/);
  // Cosmetic-churn detection in the write-exemption (metricless doorknob leak).
  const REP = fs.readFileSync("extensions/goal-loop-repetition.ts", "utf-8");
  assert.match(REP, /cosmetic churn: wrote files but the reply is ~/);
  // Prompts carry the new placeholders.
  const METRIC = fs.readFileSync("prompts/goal-loop-forever.md", "utf-8");
  assert.match(METRIC, /\$\{HYPOTHESIS_NOTE\}/);
  assert.match(METRIC, /\$\{REFINE_HINT\}/);
  const ML = fs.readFileSync("prompts/goal-loop-forever-metricless.md", "utf-8");
  assert.match(ML, /\$\{HYPOTHESIS_NOTE\}/);
  assert.match(ML, /\$\{REFINE_HINT\}/);
});

// v0.34.100: auditor silent-default verification. Field evidence
// (Screenshot_20260808_084527/084717 endless-td minimax/MiniMax-M3) showed
// the auditor's report stream muted by default. The contract: confirm
// the gate fires for ANY session model (not just for MiniMax-M3) and
// the default is on. Regression test pins:
//   1. settings.ts default is `auditorSilent: true`
//   2. display.ts honors `auditorSilent !== false` (treats undefined as on)
//   3. The plumbing in loops/goal.ts passes the loaded setting through
//      to extras.auditorSilent
//   4. With auditorSilent default on, the report stream is hidden even
//      for non-MiniMax session models (the gate is not model-specific)
test("v0.34.100: auditorSilent default is on in settings (every session model)", () => {
  const settings = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  // Default-on: the field must default to true (not false, not undefined).
  assert.match(settings, /auditorSilent: true,/);
  // The setting is registered (so /glla settings exposes the toggle).
  assert.match(settings, /"auditorSilent",/);
});

test("v0.34.100: auditorSilent plumbing threads the loaded setting through extras", () => {
  const loops = readGoalRuntimeSource();
  // extras includes auditorSilent from loadSettings
  assert.match(loops, /auditorSilent: loadSettings\(ctx\.cwd\)\.auditorSilent !== false/);
  // display.ts consumes extras.auditorSilent
  const display = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
  assert.match(display, /const silent = extras\?\.auditorSilent !== false/);
});

test("v0.34.100: silent-default widget renders muted for ANY session model", () => {
  // The gate is not model-specific — if `auditorSilent` is on (the
  // default), the widget shows "report stream muted" regardless of the
  // session model. Test with multiple mock models to confirm.
  const models = ["minimax/MiniMax-M3", "anthropic/claude-sonnet-4-5", "openai/gpt-4.1", undefined];
  for (const model of models) {
    const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: `audit-${model ?? "none"}` } });
    const audit = {
      phase: "producing_report" as const,
      elapsedMs: 300_000,
      lastActivityAt: NOW - 5_000,
      recentOutput: ["Some prose the auditor is generating."],
      reportBytes: 5_000,
    };
    // extras.auditorSilent undefined → defaults to on (the !=== false check)
    const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW)!;
    assert.ok(
      lines.some((l) => l.includes("report stream muted")),
      `model=${model}: muted-by-default renders regardless of session model`,
    );
    assert.ok(
      !lines.some((l) => l.includes("latest: Some prose")),
      `model=${model}: prose tail stays hidden by default`,
    );
  }
});

// v0.34.96/v0.34.128: complete-vs-aborted distinction when the work was
// already shipped in a prior version. Field evidence: Screenshot_20260808_080536
// — a recap ending `✓ complete` while saying "v0.34.74 already…"
// contradicted itself. The fix: detect "already shipped" / "verified
// vX.Y.Z covers this" / "no new work shipped" in the completionSummary.
// Version-bearing claims route to status=aborted with stopReason
// already_shipped:vX.Y.Z (the named version is the corroboration).
// v0.34.128 (field 2026-08-11, dracon-platform): VERSION-LESS claims are
// not corroborated — a restored session can hallucinate them from the old
// conversation's tail and abort a finding that still needs work — so they
// route to the NORMAL completion audit with the routedToAudit flag and the
// label carried into the audited recap; the auditor verifies the work
// exists in the tree.
// This SRC-pinned assertion lives in tests/display.test.ts per the
// verification contract item 12; the behavioral tests (running the
// complete_goal tool) are in tests/revision-bound-audit.test.ts for
// fixture convenience.
test("v0.34.96/v0.34.128: complete_goal detects 'already shipped' / 'verified vX covers this' / 'no new work shipped' — version-bearing aborts, version-less routes to the audit (SRC-pinned in display.test.ts)", () => {
  const loops = readGoalRuntimeSource();
  // The detection regex covers the three contracted phrases. The source
  // comment uses the literal user-facing phrase (the runtime reg-exp
  // captures v\d+\.\d+\.\d+ — verified in the runtime check below):
  assert.match(loops, /already\s+shipped/i, "detects 'already shipped'");
  assert.match(loops, /verified vX covers this|verified\s+v\d+\.\d+\.\d+\s+covers\s+this/, "detects the regex for 'verified vX.Y.Z covers this'");
  assert.match(loops, /no\s+new\s+work\s+shipped/i, "detects 'no new work shipped'");
  // Version-bearing routing: archiveCurrentGoal(ctx, "aborted", stopReason).
  assert.match(loops, /archiveCurrentGoal\(ctx,\s*"aborted",\s*stopReason(?:,\s*\{)?/, "version-bearing claims route to status=aborted via archiveCurrentGoal");
  assert.match(loops, /already_shipped:v[\d.]+|already_shipped:/, "stopReason names the matched version");
  // Version-less routing: flagged for the normal audit + label in recap.
  assert.match(loops, /routedToAudit: true/, "version-less claims are flagged for the normal audit");
  assert.match(loops, /version-less "/, "the label is carried into the audited recap");
  // The ledger event is recorded for both paths.
  assert.match(loops, /complete_goal_already_shipped/, "the ledger event is recorded");
});
