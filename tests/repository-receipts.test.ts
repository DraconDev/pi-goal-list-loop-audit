import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildRichTerminalParts, composeRichTerminalLines } from "../extensions/completion-summary.js";

const receipt = "Ledger: Four fix entries were checked; the append-only guard preserved the original record while adding the verified findings (docs/audits/2026-09-16-project-audit.md).";
function render(chat: boolean, findings: string[], proofs?: string[]) {
  return composeRichTerminalLines(buildRichTerminalParts({
    chat, outcome: "Save ordering corrected.", details: [], countsLine: "", groups: [
      { title: "Process", findings, tests: proofs },
      { title: "Engine", findings: ["Behavior: Dash uses 4/285/1000; tier1–4 and helpers/contracts remain checked."] },
    ],
  })).join("\n");
}

test("repository-only findings are archive-only, without empty chat groups", () => {
  const chat = render(true, [receipt]);
  assert.doesNotMatch(chat, /Process|Ledger|Four fix entries|docs\/audits/);
  assert.match(chat, /#### 1\. Engine/);
  assert.ok(render(false, [receipt]).includes("Four fix entries were checked"));
  assert.match(chat, /4\/285\/1000/);
  assert.match(chat, /helpers\/contracts/);
});

test("repository receipt stays archival while substantive ledger fixes remain visible", () => {
  const substantive = "Ledger corruption: Concurrent writes lost records; serialized writes now preserve account state.";
  assert.match(render(true, [substantive]), /Concurrent writes lost records/);
  const withProof = render(true, [substantive], ["Concurrent-write regression checked."]);
  assert.match(withProof, /Concurrent writes lost records/);
  assert.doesNotMatch(withProof, /Concurrent-write regression checked/);
});

test("flat receipts are archive-only while limitations remain visible", () => {
  const input = { outcome: "Work delivered.", details: [receipt, "Unresolved: 4 skipped tests remain; 10 spec checks are partial."], countsLine: "" };
  const chat = composeRichTerminalLines(buildRichTerminalParts({ ...input, chat: true })).join("\n");
  const archive = composeRichTerminalLines(buildRichTerminalParts(input)).join("\n");
  assert.doesNotMatch(chat, /Four fix entries/);
  assert.match(chat, /4 skipped tests remain; 10 spec checks are partial/);
  assert.match(archive, /Four fix entries/);
});


test("mixed receipt vocabulary never deletes repairs or unperformed checks", () => {
  const cases = [
    "Ledger corruption: Concurrent writes lost records; serialized writes now preserve account state and the regression was checked.",
    "Ledger: Four fix entries were checked; live validation was not performed because credentials are unavailable.",
    receipt + " Live validation awaits credentials.",
    "Ledger: Four fix entries were checked; production coverage is unknown.",
    "Ledger: Four fix entries were checked; serialization prevents data loss.",
  ];
  for (const finding of cases) {
    for (const grouped of [true, false]) {
      const args = { outcome: "Persistence improved.", countsLine: "", details: grouped ? [] : [finding],
        groups: grouped ? [{ title: "Persistence", findings: [finding] }] : undefined };
      for (const chat of [true, false]) {
        const text = composeRichTerminalLines(buildRichTerminalParts({ ...args, chat })).join("\n");
        const body = finding.slice(finding.indexOf(":") + 1).trim();
        assert.ok(text.includes(body), `${grouped ? "grouped" : "flat"} ${chat ? "chat" : "archive"} lost: ${finding}`);
      }
    }
  }
});

test("archive keeps unknown proof; chat keeps the detailed narrative focused", () => {
  for (const proof of ["Live validation was not performed because credentials are unavailable.", "Coverage awaits a production account.", "Concurrent-write regression checked."]) {
    assert.ok(render(false, [receipt], [proof]).includes(proof));
    assert.doesNotMatch(render(true, [receipt], [proof]), new RegExp(proof.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
