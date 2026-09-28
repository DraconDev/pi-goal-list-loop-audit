// pi-goal-list-loop-audit — v0.38.108
// tests/approved-audit-settles.test.ts
//
// An APPROVAL through the stored-claim detached path must terminate in the
// settlement driver. The v0.38.99 extraction of that driver's body dropped
// the branch's `return`, so a clean approval fell through every remaining
// branch (all gated on error / impossible / disapproved) into the
// residual-failure tail: a false "infrastructure error" warning right after
// the "Goal complete" card, and a durable
// provider_retry_audit_verdict { approved: false } record that contradicted
// the archived verdict. Pinned here end-to-end through a real fake auditor
// worker, plus a source pin next to the settlement driver.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { archivedGoalPath, readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

/** A fake `pi` that answers the detached auditor with an approval. */
function writeApprovingAuditor(cwd: string): string {
  const script = path.join(cwd, "fake-approving-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<evidence>\\nREADME.md line 1\\n</evidence>\\n<approved/>" } });
  emit({ type: "agent_settled" });
  process.exit(0);
});
`);
  fs.chmodSync(script, 0o700);
  return script;
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const RECAP = "Outcome: shipped the parser. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.";

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const previous = process.env.GLLA_PI_BINARY;
  if (previous === undefined) delete process.env.GLLA_PI_BINARY;
  else process.env.GLLA_PI_BINARY = previous;
});

test("an approved stored claim settles and never falls into the residual-failure tail", async () => {
  const cwd = tmpCwd();
  const goal = seedGoal({
    status: "paused",
    objective: "approved work whose re-drive returns an approval",
    completionSummary: RECAP,
    auditHistory: [],
    pendingCompletion: {
      at: ago(120_000),
      phase: "recovery-pending",
      startedAt: ago(120_000),
      lastActivityAt: ago(90_000),
      attemptId: "approval-attempt",
      completionSummary: RECAP,
      verificationSummary: "evidence for the parser",
    },
    pauseKind: "blocked",
    pauseReason: "seeded stored claim awaiting its verdict",
  } as any);
  seedState(cwd, { goal });
  const goalId = (goal as { id: string }).id;

  process.env.GLLA_PI_BINARY = writeApprovingAuditor(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx: MockCtx = makeMockCtx(cwd, { sessionManager: { name: `approval-settles-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  try {
    await pi.runTool("resume_goal", { reason: "re-drive the stored claim" }, ctx);
    await waitUntil(() => fs.existsSync(archivedGoalPath(cwd, goalId)), "the approval to archive the goal");

    const types = ledgerTypes(cwd);
    assert.ok(types.includes("audit_settlement_completed"), "the settlement driver reports completion");
    assert.ok(
      !types.includes("provider_retry_audit_verdict"),
      `an approval writes no residual-failure verdict record (types=${JSON.stringify(types.filter((t) => t.includes("verdict") || t.includes("settlement")))})`,
    );
    const notices = ctx.ui.notifies.map((entry) => `${entry.type ?? ""} ${entry.message}`).join("\n");
    assert.doesNotMatch(notices, /infrastructure error/i, "an approved audit never warns about an infrastructure error");
    assert.equal(readState(cwd).goal, null, "the archive is terminal — the goal is gone, not revived");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("v0.38.108: the approval branch terminates after the settlement driver", () => {
  const SRC = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.match(
    SRC,
    /settleApprovedCompletion\(liveCtx, \{[\s\S]*?inspectionSessionPath,\n\s*\}\);\n\s*return;\n\s*\}/,
    "the approved branch returns — the residual-failure tail below is for verdicts that actually failed",
  );
});
