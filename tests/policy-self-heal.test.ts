// pi-goal-list-loop-audit — v0.34.68
// tests/policy-self-heal.test.ts
//
// Bug 1.7 regression (audit/OPEN-ISSUES-2026-08-06 §1.7,
// Screenshot_20260804_212233): "list/goal drafting disallows until we
// restart". readState trusts the active.jsonl `state` event verbatim, so a
// parse failure could leave state.goal.policy outside {goal,list}; every
// mode gate branching on `state.goal.policy === "list"` then SILENTLY
// refused the wrong surface until a restart rebuilt clean state.
//
// The gate now self-heals: it re-parses the durable `**Policy**: …` marker
// from the active-goal .md in .pi-glla/goals/ and repairs the in-memory
// state in place, replacing the silent rejection with a visible recover
// notify. Contract: "regression test calls the gate with corrupted
// state.policy and asserts recovery (no restart needed), suite green +
// tsc clean."

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";
import {
  healCorruptedGoalPolicy,
  parseGoalPolicyFromMd,
  readState,
  appendLedger,
  type State,
} from "../extensions/goal-loop-core.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
});

// ---- pure core: parse + heal ----

const GOAL_ID = "20260804122233-abcdef";

/** Write the durable goal .md exactly as renderGoalMarkdown would (the
 * marker the heal re-parses). */
function seedDurablePolicy(cwd: string, policy: "goal" | "list"): void {
  const dir = path.join(cwd, ".pi-glla", "goals");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${GOAL_ID}.md`),
    `# Goal\n\n**Status**: active\n**Policy**: ${policy}\n**Auto-continue**: on\n\n## Objective\n\n> Create x.txt containing ok — done when the file exists\n`,
  );
}

function corruptedState(policy: unknown): State {
  return {
    goal: {
      id: GOAL_ID,
      objective: "Create x.txt containing ok",
      status: "active",
      policy: policy as never,
      autoContinue: true,
      createdAt: "2026-08-04T12:00:00Z",
      updatedAt: "2026-08-04T12:22:33Z",
      attemptCount: 0,
      auditHistory: [],
      taskList: { tasks: [] },
      usage: { tokensUsed: 0 },
    },
    list: [],
  } as unknown as State;
}

test("parseGoalPolicyFromMd reads the durable marker, undefined when absent", () => {
  const cwd = tmpCwd();
  try {
    seedDurablePolicy(cwd, "list");
    assert.equal(parseGoalPolicyFromMd(cwd, GOAL_ID), "list");
    seedDurablePolicy(cwd, "goal");
    assert.equal(parseGoalPolicyFromMd(cwd, GOAL_ID), "goal");
    assert.equal(parseGoalPolicyFromMd(cwd, "missing-id"), undefined);
    fs.writeFileSync(path.join(cwd, ".pi-glla", "goals", `${GOAL_ID}.md`), "# Goal\n\n**Status**: active\n\n## Objective\n\n> x\n");
    assert.equal(parseGoalPolicyFromMd(cwd, GOAL_ID), undefined, "unrecognized/missing marker");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("healCorruptedGoalPolicy repairs a corrupted policy from the durable .md and ledgers it", () => {
  const cwd = tmpCwd();
  try {
    seedDurablePolicy(cwd, "list");
    const state = corruptedState("lits"); // torn parse artifact
    const healed = healCorruptedGoalPolicy(state, cwd);
    assert.equal(healed, "list");
    assert.equal(state.goal!.policy, "list", "state healed in place");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.match(ledger, /"goal_policy_healed"/);
    assert.match(ledger, /"to":"list"/);
    assert.match(ledger, /"from":"lits"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("healCorruptedGoalPolicy leaves healthy policies and null goals untouched", () => {
  const cwd = tmpCwd();
  try {
    const healthy = corruptedState("goal");
    const h1 = healCorruptedGoalPolicy(healthy, cwd);
    assert.equal(h1, undefined);
    assert.equal(healthy.goal!.policy, "goal");
    const h2 = healCorruptedGoalPolicy({ goal: null, list: [] } as State, cwd);
    assert.equal(h2, undefined);
    assert.ok(!fs.existsSync(path.join(cwd, ".pi-glla", "active.jsonl")), "no ledger written when nothing to heal");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("healCorruptedGoalPolicy with no durable source records heal_failed and does not fake a mode", () => {
  const cwd = tmpCwd();
  try {
    const state = corruptedState("undefined");
    const healed = healCorruptedGoalPolicy(state, cwd);
    assert.equal(healed, undefined);
    assert.equal(state.goal!.policy as unknown, "undefined", "policy untouched — no invented mode");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.match(ledger, /"goal_policy_heal_failed"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("healed state persists — the next readState sees the fixed policy (no restart needed)", () => {
  const cwd = tmpCwd();
  try {
    seedDurablePolicy(cwd, "list");
    const state = corruptedState("lits");
    healCorruptedGoalPolicy(state, cwd);
    appendLedger(cwd, "state", { goal: state.goal, list: [], loop: null });
    const reread = readState(cwd);
    assert.equal(reread.goal?.policy, "list", "disk now carries the healed policy");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- behavioral: the gate itself self-heals (bug 1.7 regression) ----

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

test("bug 1.7: /list pause with a corrupted in-memory policy heals at the gate instead of refusing", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true); // keep the seeded goal ACTIVE past the restore gate
  const cwd = tmpCwd();
  try {
    // The durable .md says `list`; the restored in-memory state (ledger
    // `state` event) carries a corrupted policy — the bug 1.7 shape.
    seedState(cwd, { goal: seedGoal({ id: GOAL_ID, policy: "lits", status: "active" }) });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    // The auto-resume branch does not rewrite the goal .md (no interrupt
    // marker); write the durable truth AFTER boot so it survives the
    // session-start persist steps.
    seedDurablePolicy(cwd, "list");

    await pi.command("list", "pause", ctx);

    // The gate healed instead of silently refusing: /list pause proceeded
    // as a list item pause (the refusal said "standalone goal — /goal pause").
    assert.ok(ctx.ui.matching("/list resume to continue").length >= 1, "gate proceeded with the list-surface guidance");
    assert.equal(ctx.ui.matching("standalone goal").length, 0, "no silent list-mode rejection");
    assert.ok(ctx.ui.matching("Recovered the goal mode").length >= 1, "self-heal notify replaced the silent rejection");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.match(ledger, /"goal_policy_healed"/);
    assert.match(ledger, /"to":"list"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    setGlobalAutoResume(false);
  }
});

test("bug 1.7: /goal pause with a corrupted in-memory policy heals to goal and proceeds", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    seedState(cwd, { goal: seedGoal({ id: GOAL_ID, policy: "lits", status: "active" }) });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    seedDurablePolicy(cwd, "goal");

    await pi.command("goal", "pause", ctx);

    assert.ok(ctx.ui.matching("/goal resume to continue").length >= 1, "goal pause proceeded with goal-surface guidance");
    assert.ok(ctx.ui.matching("Recovered the goal mode").length >= 1, "self-heal notify fired");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.match(ledger, /"goal_policy_healed"/);
    assert.match(ledger, /"to":"goal"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    setGlobalAutoResume(false);
  }
});

test("S10: unhealable corruption names the true cause instead of failing over to a misleading refusal", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    // Corrupted policy with NO durable .md marker: the heal cannot land.
    // (Deliberately no seedDurablePolicy call.)
    seedState(cwd, { goal: seedGoal({ id: GOAL_ID, policy: "lits", status: "active" }) });
    const ctx = await freshSession(cwd, "reload");
    await tick();

    await pi.command("list", "pause", ctx);

    assert.ok(ctx.ui.matching("could not be recovered from the durable goal file").length >= 1, "truthful warning names the corruption");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.match(ledger, /"goal_policy_heal_failed"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    setGlobalAutoResume(false);
  }
});
