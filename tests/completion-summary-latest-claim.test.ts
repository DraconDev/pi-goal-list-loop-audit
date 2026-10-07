import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildRichArchiveSection, buildTerminalApprovalRender, humanCompletionBrief } from "../extensions/completion-summary.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import { seedGoal } from "./harness/mock-pi.js";

function recap(count: number, structured = false): string {
  const sections = structured ? `\n## Repairs\nDelivered ${count} corrections.\n## Limits\nAggregate intermittency remains.` : "";
  return `Outcome: Delivered ${count} committed fixes.${sections}\nChanged: ${count} repaired boundaries.\nEvidence: ${count} checked findings.\nTests: ${count} focused cases passed.\nUnresolved: Aggregate intermittency remains.\nNext: Investigate aggregate intermittency.`;
}
function approvedGoal(summary: string): Goal {
  return seedGoal({
    status: "complete", objective: "Repair the audited boundaries", completionSummary: summary,
    auditHistory: [
      { at: "2026-10-07T08:00:00Z", approved: false, disapproved: true, model: "fixture" },
      { at: "2026-10-07T09:00:00Z", approved: true, disapproved: false, model: "fixture" },
    ],
  }) as unknown as Goal;
}

for (const structuredPrior of [false, true]) {
  for (const structuredLatest of [false, true]) {
    test(`approved claim owns final surfaces (prior structured=${structuredPrior}, latest structured=${structuredLatest})`, () => {
      const previous = recap(5, structuredPrior);
      const latest = recap(6, structuredLatest);
      const goal = approvedGoal(latest);
      const render = buildTerminalApprovalRender({
        goal, status: "complete", approval: "completion audit approved", record: "record.md",
        completionSummary: latest, priorCompletionSummary: previous,
      });
      const chat = render.chatLines.join("\n");
      assert.match(chat.split("\n")[0]!, /Delivered 6 committed fixes/);
      assert.doesNotMatch(chat, /Delivered 5|5 repaired|5 checked|Delivered 5 corrections/);
      assert.equal((chat.match(/6 repaired boundaries/g) ?? []).length, 1);
      assert.equal((chat.match(/6 checked findings/g) ?? []).length, 1);
      assert.match(render.recap, /Delivered 6/);
      assert.doesNotMatch(render.transcriptLines.join("\n"), /Delivered 5|5 repaired|5 checked/);
      if (structuredLatest) assert.match(chat, /Delivered 6 corrections/);
      else assert.doesNotMatch(chat, /### Summary/);
      const archive = buildRichArchiveSection(goal, "complete", "record.md", undefined, undefined, previous).join("\n");
      const finalSection = archive.split("## Original completion claim (verbatim)")[0]!;
      assert.match(finalSection.split("\n")[0]!, /Delivered 6 committed fixes/);
      assert.doesNotMatch(finalSection, /Delivered 5|5 repaired|5 checked/);
      assert.ok(archive.includes(previous), "historical claim survives verbatim in the forensic section");
      assert.match(archive, /## Original completion claim \(verbatim\)/);
      assert.equal(goal.completionSummary, latest, "rendering never mutates the approved claim");
      assert.equal(goal.auditHistory?.length, 2, "rejected verdict history is retained");
    });
  }
}

test("human brief never concatenates rejected-claim details into approved details", () => {
  const result = humanCompletionBrief(recap(6), 140, 10000, recap(5));
  assert.match(result.outcome, /Delivered 6/);
  assert.equal(result.details.filter(line => line.startsWith("Changed:")).length, 1);
  assert.equal(result.details.filter(line => line.startsWith("Evidence:")).length, 1);
  assert.equal(result.details.filter(line => line.startsWith("Unresolved:")).length, 1);
  assert.doesNotMatch(result.details.join("\n"), /5 repaired|5 checked/);
});
