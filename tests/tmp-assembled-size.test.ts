import { test } from "node:test";
import { continuationPrompt } from "../extensions/goal-continuation.ts";
import { seedGoal } from "./harness/mock-pi.js";

test("tmp: measure the assembled prompt", () => {
  const goal = seedGoal({
    id: "g", objective: "Run ONE project audit pass and leave the project in a known state. Survey the project.",
    verificationContract: "every finding raised", status: "active",
    auditHistory: [{ at: "t", approved: false, disapproved: true, model: "m", report: "## Required fixes\n1. fix it" }],
  }) as any;
  const p = continuationPrompt(goal as never, {} as never) as unknown as string;
  const count = (n: string) => (p.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
  console.log(`ASSEMBLED ${p.length} bytes ~${Math.round(p.length / 3.5)} tokens`);
  for (const n of ["root-cause architectural fixes", "after 2 attempts", "lower test standards",
                   "Batch 2.4 sharp questions UP FRONT", "Batch 2.4 critical scope/acceptance",
                   "UNATTENDED autonomous mode", "never ask a vague progress", "do not resume on a missing permission"])
    console.log(`  ${count(n)}x  ${n}`);
});
