// pi-goal-list-loop-audit — v0.25.3
// tests/list-philosophy.test.ts
//
// List-philosophy rework contract items 1-8: long-running framing in all
// three draft prompts, /list depth, cross-recommend, LIST-PHILOSOPHY.md.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  computeListDepth,
  crossRecommendMode,
  formatListDepth,
} from "../extensions/goal-loop-core.ts";

// Tests run from the repo root (house pattern: cwd-relative paths).
const read = (rel: string) => fs.readFileSync(rel, "utf-8");

test("contract 1+2: /goal+/list draft prompt has short-item AND multi-hour framing", () => {
  const draft = read("prompts/goal-loop-draft.md");
  // Short-item framing (item 1 grep: minutes|short|single agent run|break.*up):
  assert.match(draft, /short/i);
  assert.match(draft, /minutes/i);
  assert.match(draft, /single agent run/i);
  assert.match(draft, /break.*up/i);
  // Multi-hour / scope framing (item 2):
  assert.match(draft, /multi-hour/i);
  assert.match(draft, /scope/i);
  assert.match(draft, /spans multiple agent runs/i);
  // Old wrong framing is gone:
  assert.doesNotMatch(draft, /10 things/i);
  assert.doesNotMatch(draft, /checklist of 50/i);
});

test("contract 3: /loop draft prompt has metric-driven framing", () => {
  const loop = read("prompts/goal-loop-forever-draft.md");
  assert.match(loop, /metric-driven/i);
  assert.match(loop, /infinite.polish/i);
  assert.match(loop, /plateau/i);
});

test("contract 4: all draft prompts open with a Long-running philosophy block", () => {
  for (const f of ["prompts/goal-loop-draft.md", "prompts/goal-loop-forever-draft.md"]) {
    const content = read(f);
    const firstHeading = content.indexOf("# Long-running philosophy");
    assert.ok(firstHeading >= 0, `${f} missing the block`);
    assert.ok(firstHeading < 200, `${f}: block must be at the top`);
  }
});

test("contract 5: LIST-PHILOSOPHY.md exists with the three-mode table", () => {
  const doc = read("LIST-PHILOSOPHY.md");
  assert.match(doc, /\| `\/goal` \| ONE big multi-hour task \|/);
  assert.match(doc, /\| `\/list` \| N items × short \(minutes each\) \|/);
  assert.match(doc, /\| `\/loop` \| 1 metric × infinite polish \|/);
  assert.match(doc, /Queue depth/i);
});

test("contract 6: INSTALL.md references LIST-PHILOSOPHY.md in a Modes section", () => {
  const install = read("INSTALL.md");
  assert.match(install, /## Modes/);
  assert.match(install, /LIST-PHILOSOPHY\.md/);
});

test("contract 7: /list depth headline format", () => {
  const queue = [
    { id: "a1", addedAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
    { id: "a2", addedAt: new Date(Date.now() - 26 * 3600_000).toISOString() },
  ];
  const entries = [
    { type: "state", value: { goal: { id: "g1", policy: "list", status: "complete", createdAt: "2026-07-20T10:00:00Z", updatedAt: "2026-07-20T10:07:00Z" } } },
    { type: "state", value: { goal: { id: "g2", policy: "list", status: "complete", createdAt: "2026-07-21T10:00:00Z", updatedAt: "2026-07-21T10:13:00Z" } } },
    { type: "state", value: { goal: { id: "g3", policy: "goal", status: "complete", createdAt: "2026-07-21T10:00:00Z", updatedAt: "2026-07-21T14:00:00Z" } } },
  ];
  const stats = computeListDepth(queue, entries, Date.now());
  assert.equal(stats.queueDepth, 2);
  assert.equal(stats.oldestItemId, "a2");
  // avg of 7m + 13m (goal-policy excluded) = 10m
  assert.equal(stats.avgDurationMs, 10 * 60_000);
  const out = formatListDepth(stats);
  assert.match(out.split("\n")[0]!, /^queue depth: 2 · oldest: 1d 2h · avg duration: 10m$/);
  assert.match(out, /oldest item: 1d 2h \(id a2\)/);
  assert.match(out, /avg item duration: 10m \(from last 2 archived\)/);
  // Empty state:
  const empty = formatListDepth(computeListDepth([], [], Date.now()));
  assert.match(empty.split("\n")[0]!, /^queue depth: 0 · oldest: — · avg duration: —$/);
});

test("contract 8+11: cross-recommend catches the 76-weak-points wrapper seed", () => {
  // The junk-runner 929gn9 seed — must steer to N short items, not a wrapper:
  const seed929 = "Close every weak point in docs/per-screen-weak-points-2026-07-24.md (76 items: 33 P1, 29 P2, 14 P3 across all 29 screens). Each weak point = one commit.";
  const xr = crossRecommendMode(seed929, "list");
  assert.ok(xr, "aggregate seed must trigger a recommendation");
  assert.match(xr!, /76 discrete items/);
  assert.match(xr!, /items\[\]/);
  assert.match(xr!, /wrapper/);
  assert.match(xr!, /per-item contract/);
});

test("contract 12: cross-recommend catches the 40-findings tasklist seed", () => {
  const seed40 = "land all 40 findings from docs/AUDIT_2026-07-24.md as a tasklist, ordered by ROI";
  const xr = crossRecommendMode(seed40, "list");
  assert.ok(xr);
  assert.match(xr!, /40 discrete items/);
  assert.match(xr!, /tasklist/i);
});

test("contract 8: multi-hour seed in /list mode suggests /goal or break-up", () => {
  const xr = crossRecommendMode("audit all 22 settings screens deeply — this will take several hours", "list");
  assert.ok(xr);
  assert.match(xr!, /multi-hour/i);
  assert.match(xr!, /\/goal/);
  // And in goal mode the same seed is fine:
  assert.equal(crossRecommendMode("audit all 22 settings screens deeply — this will take several hours", "goal"), undefined);
});

test("contract 8: five-minute seed in /goal mode suggests /list", () => {
  const xr = crossRecommendMode("fix typo in README", "goal");
  assert.ok(xr);
  assert.match(xr!, /five-minute/i);
  assert.match(xr!, /\/list/);
  // Fitting seeds produce no recommendation:
  assert.equal(crossRecommendMode("reduce npm test failures from 14 to 0", "goal"), undefined);
  assert.equal(crossRecommendMode("fix typo in README", "list"), undefined);
});

test("contract 8: open-ended seed in /goal or /list mode suggests /loop", () => {
  for (const [seed, mode] of [
    ["watch the error rate and keep it under 1%", "goal"],
    ["check the queue depth every morning and report", "list"],
    ["monitor nightly backup sizes until further notice", "goal"],
    ["keep the build at zero failures", "list"],
  ] as Array<[string, "goal" | "list"]>) {
    const xr = crossRecommendMode(seed, mode);
    assert.ok(xr, `${mode} seed must trigger a recommendation: ${seed}`);
    assert.match(xr!, /open-ended\/recurring/i, seed);
    assert.match(xr!, /\/loop/, seed);
  }
});

test("contract 8: bounded-until beats recurring vocabulary (still a goal)", () => {
  assert.equal(crossRecommendMode("keep at the refactor until done", "goal"), undefined);
  assert.equal(crossRecommendMode("watch the suite until green, then stop", "goal"), undefined);
});

test("contract 8: aggregate beats recurring (per-item work wins)", () => {
  const xr = crossRecommendMode("check all 50 screens every hour", "list");
  assert.ok(xr);
  assert.match(xr!, /50 discrete items/, "aggregate fires first");
  assert.doesNotMatch(xr!, /\/loop/, "no loop advice on an aggregate seed");
});

test("contract 8: recurring beats five-minute (cadence changes the loop)", () => {
  const xr = crossRecommendMode("fix typo every day", "goal");
  assert.ok(xr, "the five-minute check already excludes recurring words; the loop check catches it");
  assert.match(xr!, /\/loop/);
});
