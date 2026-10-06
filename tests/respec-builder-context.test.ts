import { test } from "node:test";
import assert from "node:assert/strict";
import { createRespecBuilder, adoptRespecRequirements } from "../extensions/respec-builder.js";
import { respecBuilderContext, MAX_RESPEC_CONTEXT_CHARS } from "../extensions/respec-builder-context.js";
import { loopPrompt } from "../extensions/goal-loop.js";
import type { LoopState } from "../extensions/goal-loop-forever.js";

test("actual project dispatch bounds repeated reports while retaining complete adopted criteria", () => {
  const report = "Required fixes\n" + "measured audit evidence\n".repeat(20000) + "Final required fix";
  const builder = adoptRespecRequirements(createRespecBuilder("Build the intended project"),
    [1, 2, 3].map(id => ({ id: `R${id}`, text: `Capability ${id}`, acceptance: `Exact acceptance ${id}` })));
  builder.requirements = builder.requirements.map(r => ({ ...r, status: "verified", evidence: { attemptId: "audit-proof", model: "provider/model", report } }));
  builder.history = [1, 2, 3].map(cycle => ({ cycle, tasks: [], outcome: "approved", report, attemptId: `audit-${cycle}` }));
  builder.feedback = [report, report];
  const before = JSON.stringify(builder);
  const prompt = loopPrompt({ builder, iteration: 3 } as LoopState, "", "", "");
  const json = prompt.match(/<builder_state>\n([\s\S]*?)\n<\/builder_state>/)![1]!;
  assert.ok(json.length <= MAX_RESPEC_CONTEXT_CHARS);
  const projected = JSON.parse(json);
  assert.deepEqual(projected.requirements.map((r: { acceptance: string }) => r.acceptance), builder.requirements.map(r => r.acceptance));
  assert.match(projected.history[0].report, /Required fixes/);
  assert.match(projected.history[0].report, /Final required fix/);
  assert.equal(projected.contextProjection.historyEntriesOmitted, 2);
  assert.ok(projected.requirements.every((r: { evidence: { reportReference: string } }) => r.evidence.reportReference.includes("active.jsonl")));
  assert.equal(JSON.stringify(builder), before, "durable evidence stays complete and untouched");
});

test("oversized contracts require durable reads and always serialize within the hard limit", () => {
  const builder = adoptRespecRequirements(createRespecBuilder("vision"), [{ id: "R", text: "Capability", acceptance: "binding acceptance".repeat(50000) }]);
  builder.feedback = ["\u0000".repeat(100000)];
  builder.history = [{ cycle: 1, tasks: [], outcome: "needs-work", report: "\u0000".repeat(100000) }];
  const serialized = respecBuilderContext(builder);
  assert.ok(serialized.length <= MAX_RESPEC_CONTEXT_CHARS);
  const projected = JSON.parse(serialized);
  assert.equal(projected.contextProjection.contractOmitted, true);
  assert.match(projected.contextProjection.instruction, /STOP/);
  assert.match(projected.contextProjection.authority, /active.jsonl/);
  assert.ok(builder.requirements[0]!.acceptance.length > MAX_RESPEC_CONTEXT_CHARS);
});
