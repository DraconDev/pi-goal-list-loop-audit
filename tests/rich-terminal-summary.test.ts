// pi-goal-list-loop-audit — rich terminal voice (field 20260911_003839 /
// 003903 / 003907): the Antigravity close — section headers, numbered
// findings with bold leads + code refs, a verification table — replaces
// the flat six-bullet card on the terminal render only. Archive carries
// the same rich markdown over the verbatim six-label machine record.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { sanitizeFindingGroups, type FindingGroup, type Goal } from "../extensions/goal-loop-core.js";
import {
  buildDurationLine,
  buildFinalRepoStateLines,
  buildRichArchiveSection,
  buildRichTerminalParts,
  buildTerminalApprovalRender,
  extractEvidenceTokens,
  takeBudgetedGroups,
} from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

const SIX = [
  "Outcome: shipped the rich terminal voice",
  "Changed: extensions/completion-summary.ts and extensions/loops/goal-orchestrator.ts",
  "Evidence: gate green plus release v9.9.9",
  "Tests: bun test 2075 pass, 0 fail",
  "Unresolved: none",
  "Next: replay on next contact",
].join("\n");

function richGoal(): Goal {
  return seedGoal({
    id: "20260911-rich-voice",
    objective: "restyle the terminal summary",
    completionSummary: SIX,
    telemetry: { turns: 9, fileWrites: 4, bashCalls: 2 },
    auditHistory: [
      { at: "2026-09-11T00:00:00.000Z", approved: true, disapproved: false, model: "auditor-model", report: "fine" },
    ],
  }) as unknown as Goal;
}

function render(extra: Record<string, unknown> = {}) {
  return buildTerminalApprovalRender({
    goal: richGoal(),
    status: "complete",
    stopReason: "auditor approved (detached)",
    archivePath: ".pi-glla/archive/20260911-rich-voice.md",
    approval: "— auditor auditor-model approved.",
    record: "— record: .pi-glla/archive/20260911-rich-voice.md",
    ...extra,
  });
}

test("card opens with a verdict banner, then the request-echo Done headline and numbered Key Findings", () => {
  const { chatLines } = render();
  assert.equal(chatLines[0], "## Done — auditor approved (1 verdict)", `verdict banner opens the card, got: ${chatLines[0]}`);
  assert.ok((chatLines[2] ?? "").startsWith("## Done: restyle the terminal summary — "), `headline echoes the request, got: ${chatLines[2]}`);
  const findingsIdx = chatLines.findIndex((l) => l === "### Key Findings & Remediation");
  assert.ok(findingsIdx > 0, "findings section present");
  assert.match(chatLines[findingsIdx + 1] ?? "", /^1\. \*\*Changed\*\* — /, "numbered bold lead with em-dash body");
  assert.match(chatLines[findingsIdx + 2] ?? "", /^2\. \*\*Evidence\*\* — /, "second finding numbered");
  assert.ok(chatLines.some((l) => /extensions\/completion-summary\.ts/.test(l)), "code refs ride the finding bodies");
});

test("verification always renders the full table — the PASS-line collapse is retired", () => {
  const { chatLines } = render();
  assert.ok(chatLines.includes("### Verification Summary"), "table renders even when every row is green");
  assert.ok(chatLines.some((l) => /^\| Tests \| PASS \|/.test(l)), "green Tests row present");
  assert.ok(chatLines.some((l) => /^\| Audit \|.*APPROVED \u00d71/.test(l)), "the audit verdict rides its own row");
  assert.ok(!chatLines.some((l) => l.startsWith("\u2014 Verification passed")), "no PASS line stands in for the table");
  // Findings-first: the table rides after the findings, before Next.
  const findingsIdx = chatLines.indexOf("### Key Findings & Remediation");
  const tableIdx = chatLines.indexOf("### Verification Summary");
  const nextIdx = chatLines.indexOf("### Next");
  assert.ok(findingsIdx !== -1 && findingsIdx < tableIdx && tableIdx < nextIdx, "findings precede verification, Next closes the card");
});

test("Tests row reports FAIL on nonzero failures and pipes never break the table", () => {
  const failing = render({
    goal: seedGoal({
      id: "20260911-rich-fail",
      objective: "x",
      completionSummary: SIX.replace("Tests: bun test 2075 pass, 0 fail", "Tests: bun test 3 failed, 9 passed | see log"),
    }) as unknown as Goal,
  });
  const row = failing.chatLines.find((l) => l.startsWith("| Tests |"));
  assert.ok(row, "Tests row present");
  assert.match(row!, /^\| Tests \| FAIL \|/, "nonzero failures read FAIL");
  assert.ok(!/(?<!\\)\|/.test(row!.slice("| Tests | FAIL | ".length, -2)), "cell pipes escaped");
  // Audit 2026-09-13: failure keeps the full table — findings still lead.
  const tableIdx = failing.chatLines.indexOf("### Verification Summary");
  const findingsIdx = failing.chatLines.indexOf("### Key Findings & Remediation");
  const nextIdx = failing.chatLines.indexOf("### Next");
  assert.ok(tableIdx !== -1, "failing verification renders the full table");
  assert.ok(!failing.chatLines.some((l) => l.startsWith("\u2014 Verification passed")), "no PASS line on failure");
  assert.ok(findingsIdx !== -1 && findingsIdx < tableIdx && tableIdx < nextIdx, "findings precede the failure table, Next closes the card");
});

test("REPORTED verification stays visible — unclaimed status never auto-hides", () => {
  const { chatLines } = render({
    goal: seedGoal({
      id: "20260911-rich-reported",
      objective: "x",
      completionSummary: SIX.replace("Tests: bun test 2075 pass, 0 fail", "Tests: exit 0, log kept"),
    }) as unknown as Goal,
  });
  assert.ok(chatLines.includes("### Verification Summary"), "REPORTED keeps the table");
  assert.ok(chatLines.some((l) => /^\| Tests \| REPORTED \|/.test(l)), "bare-exit notes honestly stay REPORTED");
});

test("commit hashes ride the chat (full parity) and the archive record", () => {
  const hashed = [
    "Outcome: shipped the hash audit",
    "Changed: extensions/completion-summary.ts in 02871aa6",
    "Evidence: gate green, tarball built from a8f3fad5c9e2b1a4d6f8e0c2b4a6d8e0f1a3b5c7d9",
    "Tests: bun test 2075 pass, 0 fail",
    "Unresolved: none",
    "Next: replay on next contact",
  ].join("\n");
  const goal = seedGoal({
    id: "20260911-rich-hash",
    objective: "audit hash surfacing",
    completionSummary: hashed,
    telemetry: { turns: 9, fileWrites: 4, bashCalls: 2 },
    auditHistory: [
      { at: "2026-09-11T00:00:00.000Z", approved: true, disapproved: false, model: "auditor-model", report: "fine" },
    ],
  }) as unknown as Goal;
  const group = "Scrub: extensions/completion-summary.ts fixed in 02871aa6, tarball from a8f3fad5c9e2b1a4d6f8e0c2b4a6d8e0f1a3b5c7d9 with tests green";
  const { chatLines } = buildTerminalApprovalRender({
    goal,
    status: "complete",
    stopReason: "auditor approved (detached)",
    archivePath: ".pi-glla/archive/20260911-rich-hash.md",
    approval: "\u2014 auditor auditor-model approved.",
    record: "\u2014 record: .pi-glla/archive/20260911-rich-hash.md",
    findingGroups: [{ title: "Hashes", findings: [group] }],
  });
  const chat = chatLines.join("\n");
  assert.ok(chat.includes("02871aa6"), "short hash rides the chat findings");
  assert.ok(chat.includes("a8f3fad5c9e2b1a4d6f8e0c2b4a6d8e0f1a3b5c7d9"), "full SHA rides the chat evidence");
  assert.ok(chat.includes("extensions/completion-summary.ts"), "the file ref rides along");
  // The archive human layer renders flat findings when no groups are
  // claimed (the verbatim six-label record carries them regardless).
  const archive = buildRichArchiveSection(goal, "complete", ".pi-glla/archive/20260911-rich-hash.md");
  const record = archive.join("\n");
  assert.ok(record.includes("02871aa6"), "the archive keeps the short hash");
  assert.ok(record.includes("a8f3fad5c9e2b1a4d6f8e0c2b4a6d8e0f1a3b5c7d9"), "the archive keeps the full SHA");
  assert.ok(archive.includes("### Verification Summary"), "the archive keeps the full table");
});

test("Next section carries the concrete action; stale self-reference still drops", () => {
  const { chatLines, transcriptLines } = render();
  const nextIdx = chatLines.findIndex((l) => l === "### Next");
  assert.ok(nextIdx > 0, "Next section present");
  assert.ok(chatLines.some((l) => /^- \*\*Next\*\* — replay on next contact$/.test(l)), "concrete Next survives as a bold-lead bullet");
  const stale = render({
    goal: seedGoal({
      id: "20260911-rich-stale",
      objective: "x",
      completionSummary: SIX.replace("Next: replay on next contact", "Next: verdict decides"),
    }) as unknown as Goal,
  });
  assert.ok(!stale.chatLines.some((l) => /verdict decides/.test(l)), "self-referential Next still drops from chat");
  assert.ok(!stale.transcriptLines.some((l) => /verdict decides/.test(l)), "and from the transcript");
});

test("trailer contract holds: approval bullet, record pointer last", () => {
  const { chatLines } = render();
  assert.ok(chatLines.includes("• auditor approved (1 verdict)."), "folded approval bullet survives");
  const recordIdx = chatLines.findIndex((l) => l.startsWith("• record:"));
  assert.equal(recordIdx, chatLines.length - 1, "record pointer is the final line");
});

test("finding and next lines render uncapped (full parity)", () => {
  // v0.38.55: every informing detail reaches the chat — caps retired.
  const crowded = [
    "Outcome: many things",
    `Changed: ${Array.from({ length: 10 }, (_, i) => `extensions/part-${i}.ts`).join("; ")}`,
    "Evidence: gate green",
    "Tests: pass",
    "Next: ship it",
  ].join("\n");
  const r = render({
    goal: seedGoal({
      id: "20260911-rich-cap",
      objective: "x",
      completionSummary: crowded,
      telemetry: { turns: 9, fileWrites: 4, bashCalls: 2 },
      auditHistory: [
        { at: "2026-09-11T00:00:00.000Z", approved: true, disapproved: false, model: "auditor-model", report: "fine" },
      ],
    }) as unknown as Goal,
  });
  const numbered = r.chatLines.filter((l) => /^\d+\. \*\*/.test(l));
  assert.equal(numbered.length, 2, `every flat finding renders, got ${numbered.length}`);
});

test("no audit history means no Audit row, approval voice still closes", () => {
  const r = render({
    goal: seedGoal({ id: "20260911-rich-noaudit", objective: "x", completionSummary: SIX }) as unknown as Goal,
    approval: "— completed without audit (your choice).",
  });
  assert.ok(!r.chatLines.some((l) => l.startsWith("| Audit |")), "no invented audit row");
  assert.ok(r.chatLines.some((l) => /completed without audit/.test(l)), "path voice still closes the chat");
});

test("archive section is rich for complete, Aborted-headlined for aborted", () => {
  const done = buildRichArchiveSection(richGoal(), "complete", ".pi-glla/archive/20260911-rich-voice.md");
  assert.equal(done[0], "## Done — auditor approved (1 verdict)", "verdict banner opens the archive too");
  assert.ok(done[2]?.startsWith("## Done: restyle the terminal summary — "), "archive headline matches chat");
  assert.ok(done.includes("### Key Findings & Remediation"), "archive carries findings");
  assert.ok(done.includes("### Verification Summary"), "archive carries the table");
  assert.ok(done.some((l) => l.startsWith("• record: .pi-glla/archive/20260911-rich-voice.md")), "archive record pointer last");
  const aborted = buildRichArchiveSection(richGoal(), "aborted", ".pi-glla/archive/20260911-rich-voice.md");
  assert.ok(aborted[0]?.startsWith("## Aborted — "), "aborted records never wear a Done banner");
  assert.ok(aborted[2]?.startsWith("## Aborted: restyle the terminal summary — "), "aborted records never wear a Done headline");
});

const GROUPS: FindingGroup[] = [
  { title: "Sound manager", findings: ["Disable path: soundManager.ts:333 mutes WebAudio"] },
  { title: "Simulation", findings: ["Spawn logic: sim.ts:4505-4530 batches spawns in waves"] },
];

test("duration line rides under the headline; unknown facts stay absent", () => {
  const { chatLines } = render({ findingGroups: GROUPS });
  // [0] banner, [1] blank, [2] headline, [3] blank, [4] duration.
  assert.equal(chatLines[3], "", "blank line after headline");
  assert.match(chatLines[4] ?? "", /^— 9 turns · .+ elapsed · 1 audit$/, `duration line, got: ${chatLines[4]}`);
  assert.equal(buildDurationLine({} as Goal), null, "nothing known means no duration line");
  const bare = buildDurationLine({ telemetry: { turns: 2, fileWrites: 0, bashCalls: 0 } } as Goal);
  assert.equal(bare, "— 2 turns", "only known facts render");
});

test("fewer than four groups render as nested area subsections", () => {
  const { chatLines, transcriptLines } = render({ findingGroups: GROUPS });
  const findingsIdx = chatLines.findIndex((l) => l === "### Key Findings & Remediation");
  assert.ok(findingsIdx > 0, "findings section present");
  assert.equal(chatLines[findingsIdx + 1], "#### 1. Sound manager", "first area subsection");
  assert.equal(chatLines[findingsIdx + 2], "- **Disable path** — soundManager.ts:333 mutes WebAudio", "nested evidence bullet");
  assert.ok(!chatLines.some((l) => l.startsWith("| Area |")), "no table below the threshold");
  assert.deepEqual(transcriptLines.slice(0, 3), chatLines.slice(0, 3), "transcript shares headline and duration");
});

test("four or more groups render as an Area | Finding | Evidence table", () => {
  const table = render({
    findingGroups: [
      ...GROUPS,
      { title: "Screen A", findings: ["Layout: +page.svelte:260 pins the canvas"] },
      { title: "Screen B", findings: ["Probe: /var/tmp/probe.ts:1 stays out of evidence", "Note: nothing to cite"] },
    ],
  });
  const headerIdx = table.chatLines.findIndex((l) => l === "| Area | Finding | Evidence |");
  assert.ok(headerIdx > 0, "findings table present");
  assert.equal(table.chatLines[headerIdx + 1], "| --- | --- | --- |", "table separator");
  const rows = table.chatLines.filter((l) => l.startsWith("| Sound manager |") || l.startsWith("| Simulation |") || l.startsWith("| Screen A |") || l.startsWith("| Screen B |"));
  assert.equal(rows.length, 5, `one row per finding, got: ${rows.join(" / ")}`);
  assert.ok(rows.some((l) => /\| soundManager\.ts:333 \|$/.test(l)), "relative path:line lands in Evidence");
  assert.ok(rows.some((l) => /\| sim\.ts:4505-4530 \|$/.test(l)), "line ranges land in Evidence");
  assert.ok(rows.some((l) => /\+page\.svelte:260/.test(l) && /\| \+page\.svelte:260 \|$/.test(l)), "svelte evidence token");
  const probe = rows.find((l) => l.startsWith("| Screen B |") && /probe/.test(l));
  assert.ok(probe, "absolute-path finding still renders");
  assert.ok(probe!.endsWith("| — |"), "absolute machine paths never become evidence");
  assert.ok(!table.chatLines.some((l) => l.startsWith("#### ")), "no nested subsections at table scale");
});

test("three groups stay nested — the table trigger is exactly four", () => {
  const three = render({ findingGroups: [...GROUPS, { title: "Third", findings: ["Lead: body"] }] });
  assert.ok(three.chatLines.some((l) => l.startsWith("#### 3. Third")), "third group nested");
  assert.ok(!three.chatLines.some((l) => l.startsWith("| Area |")), "still no table");
});

test("grouped findings render uncapped: every finding, full values, every Next", () => {
  const many: FindingGroup[] = Array.from({ length: 3 }, (_, g) => ({
    title: `Area ${g}`,
    findings: [`Lead ${g}a: ${"x".repeat(500)}`, `Lead ${g}b: short`, `Lead ${g}c: short`, `Lead ${g}d: short`, `Lead ${g}e: short`],
  }));
  const crowded = render({ findingGroups: many });
  const bullets = crowded.chatLines.filter((l) => l.startsWith("- **Lead"));
  assert.equal(bullets.length, 15, `every finding renders, got ${bullets.length}`);
  const long = bullets.find((l) => l.startsWith("- **Lead 0a**"));
  assert.ok(long, "first finding present");
  assert.ok(long!.length - "- **Lead 0a** — ".length >= 500, `value unclipped, got ${long!.length}`);
  assert.ok(crowded.chatLines.some((l) => l.startsWith("#### 3.")), "later groups keep their headers");
  // Every Next renders — the one-concrete-action chat filter still
  // applies to six-label Nexts; parts-level Nexts are uncapped.
  const parts = buildRichTerminalParts({
    outcome: "o",
    details: Array.from({ length: 7 }, (_, i) => `Next: action ${i}`),
    countsLine: "",
  });
  assert.equal(parts.nextLines.length, 7, `every Next renders, got ${parts.nextLines.length}`);
});

test("extractEvidenceTokens moves tokens mechanically and never invents", () => {
  assert.deepEqual(extractEvidenceTokens("Fix: a.ts:10 and b.ts:20-25 here"), {
    text: "Fix: and here",
    evidence: ["a.ts:10", "b.ts:20-25"],
  });
  const abs = extractEvidenceTokens("See /var/tmp/x.ts:1 for details");
  assert.deepEqual(abs.evidence, [], "absolute paths are not evidence");
  assert.ok(abs.text.includes("/var/tmp/x.ts:1"), "absolute path stays in the finding text");
});

test("takeBudgetedGroups fills in order and drops emptied groups", () => {
  const groups: FindingGroup[] = [
    { title: "A", findings: Array.from({ length: 12 }, (_, i) => `f${i}`) },
    { title: "B", findings: ["leftover"] },
  ];
  const taken = takeBudgetedGroups(groups);
  assert.equal(taken.length, 1, "second group emptied by the budget");
  assert.equal(taken[0]!.findings.length, 12, "first group fills the budget");
});

test("sanitizeFindingGroups bounds shape at the trust boundary", () => {
  assert.equal(sanitizeFindingGroups("nope"), undefined, "non-array degrades to absent");
  assert.equal(sanitizeFindingGroups([]), undefined, "empty degrades to absent");
  const clean = sanitizeFindingGroups([
    { title: "  Good  ", findings: ["  Lead: body  ", "", 42, "x".repeat(600)] },
    { title: "   ", findings: ["blank title drops"] },
    { title: "Empty", findings: [] },
    "junk",
    null,
  ]);
  assert.equal(clean?.length, 1, "only the valid group survives");
  assert.equal(clean?.[0]?.title, "Good", "titles trim");
  assert.equal(clean?.[0]?.findings.length, 2, "blank/non-string findings drop");
  assert.equal(clean?.[0]?.findings[1]?.length, 500, "findings clip at 500");
  const capped = sanitizeFindingGroups(Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, findings: ["f"] })));
  assert.equal(capped?.length, 6, "groups capped at 6");
});

test("v0.38.55: banner voices every audit outcome honestly", () => {
  const bannerFor = (auditHistory: Goal["auditHistory"]) => buildRichTerminalParts({
    outcome: "o",
    details: [],
    countsLine: "",
    auditHistory,
  }).banner;
  assert.equal(bannerFor([{ at: "t", approved: true, disapproved: false, model: "m", report: "r" }]), "## Done — auditor approved (1 verdict)");
  assert.equal(
    bannerFor([
      { at: "t", approved: false, disapproved: true, model: "m", report: "r" },
      { at: "t", approved: false, disapproved: true, model: "m", report: "r" },
    ]),
    "## Done — auditor disapproved (2 verdicts)",
  );
  assert.equal(bannerFor([{ at: "t", approved: false, disapproved: false, impossible: true, model: "m", report: "r" }]), "## Done — auditor ruled impossible");
  assert.equal(bannerFor(undefined), "## Done — completed without a recorded verdict");
});

test("v0.38.55: gate commands render a Command column; absent keeps 4 cols", () => {
  const withCommand = buildRichTerminalParts({
    outcome: "o",
    details: [],
    countsLine: "",
    gates: [{ gate: "Unit Tests", command: "bun test tests/", notes: "9 passed, 0 failed" }],
  });
  assert.ok(withCommand.tableLines.includes("| Quality Gate | Command | Scope | Status | Notes |"), "5-col header");
  assert.ok(withCommand.tableLines.some((l) => l.includes("bun test tests/")), "repro command in the row");
  const without = buildRichTerminalParts({
    outcome: "o",
    details: [],
    countsLine: "",
    gates: [{ gate: "Unit Tests", notes: "9 passed, 0 failed" }],
  });
  assert.ok(without.tableLines.includes("| Quality Gate | Scope | Status | Notes |"), "4-col header preserved");
});

test("v0.38.55: final repository state closes the card when readable", () => {
  const repoState = buildFinalRepoStateLines(process.cwd());
  assert.ok(repoState && repoState.length > 0, "a git checkout reports state");
  assert.match(repoState[0] ?? "", /^Branch /, "branch line leads");
  const { chatLines, transcriptLines } = render({ repoState });
  const repoIdx = chatLines.findIndex((l) => l === "### Final Repository State");
  assert.ok(repoIdx > 0, "repo section present");
  const recordIdx = chatLines.findIndex((l) => l.startsWith("• record:"));
  assert.ok(repoIdx < recordIdx, "repo state rides ahead of the record trailer");
  assert.ok(transcriptLines.includes("### Final Repository State"), "transcript mirrors the repo state");
  assert.equal(buildFinalRepoStateLines("/nonexistent-dir-xyz"), undefined, "unreadable state degrades to absent");
});
