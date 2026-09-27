import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor.ts";
import { isOutsideScopeFinding, runReviewer, DEFAULT_REVIEWER_CONFIG } from "../extensions/reviewer.ts";
import { seedGoal } from "./harness/mock-pi.ts";

describe("auditor scope guard — project at hand only", () => {
  test("auditor prompt contains outside-scope guard", () => {
    const goal = seedGoal({ objective: "fix bug", verificationContract: "one" });
    const prompt = buildGoalAuditorPrompt(goal as any, "claim", "verify");
    assert.match(prompt, /SCOPE GUARD — PROJECT AT HAND ONLY/);
    assert.match(prompt, /outside findings are informational only/i);
    assert.match(prompt, /Outside Scope/i);
  });

  test("outside-scope findings are recorded but not auto-queued", () => {
    const cfg = { ...DEFAULT_REVIEWER_CONFIG, maxFindingsPerReview: 10, mode: "on" as const };
    const ledger: any[] = [];
    let enqueued: string[] = [];
    const deps = {
      cwd: "/tmp/test",
      nowMs: Date.now(),
      ledgerEntries: [],
      sources: [{ name: "audit", text: "- bug: outside scope fix the world in other repo\n- bug: TODO fix local broken handler\n" }],
      enqueueListItems: (items: string[]) => { enqueued.push(...items); },
      proposeGoal: () => true,
      notify: () => {},
      ledger: (type: string, value: any) => ledger.push({ type, value }),
    };
    const outcome = runReviewer(cfg, { kind: "goal", goalId: "20260829-aaaaaa", objective: "done", terminal: "goal-complete" }, deps as any);
    assert.equal(outcome.fired, true);
    // outside finding should be in report
    assert.equal(outcome.report!.findings.length, 2);
    assert.equal(isOutsideScopeFinding("outside scope fix the world"), true);
    assert.equal(isOutsideScopeFinding("TODO fix local broken handler"), false);
    // but only in-scope bug enqueued
    assert.equal(enqueued.length, 1);
    assert.match(enqueued[0]!, /TODO fix local/);
    // ledger records outside
    assert.ok(ledger.some((e) => e.type === "reviewer_outside_scope"));
  });
});

// v0.38.101 — the convergence contract.
//
// Field evidence (2026-09-27): hellhunter 8 reviews / 8 disapproved at 63h,
// neonbreak 13/13, football 4/4. The auditor is an unbounded adversary — with
// no stated boundary it keeps finding new objections in a repository that
// never becomes defect-free, so approval is unreachable and the goal
// re-audits forever. Two causes: objections were scoped to the REPOSITORY
// (not the change), and "approved" had no reachable definition. These pin both
// halves of the fix, plus the rework framing that makes round N a different
// question from round 1.
describe("auditor convergence contract — the change, not the repository", () => {
  test("brief bounds blocking objections to the change and defines a reachable approval bar", () => {
    const goal = seedGoal({ objective: "fix bug", verificationContract: "one" });
    const prompt = buildGoalAuditorPrompt(goal as any, "claim", "verify");

    // The change, not the repo, is the unit of judgement.
    assert.match(prompt, /CHANGE SCOPE/);
    assert.match(prompt, /The work under review is THE CHANGE/);
    // Pre-existing / out-of-change debt is explicitly non-blocking. This is
    // the line that breaks the self-feeding loop: without it the auditor's
    // own growing findings ledger becomes next round's blocking target.
    assert.match(prompt, /NON-BLOCKING/);
    assert.match(prompt, /predate this change/);
    assert.match(prompt, /do NOT disapprove for it/i);
    // Its own prior findings are inputs to re-check, not fresh targets.
    assert.match(prompt, /not new targets/);
    // A FINITE, reachable definition of approved.
    assert.match(prompt, /WHAT APPROVED MEANS/);
    assert.match(prompt, /reachable/i);
    assert.match(prompt, /no defect inside the changed paths/);
    // The adversarial posture survives — only its target is bounded.
    assert.match(prompt, /Be skeptical and semantic/);
  });

  test("a first round carries no rework framing", () => {
    const goal = seedGoal({ objective: "fix bug", verificationContract: "one" });
    const prompt = buildGoalAuditorPrompt(goal as any, "claim", "verify");
    assert.doesNotMatch(prompt, /REWORK ROUND/);
  });

  test("a rework round asks whether the PRIOR objections are closed", () => {
    const goal = seedGoal({ objective: "fix bug", verificationContract: "one" });
    (goal as any).auditHistory = [
      { disapproved: true, approved: false },
      { disapproved: true, approved: false },
      { disapproved: true, approved: false },
    ];
    const prompt = buildGoalAuditorPrompt(goal as any, "claim", "verify");
    assert.match(prompt, /REWORK ROUND/);
    assert.match(prompt, /disapproved 3 times before/);
    assert.match(prompt, /whether the PRIOR objections are now closed/);
    // A genuinely new in-scope defect must still block — convergence is not
    // rubber-stamping.
    assert.match(prompt, /genuinely new defect in the change is still valid/);
  });
});
