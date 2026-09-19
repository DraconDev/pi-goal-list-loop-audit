// pi-goal-list-loop-audit — per-repo pitfall registry consulted at goal start.
//
// Antigravity port (survey 2026-09-19, 09-04 borrow candidate #1):
// an answer-agnostic pitfall registry per repo (`.pi-glla/pitfalls.md`),
// consulted at goal start — the ledger is forensics, never distilled. Pins:
//   1. Absent registry → no prompt section (absent stays absent).
//   2. Present registry → its contents ride the continuation prompt under a
//      REPO PITFALLS header, bounded.
//   3. Long registries are capped, never injected unbounded.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  continuationPrompt,
  readPitfallsBrief,
} from "../extensions/goal-continuation.js";
import type { Goal } from "../extensions/goal-loop-core.js";

function cleanGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260919000000-pitfall01",
    objective: "Do the thing without tripping known rakes",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    auditHistory: [],
    ...overrides,
  } as Goal;
}

function pitfallsCwd(body: string | undefined): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-pitfalls-"));
  if (body !== undefined) {
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-glla", "pitfalls.md"), body);
  }
  return cwd;
}

test("pitfall registry: absent file reads as absent", () => {
  assert.equal(readPitfallsBrief(pitfallsCwd(undefined)), undefined);
  assert.equal(readPitfallsBrief(pitfallsCwd("")), undefined, "empty registry is absent");
  assert.equal(readPitfallsBrief(pitfallsCwd("   \n  ")), undefined, "blank registry is absent");
});

test("pitfall registry: present file is returned bounded", () => {
  const body = "- Never run the suite from inside the suite.\n- Git discipline: never touch identity or branches.\n";
  assert.equal(readPitfallsBrief(pitfallsCwd(body)), body.trim());
  const long = `# Pitfalls\n\n${"- rake: do not step on it.\n".repeat(200)}`;
  const brief = readPitfallsBrief(pitfallsCwd(long))!;
  assert.ok(brief.length <= 1500, `registry capped (got ${brief.length})`);
});

test("pitfall registry: brief rides the continuation prompt", () => {
  const brief = "- Never run the suite from inside the suite.";
  const full = continuationPrompt(cleanGoal(), { pitfallsBrief: brief });
  assert.match(full, /REPO PITFALLS/, "registry rides under its own header");
  assert.match(full, /Never run the suite from inside the suite/, "registry body is consulted");
});

test("pitfall registry: no brief means no section", () => {
  const full = continuationPrompt(cleanGoal(), { pitfallsBrief: undefined });
  // The repo under test carries no .pi-glla/pitfalls.md, so the cwd
  // fallback resolves absent and the prompt stays clean.
  assert.doesNotMatch(full, /REPO PITFALLS/);
});
