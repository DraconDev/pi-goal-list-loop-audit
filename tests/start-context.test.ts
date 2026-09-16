import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  START_CONTEXT_MAX_CHARS,
  START_CONTEXT_MAX_ENTRIES,
  START_CONTEXT_MAX_TURNS,
  inferStartFromSession,
  inferStartObjective,
  isChatterReplacement,
  readBoundedStartContext,
  resolveTweakReplacement,
} from "../extensions/start-context.ts";

function message(role: "user" | "assistant", content: string): { type: "message"; message: { role: string; content: string } } {
  return { type: "message", message: { role, content } };
}

test("bare-start inference accepts one clear current request", () => {
  const result = inferStartObjective("Implement the login timeout fix", []);
  assert.deepEqual(result, {
    kind: "clear",
    objective: "Implement the login timeout fix",
    source: "current-prompt",
  });
});

test("bare-start inference ignores assistant text and generic acknowledgements", () => {
  const result = inferStartObjective("yes", [
    { role: "assistant", text: "Implement the dangerous unrelated cleanup" },
    { role: "user", text: "Fix the flaky login test" },
  ]);
  assert.deepEqual(result, {
    kind: "clear",
    objective: "Fix the flaky login test",
    source: "recent-context",
  });
});

test("bare-start inference deduplicates a repeated request", () => {
  const result = inferStartObjective("Fix the flaky login test", [
    { role: "user", text: "Fix the flaky login test" },
    { role: "assistant", text: "I will inspect it." },
  ]);
  assert.equal(result.kind, "clear");
  if (result.kind === "clear") assert.equal(result.objective, "Fix the flaky login test");
});

test("bare-start inference fails closed for two distinct requests", () => {
  const result = inferStartObjective("", [
    { role: "user", text: "Fix the flaky login test" },
    { role: "assistant", text: "Which test should change?" },
    { role: "user", text: "Update the deployment documentation" },
  ]);
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") {
    assert.equal(result.reason, "multiple-objectives");
    assert.deepEqual(result.candidates, ["Update the deployment documentation", "Fix the flaky login test"]);
    assert.match(result.seed ?? "", /deployment documentation/);
    assert.match(result.seed ?? "", /flaky login test/);
  }
});

test("bare-start inference falls back for vague or command-only context", () => {
  for (const prompt of ["fix it", "Could you fix it?", "Implement the thing", "Please investigate"]) {
    assert.deepEqual(inferStartObjective(prompt, []), {
      kind: "none",
      reason: "no-actionable-objective",
    }, prompt);
  }
  assert.deepEqual(inferStartObjective("/goal start", [
    { role: "user", text: "/loop status" },
    { role: "assistant", text: "Build the assistant's unrelated plan" },
  ]), {
    kind: "none",
    reason: "no-actionable-objective",
  });
});

test("bare-start inference marks a multi-task request ambiguous", () => {
  const result = inferStartObjective("Fix the login test and update the docs", []);
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.equal(result.reason, "unclear-objective");
});

test("bare-start inference preserves multiline task boundaries", () => {
  const result = inferStartObjective("- Fix the login test\n- Update the deployment docs", []);
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.equal(result.reason, "unclear-objective");
});

test("session reader uses only a bounded active-branch tail", () => {
  const entries = Array.from({ length: START_CONTEXT_MAX_ENTRIES + 4 }, (_, index) =>
    message("user", index === 0 ? "Implement the old task" : `say ${index}`),
  );
  entries.push(message("user", "Build the current task"));
  const window = readBoundedStartContext({ getBranch: () => entries });
  assert.ok(window.currentPrompt.includes("Build the current task"));
  assert.ok(window.recent.length <= START_CONTEXT_MAX_TURNS);
  assert.ok(window.recent.every((turn) => turn.text.length <= 800));
  assert.ok(window.recent.reduce((total, turn) => total + turn.text.length, 0) + window.currentPrompt.length <= START_CONTEXT_MAX_CHARS);
  assert.equal(inferStartFromSession({ getBranch: () => entries }).kind, "clear");
});

test("session reader fails closed when the host branch cannot be read", () => {
  const result = inferStartFromSession({
    getBranch: () => { throw new Error("stale session"); },
  });
  assert.deepEqual(result, { kind: "none", reason: "no-context" });
});

test("field 2026-09-16: chatter shapes divert, real objectives pass through", () => {
  for (const chatter of [
    "ok adjsut it",
    "ok adjust it",
    "go fix it",
    "go",
    "yes",
    "ok",
    "it",
    "fix it",
    "sure, do that",
    "yeah do it",
    "thanks, go ahead",
  ]) {
    assert.equal(isChatterReplacement(chatter), true, `chatter: ${chatter}`);
  }
  for (const real of [
    "new goal objective",
    "new paused goal objective. Done when: new proof",
    "ok, ship the release. Done when: npm latest reads 0.38.56",
    "Overhaul the Quick full setup overlay",
    "adjust the timeout to 30s",
  ]) {
    assert.equal(isChatterReplacement(real), false, `verbatim: ${real}`);
  }
});

test("field 2026-09-16: tweak chatter resolves to the discussed objective (VidPro replay)", () => {
  const manager = {
    getBranch: () => [
      message("assistant", "Three ways out: 1. Send the screenshot. 2. Waive that line — say /goal tweak to drop the live-screenshot requirement. 3. Leave it paused."),
      message("user", "remove the live screenshot requirement from the contract"),
      message("user", "/goal tweak ok adjsut it"),
    ],
  };
  const result = resolveTweakReplacement("ok adjsut it", manager);
  assert.equal(result.kind, "inferred");
  if (result.kind === "inferred") {
    assert.equal(result.text, "remove the live screenshot requirement from the contract");
    assert.equal(result.source, "recent-context");
  }
});

test("field 2026-09-16: tweak chatter with no discussed objective is unresolvable, never verbatim", () => {
  const result = resolveTweakReplacement("ok adjsut it", { getBranch: () => [] });
  assert.deepEqual(result, { kind: "unresolvable", reason: "none", candidates: [] });
});

test("field 2026-09-16: tweak chatter over competing requests surfaces candidates", () => {
  const manager = {
    getBranch: () => [
      message("user", "Fix the flaky login test"),
      message("user", "Ship the release notes"),
    ],
  };
  const result = resolveTweakReplacement("go fix it", manager);
  assert.equal(result.kind, "unresolvable");
  if (result.kind === "unresolvable") {
    assert.equal(result.reason, "ambiguous");
    assert.ok(result.candidates.length >= 2);
  }
});
