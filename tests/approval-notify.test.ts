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
// The approval voice is now outcome + all bounded informing details +
// approval + record pointer, with the stale Next stripped on every
// approval surface. The v0.38.20 two-detail cap was deliberately lifted:
// trimming Tests/Unresolved hid the proof the user asked for, and the
// filler filter upstream (briefValueContent) already keeps the chat
// glanceable by dropping content-free labels.

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
    "• Changed: sendContinuation bypass",
    "• Evidence: full gate 1917 pass",
    "• completion audit approved on the provider retry.",
    "• record: .pi-glla/archive/20260904162433-qm4iq0.md",
  ]);
});

test("approval chat keeps every informing detail (Tests + meaningful Unresolved preserved)", () => {
  const lines = buildApprovalChatLines({
    outcome: "done",
    details: ["Changed: a", "Evidence: b", "Tests: c", "Unresolved: d"],
    approval: "— auditor m approved.",
    record: "— record: x.md",
  });
  assert.deepEqual(lines, [
    "✓ done — done",
    "• Changed: a",
    "• Evidence: b",
    "• Tests: c",
    "• Unresolved: d",
    "• completion audit approved.",
    "• record: x.md",
  ]);
});

test("v0.38.39 withoutStaleNext keeps one concrete next action, still strips stale ones", () => {
  assert.deepEqual(
    withoutStaleNext(["Changed: a", "  next: something pending.", "NEXT: more", "Next-step: hyphenated is not the label"]),
    ["Changed: a", "  next: something pending.", "Next-step: hyphenated is not the label"],
    "first concrete Next survives; the second is capped",
  );
  assert.deepEqual(
    withoutStaleNext(["Changed: a", "Next: detached auditor verdict decides.", "Next: awaiting approval.", "Next: reload the extension"]),
    ["Changed: a", "Next: reload the extension"],
    "self-referential audit/process lines drop, the concrete action survives",
  );
  assert.deepEqual(withoutStaleNext(undefined), []);
  assert.deepEqual(withoutStaleNext([]), []);
});
