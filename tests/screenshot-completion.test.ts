import { test } from "node:test";
import * as assert from "node:assert/strict";
import { CARD_SECTION, extractEvidenceTokens } from "../extensions/completion-summary.js";
import { screenshotCases, renderScreenshotCase } from "./fixtures/screenshot-completion.js";

// These fixtures reproduce real completion cards (2026-09-16 screenshots).
// Field 2026-11-11 reshaped the card into one report — headline, lede,
// `Summary` with per-area subsections, always-on `Verification`, follow-ups,
// next steps, one receipt line — so the assertions below speak that
// vocabulary. Every protection is unchanged: no empty-parenthesis husks, no
// double-folded evidence tokens, no repository bookkeeping as a human
// finding, truthful verification wording, and the archive retaining the
// receipt text.

for (const example of screenshotCases) test(`screenshot-derived ${example.name} keeps explanations and truthful checks`, () => {
  const { chat, archive } = renderScreenshotCase(example);
  assert.match(chat, new RegExp(`^## Done \\u2014 `));
  // Textual husks after token extraction never reach a reader; the archive's
  // evidence TABLE is legitimate here (it is the archive's shape, not chat's).
  assert.doesNotMatch(chat, /\(\s*[,;]\s*\d|\(\s*\)/);
  assert.doesNotMatch(chat, /Final Repository State/);
  assert.equal((chat.match(/completion audit approved/g) ?? []).length, 1, "the verdict is stated once");
  assert.doesNotMatch(chat, /docs\/audits\/2026-09-16-project-audit\.md|Four fix entries were checked|closure record was corrected/);
  assert.ok(chat.includes(example.limitation), "the limitation is reported verbatim");
  assert.ok(chat.includes(example.leftOut), "the deliberate non-do is reported verbatim");
  for (const group of example.groups) {
    if (group.title === "Process") assert.doesNotMatch(chat, /Process/);
    else assert.ok(chat.includes(group.title), `the work area is named: ${group.title}`);
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
        const [outcome = "", reason] = explanation.split(/\s+[—–]\s+/, 2);
        assert.ok(chat.includes(outcome.trim()), `primary user-visible outcome retained: ${outcome}`);
        if (reason) assert.ok(chat.includes(reason.trim()), `concrete reason retained: ${reason}`);
      }
      for (const token of evidence) assert.ok(archive.includes(token), `archive retains ${token}`);
    }
  }
  // Verification is part of the report on both surfaces; the archive keeps
  // each historical note verbatim and chat states the derived status.
  assert.ok(chat.includes(`## ${CARD_SECTION.verification}`), "chat carries the verification section");
  assert.doesNotMatch(chat, /^Tests:/m, "the raw Tests label stays archival");
  assert.doesNotMatch(chat, /\| Quality Gate/, "the wide inventory stays archival");
  for (const gate of example.gates) {
    assert.ok(archive.includes(gate.notes!), `archive retains gate notes: ${gate.notes}`);
    if (gate.command) assert.ok(archive.includes(gate.command));
  }
  // A historical failure must be visible in chat as a failure — the old rule
  // was "hide it unless asked"; the report states what was checked.
  if (example.gates.some((gate) => /\b[1-9]\d*\s+fail/.test(gate.notes ?? ""))) {
    assert.match(chat, /fail/i, "a failing gate is never hidden from the report");
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
