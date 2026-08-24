// pi-goal-list-loop-audit — v0.35.53
// tests/false-repair-card.test.ts
//
// note.md Now: "objective needs repair issue, but before reload it looked
// fine". Field forensics (neonbreak, item 20260823082852-in3rc7): the list
// draft batch wrote an item with objective "" and the ENTIRE intent inside
// the verification contract, because extractVerificationContract's line
// marker regex `verify\b[^:]*:` misread the imperative sentence "Verify the
// shipped PREMIUM-UIUX pass (...): confirm ..." as a contract marker. The
// activation gate then correctly flagged the empty objective ("empty"
// reason) and jammed a repair card ahead of it — 42
// faulty_objective_list_activation_blocked events over 22 hours, an endless
// repair-card loop that wedged the session.
//
// Two-layer durable fix under test:
//  1. WRITER (goal-loop-core.ts): the line marker for the ambiguous verbs
//     requires the colon immediately ("Verify:" / "Verify when:" /
//     "Verification:"); "done"/"done when"/"verified when" keep a bounded
//     60-char decorated-marker gap. The field text now parses with a REAL
//     objective and the contract tail landing in the contract.
//  2. READER (faulty-objective-recovery.ts + goal-list-queue.ts): legacy
//     items already persisted with an empty objective + a clean, actionable
//     contract derive their objective from the contract's leading
//     imperative at activation (ledgered) instead of demanding a repair
//     card. Empty objective + absent/suspicious contract still takes the
//     true broken-objective repair path.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { deriveObjectiveFromContract } from "../extensions/faulty-objective-recovery.js";
import { parseListItemDeclaration } from "../extensions/goal-loop-core.js";
import { readState } from "../extensions/goal-loop-core.js";
import { state } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

const FIELD_TEXT = `Verify the shipped PREMIUM-UIUX pass (its old goal was cancelled only because the stored contract used unparseable arrow-prose): confirm the dated ledger section enumerates all 15 surfaces with every FIX boxed to a commit SHA, and re-run the gate set. Done when: grep -c "PASS: PREMIUM-UIUX" .pi-glla/audit-loop/findings.md`;

function ledger(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  } catch {
    return "";
  }
}

afterEach(() => __testOnlyResetOwnerSession());

async function boot(pi: MockPi, cwd: string) {
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `repair-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(60);
  return ctx;
}

// ── (1) the writer: the field text parses with a real objective ─────────

test("parser: the field 'Verify the shipped ...' item keeps its intent in the OBJECTIVE", () => {
  const parsed = parseListItemDeclaration(FIELD_TEXT);
  assert.match(parsed.objective, /^Verify the shipped PREMIUM-UIUX pass/);
  assert.ok(parsed.objective.includes("re-run the gate set"), "the whole intent sentence stays in the objective");
  assert.match(parsed.verificationContract, /grep -c "PASS: PREMIUM-UIUX"/, "the contract tail lands in the contract");
  assert.ok(!parsed.verificationContract.includes("Verify the shipped"), "the intent is not duplicated into the contract");
});

test("parser: short-marker forms still parse as contract-only declarations", () => {
  const short = parseListItemDeclaration("Verify: grep -q ok x.txt");
  assert.equal(short.objective, "");
  assert.match(short.verificationContract, /grep -q ok x\.txt/, "the short-marker form keeps its contract");
  const decorated = parseListItemDeclaration("Add the export. Done when (all three gates): bun run gate");
  assert.equal(decorated.objective, "Add the export");
  assert.match(decorated.verificationContract, /bun run gate/);
});

// ── (2) the reader: deterministic derivation for legacy items ───────────

test("derivation: the field contract yields its leading imperative sentence; junk yields null", () => {
  const contract = FIELD_TEXT.slice(FIELD_TEXT.indexOf("Verify"), FIELD_TEXT.indexOf("Done when:")).trim();
  const derived = deriveObjectiveFromContract(contract);
  assert.match(derived ?? "", /^Verify the shipped PREMIUM-UIUX pass/);
  assert.ok((derived ?? "").includes("re-run the gate set"), "first sentence only — no Done-when tail");
  assert.equal(deriveObjectiveFromContract(""), null);
  assert.equal(deriveObjectiveFromContract(undefined), null);
  assert.equal(deriveObjectiveFromContract("passes sequentially, including validated recovery"), null, "suspicious contract stays on the repair path");
  assert.equal(deriveObjectiveFromContract("the fix was committed yesterday and everything looks great"), null, "non-imperative prose is not an objective");
});

// ── (3) behavioral: the legacy stuck item ACTIVATES instead of repairing ─

test("behavioral: a legacy empty-objective item with a clean contract activates with the derived objective", async () => {
  const cwd = tmpCwd();
  const item = {
    id: "20260823082852-in3rc7",
    objective: "",
    verificationContract: FIELD_TEXT,
    addedAt: "2026-08-23T08:28:52.000Z",
  };
  seedState(cwd, { goal: null, list: [item] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(80);
  const after = readState(cwd);
  assert.match(after.goal?.objective ?? "", /^Verify the shipped PREMIUM-UIUX pass/, "the derived objective is the active goal");
  assert.equal(after.goal?.verificationContract, FIELD_TEXT, "the contract is preserved on the goal");
  assert.deepEqual(after.list, [], "the stuck item left the queue");
  assert.match(ledger(cwd), /"list_objective_derived_from_contract"/, "the heal is durable and visible");
  assert.doesNotMatch(ledger(cwd), /"faulty_objective_list_activation_blocked"/, "NO false repair demand");
  assert.doesNotMatch(ledger(cwd), /Repair the blocked list item from saved intent/);
});

test("behavioral: a legacy empty-objective item with NO contract still takes the true repair path", async () => {
  const cwd = tmpCwd();
  const item = { id: "broken-1", objective: "", addedAt: new Date().toISOString() };
  seedState(cwd, { goal: null, list: [item] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(80);
  const after = readState(cwd);
  assert.equal(after.goal, null, "nothing activated");
  assert.equal(after.list?.[0]?.objective, "Repair the blocked list item from saved intent", "the true broken-objective path fires");
  assert.match(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
});

test("behavioral: a fresh batch item written from the field text activates directly — the writer fix end-to-end", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  // The batch/add path parses each item text through parseListItemDeclaration;
  // on an empty list /list add ACTIVATES immediately — the strongest possible
  // end-to-end proof that the writer no longer produces an empty objective.
  await pi.command("list", `add ${FIELD_TEXT}`, ctx);
  await tick(80);
  const after = readState(cwd);
  assert.match(after.goal?.objective ?? "", /^Verify the shipped PREMIUM-UIUX pass/, "activated directly with the full intent as the objective");
  assert.ok(after.goal?.objective.includes("re-run the gate set"), "nothing truncated into the contract field");
  assert.doesNotMatch(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
  void state;
});
