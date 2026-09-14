// v0.38.7 (session visibility): load-hold recovery banner + durable verdict
// tally on the always-on surfaces (status line, /goal status).
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  auditorVerdictTally,
  buildLoadHoldRecoveryLines,
  buildStatusText,
  buildWidgetLines,
  formatVerdictTallySegment,
} from "../extensions/goal-loop-display.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

const G = globalThis as any;
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalAutoResume(enabled: boolean): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(enabled ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
afterEach(() => setGlobalAutoResume(false));

function verdict(over: Record<string, unknown> = {}): any {
  return { at: "2026-09-03T08:00:00.000Z", approved: false, disapproved: false, model: "m", ...over };
}

test("tally classifies like auditVerdictLabel", () => {
  assert.deepEqual(auditorVerdictTally([]), { total: 0, approvals: 0, disapprovals: 0, lastAt: null, lastLabel: null });
  assert.deepEqual(auditorVerdictTally(undefined), { total: 0, approvals: 0, disapprovals: 0, lastAt: null, lastLabel: null });
  const t = auditorVerdictTally([
    verdict({ approved: true }),
    verdict({ disapproved: true, report: "gap" }),
    verdict({ approved: true, regressionShieldPassed: false }),
    verdict({ error: "boom" }),
  ]);
  assert.equal(t.total, 4);
  assert.equal(t.approvals, 1, "shield-blocked approval is not an approval");
  assert.equal(t.disapprovals, 1, "exactly one disapproval");
  assert.equal(t.lastLabel, "infrastructure failure", "infra error is not a verdict but stays the latest entry");
  assert.equal(t.lastAt, Date.parse("2026-09-03T08:00:00.000Z"));
  const badDate = auditorVerdictTally([verdict({ approved: true, at: "not-a-date" })]);
  assert.equal(badDate.lastAt, null);
  assert.equal(badDate.lastLabel, "approved");
});

test("tally segment stays silent with no verdicts", () => {
  assert.equal(formatVerdictTallySegment({ total: 0, approvals: 0, disapprovals: 0, lastAt: null, lastLabel: null }, 1_000), "");
  const now = Date.parse("2026-09-03T10:00:00.000Z");
  const seg = formatVerdictTallySegment({
    total: 3, approvals: 1, disapprovals: 1,
    lastAt: Date.parse("2026-09-03T08:00:00.000Z"), lastLabel: "disapproved",
  }, now);
  assert.match(seg, /3 verdicts/);
  assert.match(seg, /1 disapproved/);
  assert.match(seg, /last disapproved 2h/);
});

test("recovery banner pins objective, next task, audits, resume", () => {
  const now = Date.parse("2026-09-03T10:00:00.000Z");
  const lines = buildLoadHoldRecoveryLines({
    objective: "Implement the thing",
    status: "paused",
    nextTask: "Do the first task",
    tally: { total: 2, approvals: 0, disapprovals: 2, lastAt: Date.parse("2026-09-03T08:00:00.000Z"), lastLabel: "disapproved" },
    resumeCommand: "/goal resume",
  }, now);
  const text = lines.join("\n");
  assert.match(text, /recovered from disk/);
  assert.match(text, /Implement the thing/);
  assert.match(text, /next: Do the first task/);
  assert.match(text, /2 disapproved/);
  assert.match(text, /run \/goal resume to continue/);
  const empty = buildLoadHoldRecoveryLines({
    objective: null, status: "held", nextTask: null,
    tally: { total: 0, approvals: 0, disapprovals: 0, lastAt: null, lastLabel: null },
    resumeCommand: "/list resume", listWaiting: 4,
  }, now);
  const emptyText = empty.join("\n");
  assert.match(emptyText, /no objective recorded/);
  assert.match(emptyText, /no pending tasks recorded/);
  assert.match(emptyText, /audits: none yet/);
  assert.match(emptyText, /4 waiting/);
});

test("v0.38.55: auditing status line is liveness-only — the tally lives on the card (Screenshot 20260914)", () => {
  const now = Date.parse("2026-09-03T10:00:00.000Z");
  const g = {
    id: "g1", objective: "o", status: "auditing", policy: "goal",
    pendingCompletion: { phase: "running" },
    auditHistory: [
      verdict({ approved: true, at: "2026-09-03T06:00:00.000Z" }),
      verdict({ disapproved: true, report: "gap", at: "2026-09-03T08:00:00.000Z" }),
    ],
  } as unknown as Goal;
  const text = buildStatusText({ goal: g, list: [], loop: null } as any, null, now);
  assert.ok(text);
  assert.doesNotMatch(text!, /disapproved|verdicts/, "footer repeats no card fact");
  assert.match(text!, /MAIN HOST · SUPERVISING/, "host + liveness stay");
  const card = buildWidgetLines({ goal: g, list: [], loop: null } as any, null, now)!.join("\n");
  assert.match(card, /audits:.*1 disapproved/, "the card owns the tally");
  assert.match(card, /last disapproved 2h/);
});

function heldGoal(): Goal {
  return {
    id: "20260903000000-vis01",
    objective: "Recover me after reload",
    verificationContract: "banner paints",
    status: "paused",
    policy: "goal",
    autoContinue: false,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    taskList: { tasks: [
      { id: "t0", title: "Finished task", status: "complete" },
      { id: "t1", title: "First pending task", status: "pending" },
    ] },
    auditHistory: [
      { at: "2026-09-03T06:00:00.000Z", approved: false, disapproved: true, model: "m", report: "gap" },
    ],
    pauseKind: "blocked",
    pauseReason: "restored on session load — held for explicit resume",
  } as unknown as Goal;
}

test("reload with a held goal paints the recovery banner from disk", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(false);
  seedState(cwd, { goal: heldGoal(), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `vis-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  const banner = ctx.ui.matching("recovered from disk");
  assert.equal(banner.length, 1, "exactly one banner per fresh hold");
  const text = banner[0]?.message ?? "";
  assert.match(text, /Recover me after reload/);
  assert.match(text, /next: First pending task/, "skips the completed task");
  assert.match(text, /1 disapproved/);
  assert.match(text, /run \/goal resume to continue/);
  const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8");
  assert.match(ledger, /"load_hold_recovery_banner"/);
  assert.match(ledger, /"pendingTasks":1/);
});

test("future verdict timestamp suppresses the age instead of printing 0s ago", () => {
  // v0.38.45 audit: clock skew read as \"last approved 0s ago\" via the
  // fmtElapsed clamp; now the tally drops the age like lastActivity does.
  const future = auditorVerdictTally(
    [verdict({ approved: true, at: new Date(Date.now() + 3_600_000).toISOString() })],
    Date.now(),
  );
  assert.equal(future.lastAt, null, "future lastAt is suppressed");
  const seg = formatVerdictTallySegment({ ...future, lastLabel: "approved" });
  assert.doesNotMatch(seg, /0s ago/, "no confabulated recency");
  assert.match(seg, /1 verdict/, "the count itself survives");
});
