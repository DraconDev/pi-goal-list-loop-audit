// Dynamic basic draft: a /goal seed that already carries enough detail —
// alone or together with the bounded recent conversation — activates
// directly instead of forcing an interview. Thin seeds still draft (with a
// dynamic-length interview); /goal plan always drafts (unchanged).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { buildSeedGrillMessage } from "../extensions/goal-loop-core.ts";
import { countDetailAnchors, seedPlusContextSufficient } from "../extensions/start-context.ts";

function sessionWith(...texts: Array<{ role: "user" | "assistant"; text: string }>): unknown {
  return {
    getBranch: () => texts.map((t) => ({ type: "message", message: { role: t.role, content: t.text } })),
  };
}

const EMPTY_SESSION = sessionWith();

test("rich seed alone is sufficient with no session context", () => {
  const seed = "Fix the flaky login check in tests/auth/login.test.ts — it times out after 30s on CI. "
    + "Verify with `bun test tests/auth`. Keep the suite under 60s";
  assert.equal(countDetailAnchors(seed) >= 3, true, "seed carries 3+ anchor classes");
  assert.equal(seedPlusContextSufficient(seed, EMPTY_SESSION), true);
});

test("thin seed with no context still drafts", () => {
  assert.equal(seedPlusContextSufficient("fix the login thing", EMPTY_SESSION), false);
});

test("thin seed plus rich related context is sufficient", () => {
  const session = sessionWith(
    { role: "user", text: "The login test at tests/auth/login.test.ts times out after 30s on CI" },
    { role: "assistant", text: "I will take a look at the retry logic." },
    { role: "user", text: "/goal fix the login thing" },
  );
  assert.equal(seedPlusContextSufficient("fix the login thing", session), true);
});

test("thin seed plus unrelated context still drafts", () => {
  const session = sessionWith(
    { role: "user", text: "Update the deployment docs in docs/deploy.md; verify with `make docs`" },
    { role: "user", text: "/goal fix the login thing" },
  );
  assert.equal(seedPlusContextSufficient("fix the login thing", session), false);
});

test("assistant monologue never supplies the missing detail", () => {
  const session = sessionWith(
    { role: "assistant", text: "The login flow in src/auth/login.ts fails after 30s; run `bun test src/auth`" },
  );
  assert.equal(seedPlusContextSufficient("fix the login thing", session), false);
});

test("question-only, vague, and chatter seeds still draft", () => {
  assert.equal(seedPlusContextSufficient("Why is the board query slow?", EMPTY_SESSION), false);
  assert.equal(seedPlusContextSufficient("fix it", EMPTY_SESSION), false);
  assert.equal(seedPlusContextSufficient("ok adjust it", EMPTY_SESSION), false);
  assert.equal(seedPlusContextSufficient("?", EMPTY_SESSION), false);
});

test("multi-task seed still drafts so scope is confirmed first", () => {
  assert.equal(
    seedPlusContextSufficient("Fix the login test and update the deployment documentation", EMPTY_SESSION),
    false,
  );
});

test("slash commands and overlong seeds fail closed to drafting", () => {
  assert.equal(seedPlusContextSufficient("/goal status", EMPTY_SESSION), false);
  assert.equal(seedPlusContextSufficient(`fix the login test in ${"x".repeat(800)}.ts`, EMPTY_SESSION), false);
});

test("unreadable session context fails closed without throwing", () => {
  const broken = { getBranch: () => { throw new Error("boom"); } };
  assert.equal(seedPlusContextSufficient("fix the login thing", broken), false);
  assert.equal(seedPlusContextSufficient("fix the login thing", null), false);
});

test("countDetailAnchors counts distinct evidence classes, not repeats", () => {
  assert.equal(countDetailAnchors("fix the login thing"), 0);
  assert.equal(countDetailAnchors("fix it in tests/a.test.ts and tests/b.test.ts"), 1);
  assert.equal(
    countDetailAnchors("Fix tests/a.test.ts; verify with `bun test` in under 30s:\n- [ ] repro\n- [ ] fix"),
    5,
  );
});

test("cmdSet consults the sufficiency gate before drafting", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf8");
  const gate = src.indexOf("goalArgsNeedDrafting(raw)");
  const sufficient = src.indexOf("seedPlusContextSufficient(raw", gate);
  const drafting = src.indexOf('await startDrafting(ctx, "goal", raw)', sufficient);
  assert.ok(gate >= 0 && sufficient > gate, "sufficiency gate sits inside the drafting branch");
  assert.ok(drafting > sufficient, "thin seeds still reach startDrafting after the gate");
});

test("seeded grill message promises a dynamic-length interview", () => {
  const msg = buildSeedGrillMessage("[DRAFT]", "make the game faster", "propose_goal_draft");
  assert.match(msg, /dynamic length/i);
});
