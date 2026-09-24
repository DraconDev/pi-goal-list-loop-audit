import { test } from "node:test";
import * as assert from "node:assert/strict";
import { extractEvidenceTokens } from "../extensions/completion-summary.js";
import { screenshotCases, renderScreenshotCase } from "./fixtures/screenshot-completion.js";

for (const example of screenshotCases) test(`screenshot-derived ${example.name} keeps explanations and truthful checks`, () => {
  const { chat, archive } = renderScreenshotCase(example);
  assert.match(chat, /^## Done — /);
  assert.doesNotMatch(chat, /\(\s*[,;]\s*\d|\(\s*\)|\| Area \| Finding|\| Command \||Final Repository State/);
  assert.equal((chat.match(/auditor approved/g) ?? []).length, 1);
  assert.doesNotMatch(chat, /docs\/audits\/2026-09-16-project-audit\.md|Four fix entries were checked|closure record was corrected/);
  assert.ok(chat.includes(example.limitation));
  assert.ok(chat.includes(example.leftOut));
  for (const group of example.groups) {
    if (group.title === "Process") assert.doesNotMatch(chat, /#### \d+\. Process/);
    else assert.ok(chat.includes(group.title));
    for (const finding of group.findings) {
      const { text, evidence } = extractEvidenceTokens(finding);
      const narrative = text.slice(text.indexOf(":") + 1).trim().replace(/\s*\([,\s]*commit [a-f0-9]+\)\.?$/, "");
      // Explicit expectations for the historical receipts, not a production
      // classifier import that would make this a self-fulfilling assertion.
      if (/^(Ledger|Traceability repair):/.test(finding)) {
        assert.doesNotMatch(chat, /\*\*(Ledger|Traceability repair)\*\*/);
        assert.ok(archive.includes(narrative), "archive retains repository receipt");
      } else {
        const explanation = narrative.replace(/\s*\([^()]*\.(?:ts|md)\)\.?$/, "");
        assert.ok(chat.includes(explanation), `complete explanatory clause retained: ${explanation}`);
      }
      for (const token of evidence) assert.ok(archive.includes(token), `archive retains ${token}`);
    }
  }
  // Chat hides technical verification by default; the archive retains each
  // historical gate note and command for auditability.
  assert.doesNotMatch(chat, /^### Verification/m);
  assert.doesNotMatch(chat, /^Tests:/m);
  assert.doesNotMatch(chat, /\| Quality Gate/);
  for (const gate of example.gates) {
    assert.ok(archive.includes(gate.notes!));
    if (gate.command) assert.ok(archive.includes(gate.command));
  }
  if (example.gates.some((gate) => /\b[1-9]\d*\s+fail/.test(gate.notes ?? ""))) {
    assert.doesNotMatch(chat, /^### Verification/m);
  }
});

test("multi-line citation extraction consumes the complete reference, not just its first line", () => {
  for (const ref of ["src/lib/game/phaser/run-scene.ts:672,2760", "src/routes/+page.svelte:180, 282-290", "SPEC.md:67,74", "file.ts:10–12, 20"]) {
    const result = extractEvidenceTokens(`Meaningful explanation (${ref}).`);
    assert.equal(result.text, "Meaningful explanation.");
    assert.deepEqual(result.evidence, [ref]);
  }
  assert.equal(extractEvidenceTokens("Keep the numerical limitation (3,2760).").text, "Keep the numerical limitation (3,2760).");
});
