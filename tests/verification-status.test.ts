import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildRichTerminalParts } from "../extensions/completion-summary.js";

const cases = [
  ["Unit tests: 10 passed, 0 failed; integration: 2 failed, 3 passed.", "FAIL"],
  ["Integration did not pass; credentials are unavailable and validation remains incomplete.", "REPORTED"],
  ["3 passed, 1 failed; rerun 4 passed, 0 failed.", "FAIL"],
  ["10 passed, 0 failed.", "PASS"],
  ["10 passed, 0 failures; integration 2 failures.", "FAIL"],
  ["4 skipped, 0 failed.", "REPORTED"],
  ["Not run: credentials unavailable.", "REPORTED"],
  ["The suite never passed.", "REPORTED"],
  ["The suite hasn't passed.", "REPORTED"],
  ["No tests passed.", "REPORTED"],
  ["0 passed, 0 failed.", "REPORTED"],
  ["Validation will pass after credentials arrive.", "REPORTED"],
  ["PASS expected, validation pending.", "REPORTED"],
  ["10 passed, 2 skipped, 0 failed.", "PASS"],
  ["Password checks: 10 passed, 0 failed.", "PASS"],
  ["Clean exit 0.", "REPORTED"],
  ["Credentials missing; suite unable to pass.", "REPORTED"],
  ["Suite refused to pass.", "REPORTED"],
  ["PASS", "PASS"],
  ["All tests passed.", "PASS"],
  ["0 fail", "REPORTED"],
  ["Unit tests: 10 passed, 0 failed; integration suite unable to pass because credentials are missing.", "REPORTED"],
  ["10 passed, 0 failed; integration exited with code 1.", "FAIL"],
  ["10 passed, 0 failed; integration: 2 errors.", "FAIL"],
  ["10 passed, 0 failed; integration status is unknown.", "REPORTED"],
  ["10 passed, 0 failed; integration awaits credentials.", "REPORTED"],
  ["10 passed because the results were fabricated, 0 failed.", "REPORTED"],
  ["10 passed, 0 failed (integration was omitted).", "REPORTED"],
  ["10 passed, 0 failed; integration: 3 passed, 0 failed.", "PASS"],
  ["integration: 3 passed, 0 failed; unit tests: 10 passed, 0 failed.", "PASS"],
  ["10 passed, 0 failed; integration exited with code 0.", "REPORTED"],
  ["10 passed, 0 failed; 1 error, 0 errors on rerun.", "FAIL"],
  ["10 passed, 0 failed; integration exited with code -1.", "FAIL"],
] as const;

for (const [notes, expected] of cases) {
  test(`verification status ${expected}: ${notes}`, () => {
    for (const chat of [true, false]) for (const inventory of [true, false]) {
      const parts = buildRichTerminalParts({
        chat, outcome: "Validation recorded.", countsLine: "",
        details: inventory ? [] : [`Tests: ${notes}`],
        gates: inventory ? [{ gate: "Verification", notes, command: "fixture-only command" }] : undefined,
      });
      const row = parts.tableLines.find(line => line.startsWith(inventory ? "| Verification |" : "| Tests |"));
      assert.ok(row, "production verification row exists");
      const cells = row.split("|").map(cell => cell.trim());
      const status = cells[inventory ? (chat ? 3 : 4) : 2];
      assert.equal(status, expected, `${chat ? "chat" : "archive"}/${inventory ? "gate" : "legacy"}: ${row}`);
      assert.ok(row.includes(notes), "original notes survive unchanged");
    }
  });
}
