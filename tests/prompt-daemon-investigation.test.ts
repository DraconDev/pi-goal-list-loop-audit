// pi-goal-list-loop-audit — v0.25.0
// tests/prompt-daemon-investigation.test.ts
//
// Eager-continuation contract item 30 (Section H): the continuation prompt
// teaches detached-commit detection — check the auto-committer daemon
// BEFORE self-diagnosing as stuck.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const prompt = fs.readFileSync(
  path.resolve("prompts", "goal-loop-continuation.md"),
  "utf-8",
);

test("continuation prompt has the DETACHED COMMIT DETECTION section (item 30)", () => {
  assert.match(prompt, /DETACHED COMMIT DETECTION/);
  assert.match(prompt, /dracon-sync|auto-committer/i);
  assert.match(prompt, /ps -fea|reflog/);
  assert.match(prompt, /pause the daemon|dracon-sync pause/i);
});

test("daemon guidance includes the filter-branch inspection command", () => {
  assert.match(prompt, /filter-branch\|filter-repo/);
  // v0.39.71: the section is generic — one operator's daemon config keys
  // (`auto_rewrite_large_blobs`) no longer ship to every rig.
  assert.doesNotMatch(prompt, /auto_rewrite_large_blobs|maintainer's rig/);
});
