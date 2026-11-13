// pi-goal-list-loop-audit — v0.39.71
// tests/reaudit-round2.test.ts
//
// Second re-audit (field record: ledger continuations, 483 audit verdicts,
// the 40 most recent archives, registered tool definitions):
//
//   D  turn telemetry counts MODEL turns (turn_end) — 11 of 14 archived
//      records said "0 turns" next to 15–283 bash calls;
//   E  a goal that stops without a claim says WHY, names the change set in
//      repo terms, never says "completed", and gives a concrete next action;
//   A  an exact, exit-0 contract-gate run observed in the executor's own bash
//      call stands in for the pre-audit re-run while the tree is unchanged;
//   B  the continuation template no longer carries stale completion guidance
//      or one operator's daemon details;
//   C  project-builder tools are exposed only while a builder project runs,
//      and complete_goal's schema lost its implementation notes;
//   F  without per-area groups, the card names the largest changed files.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.ts";
import { state } from "../extensions/goal-state.ts";
import { readState } from "../extensions/goal-loop-core.ts";
import {
  buildRecordedFactsCompletionSummary,
  buildRichArchiveSection,
  buildRichTerminalParts,
  composeRichTerminalLines,
  humanStopReason,
  isRecordedFactsRecap,
  withoutStaleNext,
} from "../extensions/completion-summary.ts";
import {
  normalizeGateCommand,
  observableGateStep,
  observedGateReceipt,
  observedReceiptsCoveringContract,
  upsertObservedReceipt,
  workingTreeFingerprint,
} from "../extensions/gate-receipts.ts";
import { buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor.ts";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.ts";

const sessions: Array<{ pi: MockPi; ctx: ReturnType<typeof makeMockCtx> }> = [];
afterEach(async () => {
  for (const { pi, ctx } of sessions.splice(0)) await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
});

async function liveGoal(goal: Record<string, unknown>) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", ...goal }), list: [] });
  const pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { getBranch: () => [], getSessionFile: () => path.join(cwd, "s.jsonl") } });
  sessions.push({ pi, ctx });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.command("goal", "resume", ctx);
  return { cwd, pi, ctx };
}

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-r2-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A"); git("commit", "-qm", "init");
  return dir;
}

// ── D ────────────────────────────────────────────────────────────────────
test("D: every model turn counts, even when the agent run never ends", async () => {
  const { cwd, pi, ctx } = await liveGoal({});
  for (let i = 0; i < 4; i++) {
    await pi.fire("tool_result", { toolName: "bash", toolCallId: `b${i}`, input: { command: "ls" }, content: [], isError: false }, ctx);
    await pi.fire("turn_end", {}, ctx);
  }
  // No agent_end at all: a continuation queued into a running agent.
  assert.equal(state.goal?.telemetry?.turns, 4);
  assert.equal(state.goal?.telemetry?.bashCalls, 4);
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "end_turn" }] }, ctx);
  assert.equal(state.goal?.telemetry?.turns, 4, "agent_end no longer double-counts");
  assert.ok(readState(cwd).goal);
});

// ── E ────────────────────────────────────────────────────────────────────
test("E: stop reasons read as causes a person acts on", () => {
  assert.equal(humanStopReason("user wipe (/glla wipe)"), "stopped on request (/glla wipe)");
  assert.equal(humanStopReason('402: {"code":"insufficient_balance","details":{"coding_plan_exhausted":true}}'), "the model's plan or quota ran out");
  assert.equal(humanStopReason("429 Too Many Requests"), "the provider kept rate-limiting the model");
  assert.equal(humanStopReason(undefined), "the reason was not recorded");
});

test("E: a stopped goal's recap says why, in repo terms, with a real next action — never 'completed'", () => {
  const dir = gitRepo();
  const startTree = workingTreeFingerprint(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.mkdirSync(path.join(dir, "src")); fs.writeFileSync(path.join(dir, "src", "b.ts"), "x\n");
  const goal = seedGoal({
    status: "aborted", startTree, objective: "Rewrite the report card",
    verificationContract: "`npm run release:check` exits 0",
    telemetry: { turns: 9, fileWrites: 2, bashCalls: 5, files: [path.join(dir, "a.txt"), path.join(dir, "src", "b.ts")] },
    taskList: { tasks: [{ id: "t1", title: "Draft the card", status: "complete" }, { id: "t2", title: "Wire the renderer", status: "pending" }] },
  }) as any;
  const recap = buildRecordedFactsCompletionSummary({ goal, status: "aborted", stopReason: 'Coding Plan quota is exhausted (402 insufficient_balance)', archivePath: ".pi-glla/archive/x.md", cwd: dir });
  assert.match(recap, /^Outcome: The model's plan or quota ran out — "Rewrite the report card" was not finished\.$/m);
  assert.match(recap, /^Changed: 2 files changed, \+2 −0 since the goal started \(a\.txt \+1 −0, src\/b\.ts \+1 −0\)\.$/m);
  assert.doesNotMatch(recap, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no absolute paths");
  assert.match(recap, /^Unresolved: 1 of 2 tasks done; next open task: Wire the renderer\.$/m);
  assert.match(recap, /^Next: restore model access .*then start it again with \/goal\.$/m);
  assert.ok(isRecordedFactsRecap(recap));
  assert.ok(withoutStaleNext(["Next: start it again with /goal if the objective is still wanted"]).length === 1, "the next action survives the stale-Next filter");

  goal.completionSummary = recap;
  const card = buildRichArchiveSection(goal, "aborted", ".pi-glla/archive/x.md").join("\n");
  assert.match(card, /^## Aborted — The model's plan or quota ran out$/m);
  assert.doesNotMatch(card, /completed without/i, "a stopped goal is never 'completed'");
  assert.match(card, /stopped before completion; no completion review · record: \.pi-glla\/archive\/x\.md\./);
  assert.doesNotMatch(card, /no review recorded · /, "the review state is said once");
  assert.doesNotMatch(card, /bash calls were recorded/, "machine counters stay in the machine record");
});

test("E: legacy recorded-facts recaps are still recognized", () => {
  const legacy = [
    'Outcome: Objective "x" archived with status=aborted.',
    "Changed: not recorded.",
    "Evidence: goal g; 0 turns, 0 file-write signals, and 0 bash calls were recorded; no completion review was recorded.",
    "Tests: not recorded — no terminal test result was captured.",
    "Unresolved: not recorded.",
    "Next: review the durable record at x.md.",
  ].join("\n");
  assert.ok(isRecordedFactsRecap(legacy));
});

test("A/E: GLLA's own runtime state never changes the tree fingerprint", () => {
  const dir = gitRepo();
  const before = workingTreeFingerprint(dir);
  fs.mkdirSync(path.join(dir, ".pi-glla", "goals"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi-glla", "active.jsonl"), "{}\n");
  fs.writeFileSync(path.join(dir, ".pi-glla", "goals", "g.md"), "x\n");
  assert.equal(workingTreeFingerprint(dir), before, "un-ignored .pi-glla/ writes are not work");
  fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
  assert.notEqual(workingTreeFingerprint(dir), before, "real edits still count");
});

// ── A ────────────────────────────────────────────────────────────────────
const STEPS = [{ command: "npm run release:check" }];
const bash = (command: string, exit: number | null, extra: Record<string, unknown> = {}) => ({
  toolName: "bash", isError: exit !== 0, input: { command },
  content: [{ type: "text", text: "4552 pass\n0 fail" }],
  structuredContent: { output: "4552 pass\n0 fail", exit_code: exit, wall_time_seconds: 842.4 },
  ...extra,
});

test("A: only an exact, exit-0 contract command counts as an observed receipt", () => {
  const fp = () => "c".repeat(40);
  const ok = observedGateReceipt(bash("npm run release:check 2>&1", 0), STEPS, fp);
  assert.deepEqual(ok && { ...ok }, { command: "npm run release:check", exitCode: 0, durationMs: 842_400, outputTail: "4552 pass\n0 fail", observed: true, treeFingerprint: "c".repeat(40) });
  assert.equal(observedGateReceipt(bash("npm run release:check | tail -5", 0), STEPS, fp), undefined, "a pipeline hides the real exit code");
  assert.equal(observedGateReceipt(bash("npm run release:check", 1), STEPS, fp), undefined, "a failure is never a receipt");
  assert.equal(observedGateReceipt(bash("npm run release:check", 0, { structuredContent: { output: "" } }), STEPS, fp), undefined, "no transport exit code, no receipt");
  assert.equal(observedGateReceipt(bash("cd x && npm run release:check", 0), STEPS, fp), undefined);
  assert.equal(observedGateReceipt(bash("npm run release:check", 0), STEPS, () => undefined), undefined, "no fingerprint, no receipt");
  assert.equal(observedGateReceipt({ ...bash("npm run release:check", 0), toolName: "read" }, STEPS, fp), undefined);
  assert.equal(observableGateStep({ command: "npm test | tail -n 5" }), false);
  assert.equal(observableGateStep({ command: "npm test", cwd: "web" }), false);
  assert.equal(normalizeGateCommand("  npm   run x  2>&1 "), "npm run x");
});

test("A: observed receipts cover the contract only for the identical tree and every step", () => {
  const r = (command: string, fp: string) => ({ command, exitCode: 0 as const, durationMs: 1, outputTail: "", observed: true as const, treeFingerprint: fp });
  const fp = "d".repeat(40);
  const steps = [{ command: "npm run check" }, { command: "npm test" }];
  let list = upsertObservedReceipt(undefined, r("npm run check", "e".repeat(40)));
  list = upsertObservedReceipt(list, r("npm run check", fp));
  assert.equal(list.length, 1, "latest run of a command wins");
  assert.equal(observedReceiptsCoveringContract(steps, list, fp), undefined, "one step unobserved → re-run");
  list = upsertObservedReceipt(list, r("npm test", fp));
  assert.deepEqual(observedReceiptsCoveringContract(steps, list, fp)?.map((x) => x.command), ["npm run check", "npm test"]);
  assert.equal(observedReceiptsCoveringContract(steps, list, "f".repeat(40)), undefined, "an edit since → re-run");
  assert.equal(observedReceiptsCoveringContract([{ command: "npm test | tail" }], list, fp), undefined);
});

test("A: the live hook records an observed receipt from the executor's own run", async () => {
  const dir = gitRepo();
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  seedState(dir, { goal: seedGoal({ status: "active", verificationContract: "- `npm run release:check` exits 0" }), list: [] });
  const pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(dir, { sessionManager: { getBranch: () => [], getSessionFile: () => path.join(dir, "s.jsonl") } });
  sessions.push({ pi, ctx });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.command("goal", "resume", ctx);
  await pi.fire("tool_result", { ...bash("npm run release:check | tail", 0), toolCallId: "p" }, ctx);
  assert.equal(state.goal?.observedGateReceipts, undefined, "a piped run is not recorded");
  await pi.fire("tool_result", { ...bash("npm run release:check", 0), toolCallId: "x" }, ctx);
  const [receipt] = ((state.goal as { observedGateReceipts?: Array<{ command: string; treeFingerprint?: string }> } | undefined)?.observedGateReceipts ?? []);
  assert.equal(receipt?.command, "npm run release:check");
  assert.equal(receipt?.treeFingerprint, workingTreeFingerprint(dir));
});

test("A: the brief and the card say a receipt was observed, not run", () => {
  const observed = { command: "npm run release:check", exitCode: 0 as const, durationMs: 842_000, outputTail: "ok", observed: true as const };
  const prompt = buildGoalAuditorPrompt(seedGoal({ verificationContract: "x" }) as any, "Outcome: done", undefined, [observed]);
  assert.match(prompt, /observed in the executor's own run — exit code read from the bash tool result/);
  const card = composeRichTerminalLines(buildRichTerminalParts({ outcome: "Shipped", details: [], countsLine: "", chat: true, receipts: [observed] })).join("\n");
  assert.match(card, /PASS: GLLA saw it pass — exit 0 in 14m02s/);
});

// ── B ────────────────────────────────────────────────────────────────────
test("B: the continuation template drops stale guidance and operator-specific detail", () => {
  const tmpl = fs.readFileSync("prompts/goal-loop-continuation.md", "utf8");
  assert.ok(tmpl.length < 21_000, `template is ${tmpl.length} bytes`);
  assert.doesNotMatch(tmpl, /archive-only by default/, "chat shows the gate table now — the old rule contradicted it");
  assert.doesNotMatch(tmpl, /maintainer's rig|auto_rewrite_large_blobs/);
  assert.match(tmpl, /### Completion communication[\s\S]*claim, not a verdict[\s\S]*REPORT SHAPE/);
});

// ── C ────────────────────────────────────────────────────────────────────
test("C: builder tools are active only while a builder project runs", async () => {
  const { pi, ctx } = await liveGoal({});
  pi.api.setActiveTools([...pi.api.getActiveTools(), "propose_project_requirements", "claim_project_task"]);
  await pi.fire("before_agent_start", { prompt: "go" }, ctx);
  assert.ok(!pi.api.getActiveTools().includes("claim_project_task"), "no builder → hidden");
  assert.ok(pi.api.getActiveTools().includes("complete_goal"), "GLLA's own tools stay");
  state.loop = { active: true, builder: { phase: "drafting" } } as any;
  await pi.fire("before_agent_start", { prompt: "go" }, ctx);
  for (const name of ["propose_project_requirements", "claim_project_task", "audit_project_increment"]) assert.ok(pi.api.getActiveTools().includes(name), `${name} exposed during a build`);
  state.loop = null as any;
});

test("C: complete_goal's schema carries rules, not implementation notes", async () => {
  const { pi } = await liveGoal({});
  const schema = JSON.stringify((pi.tools.get("complete_goal") as any).parameters);
  assert.ok(schema.length < 6_000, `schema is ${schema.length} chars`);
  assert.doesNotMatch(schema, /trust boundary clips|10k-char value guard/);
  assert.match(schema, /REQUIRED when the recap's Changed value names 3\+ paths/);
});

// ── F ────────────────────────────────────────────────────────────────────
test("F: without per-area groups the card names the largest changed files; with groups it does not", () => {
  const files = ["extensions/a.ts +40 −2", "tests/a.test.ts +20 −0", "README.md +3 −1", "x +1 −0", "y +1 −0", "z +1 −0"];
  const flat = composeRichTerminalLines(buildRichTerminalParts({ outcome: "Shipped", details: ["Changed: the thing"], countsLine: "", chat: true, changeLine: "6 files changed, +66 −3", changeFiles: files })).join("\n");
  assert.match(flat, /6 files changed, \+66 −3\n- `extensions\/a\.ts \+40 −2`\n- `tests\/a\.test\.ts \+20 −0`/);
  assert.equal((flat.match(/^- `/gm) ?? []).length, 5, "capped at five");
  const grouped = composeRichTerminalLines(buildRichTerminalParts({ outcome: "Shipped", details: [], countsLine: "", chat: true, changeLine: "6 files changed, +66 −3", changeFiles: files, groups: [{ title: "Core", findings: ["The thing works — extensions/a.ts:3"] }] })).join("\n");
  assert.doesNotMatch(grouped, /^- `extensions\/a\.ts/m, "areas already say what changed");
});
