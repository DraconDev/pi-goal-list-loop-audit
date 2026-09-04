// pi-goal-list-loop-audit — v0.38.21
// tests/objection-pinning.test.ts
//
// Objection-attached retries: a new disapproval retires older live rounds
// (settled context, not live objections) and a clean approval clears the
// pin. The continuation prompt argues the latest LIVE disapproval and names
// the settled rounds so the retry does not relitigate them.
//
// NOTE (honest scope): the full-report surfacing itself shipped in v0.35.x
// (`## LATEST AUDITOR`); this slice adds the missing round scoping. The
// fail-before run below pins the new behavior against the old code.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState, appendAuditVerdict, liveDisapproval, type AuditVerdict } from "../extensions/goal-loop-core.js";
import { continuationPrompt } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
afterEach(() => setGlobalAutoResume(false));

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return ctx;
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for detached-auditor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function writeFakeAuditor(cwd: string, report: string): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = ${JSON.stringify(report)};
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
`);
  fs.chmodSync(script, 0o700);
  return script;
}

const R1 = "## Required fixes\n- R1-UNIQUE-GAP: the pinned widget clips titles\n<disapproved/>";
const R2 = "## Required fixes\n- R2-UNIQUE-GAP: the pinned retry drops evidence\n<disapproved/>";

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
});

test("v0.38.21 two disapproval rounds: R1 retired with its objections attached, prompt argues R2 only", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const previousBinary = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R1);
  let ctx: MockCtx | null = null;
  try {
    ctx = await freshSession(cwd);
    await pi.command("goal", "start objection pinning target — done when pinned", ctx);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "Round one claim.", verificationSummary: "Round one evidence." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 1;
    });
    const afterR1 = readState(cwd).goal as unknown as {
      auditHistory: Array<{ report: string; disapproved: boolean; superseded?: boolean; at: string }>;
    };
    assert.equal(afterR1.auditHistory.length, 1, "R1 recorded");
    assert.equal(afterR1.auditHistory[0]!.superseded, undefined, "the first round starts live (legacy shape preserved)");

    // Round two with a distinct report through the same production path.
    process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, R2);
    await pi.runTool("complete_goal", { completionSummary: "Round two claim.", verificationSummary: "Round two evidence." }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) >= 2;
    });
    const afterR2 = readState(cwd).goal as unknown as {
      auditHistory: Array<{ report: string; disapproved: boolean; superseded?: boolean; supersededBy?: string; at: string }>;
    };
    assert.equal(afterR2.auditHistory.length, 2, "R2 appended, R1 preserved");
    assert.equal(afterR2.auditHistory[0]!.superseded, true, "R1 retired when R2 landed");
    assert.match(afterR2.auditHistory[0]!.supersededBy ?? "", /^disapproval:/, "R1 names its superseding round");
    assert.equal(afterR2.auditHistory[1]!.superseded, undefined, "R2 is the live round");
    assert.match(afterR2.auditHistory[1]!.report, /R2-UNIQUE-GAP/, "R1's objections stay attached to R1's entry");

    const prompt = continuationPrompt(afterR2 as never);
    assert.match(prompt, /R2-UNIQUE-GAP/, "the retry argues the live round");
    assert.match(prompt, /Settled rounds \(superseded, do not relitigate\)/, "settled rounds are named, not relitigated");
    assert.match(prompt, new RegExp(afterR2.auditHistory[0]!.at.replace(/[T:.-]/g, (c) => `\\${c}`)), "the settled line cites R1's round");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    ctx = null;
  } finally {
    if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previousBinary;
    if (ctx) await pi.fire("session_shutdown", { reason: "quit" }, ctx).catch(() => {});
  }
});

test("v0.38.21 appendAuditVerdict: clean approval clears the pin, shield-clear counts, errors never touch flags", () => {
  const at = (n: number): string => `2026-09-04T20:0${n}:00.000Z`;
  const dis = (n: number): AuditVerdict => ({ at: at(n), approved: false, disapproved: true, model: "m", report: `R${n}` });

  // New disapproval retires the older live round.
  const h1: AuditVerdict[] = [dis(1)];
  appendAuditVerdict(h1, dis(2));
  assert.equal(h1[0]!.superseded, true, "R1 retired");
  assert.equal(h1[0]!.supersededBy, "disapproval:2026-09-04T20:02:00.000Z", "R1 names R2");
  assert.equal(liveDisapproval(h1 as never)?.report, "R2", "R2 is live");

  // Clean approval clears whatever is live.
  appendAuditVerdict(h1, { at: at(3), approved: true, disapproved: false, model: "m", report: "ok" });
  assert.equal(liveDisapproval(h1), undefined, "no live objections after approval");
  assert.equal(h1[1]!.supersededBy, "approval:2026-09-04T20:03:00.000Z", "R2 cleared by the approval");

  // Shield-blocked approval also clears: the claim passed audit, only the
  // evidence citation failed — the objections were addressed.
  const h2: AuditVerdict[] = [dis(1)];
  appendAuditVerdict(h2, { at: at(2), approved: true, disapproved: false, regressionShieldPassed: false, model: "m", report: "ok" });
  assert.equal(liveDisapproval(h2), undefined, "shield-blocked approval still clears the pin");

  // Infrastructure entries are transparent: neither retire nor clear.
  const h3: AuditVerdict[] = [dis(1)];
  appendAuditVerdict(h3, { at: at(2), approved: false, disapproved: false, error: "boom", model: "m" });
  assert.equal(liveDisapproval(h3)?.report, "R1", "an error entry leaves R1 live");
  assert.equal(h3[0]!.superseded, undefined, "errors never mark flags");

  // The pin embeds content, never a path into a reaped job dir.
  const blob = JSON.stringify(h1);
  assert.doesNotMatch(blob, /audit-jobs/, "no job-dir paths in the pinned scope");
});
