import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readGoalRuntimeSource } from "./harness/goal-source.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { makeMockCtx, MockPi, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";
import { buildRecordedFactsCompletionSummary, compactCompletionSummary, compactTerminalCompletionSummary, isUsefulCompletionSummary, missingCompletionSummaryLabels, resolveCompletionSummary } from "../extensions/completion-summary.js";

const SRC = readGoalRuntimeSource();
const MAIN_SM = { name: "main-session-manager" };
function ownerCtx(cwd: string) { return makeMockCtx(cwd, { sessionManager: MAIN_SM }); }
function rememberCtxFor(cwd: string) { __testOnlyRememberCtx(ownerCtx(cwd) as any); }
function readLedger(cwd: string) {
  return fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("completion summary quality: validator requires six labels", () => {
  assert.match(SRC, /const requiredLabels = \[\"Outcome:\", \"Changed:\", \"Evidence:\", \"Tests:\", \"Unresolved:\", \"Next:\"\] as const;/);
  assert.match(SRC, /completion_summary_missing_labels/);
  assert.match(SRC, /completionSummary missing required labels/);
});

test("completion summary quality: generic prose and missing labels ledger and NOTE", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  // Use hanging auditor so the goal stays auditing for inspection before settle
  const script = path.join(cwd, "hanging-auditor.mjs");
  fs.writeFileSync(script, "setTimeout(()=>process.exit(0),8000)");
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  try {
    const res = await pi.runTool("complete_goal", { completionSummary: "done", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i);
    const st = JSON.parse(fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8").split("\n").filter(Boolean).pop()!);
    // The stored summary should contain NOTE about missing labels
    const ledger = readLedger(cwd);
    const missing = ledger.find((e) => e.type === "completion_summary_missing_labels");
    assert.ok(missing, "missing labels ledgered");
    assert.match(String(missing.value.flags.join(" ")), /missing required labels/);
    // Pending completion may carry a validation NOTE, but the annotation is
    // metadata only and must not make the incomplete claim archive-valid.
    const { readState } = await import("../extensions/goal-loop-core.js");
    const state = readState(cwd);
    assert.ok(state.goal?.completionSummary?.includes("NOTE:"), "stored summary amended with NOTE");
    assert.doesNotMatch(state.goal?.completionSummary ?? "", /NOTE:.*Outcome:/, "validation NOTE does not contain field labels");
    assert.equal(isUsefulCompletionSummary(state.goal?.completionSummary), false, "annotated incomplete claim remains invalid");
  } finally { delete process.env.GLLA_PI_BINARY; __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession(); }
});

test("completion summary quality: valid six-label recap passes without missing-label ledger", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  const script = path.join(cwd, "hanging-auditor2.mjs");
  fs.writeFileSync(script, "setTimeout(()=>process.exit(0),8000)");
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  const valid = "Outcome: Shipped X. Changed: file.ts. Evidence: commit abc. Tests: bun test — 1 pass. Unresolved: none. Next: none.";
  try {
    const res = await pi.runTool("complete_goal", { completionSummary: valid, verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i);
    const ledger = readLedger(cwd);
    assert.equal(ledger.filter((e) => e.type === "completion_summary_missing_labels").length, 0, "valid recap does not ledger missing labels");
    const { readState } = await import("../extensions/goal-loop-core.js");
    const state = readState(cwd);
    assert.equal(state.goal?.completionSummary, valid, "valid recap stored verbatim without NOTE");
  } finally { delete process.env.GLLA_PI_BINARY; __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession(); }
});

test("v0.36.0: every terminal outcome gets a six-label recorded-facts fallback", () => {
  const outcomes = [
    ["complete", "auditor approved"],
    ["aborted", "user cancelled"],
    ["aborted", "auto-dropped after impossible recovery"],
    ["aborted", "already_shipped:v0.35.72"],
    ["aborted", "auditor impossible: provider cannot satisfy this contract"],
  ] as const;
  for (const [status, stopReason] of outcomes) {
    const resolved = resolveCompletionSummary({
      goal: seedGoal({
        status,
        objective: "inspect the durable terminal record",
        telemetry: { turns: 2, fileWrites: 1, bashCalls: 3 },
      }) as any,
      status,
      stopReason,
      archivePath: `.pi-glla/archive/${status}.md`,
    });
    assert.equal(resolved.usedFallback, true, `${status} uses the fallback when no recap was supplied`);
    for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) {
      assert.equal(resolved.summary.match(new RegExp(`^${label}`, "gm"))?.length, 1, `${status} has one ${label} line`);
    }
    assert.match(resolved.summary, /not recorded|recorded/);
  }
});

test("v0.36.0: validation annotations cannot satisfy recap-label validation", () => {
  const annotated = "done — NOTE: completionSummary missing required labels Outcome:, Changed:, Evidence:, Tests:, Unresolved:, Next: — expected six labeled fields.";
  const goal = seedGoal({ objective: "reject validation-label spoofing" }) as any;
  const resolved = resolveCompletionSummary({ goal, status: "complete", stopReason: "auditor approved" }, annotated);
  assert.equal(isUsefulCompletionSummary(annotated), false);
  assert.equal(resolved.usedFallback, true);
  assert.doesNotMatch(resolved.summary, /done — NOTE:/);
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(resolved.summary, new RegExp(`^${label}`, "m"));
});

test("v0.36.0: valid recap is preserved while generic prose is replaced", () => {
  const valid = "Outcome: Shipped the fix.\nChanged: extensions/example.ts.\nEvidence: commit abc123.\nTests: bun test tests/example.test.ts — pass.\nUnresolved: none.\nNext: none.";
  assert.equal(isUsefulCompletionSummary(valid), true);
  const goal = seedGoal({ objective: "ship a useful recap" }) as any;
  const kept = resolveCompletionSummary({ goal, status: "complete", stopReason: "auditor approved" }, valid);
  assert.equal(kept.usedFallback, false);
  assert.equal(kept.summary, valid);
  const generic = resolveCompletionSummary({ goal, status: "complete", stopReason: "auditor approved" }, "done");
  assert.equal(generic.usedFallback, true);
  assert.match(generic.summary, /Outcome:/);
  assert.doesNotMatch(generic.summary, /Outcome: done/);
});

test("gate and projectors share last-occurrence segmentation on stolen labels", () => {
  const stolen = "Outcome: o. Changed: c. Evidence: e. Tests: see Next: x. Unresolved: u. Next:";
  assert.deepEqual(missingCompletionSummaryLabels(stolen), ["Next:"], "the empty final Next is missing even though Next: appears inside Tests:");
  assert.equal(isUsefulCompletionSummary(stolen), false, "gate rejects what the projector renders as Next: not recorded");
  assert.match(compactCompletionSummary(stolen), /Next: not recorded/, "projector and gate agree on the missing label");
});

test("v0.36.0: compact recap projection keeps all six labels and bounds each value", () => {
  const compact = compactCompletionSummary([
    "Outcome: shipped the durable terminal path",
    "Changed: extensions/loops/goal-tools.ts and tests/impossible-list-drop.test.ts",
    "Evidence: an intentionally long evidence detail that should be shortened for notification readability",
    "Tests: bun test — pass",
    "Unresolved: none",
    "Next: none",
  ].join("\\n"), 24);
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(compact, new RegExp(label));
  assert.ok(compact.includes(" · "), "projection is one scannable line");
  assert.ok(compact.includes("…"), "long values are bounded");
});

test("v0.36.0: terminal notification projection resolves generic claims from durable facts", () => {
  const compact = compactTerminalCompletionSummary({
    goal: seedGoal({
      status: "active",
      objective: "terminal notification projection",
      completionSummary: "done",
      telemetry: { turns: 3, fileWrites: 2, bashCalls: 1 },
    }) as any,
    status: "aborted",
    stopReason: "user cancelled",
    archivePath: ".pi-glla/archive/terminal-notification.md",
  });
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(compact, new RegExp(label));
  assert.match(compact, /user cancelled/);
  assert.match(compact, /not recorded/);
  assert.doesNotMatch(compact, /done/);
});

test("v0.36.0: fallback never invents changed files or test results", () => {
  const summary = buildRecordedFactsCompletionSummary({
    goal: seedGoal({ objective: "research a question", telemetry: undefined }) as any,
    status: "aborted",
    stopReason: "provider unavailable",
  });
  assert.match(summary, /Changed: not recorded/);
  assert.match(summary, /Tests: not recorded/);
  assert.match(summary, /no auditor verdict was recorded/);
  assert.doesNotMatch(summary, /commit [a-f0-9]{7,}/i);
});

test("v0.36.0: archive boundary replaces a validator annotation with recorded facts", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "archive annotated incomplete claims" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  const script = path.join(cwd, "hanging-annotation-auditor.mjs");
  fs.writeFileSync(script, "setTimeout(()=>process.exit(0),8000)");
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  try {
    await pi.runTool("complete_goal", {
      completionSummary: "done",
      verificationSummary: "Evidence was not captured.",
    }, ownerCtx(cwd));
    const { readState } = await import("../extensions/goal-loop-core.js");
    const pending = readState(cwd).goal?.completionSummary ?? "";
    assert.match(pending, /NOTE:/);
    assert.equal(isUsefulCompletionSummary(pending), false, "the pending annotation remains incomplete");
    const archive = (globalThis as any).archiveCurrentGoal as ((ctx: unknown, status: string, reason: string) => boolean) | undefined;
    assert.equal(archive?.(ownerCtx(cwd), "aborted", "test archive annotation fallback"), true);
    const files = fs.readdirSync(path.join(cwd, ".pi-glla", "archive"));
    assert.equal(files.length, 1);
    const markdown = fs.readFileSync(path.join(cwd, ".pi-glla", "archive", files[0]!), "utf8");
    assert.match(markdown, /^Outcome: Objective/m, "archive contains the recorded-facts Outcome");
    assert.doesNotMatch(markdown, /done — NOTE:/, "archive does not preserve the annotation as the recap");
    assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /completion_summary_fallback/);
  } finally {
    delete process.env.GLLA_PI_BINARY;
    __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  }
});

test("v0.36.0: archiveCurrentGoal writes a recap for complete and abort-derived terminal paths", () => {
  assert.match(SRC, /resolveCompletionSummary\(\{[\s\S]*source: "durable-terminal-state"/);
  assert.match(SRC, /completionSummary: summaryResolution\.summary/);
  const archive = (globalThis as any).archiveCurrentGoal as ((ctx: unknown, status: string, reason: string) => boolean) | undefined;
  assert.equal(typeof archive, "function", "the central archive boundary is available to the behavioral harness");
  for (const [status, reason] of [["complete", "auditor approved"], ["aborted", "auto-dropped after impossible recovery"]] as const) {
    const cwd = tmpCwd();
    seedState(cwd, { goal: seedGoal({ objective: `terminal ${status}`, status: "active" }) });
    __testOnlyLoadState(cwd);
    rememberCtxFor(cwd);
    assert.equal(archive!(ownerCtx(cwd), status, reason), true, `${status} archive lands`);
    const files = fs.readdirSync(path.join(cwd, ".pi-glla", "archive"));
    assert.equal(files.length, 1);
    const markdown = fs.readFileSync(path.join(cwd, ".pi-glla", "archive", files[0]!), "utf8");
    for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(markdown, new RegExp(`^${label}`, "m"), `${status} archive has ${label}`);
    assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /completion_summary_fallback/);
    __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  }
});

test("completion summary audit doc exists and inventories archives", () => {
  const p = path.resolve("audit/COMPLETION-SUMMARY-AUDIT-2026-08-27.md");
  assert.ok(fs.existsSync(p), "audit doc exists");
  const txt = fs.readFileSync(p, "utf-8");
  assert.match(txt, /Inventory/);
  assert.match(txt, /Usefulness assessment/);
  assert.match(txt, /six-label/);
});
