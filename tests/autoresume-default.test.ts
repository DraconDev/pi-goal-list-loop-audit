// pi-goal-list-loop-audit — v0.26.9
// tests/autoresume-default.test.ts
//
// "Don't auto-start on session LOAD; continue forever DURING the session
// unless big stuck." The restore gate is a tri-state: on = always
// auto-resume (unattended rigs), off = never, default (undefined) = hold
// when a human loads a session, auto-resume on in-session machinery
// (reload/fork). Mid-session continuation is not gated at all.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();

test("/glla settings persists explicit auto-resume off (tri-state, not undefined)", () => {
  assert.match(SRC, /saveSettings\("global", ctx, \{ autoResume: v\.startsWith\("on"\) \? true : v\.startsWith\("off"\) \? false : undefined \}\)/);
  assert.doesNotMatch(SRC, /\/glla autoresume=/);
});

test("settings table shows the tri-state honestly", () => {
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /valueText: show\("autoResume", "default"\)/);
  assert.match(MENU, /default: hold on a fresh load, rebind on reload\/fork/);
  assert.match(SRC, /default — hold on load, rebind on reload\/fork/);
});

test("hold-on-load text offers the explicit resume + the on opt-in", () => {
  assert.match(SRC, /restored on session load — held for explicit resume/);
  assert.match(SRC, /enable Auto-resume in \/glla settings/);
});
