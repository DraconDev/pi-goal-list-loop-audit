import type { Goal } from "./goal-loop-core.js";
import type { RespecBuilderState } from "./respec-builder.js";

/** Use the existing isolated goal auditor contract without installing a live goal. */
export function respecIncrementAuditGoal(builder: RespecBuilderState, loopId: string, at: string): Goal {
  if (builder.phase !== "auditing" || !builder.audit) throw new Error("No respec increment awaiting audit.");
  const selected = new Set(builder.audit.requirementIds);
  const requirements = builder.requirements.filter(r => selected.has(r.id));
  const regression = builder.requirements.filter(r => r.status === "verified" && !selected.has(r.id));
  if (!requirements.length) throw new Error("Audit has no requirements.");
  const describe = (r: typeof requirements[number]) => `${r.id}: ${r.text}\nAcceptance: ${r.acceptance}`;
  return {
    id: `${loopId}:cycle-${builder.cycle}:revision-${builder.revision}`,
    objective: `Independently verify this project increment toward: ${builder.vision}\n\nRequired capabilities:\n${requirements.map(describe).join("\n\n")}\n\nCheck the actual implementation and behavior. This is an increment, not a claim that unselected project requirements are complete.`,
    verificationContract: [...requirements.map(describe), ...regression.map(r => `Regression — ${describe(r)}`)].join("\n\n"),
    status: "auditing", policy: "goal", autoContinue: false,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: builder.audit.at, updatedAt: builder.audit.at, revision: builder.revision,
    pendingCompletion: { completionSummary: builder.audit.claim, at: builder.audit.at, attemptId: builder.audit.attemptId },
  };
}
