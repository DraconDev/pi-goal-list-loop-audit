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

test("chat opens with a request-echo Done headline and Key Findings numbered with bold leads", () => {
  const { chatLines } = render();
  assert.ok((chatLines[0] ?? "").startsWith("## Done: restyle the terminal summary — "), `headline echoes the request, got: ${chatLines[0]}`);
  const findingsIdx = chatLines.findIndex((l) => l === "### Key Findings & Remediation");
  assert.ok(findingsIdx > 0, "findings section present");
  assert.match(chatLines[findingsIdx + 1] ?? "", /^1\. \*\*Changed\*\* — /, "numbered bold lead with em-dash body");
  assert.match(chatLines[findingsIdx + 2] ?? "", /^2\. \*\*Evidence\*\* — /, "second finding numbered");
  assert.ok(chatLines.some((l) => /extensions\/completion-summary\.ts/.test(l)), "code refs ride the finding bodies");
});

test("verification table tabulates Tests PASS plus the audit row", () => {
  const { chatLines } = render();
  const tableIdx = chatLines.findIndex((l) => l === "### Verification Summary");
  assert.ok(tableIdx > 0, "verification section present");
  assert.equal(chatLines[tableIdx + 1], "| Check | Status | Details |", "table header");
  assert.equal(chatLines[tableIdx + 2], "| --- | --- | --- |", "table separator");
  const rows = chatLines.slice(tableIdx + 3, tableIdx + 5);
  assert.ok(rows.some((l) => /^\| Tests \| PASS \|/.test(l)), `Tests PASS row, got: ${rows.join(" / ")}`);
  assert.ok(rows.some((l) => /^\| Audit \| APPROVED ×1 \|/.test(l)), "audit row carries the verdict count");
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

test("finding and next lines stay bounded", () => {
  // Findings derive from labels (Changed/Evidence today), so the caps
  // are future-proofing — this pins the bound, not a reachable overflow.
  const crowded = [
    "Outcome: many things",
    `Changed: ${Array.from({ length: 10 }, (_, i) => `extensions/part-${i}.ts`).join("; ")}`,
    "Evidence: gate green",
    "Tests: pass",
    "Next: ship it",
  ].join("\n");
  const r = render({
    goal: seedGoal({ id: "20260911-rich-cap", objective: "x", completionSummary: crowded }) as unknown as Goal,
  });
  const numbered = r.chatLines.filter((l) => /^\d+\. \*\*/.test(l));
  assert.ok(numbered.length <= 8, `findings capped, got ${numbered.length}`);
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
  assert.ok(done[0]?.startsWith("## Done: restyle the terminal summary — "), "archive headline matches chat");
  assert.ok(done.includes("### Key Findings & Remediation"), "archive carries findings");
  assert.ok(done.includes("### Verification Summary"), "archive carries the table");
  assert.ok(done.some((l) => l.startsWith("• record: .pi-glla/archive/20260911-rich-voice.md")), "archive record pointer last");
  const aborted = buildRichArchiveSection(richGoal(), "aborted", ".pi-glla/archive/20260911-rich-voice.md");
  assert.ok(aborted[0]?.startsWith("## Aborted: restyle the terminal summary — "), "aborted records never wear a Done headline");
});

const GROUPS: FindingGroup[] = [
  { title: "Sound manager", findings: ["Disable path: soundManager.ts:333 mutes WebAudio"] },
  { title: "Simulation", findings: ["Spawn logic: sim.ts:4505-4530 batches spawns in waves"] },
];

test("duration line rides under the headline; unknown facts stay absent", () => {
  const { chatLines } = render({ findingGroups: GROUPS });
  assert.equal(chatLines[1], "", "blank line after headline");
  assert.match(chatLines[2] ?? "", /^— 9 turns · .+ elapsed · 1 audit$/, `duration line, got: ${chatLines[2]}`);
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

test("grouped findings respect the raised budgets: 12 findings, 400-char values, 6 Nexts", () => {
  const many: FindingGroup[] = Array.from({ length: 3 }, (_, g) => ({
    title: `Area ${g}`,
    findings: [`Lead ${g}a: ${"x".repeat(500)}`, `Lead ${g}b: short`, `Lead ${g}c: short`, `Lead ${g}d: short`, `Lead ${g}e: short`],
  }));
  const crowded = render({ findingGroups: many });
  const bullets = crowded.chatLines.filter((l) => l.startsWith("- **Lead"));
  assert.equal(bullets.length, 12, `findings capped at 12, got ${bullets.length}`);
  const long = bullets.find((l) => l.startsWith("- **Lead 0a**"));
  assert.ok(long, "first finding present");
  assert.ok((long!.length - "- **Lead 0a** — ".length) <= 400, `value clipped to 400, got ${long!.length}`);
  assert.ok(!crowded.chatLines.some((l) => l.startsWith("#### 4.")), "emptied groups drop their header");
  // The Next budget pins at unit level: the chat filter keeps at most one
  // concrete Next action (v0.38.39 Codex rule), so the cap is enforced on
  // the parts input directly — future-proofing, like the old findings cap.
  const parts = buildRichTerminalParts({
    outcome: "o",
    details: Array.from({ length: 7 }, (_, i) => `Next: action ${i}`),
    countsLine: "",
  });
  assert.equal(parts.nextLines.length, 6, `Next capped at 6, got ${parts.nextLines.length}`);
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
