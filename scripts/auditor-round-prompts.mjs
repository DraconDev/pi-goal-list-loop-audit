// pi-goal-list-loop-audit — v0.39.43
// scripts/auditor-round-prompts.mjs
//
// The briefs the detached auditor resumes with: the falsification round's
// prompt and the continuation prompt after a tool call was cancelled at its
// budget.
//
// These are PRODUCT CONTRACTS, not worker internals: they decide what the
// auditor is asked to do, and they decide whether a round that lost a tool
// call still ends with a verdict. They live here, pure and exported, so the
// contract is directly assertable — a brief that quietly stopped demanding a
// final-line verdict, or stopped bounding a rework round's scope, would
// otherwise be invisible until a project looped on it in the field.
//
// The worker (scripts/goal-auditor-worker.mjs) owns the round MACHINE; the
// briefs themselves are data.

/** v0.38.76: marks the resume point of the falsification pass in the report
 * stream, so the report shows where round 1 ended and round 2 began. */
export const CHALLENGE_SEPARATOR = "\n\n--- auditor challenge round (falsification pass) ---\n\n";

/** v0.38.99: marks the resume point after a cancelled tool call, so the report
 * stream shows where the abort happened instead of reading as one run. */
export const CONTINUATION_SEPARATOR = "\n\n--- auditor continuation (tool call cancelled at its budget) ---\n\n";

/**
 * The scope rules a rework round shares with its falsification pass.
 *
 * v0.39.43 (field 2026-10-20/21): a rework round is a targeted re-check of
 * the OPEN OBJECTIONS. Without this bound the auditor re-ran the project's
 * whole verification suite — its browser-test harness, its full test run —
 * to re-establish what the prior round had already established. Each round
 * then cost more wall time than the last, and a transient provider blip
 * destroyed the whole thing, so the recovery machinery started the next
 * round: the audit churned the project's test suites, saturated the host, and
 * starved itself. The bound does NOT narrow what may block approval — a new
 * defect inside the changed paths still blocks, because the CHANGE SCOPE
 * contract in the original brief still applies.
 */
export const REWORK_SCOPE_RULES = [
  "- VERIFY THE OPEN OBJECTIONS, NOT THE WHOLE CHANGE. Do not re-run the project's full verification suite, its whole test run, or its end-to-end harness to re-establish what the prior round already established. Check each open objection with the narrowest command that produces evidence for it (the single test, the single file, the single command the objection names).",
  "- The prior round's evidence still stands. If a prior objection is closed, say so and quote the narrow check that closes it. Re-verify only what the objection requires.",
];

/**
 * v0.39.70: the falsification pass on a FIRST (non-rework) round.
 *
 * Round 2 is a fresh process: it sees the first-pass REPORT but none of its
 * tool output, and "re-verify the load-bearing claims" used to mean re-running
 * the project's whole verification suite a second time. Field record: the
 * challenge round is where audits stalled on a full-suite bash call past the
 * per-tool budget (the worker aborted and the approval was lost). The pass
 * stays adversarial — it is scoped to the cheapest evidence that can falsify
 * the approval, and to the GLLA gate receipts that already prove the suite.
 */
export const FIRST_ROUND_CHALLENGE_SCOPE_RULES = [
  "FALSIFY CHEAPLY — scope for this pass:",
  "- Do NOT re-run the project's full verification suite, its whole test run, its end-to-end harness, or any command listed under GLLA GATE RECEIPTS in the brief. GLLA ran those itself against this tree; re-running them proves nothing new and can exceed your per-tool budget.",
  "- Target the load-bearing claims in the first-pass report: open the files and lines it cites and confirm they say what the report says, and run the single narrowest command (one test file, one grep) for any claim you doubt.",
  "- Independent read-only checks (read/grep/find/ls of different files) may be issued together in one turn.",
];

export function buildChallengePrompt(originalPrompt, round1Output, reworkRound) {
  return [
    "AUDITOR CHALLENGE ROUND (falsification pass).",
    "",
    "A first-pass auditor already APPROVED the completion below. Approvals can be wrong — your job is to try to prove this one wrong. Re-verify the load-bearing claims with your own tool calls; do not trust the first report's assertions without checking them.",
    "",
    "ORIGINAL AUDIT BRIEF (verbatim):",
    originalPrompt,
    "",
    "FIRST-PASS REPORT (verbatim):",
    round1Output,
    "",
    ...(reworkRound ? [
      "REWORK ROUND — this claim was disapproved before, and the open objections are listed in the original brief above.",
      "- Your primary target is the OPEN OBJECTIONS: try to prove that the prior objections are NOT actually closed.",
      "- Do NOT re-verify the whole change from scratch, and do NOT re-run the project's full verification suite, its whole test run, or its end-to-end harness. The first pass established that part already.",
      "- Check the open objections with the narrowest command that produces evidence for them.",
    ] : [
      ...FIRST_ROUND_CHALLENGE_SCOPE_RULES,
    ]),
    "RULES:",
    "- If you find ANY genuine gap between the completion claim and the evidence (missing artifact, failing check, untested contract item, hallucinated file, evidence that does not actually show what the report claims), list the concrete gaps, then end your report with a single final line exactly: <disapproved/>",
    "- If the completion genuinely holds up after your adversarial re-check, end with a single final line exactly: <approved/>",
    "- The final non-empty line is the ONLY authoritative verdict location. Do not emit verdict markers anywhere else.",
  ].join("\n");
}

export function buildContinuationPrompt(args) {
  const { originalPrompt, completedToolCalls = [], cancelled, timeoutLabel } = args;
  return [
    "AUDITOR CONTINUATION AFTER A CANCELLED TOOL CALL.",
    "",
    "Your previous turn was cut short: a tool call exceeded its time budget and was cancelled. Everything you had already verified in that turn is still valid and listed below — do not redo it.",
    "",
    "ORIGINAL AUDIT BRIEF (verbatim):",
    originalPrompt,
    "",
    "TOOL CALLS YOU COMPLETED BEFORE THE CANCELLATION:",
    completedToolCalls.length > 0
      ? completedToolCalls.map((call) => `- ${call.name}: ${call.argsPrefix}`).join("\n")
      : "(none)",
    "",
    "CANCELLED TOOL CALL:",
    `- ${cancelled.name}: ${cancelled.argsPrefix} (cancelled after ${timeoutLabel})`,
    "",
    "RULES:",
    "- The cancelled call produced NO usable result. Treat that specific piece of verification as UNKNOWN — say so plainly; never assert what it would have shown.",
    "- Re-run that one check yourself with a bounded, cheaper command (target the single test, or a short timeout) if you need its result to decide.",
    "- Everything else you already established stands. Do not restart the whole audit from scratch.",
    "- End with a single final line exactly: <approved/> or <disapproved/> as your evidence supports. That final non-empty line is the ONLY authoritative verdict location.",
  ].join("\n");
}
