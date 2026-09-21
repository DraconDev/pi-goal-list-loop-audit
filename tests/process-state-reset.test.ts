// pi-goal-list-loop-audit — v0.38.88
// tests/process-state-reset.test.ts
//
// The __testOnlyResetProcessState composite (loops/goal.ts) is the per-file
// isolation boundary: bun test shares module state across files in one
// process, and the preload (tests/harness/setup.ts) calls the composite
// before EACH file. These tests prove the composite actually clears
// poisoned latches (starvation streak, session-owner claim) and pin its
// membership — every exported __testOnlyReset*/__testOnlyClear* must be
// invoked in the composite body, so a future reset cannot silently bypass
// the per-file boundary.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState } from "./harness/mock-pi.js";

const G = globalThis as any;
const pi = new MockPi();
activate(pi.api);

afterEach(() => {
  // Dogfood the composite: this file leaves no latch state behind either.
  __testOnlyResetProcessState();
});

test("v0.38.88: composite clears a poisoned starvation streak", () => {
  assert.equal(typeof G.noteContextStarvedYield, "function");
  assert.equal(typeof G.isContextStarvedRefused, "function");
  G.noteContextStarvedYield();
  G.noteContextStarvedYield();
  assert.equal(G.isContextStarvedRefused(), true, "poisoned: fresh streak refuses");
  __testOnlyResetProcessState();
  assert.equal(G.isContextStarvedRefused(), false, "composite cleared the streak");
});

test("v0.38.88: composite releases the session-owner claim", async () => {
  assert.equal(typeof G.isForeignCtx, "function");
  const smA = { name: "reset-test-owner" };
  const smB = { name: "reset-test-stranger" };
  const cwd = tmpCwd();
  seedState(cwd, {});
  await pi.fire("session_start", { reason: "startup" }, makeMockCtx(cwd, { sessionManager: smA }));
  const stranger = makeMockCtx(cwd, { sessionManager: smB });
  assert.equal(G.isForeignCtx(stranger), true, "poisoned: stranger is foreign while A holds the claim");
  __testOnlyResetProcessState();
  assert.equal(G.isForeignCtx(stranger), false, "composite released the claim");
});

test("v0.38.88: composite invokes every exported latch reset", () => {
  const goalSrc = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  const body = goalSrc.slice(
    goalSrc.indexOf("export function __testOnlyResetProcessState"),
  );
  assert.ok(body.length > 0, "composite exists");
  const members: string[] = [];
  const roots = ["extensions", "extensions/loops"];
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".ts")) continue;
      const src = fs.readFileSync(path.join(root, name), "utf-8");
      for (const match of src.matchAll(/export (?:async )?function (__testOnly(?:Reset|Clear)[A-Za-z]*)/g)) {
        members.push(match[1]!);
      }
    }
  }
  const expected = [...new Set(members)].filter((m) => m !== "__testOnlyResetProcessState");
  assert.ok(expected.length >= 17, `expected >=17 member resets, got ${expected.length}`);
  for (const name of expected) {
    assert.ok(body.includes(`${name}()`), `${name} is invoked by the composite`);
  }
});
