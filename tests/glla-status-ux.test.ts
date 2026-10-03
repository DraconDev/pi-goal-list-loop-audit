import ts from "typescript";
// pi-goal-list-loop-audit — v0.35.15
// tests/glla-status-ux.test.ts
//
// v0.35.15 status-surface UX goal:
//   1. visual footer — distinct per-phase glyphs + draining activity meter,
//      supervisor-paused chip in EVERY lifecycle branch;
//   2. /glla pause|resume — broad supervisor freeze, persisted across
//      reloads, active work untouched;
//   3. proactive quiet-phase notification (exactly once) + silent-stretch
//      detailed auditor-card summary.
//
// Behavioral tests drive the real command dispatcher through MockPi; the
// quiet watcher is exercised through the exported test hook with a
// controlled clock; the frozen dispatch points are pinned by source
// assertions (same style as glla-stale-context.test.ts) because driving
// armed timers through the harness cannot prove a negative.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate from "../extensions/loops/goal.js";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../extensions/goal-loop-display.ts";
import { readState } from "../extensions/goal-loop-core.js";
import {
  __testOnlyAuditorQuietWatchTick,
  __testOnlyLastAuditorQuietStretch,
  __testOnlyLoadState,
  __testOnlyResetAuditorQuietWatch,
  summarizeToolArg,
} from "../extensions/loops/goal-ui.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick, type MockCtx } from "./harness/mock-pi.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const QUIET_MS = 3 * 60_000;

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

function auditingGoal(): Record<string, unknown> {
  return {
    id: "20260821120000-audit1",
    objective: "audit-seeded objective — done when pinned",
    status: "auditing",
    policy: "goal",
    autoContinue: true,
    createdAt: new Date(NOW - 3600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    pendingCompletion: { phase: "running", attemptId: "audit-test-attempt", startedAt: new Date(NOW - 120_000).toISOString(), completionSummary: "s", verificationSummary: "v", retryAttempts: 0 },
  };
}

function auditProgress(overrides: Partial<AuditDisplayProgress> = {}): AuditDisplayProgress {
  return {
    label: "running",
    phase: "thinking",
    elapsedMs: 120_000,
    lastActivityAt: NOW,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. Visual footer: distinct glyph + activity meter per auditor phase
// ────────────────────────────────────────────────────────────────────

test("v0.35.15: auditing footer carries a distinct phase glyph AND an activity meter element for every auditor phase", () => {
  const cases: Array<{ name: string; progress: AuditDisplayProgress; glyph: string }> = [
    { name: "running", progress: auditProgress({ lastActivityAt: NOW }), glyph: "▶" },
    { name: "quiet", progress: auditProgress({ lastActivityAt: NOW - QUIET_MS - 1000 }), glyph: "◌" },
    { name: "blocked", progress: auditProgress({ label: "error", lastActivityAt: NOW }), glyph: "⛔" },
    { name: "awaiting-verdict", progress: auditProgress({ phase: "complete", label: "running", lastActivityAt: NOW }), glyph: "✓" },
  ];
  const seenGlyphs = new Set<string>();
  for (const c of cases) {
    const text = buildStatusText(
      { goal: auditingGoal() as never, list: [] },
      c.progress,
      NOW,
    );
    assert.ok(text, "status line renders");
    assert.ok(text.includes(c.glyph), `${c.name}: footer contains the distinct glyph ${c.glyph}`);
    seenGlyphs.add(c.glyph);
    // The compact activity meter (▰▱ cells) renders next to the phase.
    assert.ok(/▰+▱*|▱+/.test(text), `${c.name}: footer contains the activity meter`);
  }
  assert.equal(seenGlyphs.size, 4, "each phase has a DISTINCT glyph");
});

test("v0.35.15: activity meter drains as worker silence grows (full at fresh, empty past the quiet threshold)", () => {
  const fresh = buildStatusText({ goal: auditingGoal() as never, list: [] }, auditProgress({ lastActivityAt: NOW }), NOW)!;
  const old = buildStatusText({ goal: auditingGoal() as never, list: [] }, auditProgress({ lastActivityAt: NOW - QUIET_MS }), NOW)!;
  const freshFilled = (fresh.match(/▰/g) ?? []).length;
  const oldFilled = (old.match(/▰/g) ?? []).length;
  assert.ok(freshFilled > oldFilled, `meter drains: fresh=${freshFilled} old=${oldFilled}`);
  assert.equal(oldFilled, 0, "at the quiet threshold the meter is empty");
});

// ────────────────────────────────────────────────────────────────────
// 2. Supervisor-paused chip in every lifecycle branch
// ────────────────────────────────────────────────────────────────────

test("v0.35.15: ⏸ supervisor chip leads the footer in every lifecycle branch when paused", () => {
  const paused = { supervisorPausedAt: NOW - 5000 };
  const states: Array<Record<string, unknown>> = [
    { ...paused, goal: { id: "g1", objective: "x", status: "active", policy: "goal", autoContinue: true, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() } as never, list: [] },
    { ...paused, goal: auditingGoal() as never, list: [] },
    { ...paused, loop: { active: true, iteration: 3, maxIterations: 10, stallCount: 0, plateauWindow: 5, target: "t", measureCmd: "echo 1", direction: "min", bestValue: 2 } as never },
  ];
  for (const s of states) {
    const text = buildStatusText(s as never, undefined, NOW);
    assert.ok(text?.includes("⏸ supervisor"), `branch renders the paused chip (${(s.goal as { status?: string })?.status ?? "loop"})`);
  }
  // Not paused → no chip.
  const unpaused = buildStatusText({ goal: auditingGoal() as never, list: [] }, auditProgress({ lastActivityAt: NOW }), NOW)!;
  assert.ok(!unpaused.includes("⏸ supervisor"), "no chip while the supervisor is free");
});

// ────────────────────────────────────────────────────────────────────
// 3. Silent-stretch summary in the detailed auditor card
// ────────────────────────────────────────────────────────────────────

test("v0.35.15: a recently ended quiet stretch shows 'silent Xm then resumed' in the widget; stale stretches stay hidden", () => {
  const base = { goal: auditingGoal() as never, list: [] };
  const progress = auditProgress({ lastActivityAt: NOW }); // resumed now
  const shownStatus = buildStatusText(base as never, progress, NOW, undefined, {
    auditorQuietStretch: { ms: 8 * 60_000, endedAt: NOW - 1000 },
  })!;
  assert.ok(!shownStatus.includes("then resumed"), "the compact footer does not duplicate detailed history");
  const shownWidget = buildWidgetLines(base as never, progress, NOW, undefined, undefined, {
    auditorQuietStretch: { ms: 8 * 60_000, endedAt: NOW - 1000 },
  })!.join("\\n");
  assert.ok(shownWidget.includes("silent 8m 00s then resumed"), "the detailed card summarizes the ended stretch");
  const expired = buildWidgetLines(base as never, progress, NOW, undefined, undefined, {
    auditorQuietStretch: { ms: 8 * 60_000, endedAt: NOW - 11 * 60_000 },
  })!.join("\\n");
  assert.ok(!expired.includes("then resumed"), "a stretch older than the visibility window disappears");
});

// ────────────────────────────────────────────────────────────────────
// 4. Proactive quiet watcher: exactly-once notify + stretch recording
// ────────────────────────────────────────────────────────────────────

test("v0.35.15: quiet watcher notifies EXACTLY ONCE on entering the quiet phase, records the stretch on resume", () => {
  __testOnlyResetAuditorQuietWatch();
  const cwd = tmpCwd();
  seedState(cwd, { goal: auditingGoal() });
  __testOnlyLoadState(cwd);

  const t0 = NOW;
  // Fresh worker evidence → silent.
  assert.equal(__testOnlyAuditorQuietWatchTick(auditProgress({ lastActivityAt: t0 }), t0), null);
  // Cross the threshold (~3 min of zero activity) → ONE warning.
  const warning = __testOnlyAuditorQuietWatchTick(auditProgress({ lastActivityAt: t0 }), t0 + QUIET_MS + 5_000);
  assert.ok(warning?.includes("NO worker activity"), "the crossing fires the proactive warning");
  assert.ok(warning!.includes("/goal cancel"), "names the discard escape hatch");
  // Still quiet, later ticks → no repeat.
  assert.equal(__testOnlyAuditorQuietWatchTick(auditProgress({ lastActivityAt: t0 }), t0 + QUIET_MS + 65_000), null);
  // Activity resumes → stretch recorded (≥3 min), watcher re-armed.
  assert.equal(__testOnlyAuditorQuietWatchTick(auditProgress({ lastActivityAt: t0 + QUIET_MS + 70_000 }), t0 + QUIET_MS + 70_000), null);
  const stretch = __testOnlyLastAuditorQuietStretch();
  assert.ok(stretch && stretch.ms >= QUIET_MS, `ended stretch recorded (${stretch?.ms}ms)`);
});

test("v0.35.15: quiet watcher stays silent while the supervisor is paused (it IS automatic machinery)", () => {
  __testOnlyResetAuditorQuietWatch();
  const cwd = tmpCwd();
  seedState(cwd, { goal: auditingGoal(), supervisorPausedAt: NOW - 1000 } as never);
  __testOnlyLoadState(cwd);

  const warning = __testOnlyAuditorQuietWatchTick(auditProgress({ lastActivityAt: NOW }), NOW + QUIET_MS + 5_000);
  assert.equal(warning, null, "no proactive notify inside a supervisor pause");
  __testOnlyResetAuditorQuietWatch();
});

// ────────────────────────────────────────────────────────────────────
// 5. /glla pause | resume: persisted, broad, work untouched
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// 6. Frozen dispatch points — pinned by source (driving armed timers
// through the harness cannot prove a negative; same style as
// glla-stale-context.test.ts's source tests)
// ────────────────────────────────────────────────────────────────────

test("v0.35.15: every automatic dispatch point gates on supervisorPaused", () => {
  const gates: Array<[string, string, RegExp]> = [
    ["extensions/goal-continuation.ts", "scheduleContinuation", /supervisorPaused\(state\)/],
    ["extensions/goal-continuation.ts", "sendContinuation", /if \(supervisorPaused\(state\)\) return;/],
    ["extensions/goal-loop.ts", "scheduleLoopTick", /if \(supervisorPaused\(state\)\) return;/],
    ["extensions/goal-loop.ts", "sendLoopTurn", /if \(supervisorPaused\(state\)\) return;/],
    ["extensions/goal-recovery.ts", "scheduleMainModelRecoveryTimer", /if \(supervisorPaused\(state\)\) return;/],
    ["extensions/loops/goal-auditor-hooks.ts", "retryStoredCompletionAudit", /origin !== "manual" && supervisorPaused\(state\)/],
    ["extensions/loops/goal-ui.ts", "__auditorQuietWatchTick", /supervisorPaused\(state\)/],
  ];
  // Inspect the function rather than a character window sensitive to comments.
  const source = ts.createSourceFile("heartbeat.ts", fs.readFileSync("extensions/goal-heartbeat.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const heartbeat = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "heartbeatTick");
  assert.ok(heartbeat?.body);
  const guard = heartbeat.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(source) === 'typeof state.supervisorPausedAt === "number"');
  assert.ok(guard && ts.isIfStatement(guard) && ts.isReturnStatement(guard.thenStatement), "heartbeat must return for a manual supervisor pause");
  for (const [file, point, re] of gates) {
    const parsed = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === point);
    assert.ok(declaration?.body, `${file}: ${point} must exist`);
    assert.match(declaration.body.getText(parsed), re, `${file}: ${point} must freeze under /glla pause`);
  }
});
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  return ctx;
}

afterEach(() => {
  __testOnlyResetAuditorQuietWatch();
});

test("v0.35.15: /glla pause persists a durable flag, leaves the active goal untouched, and survives a disk reload", async () => {
  const cwd = tmpCwd();
  const goal = { id: "20260821120100-active", objective: "keep working — done when pinned", status: "active", policy: "goal", autoContinue: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  seedState(cwd, { goal });
  const ctx = await freshSession(cwd);
  // session_start's own auto-resume machinery may park the seeded active
  // goal (no conversation bound in the mock) BEFORE we pause — capture the
  // post-startup truth so we assert "pause changed nothing", not "mock
  // startup quirks".
  const statusBefore = readState(cwd).goal?.status;

  await pi.command("glla", "pause", ctx);
  await tick();

  const paused = ctx.ui.matching("Supervisor PAUSED");
  assert.equal(paused.length, 1, "the freeze is announced as a warning");
  const onDisk = readState(cwd);
  assert.equal(typeof onDisk.supervisorPausedAt, "number", "the pause flag is durable on disk");
  assert.equal(onDisk.goal?.id, goal.id, "the active goal is untouched");
  assert.equal(onDisk.goal?.status, statusBefore, "/glla pause did not touch the goal lifecycle — only automation froze");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"supervisor_pause"'), "the freeze is ledgered");

  // Idempotent repeat does not corrupt anything.
  await pi.command("glla", "pause", ctx);
  await tick();
  assert.ok(ctx.ui.matching("already paused").length >= 1, "repeat pause is honest about it");
  assert.equal(typeof readState(cwd).supervisorPausedAt, "number");

  // A reload (session restart) must NOT silently re-arm: readState keeps it.
  const reloaded = readState(cwd);
  assert.equal(typeof reloaded.supervisorPausedAt, "number", "pause survives a restart-shaped reload");
});

test("v0.35.15: /glla resume clears the freeze, reports the frozen duration, and never lies 'Nothing to resume'", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { supervisorPausedAt: Date.now() - 120_000 } as never);
  const ctx = await freshSession(cwd);

  await pi.command("glla", "resume", ctx);
  await tick();

  assert.ok(ctx.ui.matching("Supervisor RESUMED").length === 1, "the unfreeze is announced with the frozen duration");
  assert.equal(readState(cwd).supervisorPausedAt, undefined, "the flag is cleared on disk");
  const misleading = ctx.ui.matching("Nothing to resume");
  assert.equal(misleading.length, 0, "clearing ONLY the pause is not 'nothing'");
});

// v0.38.104: the working-card tool argument is provider/child-controlled text
// (file_path/path/command/pattern/query/url/title). The length cut was UTF-16
// (`base.slice(0, 23)`), so a multi-code-unit glyph at index 23 painted a
// broken surrogate into the card for the rest of the turn.
test("v0.38.104: the working-card tool argument is cut cell-aware, never mid-surrogate", () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // Exactly 22 ASCII chars, so the emoji's high surrogate lands on index 22 and
  // the old `slice(0, 23)` emitted half of it.
  const command = `${"x".repeat(22)}🚀 done`;
  const shown = summarizeToolArg("bash", { command })!;
  assert.doesNotMatch(shown, loneSurrogate, "no unpaired surrogate in the card");
  assert.ok(shown.length <= 24, `the card stays one line wide, got ${shown.length}`);

  // A wide glyph is measured in cells, so the cut never overruns the budget.
  const wide = summarizeToolArg("bash", { command: `echo ${"字".repeat(40)}` })!;
  assert.doesNotMatch(wide, loneSurrogate);
  assert.ok([...wide].length <= 24, "the cut respects the cell budget");

  // The pre-existing contract is unchanged: control bytes are stripped, and
  // short values pass through untouched.
  assert.equal(summarizeToolArg("bash", { command: "ls -la" }), "ls -la");
  assert.equal(summarizeToolArg("bash", { command: "printf 'a\nb'" }), "printf 'a b'", "control bytes never break the card layout");
  assert.equal(summarizeToolArg("bash", { command: "" }), undefined);
  assert.equal(summarizeToolArg("read", { file_path: "/a/b/c/deep/file.ts" }), "file.ts", "a path keeps only its basename");
});
