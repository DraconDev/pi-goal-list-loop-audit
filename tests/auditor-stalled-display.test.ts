// pi-goal-list-loop-audit — v0.39.22 stalled-audit presentation.
//
// Field 2026-10-10: the dracon-platform/seo goal sat in `auditing` for 15
// days on a dead worker while the card read "quiet · detached worker" with
// `/goal cancel` as the only next action — a live-vs-dead state the UI
// could not tell apart. Past the death bound with no worker activity and
// no in-budget tool, quiet escalates to stalled: the card names the death,
// the live-worker claim is dropped, and the retry (/goal resume) becomes
// the next action. The quiet watcher fires its own one-shot stall notice.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import activate from "../extensions/loops/goal.js";
import {
  AUDITOR_STALLED_MS,
  auditorDisplayPhase,
  buildStatusText,
  buildWidgetLines,
  type AuditDisplayProgress,
} from "../extensions/goal-loop-display.ts";
import {
  __testOnlyAuditorQuietWatchTick,
  __testOnlyLoadState,
  __testOnlyResetAuditorQuietWatch,
} from "../extensions/loops/goal-ui.js";
import { tmpCwd, seedState } from "./harness/mock-pi.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const QUIET_MS = 3 * 60_000;

activate((globalThis as Record<string, unknown>).__pi as never ?? (await import("./harness/mock-pi.js").then(() => undefined) as never));

function auditingGoal(): Record<string, unknown> {
  return {
    id: "20261010120000-audit1",
    objective: "stalled-audit objective — done when pinned",
    status: "auditing",
    policy: "goal",
    autoContinue: true,
    createdAt: new Date(NOW - 3600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    pendingCompletion: { phase: "running", attemptId: "audit-stalled", startedAt: new Date(NOW - 120_000).toISOString(), completionSummary: "s", verificationSummary: "v", retryAttempts: 0 },
  };
}

function auditProgress(overrides: Partial<AuditDisplayProgress> = {}): AuditDisplayProgress {
  return {
    phase: "thinking",
    elapsedMs: 120_000,
    lastActivityAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  __testOnlyResetAuditorQuietWatch();
});

// ---- phase boundaries ----

test("stalled: silence past the death bound escalates quiet to stalled, before it stays quiet", () => {
  const g = auditingGoal() as never;
  assert.equal(auditorDisplayPhase(g, auditProgress({ lastActivityAt: NOW - 59 * 60_000 }), NOW), "quiet");
  assert.equal(auditorDisplayPhase(g, auditProgress({ lastActivityAt: NOW - 61 * 60_000 }), NOW), "stalled");
  // The seo shape: 15 days of silence is stalled, not quiet.
  assert.equal(auditorDisplayPhase(g, auditProgress({ lastActivityAt: NOW - 15 * 24 * 60 * 60_000 }), NOW), "stalled");
  assert.equal(AUDITOR_STALLED_MS, 60 * 60_000, "death bound pinned at one hour");
});

test("stalled: an in-budget tool exempts a long silent run from both quiet and stalled", () => {
  const g = auditingGoal() as never;
  const audit = auditProgress({
    phase: "tool_executing",
    currentTool: "read",
    currentToolStartedAt: NOW - 61 * 60_000,
    toolTimeoutMs: 120 * 60_000,
    lastActivityAt: NOW - 61 * 60_000,
  });
  assert.equal(auditorDisplayPhase(g, audit, NOW), "running");
});

// ---- card + footer ----

test("stalled: card names the death, drops the live-worker claim, offers the retry", () => {
  const g = auditingGoal() as never;
  const audit = auditProgress({ lastActivityAt: NOW - 61 * 60_000 });
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW, undefined, 120)!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /auditor: stalled · no worker responds · last progress 1h 01m/, `stalled lead:\n${text}`);
  assert.doesNotMatch(lines[1]!, /detached worker/, "no live worker is claimed");
  assert.match(lines[3]!, /next: \/goal resume retries the claim/, "stalled next action names the retry, not the discard");
  assert.match(text, /auditor stalled 1h 01m — no worker activity/, "closer keeps the stalled wording");
  const footer = buildStatusText({ goal: g, list: [] }, audit, NOW)!;
  assert.match(footer, /auditor ✖ stalled/, "footer names the same stalled phase");
});

test("stalled: the seo shape reads in days and never claims a worker", () => {
  const g = auditingGoal() as never;
  const audit = auditProgress({ lastActivityAt: NOW - 15 * 24 * 60 * 60_000 });
  const lines = buildWidgetLines({ goal: g, list: [] }, audit, NOW, undefined, 120)!;
  const text = lines.join("\n");
  assert.match(lines[1]!, /last progress 15d 00h/, `day granularity past 24h:\n${text}`);
  assert.doesNotMatch(text, /detached worker/, "a 15-day-dead audit claims no worker anywhere");
});

// ---- watcher ----

test("stalled: watcher fires its own one-shot stall notice past the death bound", () => {
  __testOnlyResetAuditorQuietWatch();
  const cwd = tmpCwd();
  seedState(cwd, { goal: auditingGoal() });
  __testOnlyLoadState(cwd);
  const t0 = NOW;
  const progress = auditProgress({ lastActivityAt: t0 });
  const quietWarning = __testOnlyAuditorQuietWatchTick(progress, t0 + QUIET_MS + 5_000);
  assert.ok(quietWarning?.includes("NO worker activity"), "quiet crossing still warns first");
  const stallWarning = __testOnlyAuditorQuietWatchTick(progress, t0 + AUDITOR_STALLED_MS + 5_000);
  assert.ok(stallWarning?.includes("STALLED"), "death-bound crossing fires the stall notice");
  assert.ok(stallWarning!.includes("/goal resume"), "stall notice names the retry");
  assert.equal(__testOnlyAuditorQuietWatchTick(progress, t0 + AUDITOR_STALLED_MS + 65_000), null, "no repeat");
});
