// v0.38.6 (starvation ladder): compact-first nudge, over-cap ladder message,
// send-choke refuse, sticky refuse while physically over cap.
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalAutoResume(enabled: boolean): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(enabled ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

import {
  buildStarvationLadderMessage,
  COMPACT_FIRST_NUDGE_PERCENT,
  COMPACT_FIRST_RESET_PERCENT,
  noteContextPercent,
  shouldCompactFirstNudge,
} from "../extensions/loops/goal-ui.js";
import { LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT } from "../extensions/length-continue.js";
import activate, { __testOnlyResetOwnerSession, __testOnlySetLastCompactionAt } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

const G = globalThis as any;

function cleanupStarvationGlobals(): void {
  // Leave no streak/percent/latch behind: later files share this worker.
  if (typeof G.onCompactionLanded === "function") G.onCompactionLanded();
  noteContextPercent(null);
  shouldCompactFirstNudge(0);
  __testOnlySetLastCompactionAt(null);
}

afterEach(() => { cleanupStarvationGlobals(); setGlobalAutoResume(false); });

test("compact-first band sits below the starvation line", () => {
  assert.ok(COMPACT_FIRST_NUDGE_PERCENT < LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT);
  assert.equal(COMPACT_FIRST_NUDGE_PERCENT, 85);
  assert.equal(LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT, 90);
  assert.ok(COMPACT_FIRST_RESET_PERCENT < COMPACT_FIRST_NUDGE_PERCENT);
});

test("ladder message names all three recoveries plus the backstop", () => {
  const msg = buildStarvationLadderMessage({ percent: 124.5, streak: 3 });
  assert.match(msg, /124\.5%/);
  assert.match(msg, /\/compact again/);
  assert.match(msg, /larger-context model/);
  assert.match(msg, /\/new, then \/goal resume/);
  assert.match(msg, /durable on disk/);
  assert.match(msg, /no summarization needed/);
  assert.match(msg, /stay parked/);
  const noPct = buildStarvationLadderMessage({});
  assert.match(noPct, /nearly full/);
});

test("compact-first nudge fires once per episode", () => {
  assert.equal(shouldCompactFirstNudge(86), true);
  assert.equal(shouldCompactFirstNudge(87), false, "same episode stays quiet");
  assert.equal(shouldCompactFirstNudge(79), false, "below reset clears the latch");
  assert.equal(shouldCompactFirstNudge(86), true, "new episode re-arms");
  assert.equal(shouldCompactFirstNudge(null), false);
  assert.equal(shouldCompactFirstNudge(NaN), false);
  G.onCompactionLanded();
  assert.equal(shouldCompactFirstNudge(86), true, "real compaction re-arms");
});

test("refuse stays sticky while physically over cap", () => {
  assert.equal(typeof G.noteContextStarvedYield, "function");
  assert.equal(typeof G.isContextStarvedRefused, "function");
  __testOnlySetLastCompactionAt(null);
  G.noteContextStarvedYield();
  G.noteContextStarvedYield();
  assert.equal(G.isContextStarvedRefused(), true, "fresh streak refuses");
  // Age the streak past the 90s recency window with no new percent reading.
  noteContextPercent(null);
  G.lastContextStarvedAt = Date.now() - 600_000;
  assert.equal(G.isContextStarvedRefused(), false, "stale streak without readings lapses");
  // Same aged streak, but the last-known reading is still over cap: stuck.
  G.noteContextStarvedYield();
  G.noteContextStarvedYield();
  G.lastContextStarvedAt = Date.now() - 600_000;
  noteContextPercent(243.6);
  assert.equal(G.isContextStarvedRefused(), true, "over-cap reading keeps the refuse");
  // A real compaction clears everything even while the reading is hot.
  G.onCompactionLanded();
  assert.equal(G.isContextStarvedRefused(), false);
});

test("sendContinuation consults the starvation choke point", () => {
  const src = fs.readFileSync(new URL("../extensions/goal-continuation.ts", import.meta.url), "utf-8");
  const send = src.slice(src.indexOf("export function sendContinuation"));
  assert.match(send, /if \(isContextStarvedRefused\(\)\) \{/);
  assert.match(send, /continuation_send_refused_context_starved/);
});

function cleanGoal(): Goal {
  return {
    id: "20260903000000-starve01",
    objective: "Implement the starvation ladder",
    verificationContract: "Done when over-cap stops spinning",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    taskList: { tasks: [{ id: "t1", title: "Do the thing", status: "pending" }] },
    auditHistory: [],
  } as unknown as Goal;
}

test("starved boot refuses the automatic send instead of truncating", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  __testOnlySetLastCompactionAt(null);
  G.noteContextStarvedYield();
  G.noteContextStarvedYield();
  assert.equal(G.isContextStarvedRefused(), true);
  seedState(cwd, { goal: cleanGoal(), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `starve-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8");
  assert.match(ledger, /"continuation_send_refused_context_starved"/, "auto send refused while starved");
  const goalSends = pi.sent.filter((s) => String(s.message.customType ?? "").includes("goal"));
  assert.equal(goalSends.length, 0, "no goal turn queued into the full context");
  assert.equal(readState(cwd).goal?.status, "active", "refusal parks the turn, not the goal");
});
