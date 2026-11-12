// pi-goal-list-loop-audit — rich terminal voice (field 20260911_003839 /
// 003903 / 003907): the Antigravity close — section headers, findings with
// bold leads + code refs, a verification table — replaces the flat six-bullet
// card on the terminal render only. Archive carries the same rich markdown
// over the verbatim six-label machine record.
//
// Field 2026-11-11 ("more like opencode's end-of-task summary") shaped that
// rich voice into ONE report: `## Done — <title>`, a prose lede, `## Summary`
// with per-area `What changed · <area>` subsections, the always-on
// `## Verification` gate table, `## Follow-up items`, `## Next steps`, the
// archive-only repository state, and a single closing receipt line. Every
// assertion below protects the same behavior it always did, expressed in that
// vocabulary: derived verification status, evidence tokens, pipe escaping,
// stale-Next filtering, sanitize bounds, and no invented verdicts.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { sanitizeFindingGroups, type FindingGroup, type Goal } from "../extensions/goal-loop-core.js";
import {
  CARD_SECTION,
  buildDurationLine,
  buildFinalRepoStateLines,
  buildRichArchiveSection,
  buildRichTerminalParts,
  buildTerminalApprovalRender,
  composeRichTerminalLines,
  extractEvidenceTokens,
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

/** Chat section heading line (`##  <name>`), the one depth the Pi TUI renders. */
function section(name: string): string {
  return `## ${name}`;
}

test("card opens with the outcome, then a report body with findings and verification", () => {
  const { chatLines } = render();
  assert.equal(chatLines[0], "## Done — shipped the rich terminal voice");
  assert.equal(chatLines.filter(line => line.startsWith("## Done")).length, 1, "one outcome headline");
  const findingsIdx = chatLines.indexOf(section(CARD_SECTION.summary));
  assert.ok(findingsIdx > 0, "the change body has its own section");
  // The change text rides a single bullet; a bare path is not promoted into
  // a second human finding, so `Evidence:` never masquerades as a change.
  assert.ok(chatLines.some(line => /extensions\/completion-summary\.ts/.test(line)), "code refs ride the finding bodies");
  assert.ok(!chatLines.some(line => /^- \*\*gate green/.test(line)), "verification receipt is not a second change");
  assert.ok(chatLines.includes(section(CARD_SECTION.verification)), "verification is part of the report");
});

test("verification renders on both surfaces; the archive keeps the full inventoried table", () => {
  const chat = render().chatLines;
  const verification = chat.indexOf(section(CARD_SECTION.verification));
  assert.ok(verification > 0, "verification section present in chat");
  // Chat states the facts a person checks: the derived status and the notes.
  assert.ok(chat.some((l) => /^\| Verification \| PASS \| 2075 pass, 0 fail \|$/.test(l)), chat.join("\n"));
  assert.ok(!chat.some((l) => /^Tests:/.test(l)), "technical Tests label never reaches chat");
  const archive = buildRichArchiveSection(richGoal(), "complete", ".pi-glla/archive/20260911-rich-voice.md");
  assert.ok(archive.includes(section("Verification"), ) || archive.includes("### Verification"), "archive keeps the verification record");
  assert.ok(archive.some((l) => /^\| Verification \| PASS \| 2075 pass, 0 fail \|$/.test(l)), "archive keeps the derived row");
  assert.ok(archive.some((l) => /^\| Completion review \| approved \(1 review\) \|/.test(l)), "archive keeps the review row");
});

test("a failing gate is reported honestly in chat instead of being hidden", () => {
  const failing = render({
    goal: seedGoal({
      id: "20260911-rich-fail",
      objective: "x",
      completionSummary: SIX.replace("Tests: bun test 2075 pass, 0 fail", "Tests: bun test 3 failed, 9 passed | see log"),
    }) as unknown as Goal,
  });
  const chat = failing.chatLines.join("\n");
  // The old rule was "failures are archive-only"; the report contract is that
  // verification is always stated — so the failure must be visible, and it must
  // never be softened into a PASS label.
  assert.ok(chat.includes(section(CARD_SECTION.verification)), chat);
  assert.ok(/3 failed/.test(chat), "the failure count survives verbatim");
  assert.doesNotMatch(chat, /PASS: 3 failed/, "a failing gate never borrows a PASS label");
  assert.ok(!failing.chatLines.some((l) => /^Tests:/.test(l)), "the raw Tests label stays archival");
});

test("REPORTED verification stays REPORTED — bare-exit wording never upgrades to PASS", () => {
  const { chatLines } = render({
    goal: seedGoal({
      id: "20260911-rich-reported",
      objective: "x",
      completionSummary: SIX.replace("Tests: bun test 2075 pass, 0 fail", "Tests: exit 0, log kept"),
    }) as unknown as Goal,
  });
  const chat = chatLines.join("\n");
  assert.ok(chat.includes(section(CARD_SECTION.verification)), "reported evidence is shown");
  assert.match(chat, /exit 0, log kept/, "the note rides the row unchanged");
  assert.doesNotMatch(chat, /PASS: exit 0/, "a bare exit code is not a proven pass");
});

test("commit hashes stay in the archive, while chat keeps explanations", () => {
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
  assert.ok(!chat.includes("02871aa6"), "short hash stays archival");
  assert.ok(!chat.includes("a8f3fad5c9e2b1a4d6f8e0c2b4a6d8e0f1a3b5c7d9"), "full SHA stays archival");
  assert.doesNotMatch(chat, /fixed in\s*[,—.]/, "no dangling citation fragment");
  assert.ok(chat.includes("extensions/completion-summary.ts"), "the file ref rides along");
  const archive = buildRichArchiveSection(goal, "complete", ".pi-glla/archive/20260911-rich-hash.md");
  const record = archive.join("\n");
  assert.ok(record.includes("02871aa6"), "the archive keeps the short hash");
  assert.ok(record.includes("a8f3fad5c9e2b1a4d6f8e0c2b4a6d8e0f1a3b5c7d9"), "the archive keeps the full SHA");
  assert.ok(archive.includes("### Verification") || archive.includes(section("Verification")), "the archive keeps the table");
});

test("Next steps carries the concrete action; stale self-reference still drops", () => {
  const { chatLines, transcriptLines } = render();
  const nextIdx = chatLines.indexOf(section(CARD_SECTION.nextSteps));
  assert.ok(nextIdx > 0, "Next steps section present");
  assert.ok(chatLines.some((l) => /^- replay on next contact$/.test(l)), "concrete Next survives without repeating its section label");
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

test("trailer contract holds: one receipt line, record pointer last", () => {
  const { chatLines } = render();
  const last = chatLines[chatLines.length - 1] ?? "";
  assert.ok(last.startsWith("completion audit approved (1 review)"), `receipt states the verdict once: ${last}`);
  assert.ok(last.includes("record: .pi-glla/archive/20260911-rich-voice.md"), "the record pointer closes it");
  assert.equal(chatLines.filter((l) => /completion audit approved/.test(l)).length, 1, "the verdict is never restated");
  assert.ok(!chatLines.some((l) => l.startsWith("\u2022 ")), "no legacy bullet trailer");
  assert.equal(render().transcriptLines.at(-1), "completion audit approved (1 review)", "the transcript carries the verdict half only");
});

test("detailed receipt keeps the supplied change and next action, not evidence as a second change", () => {
  // The saved message remains complete; the default renderer previews it.
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
  const findings = r.chatLines.filter((l) => l.startsWith("- "));
  assert.equal(findings.length, 1, "Changed is the finding; Evidence is saved separately");
  assert.ok(r.chatLines.join("\n").includes("extensions/part-9.ts"));
  assert.ok(r.chatLines.join("\n").includes("ship it"));
});

test("no audit history means no invented review row, and the receipt names the real shape", () => {
  const r = render({
    goal: seedGoal({ id: "20260911-rich-noaudit", objective: "x", completionSummary: SIX }) as unknown as Goal,
    approval: "— completed without audit (your choice).",
    countsLine: "— completion review: completed without a completion review (your choice).",
  });
  assert.ok(!r.chatLines.some((l) => l.startsWith("| Completion review |")), "no invented completion review row");
  assert.equal(r.chatLines.filter((l) => /completed without a completion review/.test(l)).length, 1, "the receipt states the honest shape once");
});

test("archive carries the same report as chat, and aborted records never wear a Done headline", () => {
  const done = buildRichArchiveSection(richGoal(), "complete", ".pi-glla/archive/20260911-rich-voice.md");
  assert.equal(done[0], "## Done — shipped the rich terminal voice", "the archive opens with the same result headline");
  assert.ok(done.includes(`### ${CARD_SECTION.summary}`), "archive carries the change body");
  assert.ok(done.includes("### Verification"), "archive carries the table");
  assert.ok(done.at(-1)?.startsWith("completion audit approved"), `archive closes with the receipt: ${done.at(-1)}`);
  const aborted = buildRichArchiveSection(richGoal(), "aborted", ".pi-glla/archive/20260911-rich-voice.md");
  assert.ok(aborted[0]?.startsWith("## Aborted — "), "aborted records never wear a Done headline");
});

const GROUPS: FindingGroup[] = [
  { title: "Sound manager", findings: ["Disable path: soundManager.ts:333 mutes WebAudio"] },
  { title: "Simulation", findings: ["Spawn logic: sim.ts:4505-4530 batches spawns in waves"] },
];

test("duration line closes the meta footnote; unknown facts stay absent", () => {
  const { chatLines } = render({ findingGroups: GROUPS });
  assert.match(chatLines[0] ?? "", /^## Done — shipped the rich terminal voice$/);
  assert.equal(chatLines[1], "", "blank line after headline");
  // Report shape (field 2026-11-11): the meta line is a dim italic footnote
  // rather than a bare `—` line that reads as a broken bullet.
  assert.match(chatLines[2] ?? "", /^\*9 turns · .+ elapsed · 1 audit\*$/, `meta line, got: ${chatLines[2]}`);
  assert.equal(buildDurationLine({} as Goal), null, "nothing known means no meta line");
  const bare = buildDurationLine({ telemetry: { turns: 2, fileWrites: 0, bashCalls: 0 } } as Goal);
  assert.equal(bare, "*2 turns*", "only known facts render");
});

test("each work area renders as its own `What changed · <area>` subsection", () => {
  const { chatLines, transcriptLines } = render({ findingGroups: GROUPS });
  const bodyIdx = chatLines.indexOf(section(CARD_SECTION.summary));
  assert.ok(bodyIdx > 0, "change body present");
  assert.equal(chatLines[bodyIdx + 1], `**${CARD_SECTION.whatChanged} · Sound manager**`, "the area names its own subsection");
  // Report shape: ONE bullet per finding — the outcome leads, its evidence
  // follows on the same line, so the reader gets gist and proof together.
  assert.equal(chatLines[bodyIdx + 2], "- **mutes WebAudio** — soundManager.ts:333", "finding prose is a single bullet");
  assert.equal(chatLines[bodyIdx + 4], `**${CARD_SECTION.whatChanged} · Simulation**`, "second area follows");
  assert.ok(!chatLines.some((l) => l.startsWith("| Area |")), "no table below the archive threshold");
  assert.deepEqual(transcriptLines.slice(0, 3), chatLines.slice(0, 3), "transcript shares headline and meta");
});

test("four or more groups keep a table in the archive while chat stays grouped", () => {
  const groups: FindingGroup[] = [
    ...GROUPS,
    { title: "Screen A", findings: ["Layout: +page.svelte:260 pins the canvas"] },
    { title: "Screen B", findings: ["Probe: /var/tmp/probe.ts:1 stays out of evidence", "Note: nothing to cite"] },
  ];
  const archive = buildRichArchiveSection(richGoal(), "complete", "archive.md", groups);
  const chat = render({ findingGroups: groups }).chatLines;
  assert.ok(chat.some(line => line === `**${CARD_SECTION.whatChanged} · Screen B**`), "later areas keep their subsection");
  assert.ok(chat.includes(section(CARD_SECTION.summary)));
  assert.ok(!chat.some(line => line.startsWith("| Area |")), "chat groups instead of tabulating");
  const headerIdx = archive.findIndex((l) => l === "| Area | User-visible outcome | Evidence / reason |");
  assert.ok(headerIdx > 0, "archive findings table present");
  assert.equal(archive[headerIdx + 1], "| --- | --- | --- |", "table separator");
  const rows = archive.filter((l) => l.startsWith("| Sound manager |") || l.startsWith("| Simulation |") || l.startsWith("| Screen A |") || l.startsWith("| Screen B |"));
  assert.equal(rows.length, 5, `one row per finding, got: ${rows.join(" / ")}`);
  assert.ok(rows.some((l) => /\| soundManager\.ts:333/.test(l)), "relative path:line lands in evidence");
  assert.ok(rows.some((l) => /\| sim\.ts:4505-4530/.test(l)), "line ranges land in evidence");
  assert.ok(rows.some((l) => /\+page\.svelte:260/.test(l)), "svelte evidence token");
  const probe = rows.find((l) => l.startsWith("| Screen B |") && /probe/.test(l));
  assert.ok(probe, "absolute-path finding still renders");
  assert.ok(probe!.endsWith("| not recorded |"), "absolute machine paths never become evidence");
  assert.ok(!archive.some((l) => l.startsWith("#### ")), "no nested subsections at table scale");
});

test("three groups stay grouped — the archive table trigger is exactly four", () => {
  const three = render({ findingGroups: [...GROUPS, { title: "Third", findings: ["Lead: body"] }] });
  assert.ok(three.chatLines.some((l) => l.startsWith(`**${CARD_SECTION.whatChanged} · Third**`)), "third group renders");
  assert.ok(three.chatLines.includes(section(CARD_SECTION.summary)));
  assert.ok(!three.chatLines.some((l) => l.startsWith("| Area |")), "still no table");
});

test("v0.38.55: render path respects the sanitize trust boundary", () => {
  // v0.38.55 audit: the render tests used to bypass the boundary they
  // claimed to pin — raw oversized groups went straight into the
  // renderer. The real path always sanitizes first, so the test does too.
  const many: FindingGroup[] = Array.from({ length: 3 }, (_, g) => ({
    title: `Area ${g}`,
    findings: [`Lead ${g}a: ${"x".repeat(500)}`, `Lead ${g}b: short`, `Lead ${g}c: short`, `Lead ${g}d: short`, `Lead ${g}e: short`],
  }));
  const crowded = render({ findingGroups: sanitizeFindingGroups(many) });
  const bullets = crowded.chatLines.filter((l) => l.startsWith("- ") && l !== '- replay on next contact');
  assert.equal(bullets.length, 15, `all 15 in-boundary findings render, got ${bullets.length}`);
  assert.ok(crowded.chatLines.includes('- replay on next contact'), 'the next action remains outside the finding count');
  const long = bullets.find((l) => l.includes('x'.repeat(400)));
  assert.ok(long, "first finding present");
  // The renderer itself never clips values — the 10k-char finding bound
  // is the trust boundary's doing (pinned by the sanitize test above).
  assert.ok(long!.includes("x".repeat(400)), `value substantially present, got ${long!.length}`);
  assert.ok(crowded.chatLines.some((l) => l.startsWith(`**${CARD_SECTION.whatChanged} · Area 2**`)), "later groups keep their subsections");
  assert.ok(crowded.chatLines.includes(section(CARD_SECTION.summary)));
  const fifteen = sanitizeFindingGroups(Array.from({ length: 15 }, (_, i) => ({ title: `t${i}`, findings: ["Lead: body"] })));
  const capped = render({ findingGroups: fifteen });
  assert.ok(capped.chatLines.includes(`**${CARD_SECTION.whatChanged} · t11**`), "groups inside the 12-group boundary render");
  assert.ok(!capped.chatLines.includes(`**${CARD_SECTION.whatChanged} · t12**`), "groups past the boundary never render");
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
  // 2026-09-16 fragment pin: moving a parenthesized token must not leave
  // an empty-parenthesis husk, and real words in the group must survive.
  const husk = extractEvidenceTokens("Fix: Updated collision handling (game.ts:120).");
  assert.deepEqual(husk.evidence, ["game.ts:120"]);
  assert.equal(husk.text, "Fix: Updated collision handling.");
  const prose = extractEvidenceTokens("Fix: retry (with backoff) (sim.ts:4505-4530)");
  assert.deepEqual(prose.evidence, ["sim.ts:4505-4530"]);
  assert.equal(prose.text, "Fix: retry (with backoff)");
});

test("sanitizeFindingGroups bounds shape at the trust boundary", () => {
  assert.equal(sanitizeFindingGroups("nope"), undefined, "non-array degrades to absent");
  assert.equal(sanitizeFindingGroups([]), undefined, "empty degrades to absent");
  const clean = sanitizeFindingGroups([
    { title: "  Good  ", findings: ["  Lead: body  ", "", 42, "x".repeat(600), "y".repeat(10500)] },
    { title: "   ", findings: ["blank title drops"] },
    { title: "Empty", findings: [] },
    "junk",
    null,
  ]);
  assert.equal(clean?.length, 1, "only the valid group survives");
  assert.equal(clean?.[0]?.title, "Good", "titles trim");
  assert.equal(clean?.[0]?.findings.length, 3, "blank/non-string findings drop");
  assert.equal(clean?.[0]?.findings[1]?.length, 600, "in-guard findings pass through untouched");
  assert.equal(clean?.[0]?.findings[2]?.length, 10000, "pathological findings clip at the 10k guard");
  const capped = sanitizeFindingGroups(Array.from({ length: 15 }, (_, i) => ({ title: `t${i}`, findings: ["f"] })));
  assert.equal(capped?.length, 12, "groups capped at 12");
});

test("the review verdict is stated once per surface, in the receipt voice", () => {
  // Was the archival banner test: the verdict used to open the archive as a
  // `## Done — completion audit approved (N reviews)` banner. It now closes the
  // report as the receipt line, so the same facts are pinned there.
  const receiptFor = (auditHistory: Goal["auditHistory"]) => buildRichTerminalParts({
    outcome: "o",
    details: [],
    countsLine: "",
    auditHistory,
  });
  assert.equal(receiptFor([{ at: "t", approved: true, disapproved: false, model: "m", report: "r" }]).headline, "## Done — o");
  const built = (history: Goal["auditHistory"]) => {
    const goal = { ...richGoal(), auditHistory: history } as Goal;
    return buildTerminalApprovalRender({ goal, status: "complete", approval: "— auditor m approved.", record: "— record: a.md" }).chatLines.at(-1) ?? "";
  };
  assert.match(built([{ at: "t", approved: true, disapproved: false, model: "m", report: "r" }]), /approved \(1 review\)/, "approved");
  assert.match(
    built([
      { at: "t", approved: false, disapproved: true, model: "m", report: "r" },
      { at: "t", approved: false, disapproved: true, model: "m", report: "r" },
    ]),
    /disapproved \(2 reviews\)/,
    "disapproved",
  );
  assert.match(built([{ at: "t", approved: false, disapproved: false, impossible: true, model: "m", report: "r" }]), /ruled impossible|impossible/, "impossible");
  assert.match(built(undefined), /no review recorded|without a completion review/, "no invented verdict");
});

test("gate commands render a Command column on both surfaces; chat abbreviates", () => {
  const withCommand = buildRichTerminalParts({
    outcome: "o",
    details: [],
    countsLine: "",
    gates: [{ gate: "Unit Tests", command: "bun test tests/", notes: "9 passed, 0 failed" }],
  });
  assert.ok(withCommand.tableLines.includes("| Quality Gate | Command | Scope | Status | Notes |"), "5-col archive header");
  assert.ok(withCommand.tableLines.some((l) => l.includes("bun test tests/")), "repro command in the archive row");
  const chat = composeRichTerminalLines({ ...withCommand, chat: true }).join("\n");
  assert.ok(chat.includes("| Gate | Command | Result |"), chat);
  assert.ok(chat.includes("| Unit Tests | bun test tests/ | PASS: 9 passed, 0 failed |"), "chat states gate, command and result");
  assert.ok(!chat.includes("| Quality Gate | Command | Scope | Status | Notes |"), "the wide inventory stays archival");
});

test("rich terminal projections remove ANSI, OSC, and control bytes from every field", () => {
  const hostile = "safe\u001b[31mRED\u001b[0m\u001b]0;spoof\u0007\u0000\u202Ehidden\u200B";
  const groups: FindingGroup[] = [{ title: hostile, findings: [`Finding: ${hostile}`], tests: [`Proof: ${hostile}`] }];
  const gates = [{ gate: hostile, command: hostile, scope: hostile, notes: `1 passed, 0 failed ${hostile}` }];
  const input = {
    outcome: hostile,
    objective: hostile,
    details: [`Changed: ${hostile}`, `Tests: ${hostile}`, `Next: ${hostile}`],
    countsLine: `\u2014 audit: ${hostile}.`,
    groups,
    gates,
    repoState: [hostile],
  };
  const controls = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  for (const chat of [false, true]) {
    const rendered = composeRichTerminalLines(buildRichTerminalParts({ ...input, chat })).join("\n");
    assert.ok(rendered.includes("safeRED") && rendered.includes("hidden"), `${chat ? "chat" : "archive"} preserves readable text`);
    assert.ok(!rendered.includes("\u001b") && !rendered.includes("\u0007"), `${chat ? "chat" : "archive"} removes terminal sequences`);
    assert.ok(!rendered.split("\n").some((line) => controls.test(line)), `${chat ? "chat" : "archive"} has no display controls`);
  }
});

test("v0.38.55: final repository state closes the archive when readable, never chat", () => {
  const repoState = buildFinalRepoStateLines(process.cwd());
  assert.ok(repoState && repoState.length > 0, "a git checkout reports state");
  assert.match(repoState[0] ?? "", /^Branch /, "branch line leads");
  const { chatLines, transcriptLines } = render({ repoState });
  assert.ok(!chatLines.includes(`### ${CARD_SECTION.repo}`), "bookkeeping stays out of chat");
  assert.ok(!chatLines.includes(`## ${CARD_SECTION.repo}`), "bookkeeping stays out of chat");
  assert.ok(!transcriptLines.includes(`### ${CARD_SECTION.repo}`), "transcript shares concise chat");
  const archive = buildRichArchiveSection({ ...richGoal(), ...({ repoState } as object) } as Goal, "complete", "archive.md", undefined, undefined);
  assert.ok(archive.length > 0);
  const archiveParts = buildRichTerminalParts({ outcome: "shipped", details: [], countsLine: "", repoState });
  assert.deepEqual(archiveParts.repoLines, repoState, "archive projection retains full repository evidence");
  assert.equal(buildFinalRepoStateLines("/nonexistent-dir-xyz"), undefined, "unreadable state degrades to absent");
});

test("audit 2026-09-26: complete_goal accepts long free-prose values instead of refusing them", () => {
  // Field follow-up (endless-td screenshots): a >500-char leftOut was
  // refused at the tool boundary while the prompt promises uncapped values
  // under a 10k-char guard. Schema, handler, and sanitizer must agree.
  const src = fs.readFileSync("extensions/loops/goal-tools.ts", "utf-8");
  assert.match(src, /leftOut: Type\.Optional\(Type\.String\(\{\s*maxLength: 10000,/, "leftOut schema matches the documented 10k guard");
  assert.doesNotMatch(src, /leftOut\?\.trim\(\) \? \{ leftOut: p\.leftOut\.trim\(\)\.slice\(0, 500\)/, "no mid-word 500-slice on leftOut");
  assert.match(src, /clipSummaryValue\(p\.leftOut\.trim\(\), 10000\)/, "over-guard leftOut clips at a clause boundary");
  // The same class on findingGroups strings: a 1500-char finding (the shape
  // that would have been refused) survives the trust boundary intact.
  const long = `Users can complete the fill — ${"detail ".repeat(300)}src/popup.ts:42`;
  assert.ok(long.length > 1500, "fixture exceeds the old 500 cap");
  const kept = sanitizeFindingGroups([{ title: "Area", findings: [long] }]);
  assert.equal(kept?.[0]?.findings[0], long.replace(/\s+/g, " ").trim(), "in-guard findings pass through untouched");
});

/** Compose the card from an explicit detail list — the layer the v0.38.102
 * expander actually lives in. `buildTerminalApprovalRender` additionally
 * SYNTHESISES its own Unresolved/Next rows from the terminal facts (stop reason,
 * archive path), which would shadow the payload under test here. */
function compose(details: string[]): string[] {
  return composeRichTerminalLines(buildRichTerminalParts({
    chat: true,
    countsLine: "completion review: approved (1 review).",
    outcome: "shipped the kill-switch runbook",
    kind: "Done",
    auditHistory: [],
    groups: [],
    details,
  }));
}

// v0.38.102 — readability of the follow-up, next-step and change sections.
//
// Field 2026-09-27 (Ghosty, billing kill-switch, 4 audits): a `leftOut` field
// carrying seven distinct scope decisions rendered as ONE ~900-character
// bullet, so the reasons were unreadable.
test("v0.38.102 an inline enumeration renders as an indented list", () => {
  const chatLines = compose([
    "Changed: the kill-switch runbook",
    "Left out: Deliberately not done, and why: (1) The runbook's probes target production URLs and were not executed live here. (2) No on-call rota was invented; the runbook keeps one marked TODO(owner). (3) No production configuration or toggle file was created — the switch ships fail-open and inert. (4) Not attempted: a dedicated ops-only endpoint reporting the switch state.",
  ]);
  const idx = chatLines.indexOf(section(CARD_SECTION.followUp));
  assert.ok(idx > 0, `follow-up section present:\n${chatLines.join("\n")}`);
  assert.equal(
    chatLines[idx + 1],
    "- **Left out** — Deliberately not done, and why:",
    "the lead sentence stays on the bullet, the enumeration moves down",
  );
  assert.equal(chatLines[idx + 2], "  - The runbook's probes target production URLs and were not executed live here.");
  assert.equal(chatLines[idx + 3], "  - No on-call rota was invented; the runbook keeps one marked TODO(owner).");
  assert.equal(chatLines[idx + 4], "  - No production configuration or toggle file was created — the switch ships fail-open and inert.");
  assert.equal(chatLines[idx + 5], "  - Not attempted: a dedicated ops-only endpoint reporting the switch state.");
  // No line may still carry the whole inventory.
  assert.ok(
    chatLines.every((l) => l.length < 400),
    `no single line should hold the whole enumeration: longest ${Math.max(...chatLines.map((l) => l.length))}`,
  );
});

test("v0.38.102 a single (1) marker is prose, not a list, and is left intact", () => {
  // Guard the expander against mangling a sentence that merely contains a
  // parenthetical. Two or more markers are required before splitting.
  const chatLines = compose([
    "Changed: the runbook",
    "Unresolved: the only named owner is TODO(owner) and the count is off by (1) unit.",
  ]);
  const idx = chatLines.indexOf(section(CARD_SECTION.followUp));
  assert.equal(chatLines[idx + 1], "- the only named owner is TODO(owner) and the count is off by (1) unit.");
  assert.ok(
    !chatLines.slice(idx + 1).some((l) => l.startsWith("  - ")),
    "a lone (1) must not produce a sub-bullet",
  );
});

test("v0.38.102 Next steps gets the same treatment as the follow-ups", () => {
  const chatLines = compose([
    "Changed: the runbook",
    "Next: finish the handoff, and note: (1) claim the owner name. (2) record it in the runbook.",
  ]);
  const idx = chatLines.indexOf(section(CARD_SECTION.nextSteps));
  assert.ok(idx > 0, "Next steps section present");
  assert.equal(chatLines[idx + 1], "- finish the handoff, and note:");
  assert.equal(chatLines[idx + 2], "  - claim the owner name.");
  assert.equal(chatLines[idx + 3], "  - record it in the runbook.");
});

test("v0.39.19: chat renders its report headings, and never leaks agent-authored hashes", () => {
  // Field 2026-10-09 (terminal card screenshot): `### What Changed` and
  // `#### 1. Area` reached the screen verbatim — the Pi TUI renders depth 2
  // without its `#` prefix but prints deeper levels literally. Chat therefore
  // carries only `##` report headings; the archive keeps `###`.
  const { chatLines } = render({
    findingGroups: [
      { title: "Sound manager", findings: ["mutes WebAudio — soundManager.ts:333"] },
    ],
  });
  assert.ok(!chatLines.some((l) => l.startsWith("###")), `no H3/H4 headings in chat, got: ${chatLines.join(" / ")}`);
  assert.ok(chatLines.includes(section(CARD_SECTION.summary)), "the report section is a rendered heading");
  assert.ok(chatLines.includes(`**${CARD_SECTION.whatChanged} · Sound manager**`), "the area label is bold, not a heading");
  const archive = buildRichArchiveSection(richGoal(), "complete", ".pi-glla/archive/20260911-rich-voice.md", [
    { title: "Sound manager", findings: ["mutes WebAudio — soundManager.ts:333"] },
  ]);
  assert.ok(archive.includes(`### ${CARD_SECTION.summary}`), "archive keeps markdown headings");
  assert.ok(archive.includes(`#### ${CARD_SECTION.whatChanged} · Sound manager`), "archive keeps area subheads");
});

test("v0.39.19: token-extraction comma husks never lead the finding bullet", () => {
  // Field 2026-10-09: the card showed `· , weight 0.62 at · src/…` — the
  // evidence tokens rode mid-sentence and extraction stranded a leading
  // comma on the reason join.
  const { chatLines } = render({
    findingGroups: [
      { title: "Area", findings: ["Pictures blur via the verdict, weight 0.62 at src/extract.ts:692"] },
    ],
  });
  const bullets = chatLines.filter((l) => l.startsWith("- "));
  assert.ok(bullets.length > 0, "finding bullet renders");
  assert.ok(bullets.every((l) => !/^- \*\*[,;:]/.test(l) && !l.includes("· , ")), `no punctuation husk, got: ${bullets.join(" / ")}`);
});
