import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildApprovalChatLines,
  withoutStaleNext,
} from "../extensions/completion-summary.js";

// v0.38.20 (field 2026-09-04 19:20): the detached-approval chat notify
// reprinted the agent's pre-verdict recap verbatim — `Next: detached auditor
// verdict decides.` directly above `— auditor … approved.` — reading as
// complete-before-verify, and five 120-char label lines scanning as soup.
// The approval voice is now outcome + at most two details + approval +
// record pointer, with the stale Next stripped on every approval surface.

test("v0.38.20 approval chat drops the stale pre-verdict Next line", () => {
  const lines = buildApprovalChatLines({
    outcome: "v0.38.19 answers the disapproval",
    details: [
      "Changed: sendContinuation bypass",
      "Evidence: full gate 1917 pass",
      "Next: detached auditor verdict decides.",
    ],
    approval: "— auditor m approved on the provider retry.",
    record: "— record: .pi-glla/archive/20260904162433-qm4iq0.md",
  });
  assert.deepEqual(lines, [
    "✓ done — v0.38.19 answers the disapproval",
    "Changed: sendContinuation bypass",
    "Evidence: full gate 1917 pass",
    "— auditor m approved on the provider retry.",
    "— record: .pi-glla/archive/20260904162433-qm4iq0.md",
  ]);
});

test("v0.38.20 approval chat keeps at most two details", () => {
  const lines = buildApprovalChatLines({
    outcome: "done",
    details: ["Changed: a", "Evidence: b", "Tests: c", "Unresolved: d"],
    approval: "— auditor m approved.",
    record: "— record: x.md",
  });
  assert.equal(lines.length, 5);
  assert.ok(!lines.some((l) => l.startsWith("Tests:")), "third detail trimmed — the archive holds the rest");
});

test("v0.38.20 withoutStaleNext strips Next case-insensitively, keeps the rest", () => {
  assert.deepEqual(
    withoutStaleNext(["Changed: a", "  next: something pending.", "NEXT: more", "Next-step: hyphenated is not the label"]),
    ["Changed: a", "Next-step: hyphenated is not the label"],
  );
  assert.deepEqual(withoutStaleNext(undefined), []);
  assert.deepEqual(withoutStaleNext([]), []);
});
