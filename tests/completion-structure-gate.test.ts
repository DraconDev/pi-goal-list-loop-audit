// pi-goal-list-loop-audit — multi-area completion claims must carry structure.
//
// Field 2026-11-07 (tab-hero, ~45m goal): the claim named six changed files in
// durable telemetry, closed as one paragraph, and every downstream surface —
// chat card, archive record, and the human reading them — inherited four
// opaque sentences. The v0.38.69 density lint saw it and only ANNOTATED the
// claim, so the git-history check for the operator was to open six files.
//
// This pins the capture-time gate: multi-area work without findingGroups or
// gateRows is refused BEFORE any state change, single-area work stays flat,
// and the refusal names the real change set rather than guessing from prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { makeMockCtx, MockPi, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";
import {
  completionSummaryChangedPaths,
  completionSummaryStructureGap,
} from "../extensions/completion-summary.js";

const MAIN_SM = { name: "main-session-manager" };
function ownerCtx(cwd: string) { return makeMockCtx(cwd, { sessionManager: MAIN_SM }); }
function rememberCtxFor(cwd: string) { __testOnlyRememberCtx(ownerCtx(cwd) as any); }
function readLedger(cwd: string) {
  return fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// The real claim that motivated the gate, verbatim from
// .pi-glla/archive/20261107103159-jps4k0.md.
const TAB_HERO_CLAIM = [
  "Outcome: The mini popup is gone — the toolbar button now opens Town, which is the home page, and every page renders fluid full-width.",
  "Changed: removed default_popup and entrypoints/popup/, added a background onClicked that opens Town, moved Collect Loot plus Settings and Side Panel buttons onto Town, and dropped all max-width caps from the shared glass styles; no game logic touched.",
  "Evidence: audit-evidence/fullwidth-preview.png screenshot and a built bundle with no popup.html.",
  "Tests: vitest 72 passed (including the migrated popup-contract tests); typecheck 0 errors; wxt build clean.",
  "Unresolved: none.",
  "Next: none — fullscreen pass complete.",
].join(" ");

// The goal's own durable change set (v0.38.100 telemetry), as recorded in the
// archived state line.
const TAB_HERO_CHANGE_SET = [
  "entrypoints/background.ts",
  "wxt.config.ts",
  "entrypoints/town/TownApp.svelte",
  "lib/ui/theme.css",
  "tests/writer-contract.test.ts",
  "tests/manifest.test.ts",
];

test("structure gate: the real tab-hero claim is refused and names its change set", () => {
  const gap = completionSummaryStructureGap(TAB_HERO_CLAIM, undefined, undefined, TAB_HERO_CHANGE_SET);
  assert.ok(gap, "six touched files reported as one bullet is the failure this gate exists to stop");
  assert.match(gap, /spans 7 paths/, "the refusal counts the claim's own path plus the durable change set");
  assert.match(gap, /entrypoints\/background\.ts/, "it names real paths so the agent can group them");
  assert.match(gap, /findingGroups/, "it names the field to fill");
  assert.match(gap, /gateRows/, "it names the gate inventory too");
  assert.match(gap, /no state changed/, "a refusal must state that nothing was mutated");
});

test("structure gate: single-area work stays a flat recap", () => {
  const single = "Outcome: fixed it. Changed: extensions/goal-recovery.ts retry timer. Evidence: commit abc. Tests: 12 pass. Unresolved: none. Next: none.";
  assert.equal(
    completionSummaryStructureGap(single, undefined, undefined, ["extensions/goal-recovery.ts"]),
    undefined,
    "one path is one area — flat is the correct shape, never a refusal",
  );
  assert.equal(
    completionSummaryStructureGap(single),
    undefined,
    "a claim with no telemetry and one named path is still single-area",
  );
});

test("structure gate: supplied structure satisfies the gate", () => {
  assert.equal(
    completionSummaryStructureGap(
      TAB_HERO_CLAIM,
      [{ title: "Popup removal", findings: ["toolbar click opens Town"] }],
      undefined,
      TAB_HERO_CHANGE_SET,
    ),
    undefined,
    "finding groups prove the agent did the grouping",
  );
  assert.equal(
    completionSummaryStructureGap(TAB_HERO_CLAIM, undefined, [
      { gate: "Unit tests", command: "npx vitest run", notes: "72 passed, 0 failed" },
    ], TAB_HERO_CHANGE_SET),
    undefined,
    "a gate inventory is the other half of the same structure",
  );
});

test("structure gate: prose paths alone are counted, directories are not", () => {
  const claim = "Outcome: x. Changed: edited src/a.ts, src/b.ts, src/c.ts and the lib/ tree. Evidence: none. Tests: none. Unresolved: none. Next: none.";
  const paths = completionSummaryChangedPaths(claim);
  assert.deepEqual(paths.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"], "only openable files count as breadth");
  assert.ok(completionSummaryStructureGap(claim), "three real paths is multi-area even with no telemetry");
});

test("complete_goal refuses a multi-area flat claim before any state change", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "active",
      telemetry: { turns: 9, fileWrites: 6, bashCalls: 11, files: TAB_HERO_CHANGE_SET },
    }),
  });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  try {
    const res = await pi.runTool("complete_goal", { completionSummary: TAB_HERO_CLAIM, verificationSummary: "vitest green" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /needs structure for multi-area work/, "the claim is refused, not annotated");
    assert.match(res.content[0]!.text, /findingGroups/, "the refusal says how to satisfy it");
    const refused = readLedger(cwd).find((e) => e.type === "complete_goal_structure_refused");
    assert.ok(refused, "the refusal is ledgered for forensics");
    assert.equal(refused.value.goalId, JSON.parse(fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8").split("\n").filter(Boolean)[0]!).value.goal.id);
    assert.equal(refused.value.changeSet.length, 6, "the ledger keeps the real change set it judged");
    // No audit was dispatched and no terminal state was written.
    const { readState } = await import("../extensions/goal-loop-core.js");
    const state = readState(cwd);
    assert.equal(state.goal?.pendingCompletion, undefined, "no completion claim was persisted");
    assert.equal(state.goal?.status, "active", "the goal stays active for an honest re-submission");
    assert.equal(state.goal?.completionSummary, undefined, "the thin recap never lands on the goal");
    assert.equal(readLedger(cwd).filter((e) => e.type === "auditor_queued" || e.type === "audit_tier_decided").length, 0, "no auditor was launched");
  } finally {
    delete process.env.GLLA_PI_BINARY;
    __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  }
});

test("complete_goal still audits a single-area flat claim", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "active",
      telemetry: { turns: 4, fileWrites: 1, bashCalls: 2, files: ["extensions/goal-recovery.ts"] },
    }),
  });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  const script = path.join(cwd, "hanging-auditor-structure.mjs");
  fs.writeFileSync(script, "setTimeout(()=>process.exit(0),8000)");
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  try {
    const recap = "Outcome: retry timer reset. Changed: extensions/goal-recovery.ts. Evidence: commit abc1234. Tests: bun test 12 pass, 0 fail. Unresolved: none. Next: none.";
    const res = await pi.runTool("complete_goal", { completionSummary: recap, verificationSummary: "bun test green" }, ownerCtx(cwd));
    assert.doesNotMatch(res.content[0]!.text, /needs structure/, "single-area work is never gated");
    assert.match(res.content[0]!.text, /auditor queued|detached|AUDIT PENDING/i, "the claim reaches the auditor");
    assert.equal(readLedger(cwd).filter((e) => e.type === "complete_goal_structure_refused").length, 0);
  } finally {
    delete process.env.GLLA_PI_BINARY;
    __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  }
});
