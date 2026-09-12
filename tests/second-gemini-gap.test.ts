// pi-goal-list-loop-audit — v0.38.52 second Gemini-gap (field 2026-09-12
// shots B/C/D): the verification gate inventory table (Quality Gate |
// Scope | Status | Notes, agent-supplied with mechanically derived
// statuses) plus per-finding `Test Results:` sub-lines. Archive-only
// close preserved: no commit hash or artifact links in chat.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry } from "../extensions/loops/goal-activation.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { readState, sanitizeFindingGroups, sanitizeGateRows, type FindingGroup, type GateRow, type Goal } from "../extensions/goal-loop-core.js";
import { buildRichTerminalParts, buildTerminalApprovalRender, takeBudgetedGroups } from "../extensions/completion-summary.js";
import { MockPi, makeMockCtx, seedGoal, tmpCwd } from "./harness/mock-pi.js";

const GATES: GateRow[] = [
  { gate: "Unit Tests", scope: "65 test files", notes: "743 passed, 0 failed" },
  { gate: "Typecheck", scope: "svelte + ts", notes: "0 errors, 0 warnings" },
  { gate: "Release Gate", notes: "Clean exit 0" },
  { gate: "E2E", scope: "playwright", notes: "1 failed, 9 passed" },
];

const AUDITED = [{ at: "2026-09-12T00:00:00.000Z", approved: true, disapproved: false, model: "m", report: "fine" }];

function parts(extra: Record<string, unknown> = {}) {
  return buildRichTerminalParts({
    outcome: "Shipped gates",
    details: ["Outcome: x", "Changed: y", "Tests: bun test passed"],
    countsLine: "— 1/1 done · 1 audit",
    auditHistory: AUDITED as Goal["auditHistory"],
    ...extra,
  });
}

test("v0.38.52: gate rows widen the verification table with derived statuses", () => {
  const p = parts({ gates: GATES });
  assert.equal(p.tableLines[0], "| Quality Gate | Scope | Status | Notes |", "four-column header");
  assert.equal(p.tableLines[1], "| --- | --- | --- | --- |", "four-column separator");
  const rows = p.tableLines.slice(2);
  assert.ok(rows.some((l) => l === "| Unit Tests | 65 test files | PASS | 743 passed, 0 failed |"), `pass notes derive PASS, got: ${rows.join(" / ")}`);
  assert.ok(rows.some((l) => l === "| Typecheck | svelte + ts | REPORTED | 0 errors, 0 warnings |"), "notes without a pass claim stay REPORTED — status is never claimed");
  assert.ok(rows.some((l) => l === "| Release Gate | — | REPORTED | Clean exit 0 |"), "bare-exit notes honestly stay REPORTED, absent scope renders —");
  assert.ok(rows.some((l) => l === "| E2E | playwright | FAIL | 1 failed, 9 passed |"), "nonzero failures derive FAIL");
  assert.ok(!rows.some((l) => l.startsWith("| Tests |")), "the agent inventory supersedes the mechanical Tests rows — never duplicated");
  assert.ok(rows.some((l) => /^\| Audit \| .* \| APPROVED ×1 \| /.test(l)), "the audit row rides the wide table");
});

test("v0.38.52: without gates the 3-col mechanical table is byte-identical", () => {
  const bare = parts({});
  assert.equal(bare.tableLines[0], "| Check | Status | Details |", "mechanical header preserved");
  assert.ok(bare.tableLines.some((l) => /^\| Tests \| PASS \| bun test passed/.test(l)), "mechanical Tests row preserved");
  const empty: GateRow[] = [];
  assert.deepEqual(parts({ gates: empty }), bare, "an empty inventory is the same as absent");
});

test("v0.38.52: nested findings render Test Results sub-bullets aligned by index", () => {
  const groups: FindingGroup[] = [
    { title: "Router", findings: ["Reroute: router.ts:12 pins the path", "Second: router.ts:20 guards"], tests: ["router suite 18/18", "edge suite 5/5"] },
    { title: "Sim", findings: ["Spawn: sim.ts:100 waves"] },
  ];
  const p = parts({ groups, gates: [] });
  assert.ok(p.findingLines.includes("  - Test Results: router suite 18/18"), "first proof rides its finding");
  assert.ok(p.findingLines.includes("  - Test Results: edge suite 5/5"), "second proof stays aligned");
  const simIdx = p.findingLines.findIndex((l) => l.includes("**Spawn**"));
  assert.ok(!p.findingLines.slice(simIdx, simIdx + 2).some((l) => l.includes("Test Results")), "a finding without proof renders no sub-line");
});

test("v0.38.52: table-mode findings ride test proof in the Evidence cell", () => {
  const groups: FindingGroup[] = [1, 2, 3, 4].map((n) => ({
    title: `Area ${n}`,
    findings: [`Lead${n}: body ${n} area.ts:${n}`],
    tests: [`suite ${n} green`],
  }));
  const p = parts({ groups, gates: [] });
  assert.equal(p.findingLines[0], "| Area | Finding | Evidence |", "group table shape preserved");
  const row = p.findingLines.find((l) => l.startsWith("| Area 1 |"));
  assert.ok(row?.includes("area.ts:1"), "mechanical evidence token still extracted");
  assert.ok(row?.includes("Tests: suite 1 green"), `proof rides the cell, got: ${row}`);
  assert.ok(!/(?<!\\)\|/.test(row!.slice(0, -2).split("|").slice(3).join("|")), "no raw pipes leak into the cell");
});

test("v0.38.52: takeBudgetedGroups keeps tests aligned with surviving findings", () => {
  const groups: FindingGroup[] = [
    { title: "A", findings: Array.from({ length: 8 }, (_, i) => `F${i}: b${i}`), tests: Array.from({ length: 8 }, (_, i) => `t${i}`) },
    { title: "B", findings: Array.from({ length: 8 }, (_, i) => `G${i}: h${i}`), tests: Array.from({ length: 8 }, (_, i) => `u${i}`) },
  ];
  const out = takeBudgetedGroups(groups);
  assert.equal(out.length, 2, "both groups survive");
  assert.equal(out[0]!.findings.length, 8, "first group whole");
  assert.equal(out[1]!.findings.length, 4, "second group clipped to the 12-finding budget");
  assert.deepEqual(out[1]!.tests, ["u0", "u1", "u2", "u3"], "tests clipped to the surviving findings");
});

test("v0.38.52: sanitizeGateRows drops garbage, clips, caps", () => {
  assert.equal(sanitizeGateRows("nope"), undefined, "non-array degrades to absent");
  assert.equal(sanitizeGateRows([]), undefined, "empty degrades to absent");
  assert.equal(sanitizeGateRows([null, 42, { title: "no gate key" }, { gate: "   " }]), undefined, "blank gates drop");
  const clipped = sanitizeGateRows([{ gate: `g${"x".repeat(200)}`, scope: `s${"y".repeat(300)}`, notes: `n${"z".repeat(500)}`, extra: "dropped" }]);
  assert.equal(clipped?.[0]?.gate.length, 120, "gate clipped");
  assert.equal(clipped?.[0]?.scope?.length, 200, "scope clipped");
  assert.equal(clipped?.[0]?.notes?.length, 400, "notes clipped");
  assert.ok(!("extra" in (clipped?.[0] ?? {})), "unknown keys never survive the boundary");
  const many = Array.from({ length: 11 }, (_, i) => ({ gate: `gate ${i}` }));
  assert.equal(sanitizeGateRows(many)?.length, 10, "rows capped");
});

test("v0.38.52: sanitizeFindingGroups parses parallel tests", () => {
  const groups = sanitizeFindingGroups([
    { title: "R", findings: ["A: a", "B: b"], tests: ["t1", "", 42, "t2", "overflow"] },
    { title: "NoTests", findings: ["C: c"] },
  ]);
  assert.deepEqual(groups?.[0]?.tests, ["t1", "t2"], "blanks and non-strings drop, overflow clipped to findings");
  assert.ok(!("tests" in (groups?.[1] ?? {})), "groups without tests keep the v0.38.50 shape");
});

test("v0.38.52: old claims without tests render byte-identical to v0.38.50", () => {
  const legacy: FindingGroup[] = [{ title: "R", findings: ["Reroute: router.ts:12 pins the path"] }];
  const p = parts({ groups: legacy, gates: [] });
  assert.ok(p.findingLines.includes("- **Reroute** — router.ts:12 pins the path"), "nested finding unchanged");
  assert.ok(!p.findingLines.some((l) => l.includes("Test Results")), "no invented sub-line");
});

// ── claim-to-chat end to end ──────────────────────────────────────────

const pi = new MockPi(); activate(pi.api);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
const summary = "Outcome: Fixed gates.\nChanged: renderer.\nEvidence: gate green.\nTests: gate suite passed.\nUnresolved: none.\nNext: ship.";
async function waitFor(check: () => boolean, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error("settlement timeout"); await new Promise(r => setTimeout(r, 20)); }
}
async function setup() {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  __testOnlyResetZombieAutoRetry(); __testOnlyResetZombieRunWatchdog();
  const cwd = tmpCwd(); resetContinuationDispatchState(cwd);
  const binary = path.join(cwd, "auditor.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"tool_execution_start",toolCallId:"read",toolName:"read",args:{path:"README.md"}});
emit({type:"tool_execution_end",toolCallId:"read"});
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"<evidence>pinned</evidence>\\n<approved/>"}});
emit({type:"agent_settled"});
}, 350); });`);
  fs.chmodSync(binary, 0o700);
  const previous = process.env.GLLA_PI_BINARY; process.env.GLLA_PI_BINARY = binary;
  const entries: any[] = [];
  const file = path.join(cwd, "session.jsonl");
  const ctx = makeMockCtx(cwd, { sessionManager: { getBranch: () => entries, getSessionFile: () => file } });
  const original = pi.api.sendMessage;
  pi.api.sendMessage = (message, options) => {
    original(message, options);
    if (options?.triggerTurn === false) {
      const entry = { type: "custom_message", id: String(entries.length), ...message };
      entries.push(entry); fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    }
  };
  cleanup = async () => {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    resetContinuationDispatchState(cwd); __testOnlyResetZombieRunWatchdog(); __testOnlyResetZombieAutoRetry();
    pi.api.sendMessage = original;
    if (previous === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = previous;
  };
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return { cwd, ctx, entries };
}

test("v0.38.52: complete_goal gateRows + tests ride the claim into the chat render", async () => {
  const { cwd, ctx, entries } = await setup();
  await pi.command("goal", "fix gates with inventory — done when pinned", ctx);
  const result = await pi.runTool("complete_goal", {
    completionSummary: summary,
    verificationSummary: "pinned",
    findingGroups: [
      { title: "Renderer", findings: ["Widen: completion-summary.ts:460 adds the gate table"], tests: ["gate suite 9/9"] },
    ],
    gateRows: [
      { gate: "Unit Tests", scope: "gate file", notes: "9 passed, 0 failed" },
      { gate: "", notes: "blank gate drops" },
    ],
  }, ctx) as any;
  assert.match(result.content[0].text, /AUDIT PENDING — nonterminal/);
  assert.deepEqual(readState(cwd).goal?.pendingCompletion?.gateRows, [
    { gate: "Unit Tests", scope: "gate file", notes: "9 passed, 0 failed" },
  ], "the pending claim stores the sanitized inventory");
  assert.deepEqual(readState(cwd).goal?.pendingCompletion?.findingGroups, [
    { title: "Renderer", findings: ["Widen: completion-summary.ts:460 adds the gate table"], tests: ["gate suite 9/9"] },
  ], "the pending claim stores the parallel test lines");
  await waitFor(() => entries.length === 1);
  assert.ok(entries[0].content.includes("| Quality Gate | Scope | Status | Notes |"), "wide table reaches the chat");
  assert.ok(entries[0].content.includes("| Unit Tests | gate file | PASS | 9 passed, 0 failed |"), "derived PASS row reaches the chat");
  assert.ok(entries[0].content.includes("  - Test Results: gate suite 9/9"), "per-finding proof reaches the chat");
  assert.ok(!entries[0].content.includes("a8f3fad5"), "no commit hash in chat — archive-only close preserved");
});
