import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDurableDeferRecommendation,
  DURABLE_DEFER_PLAQUE_ORDER,
  formatDurableDeferPolicyLine,
  LONG_RUNNING_JUDGMENT_POLICY,
} from "../extensions/goal-loop-core.ts";

describe("defer vs durable — semantic recommendation ordering", () => {
  test("v0.38.71: imperative fix verbs do not double against the plaque verb (field UI-SURVEY-2026-09-20)", () => {
    const inline = buildDurableDeferRecommendation({
      durableFix: "Implement Keep sticky/search grouping as typed components",
      deferRecommendations: ["use only when unsafe"],
    });
    assert.match(inline.plaques[0]?.body ?? "", /^Implement sticky\/search grouping as typed components now/);
    assert.doesNotMatch(inline.plaques[0]?.body ?? "", /Implement Implement|Implement Keep/);
    const deferred = buildDurableDeferRecommendation({
      durableFix: "Keep the cleared-segment contract",
      deferRecommendations: ["use only when unsafe"],
      durableBlocked: true,
    });
    assert.match(deferred.plaques[0]?.body ?? "", /^Keep the cleared-segment contract as the follow-up/);
  });
  test("three defer recommendations still select the safe durable action first", () => {
    const recommendation = buildDurableDeferRecommendation({
      durableFix: "pin plaque ordering",
      deferRecommendations: [
        "defer until the next pass",
        "use a cosmetic workaround",
        "wait for another review",
      ],
    });

    assert.equal(recommendation.deferCount, 3);
    assert.equal(recommendation.choice, "inline");
    assert.deepEqual(
      recommendation.plaques.map((plaque) => plaque.kind),
      [...DURABLE_DEFER_PLAQUE_ORDER],
    );
    assert.equal(recommendation.plaques[0]?.recommended, true);
    assert.equal(recommendation.plaques[1]?.recommended, false);
    assert.match(recommendation.plaques[0]?.body ?? "", /pin plaque ordering/);
    assert.match(recommendation.plaques[0]?.body ?? "", /prior defer recommendations do not move it behind/i);
  });

  test("only an explicit blocked fact selects the reversible defer plaque", () => {
    const recommendation = buildDurableDeferRecommendation({
      durableFix: "migrate the durable store",
      deferRecommendations: ["temporary workaround", "small patch", "wait"],
      durableBlocked: true,
    });

    assert.equal(recommendation.choice, "deferred");
    assert.equal(recommendation.plaques[0]?.recommended, false);
    assert.equal(recommendation.plaques[1]?.recommended, true);
  });

  test("the policy is generated from the same semantic three-defer path", () => {
    const line = formatDurableDeferPolicyLine();
    assert.match(line, /after 3 defer recommendations/);
    assert.match(line, /inline choice is still the durable fix, not a defer/i);
    assert.match(line, /semantic order durable → defer/);
    assert.match(LONG_RUNNING_JUDGMENT_POLICY, /semantic order durable → defer/);
    assert.match(LONG_RUNNING_JUDGMENT_POLICY, /N=31.*i%2.*wrap/i);
    assert.match(LONG_RUNNING_JUDGMENT_POLICY, /the-ember-throne/i);
    assert.match(LONG_RUNNING_JUDGMENT_POLICY, /the-frost-beneath/i);
  });
});
