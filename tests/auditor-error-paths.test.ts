import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression guard for the v0.11.1 audit critical: infrastructure failures
// (exceptions, missing model, aborts) must return disapproved:false so the
// three-way split routes them to the infra path, not the disapproval branch.
//
// v0.34.108: the in-process runGoalCompletionAuditor (goal-loop-auditor.ts)
// was dead code and removed. These pins moved to the production path
// (goal-loop-auditor-process.ts + scripts/goal-auditor-worker.mjs), which
// owns all verdict construction today.
const SRC = readFileSync(
  path.resolve(__dirname, "../extensions/goal-loop-auditor-process.ts"),
  "utf-8",
);

function infraBody(): string {
  const idx = SRC.indexOf("function infra(");
  assert.ok(idx > 0, "infra helper exists");
  return SRC.slice(idx, SRC.indexOf("function stampToken"));
}

test("catch block never returns disapproved: true", () => {
  // The worker's run loop catches RPC/session exceptions and converts them
  // through infra() — never a disapproval.
  const catchIdx = SRC.lastIndexOf("} catch (error)");
  assert.ok(catchIdx > 0, "production auditor has a catch block");
  const catchBody = SRC.slice(catchIdx);
  assert.ok(!/disapproved:\s*true/.test(catchBody), "catch must not mark disapproved");
  assert.ok(catchBody.includes("infra("), "catch routes through the infra helper");
});

test("infra-flavored returns (no model / aborted) are not disapprovals", () => {
  for (const marker of ["no auditor model", "Auditor aborted."]) {
    const idx = SRC.indexOf(marker);
    assert.ok(idx > 0, `found: ${marker}`);
    // the return expression containing this marker is an infra() call —
    // disapproved:false by construction, never a verdict.
    const window = SRC.slice(Math.max(0, idx - 300), idx);
    assert.ok(window.includes("return infra("), `'${marker}' returns via infra()`);
  }
  // The infra() helper itself is disapproved:false by construction.
  assert.match(infraBody(), /disapproved:\s*false/);
  assert.match(infraBody(), /approved:\s*false/);
  assert.match(infraBody(), /error:/);
  assert.match(infraBody(), /infrastructureClass/);
  assert.match(SRC, /"no-verdict"/);
  assert.match(SRC, /"transport"/);
  assert.match(SRC, /failedResultClass/);
});

test("auditor watchdog exits are infrastructure failures, never verdicts", () => {
  // Confirmed-silence and per-tool watchdogs remain infrastructure outcomes;
  // elapsed time alone must not terminate an auditor with real progress.
  assert.match(SRC, /event-derived/);
  assert.match(SRC, /lifecycle cancellation/);
  assert.doesNotMatch(SRC, /return infra\([^\n]+wall-clock bound/);
  assert.match(SRC, /GLLA_AUDITOR_STALL_MS/, "worker stall brake env var honored");
  const worker = readFileSync(
    path.resolve(__dirname, "../scripts/goal-auditor-worker.mjs"),
    "utf-8",
  );
  assert.match(worker, /no wall-clock lifetime timer/);
  const stallIdx = worker.indexOf("Auditor stalled");
  assert.ok(stallIdx >= 0, "worker stall watchdog branch exists");
  assert.match(worker.slice(stallIdx, stallIdx + 300), /aborted|no session activity/i);
});

test("semantic verdict-quality failures and shield blocks keep distinct categories", () => {
  assert.match(SRC, /treated as disapproved\./, "approval without evidence tools is a semantic disapproval");
  const shield = SRC.slice(SRC.indexOf("if (!shield.passed)"), SRC.indexOf("progress.phase = \"complete\"", SRC.indexOf("if (!shield.passed)")));
  assert.match(shield, /approved:\s*false/);
  assert.match(shield, /disapproved:\s*false/);
  assert.match(shield, /regressionShieldPassed:\s*false/);
  assert.doesNotMatch(shield, /error:/, "a shield block is not infrastructure failure");
});
