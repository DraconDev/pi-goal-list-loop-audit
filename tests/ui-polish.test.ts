// pi-goal-list-loop-audit — v0.38.89
// tests/ui-polish.test.ts
//
// UI polish finale: /glla stats names its usage on unknown args (instead
// of silently rendering the default view), the stats header carries the
// same /glla prefix as the stats error paths, and the /goal status card
// points at its slow twin (/goal timeline).

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, { __testOnlyResetOwnerSession, __testOnlyLoadState } from "../extensions/loops/goal.js";
import { unknownStatsArg } from "../extensions/goal-commands.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

afterEach(() => {
  __testOnlyResetOwnerSession();
});

test("v0.38.89: unknownStatsArg strips the known stats tokens", () => {
  assert.equal(unknownStatsArg(""), null);
  assert.equal(unknownStatsArg("outcomes"), null);
  assert.equal(unknownStatsArg("challenges json"), null);
  assert.equal(unknownStatsArg("premature project=~/work outcomes"), null);
  assert.equal(unknownStatsArg("  json  "), null);
  assert.equal(unknownStatsArg("frobnicate"), "frobnicate");
  assert.equal(unknownStatsArg("chalenges"), "chalenges");
  assert.equal(unknownStatsArg("outcomes frobnicate"), "frobnicate");
  assert.equal(unknownStatsArg("outcomesx"), "outcomesx");
  assert.equal(unknownStatsArg("project="), "project=");
});

test("v0.38.89: stats header and unknown-arg usage share the /glla prefix", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(src, /ctx\.ui\.notify\(`\/glla stats\$\{view/);
  assert.match(src, /Unknown \/glla stats argument/);
  assert.doesNotMatch(src, /notify\(`glla stats\$\{view/);
});

test("v0.38.91: tool descriptions enumerate plan/audit/verify/add", () => {
  const src = fs.readFileSync("extensions/loops/goal-activation.ts", "utf-8");
  assert.match(src, /\/goal status\|timeline\|pause\|resume\|cancel\|tweak <text>\|archive\|start\|plan\|audit\|verify/);
  assert.match(src, /\/list plan \| \/list add <text>/);
});

test("v0.38.89: /goal status card points at /goal timeline", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "status card polish — done when pinned" }) });
  __testOnlyLoadState(cwd);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "ui-polish-status" } });
  await pi.command("goal", "status", ctx);
  const card = ctx.ui.notifies.map((n) => n.message).join("\n");
  assert.ok(card.includes("status card polish"), "the card renders the live goal");
  assert.ok(card.includes("Trail: /goal timeline"), "the card points at the timeline");
});
