// pi-goal-list-loop-audit — v0.38.25 (post-objective summary)
//
// Field failure 2026-09-07: goal `20260907131550-12ddoy` completed with a
// perfect six-label archive record, but the approval chat lines fired into a
// dead context (auditor verdict landed with no live turn) — record perfect,
// delivery silent. These pins cover the fix: ONE canonical builder for every
// approval surface (chat/transcript/external/persisted), the audit-goal
// counts line, persist-first delivery marking via the idle probe, and
// fire-once replay on the next live contact.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Goal } from "../extensions/goal-loop-core.js";
import { ledgerPath } from "../extensions/goal-loop-core.js";
import {
  CARD_SECTION,
  buildApprovalChatLines,
  buildAuditCountsLine,
  buildRichArchiveSection,
  buildTerminalApprovalRender,
  chatSafeDetailValue,
  clipSummaryValue,
} from "../extensions/completion-summary.js";
import {
  approvalRenderStorePath,
  persistApprovalRender,
  replayUndeliveredApprovalRenders,
} from "../extensions/approval-render-store.js";
import { makeMockCtx, seedGoal, tmpCwd } from "./harness/mock-pi.js";

const SIX = [
  "Outcome: shipped the post-objective summary",
  "Changed: extensions/completion-summary.ts",
  "Evidence: commit abc123",
  "Tests: bun test — pass",
  "Unresolved: none",
  "Next: replay on next contact",
].join("\n");

function richGoal(): Goal {
  return seedGoal({
    id: "20260907-approval-render",
    objective: "ship the post-objective summary with persist and replay",
    completionSummary: SIX,
    telemetry: { turns: 42, fileWrites: 17, bashCalls: 23 },
    auditHistory: [
      { at: "2026-09-07T00:00:00.000Z", approved: true, disapproved: false, model: "auditor-model", report: "fine" },
    ],
  }) as unknown as Goal;
}

test("skipped challenges are disclosed in chat, transcript, and archive evidence", () => {
  for (const challenge of ["skipped: light-tier audit", "skipped: rework-streak convergence", "skipped: transport error with internal details"]) {
    const goal = richGoal();
    goal.auditHistory![0]!.challenge = challenge;
    const render = buildTerminalApprovalRender({ goal, status: "complete", approval: "— completion audit approved.", record: "— record: archive.md" });
    const archive = buildRichArchiveSection(goal, "complete", "archive.md");
    for (const lines of [render.chatLines, render.transcriptLines, archive]) {
      assert.ok(lines.some(line => line.includes("Falsification pass skipped")));
      assert.ok(lines.every(line => !line.includes("internal details")), "raw transport diagnostics stay in the audit record");
    }
  }
});

test("canonical render folds a lone approval with the verdict count, model-free", () => {
  const render = buildTerminalApprovalRender({
    goal: richGoal(),
    status: "complete",
    stopReason: "auditor auditor-model approved (detached)",
    archivePath: ".pi-glla/archive/20260907-approval-render.md",
    approval: "— auditor auditor-model approved on the provider retry.",
    record: "— record: .pi-glla/archive/20260907-approval-render.md",
  });
  assert.equal(render.chatLines[0], `## Done — ${render.outcome}`, "outcome opens the card");
  // Report shape (field 2026-11-11): what changed, what was checked, what is
  // still open, what comes next — then ONE receipt line.
  assert.ok(render.chatLines.includes(`## ${CARD_SECTION.summary}`), "the change body present");
  assert.ok(!render.chatLines.some((l) => l.startsWith("### ")), "no literal markdown headings in chat");
  assert.ok(render.chatLines.includes(`## ${CARD_SECTION.verification}`), "verification is part of the report");
  assert.equal(render.chatLines.includes("1 passed."), false, "no aggregate substitute for the gate row");
  assert.ok(!render.chatLines.some((l) => /^Tests:/.test(l)), "the raw Tests label stays archival");
  assert.ok(!render.chatLines.some((l) => /^\| Tests \|/.test(l)), "the mechanical Tests row stays archival");
  const findingsIdx = render.chatLines.indexOf(`## ${CARD_SECTION.summary}`);
  const tableIdx = render.chatLines.indexOf(`## ${CARD_SECTION.verification}`);
  const nextIdx = render.chatLines.indexOf(`## ${CARD_SECTION.nextSteps}`);
  assert.ok(findingsIdx !== -1 && findingsIdx < tableIdx && tableIdx < nextIdx, "changes precede verification, which precedes next steps");
  // v0.38.42 (field 20260909_140404): a lone approval folds with the count and
  // carries no model ID. The verdict rides ONE receipt line that closes the
  // report, with the record pointer last.
  const last = render.chatLines.at(-1) ?? "";
  assert.match(last, /completion audit approved on the provider retry \(1 review\) \u00b7 record: .pi-glla\/archive\/20260907-approval-render\.md\./, last);
  assert.ok(!render.chatLines.some((l) => l.startsWith("\u2022 ")), "no legacy bullet trailer");
  assert.ok(!render.chatLines.some((l) => /auditor-model/.test(l)), "no model ID anywhere in the chat");
  assert.ok(!render.chatLines.some((l) => /^\s*Next\s*:/i.test(l)), "stale pre-verdict Next never reaches the chat");
  const transcriptLast = render.transcriptLines.at(-1) ?? "";
  assert.match(transcriptLast, /completion audit approved on the provider retry \(1 review\)/, "transcript carries the verdict half, model-free");
  assert.ok(!render.transcriptLines.some((l) => /auditor-model/.test(l)), "no model ID in the transcript either");
  assert.ok(!render.transcriptLines.some((l) => /^\s*Next\s*:/i.test(l)), "transcript strips the stale Next too");
  assert.equal(render.approval, "— auditor auditor-model approved on the provider retry.", "the shared approval field keeps the full string for archive/persist consumers");
  assert.ok(render.recap.length > 0, "external single line still produced");
  assert.ok((render.chatLines[0] ?? "").startsWith(`## Done — ${render.outcome}`), "outcome matches the chat headline");
});

test("the receipt states verdict-count news once, model-free", () => {
  const base = {
    status: "complete" as const,
    stopReason: "auditor m approved (detached)",
    archivePath: ".pi-glla/archive/20260907-approval-render.md",
    approval: "— auditor m approved.",
    record: "— record: .pi-glla/archive/20260907-approval-render.md",
  };
  // Two verdicts: the counts bullet carries news the approval lacks.
  const two = richGoal();
  two.auditHistory = [...(two.auditHistory ?? []), { at: "2026-09-07T01:00:00.000Z", approved: true, disapproved: false, model: "m2" }];
  const multi = buildTerminalApprovalRender({ ...base, goal: two });
  const multiLast = multi.chatLines.at(-1) ?? "";
  assert.match(multiLast, /completion audit approved \u00b7 completion review: approved \(2 reviews\)/, `multi-review news survives in the receipt: ${multiLast}`);
  assert.ok(!multi.chatLines.some((l) => /auditor-model|\bm2\b/.test(l)), "no model ID in the multi-review receipt");
  // Lone disapproval: the counts segment carries the disapproval news.
  const dis = richGoal();
  dis.auditHistory = [{ at: "2026-09-07T01:00:00.000Z", approved: false, disapproved: true, model: "m" }];
  const disRender = buildTerminalApprovalRender({ ...base, goal: dis, approval: "— auditor m disapproved." });
  assert.match(disRender.chatLines.at(-1) ?? "", /completion review: disapproved/, "disapproval news survives in the receipt");
  // Archive record still carries the full model ID (v0.38.42 contract:
  // the model leaves chat/transcript, never the record).
  const hooks = fs.readFileSync(path.resolve("extensions/loops/goal-auditor-hooks.ts"), "utf-8");
  assert.ok(
    hooks.includes("completion audit ${model} approved (${origin})"),
    "archive reason still carries the model provenance (v0.38.99: templated from the settlement driver's approved model)",
  );
});

test("counts line proofs the audit verdict from durable state only", () => {
  assert.equal(
    buildAuditCountsLine(richGoal()),
    "— completion review: approved (1 review).",
  );
  const two = richGoal();
  two.auditHistory = [...(two.auditHistory ?? []), { at: "2026-09-07T01:00:00.000Z", approved: false, disapproved: true, model: "m2" }];
  assert.match(buildAuditCountsLine(two), /disapproved \(2 reviews\)/, "latest review + plural count");
  const bare = seedGoal({ completionSummary: SIX }) as unknown as Goal;
  assert.equal(
    buildAuditCountsLine(bare),
    "— completion review: no review recorded.",
    "absent facts named as absent, never invented",
  );
  assert.match(
    buildAuditCountsLine(richGoal(), "completed without audit (your choice)"),
    /completed without a completion review \(your choice\)/,
    "no-audit path says so honestly",
  );
  assert.doesNotMatch(
    buildAuditCountsLine(richGoal()),
    /turns|file writes|bash calls/,
    "raw run stats stay in the archive, never in user chat (field 2026-09-08)",
  );
});

test("buildApprovalChatLines stays backward compatible without counts", () => {
  const lines = buildApprovalChatLines({ outcome: "did it", details: ["Changed: x"], approval: "— approved.", record: "— record: p" });
  assert.deepEqual(lines, ["✓ done — did it", "• Changed: x", "• approved.", "• record: p"]);
});

test("v0.38.37 posted summary carries verifiable-result bullets plus the deliberate non-do", () => {
  const base = {
    goal: richGoal(),
    status: "complete" as const,
    stopReason: "auditor auditor-model approved (detached)",
    archivePath: ".pi-glla/archive/20260907-approval-render.md",
    approval: "— auditor auditor-model approved.",
    record: "— record: .pi-glla/archive/20260907-approval-render.md",
  };
  const withLeftOut = buildTerminalApprovalRender({ ...base, leftOut: "the walkthrough artifact surface" });
  // Each change is one bullet, outcome first with its evidence folded in; the
  // bare `Changed:` value is NOT promoted into a second human finding.
  const bullets = withLeftOut.chatLines.filter((l) => l.startsWith("- "));
  assert.ok(bullets.length >= 1 && bullets.length <= 8, `change bullets carry the evidence, got ${bullets.length}`);
  assert.ok(bullets.some((l) => /extensions\/completion-summary\.ts/.test(l)), "the change carries its evidence inline");
  assert.ok(!withLeftOut.chatLines.some((l) => /^- \*\*gate green/.test(l)), "an Evidence receipt never becomes a change");
  // The follow-up section carries the non-do; the receipt closes last.
  const remainingIdx = withLeftOut.chatLines.indexOf(`## ${CARD_SECTION.followUp}`);
  assert.ok(remainingIdx > 0, "the follow-up section carries the non-do");
  const recordIdx = withLeftOut.chatLines.findIndex((l) => l.includes("record: "));
  assert.equal(recordIdx, withLeftOut.chatLines.length - 1, "the record pointer closes the report");
  assert.ok(withLeftOut.chatLines.some((l) => l === "- **Left out** — the walkthrough artifact surface"), "agent-claimed non-do closes the sections");
  assert.ok(withLeftOut.transcriptLines.some((l) => l === "- **Left out** — the walkthrough artifact surface"), "transcript surface carries the non-do too");
  const without = buildTerminalApprovalRender(base);
  assert.ok(!without.chatLines.some((l) => /Left out:/.test(l)), "absent non-do stays absent, never invented");
  assert.ok(!without.transcriptLines.some((l) => /Left out:/.test(l)), "transcript never invents a non-do");
  const filler = buildTerminalApprovalRender({ ...base, leftOut: "none" });
  assert.ok(!filler.chatLines.some((l) => /Left out:/.test(l)), "filler non-do drops like any filler label");
});

test("idle-persisted render replays once on the next live contact", () => {
  const cwd = tmpCwd();
  const chatLines = ["✓ done — shipped it", "— auditor m approved.", "— audit: auditor approved (1 verdict).", "— record: r"];
  assert.equal(persistApprovalRender(cwd, { goalId: "g1", objective: "ship it", chatLines }), true);
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(replayUndeliveredApprovalRenders(ctx, (entry) => { ctx.ui.notify(entry.chatLines.join("\n"), "info"); return true; }), 1, "confirmed delivery acknowledges the render");
  assert.equal(ctx.ui.notifies.length, 1, "exactly one notify goes out");
  assert.equal(ctx.ui.notifies[0]?.message, chatLines.join("\n"), "the persisted render arrives verbatim");
  assert.equal(replayUndeliveredApprovalRenders(ctx), 0, "fire-once: second contact replays nothing");
  assert.equal(ctx.ui.notifies.length, 1, "no duplicate notify");
  const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), "utf-8"));
  assert.equal((stored[0] as { deliveredAt?: string }).deliveredAt !== undefined, true, "replay marks delivered");
  const ledger = fs.readFileSync(ledgerPath(cwd), "utf-8");
  assert.match(ledger, /terminal_approval_render_persisted/, "persist is ledgered");
  assert.match(ledger, /terminal_approval_render_replayed/, "replay is ledgered");
});

test("render with confirmed delivery never replays", () => {
  const cwd = tmpCwd();
  persistApprovalRender(cwd, { goalId: "g2", objective: "live one", chatLines: ["✓ done — live"] });
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(replayUndeliveredApprovalRenders(ctx, () => true), 1);
  assert.equal(replayUndeliveredApprovalRenders(ctx), 0);
  assert.equal(ctx.ui.notifies.length, 0);
});

test("corrupt store degrades to zero replays, never throws", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(approvalRenderStorePath(cwd), "{not json", "utf-8");
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(replayUndeliveredApprovalRenders(ctx), 0);
  const ledger = fs.readFileSync(ledgerPath(cwd), "utf-8");
  assert.match(ledger, /terminal_approval_render_store_invalid/, "corruption is ledgered, not thrown");
});


test("v0.38.39 chat brief strips machine paths but the archive keeps them", () => {
  assert.equal(
    chatSafeDetailValue("full gate 2040 pass across 204 files (/var/tmp/glla-elapsed-release-check.log, tarball pi-goal-list-loop-audit-0.38.38.tgz)"),
    "full gate 2040 pass across 204 files",
    "absolute log path + tarball token drop, human proof stays",
  );
  assert.equal(
    chatSafeDetailValue("tag v0.38.38, npm version 0.38.38, PR #47 closed"),
    "tag v0.38.38, npm version 0.38.38, PR #47 closed",
    "human evidence passes through untouched",
  );
  const render = buildTerminalApprovalRender({
    goal: richGoal(),
    status: "complete",
    approval: "— auditor m approved.",
    record: "— record: .pi-glla/archive/x.md",
    completionSummary: [
      "Outcome: cut the duplication",
      "Changed: extensions/completion-summary.ts",
      "Evidence: tag v0.38.38",
      "Tests: full gate 2040 pass (/var/tmp/glla-elapsed-release-check.log)",
      "Unresolved: none",
      "Next: none",
    ].join("\n"),
  });
  assert.ok(!render.chatLines.some((l) => l.includes("/var/tmp/")), "no machine path reaches the chat lines");
  // Chat hides technical verification by default; full detail stays in the archive.
  assert.equal(render.chatLines.includes("### Verification"), false, "verification is hidden by default");
  assert.equal(render.chatLines.includes("1 passed."), false, "test aggregate is hidden by default");
  assert.ok(!render.chatLines.some((l) => /^Tests:/.test(l)), "technical Tests stays out of default chat");
  assert.ok(!render.chatLines.some((l) => /^\| Tests \|/.test(l)), "gate table stays archival");
});

test("v0.38.39 clause cut respects +-joined lists", () => {
  const cut = clipSummaryValue("Evidencealpha beta, gamma + delta epsilon zeta eta theta iota kappa lambda mu", 40);
  assert.equal(cut, "Evidencealpha beta, gamma…", "cut lands on the + boundary (without it the cut would strand at `beta…`)");
});

test("second approval for the same goal after delivery queues a fresh render", () => {
  // v0.38.45 audit: goalId dedup matched delivered history too, so an
  // archive-failure retry (same goalId re-approved) silently dropped its
  // chat summary while the caller believed it queued.
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(persistApprovalRender(cwd, { goalId: "g9", objective: "retry me", chatLines: ["✓ done — first"] }), true);
  assert.equal(replayUndeliveredApprovalRenders(ctx, () => true), 1, "first render delivers");
  assert.equal(
    persistApprovalRender(cwd, { goalId: "g9", objective: "retry me", chatLines: ["✓ done — second"] }),
    true,
    "re-approval after delivery queues instead of deduping against history",
  );
  assert.equal(replayUndeliveredApprovalRenders(ctx, () => true), 1, "the fresh render replays");
  assert.equal(ctx.ui.notifies.length, 0, "confirmed deliveries stay silent");
});

test("error-only audit history renders an honest archive banner with no review row", () => {
  const goal = seedGoal({
    id: "20260925-no-review-banner",
    objective: "prove the banner never claims an unrecorded review",
    completionSummary: "Outcome: nothing shipped. Changed: none. Evidence: none. Tests: none. Unresolved: none. Next: none.",
    auditHistory: [
      { at: "2026-09-25T00:00:00.000Z", approved: false, disapproved: false, model: "auditor-model", error: "provider wall: no model available" },
    ],
  }) as unknown as Goal;
  const lines = buildRichArchiveSection(goal, "complete", ".pi-glla/archive/20260925-no-review.md");
  assert.ok(lines.some((l) => l.includes("completed without a recorded completion review")), `receipt names the absence:\n${lines.join("\n")}`);
  assert.ok(!lines.some((l) => /completion review recorded/.test(l)), "no false recorded-review claim");
  assert.ok(!lines.some((l) => /^\| Completion review \| no review \|/.test(l)), "no lowercase review row leaks into the archive table");
});

test('unreadable outbox refuses enqueue without replacing an earlier pending render', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const cwd = tmpCwd();
  const first = { goalId: 'preserved-first', objective: 'first', chatLines: ['first summary'] };
  const second = { goalId: 'preserved-second', objective: 'second', chatLines: ['second summary'] };
  assert.equal(persistApprovalRender(cwd, first), true);
  const file = approvalRenderStorePath(cwd);
  const original = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0);
  try {
    assert.equal(persistApprovalRender(cwd, second), false);
    assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => { throw new Error('must not deliver an unreadable queue'); }), 0);
  } finally { fs.chmodSync(file, 0o600); }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(persistApprovalRender(cwd, second), true);
  const delivered: string[] = [];
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => { delivered.push(entry.goalId); return true; }), 2);
  assert.deepEqual(delivered, [first.goalId, second.goalId]);
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => true), 0);
});

test('malformed and partially invalid stores preserve bytes and refuse mutations', () => {
  const cwd = tmpCwd();
  persistApprovalRender(cwd, { goalId: 'valid', objective: 'valid', chatLines: ['pending'] });
  const file = approvalRenderStorePath(cwd);
  const valid = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
  for (const bytes of ['{not json', JSON.stringify([valid, { goalId: 'broken' }])]) {
    fs.writeFileSync(file, bytes);
    let sends = 0;
    assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => { sends++; return true; }), 0);
    assert.equal(persistApprovalRender(cwd, { goalId: 'new', objective: 'new', chatLines: ['new'] }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(sends, 0);
  }
  // Explicit repair of the preserved bytes restores delivery without loss.
  fs.writeFileSync(file, JSON.stringify([valid]));
  assert.equal(persistApprovalRender(cwd, { goalId: 'new', objective: 'new', chatLines: ['new'] }), true);
  const ids: string[] = [];
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => { ids.push(entry.goalId); return true; }), 2);
  assert.deepEqual(ids, ['valid', 'new']);
});

test('delivery callback enqueue survives acknowledgement and replays on next contact', () => {
  const cwd = tmpCwd();
  const enqueue = (goalId: string) => persistApprovalRender(cwd, { goalId, objective: goalId, chatLines: [goalId] });
  assert.equal(enqueue('first'), true);
  const delivered: string[] = [];
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => {
    delivered.push(entry.goalId);
    assert.equal(enqueue('second'), true);
    return true;
  }), 1);
  const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), 'utf8'));
  assert.equal(stored.length, 2);
  assert.ok(stored.find((e: any) => e.goalId === 'first').deliveredAt);
  assert.equal(stored.find((e: any) => e.goalId === 'second').deliveredAt, undefined);
  const deliver = (entry: { goalId: string }) => { delivered.push(entry.goalId); return true; };
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, deliver), 1);
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, deliver), 0);
  assert.deepEqual(delivered, ['first', 'second']);
});

test('nested replay neither repeats the in-flight render nor restores acknowledged entries', () => {
  const cwd = tmpCwd();
  for (const goalId of ['first', 'second']) assert.equal(persistApprovalRender(cwd, { goalId, objective: goalId, chatLines: [goalId] }), true);
  const delivered: string[] = [];
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => {
    delivered.push(entry.goalId);
    assert.equal(replayUndeliveredApprovalRenders({ cwd }, nested => { delivered.push(nested.goalId); return true; }), 1);
    return true;
  }), 1);
  assert.deepEqual(delivered, ['first', 'second']);
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => true), 0);
  assert.ok(JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), 'utf8')).every((e: any) => e.deliveredAt));
});

test('refusal rotation preserves callback enqueues and makes them reachable next contact', () => {
  const cwd = tmpCwd();
  for (let i = 0; i < 6; i++) persistApprovalRender(cwd, { goalId: `g${i}`, objective: 'rotation', chatLines: [`g${i}`] });
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => {
    if (entry.goalId === 'g0') assert.equal(persistApprovalRender(cwd, { goalId: 'new', objective: 'new', chatLines: ['new'] }), true);
    return false;
  }), 0);
  const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), 'utf8'));
  assert.equal(stored.length, 7);
  assert.ok(stored.every((e: any) => !e.deliveredAt));
  const delivered: string[] = [];
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => { delivered.push(entry.goalId); return true; }), 5);
  assert.deepEqual(delivered.slice(0, 2), ['g5', 'new']);
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => { delivered.push(entry.goalId); return true; }), 2);
  assert.equal(new Set(delivered).size, 7);
});

// v0.39.45 (audit 2026-10-22) — the delivery acknowledgement is the gate
// for the "replayed" claim, and a broken store is reported once, not on
// every read.
test('a replay whose acknowledgement cannot land is not claimed as replayed and is not re-delivered', () => {
  const cwd = tmpCwd();
  assert.equal(persistApprovalRender(cwd, { goalId: 'ack-fail', objective: 'ack', chatLines: ['ack'] }), true);
  const file = approvalRenderStorePath(cwd);
  const delivered: string[] = [];
  // The store can be READ but not WRITTEN: the write path creates a temp
  // file next to the store, so a directory in its place makes every write
  // fail (EISDIR) while the pending entry stays readable.
  fs.mkdirSync(`${file}.tmp`);
  try {
    assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => { delivered.push(entry.goalId); return true; }), 1);
    const lines = fs.readFileSync(ledgerPath(cwd), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(lines.some(l => l.type === 'terminal_approval_render_replayed'), false,
      'a delivery whose acknowledgement did not land must not be journalled as replayed');
    assert.equal(lines.some(l => l.type === 'terminal_approval_render_replay_unacknowledged'), true,
      'the unacknowledged delivery is journalled as such');
    // The durable truth is unchanged: the entry is still pending, because
    // the acknowledgement never landed.
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored[0].deliveredAt, undefined, 'an unacknowledged delivery stays pending in the store');
  } finally { fs.rmSync(`${file}.tmp`, { recursive: true, force: true }); }
  // The store is writable again: the next replay re-attempts the
  // acknowledgement (the visible message is deduplicated by the delivery
  // layer, not by the outbox) and the row now claims a real replay.
  const again: string[] = [];
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, entry => { again.push(entry.goalId); return true; }), 1);
  assert.deepEqual(again, ['ack-fail']);
  const rows = fs.readFileSync(ledgerPath(cwd), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(rows.some(l => l.type === 'terminal_approval_render_replayed'), true,
    'a landed acknowledgement is journalled as a replay');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].deliveredAt !== undefined, true,
    'the acknowledgement landed this time');
});

test('a broken store is reported once per distinct broken file, not on every read', () => {
  const cwd = tmpCwd();
  const file = approvalRenderStorePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  for (let i = 0; i < 3; i++) assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => true), 0);
  const rows = fs.readFileSync(ledgerPath(cwd), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(l => l.type === 'terminal_approval_render_store_invalid');
  assert.equal(rows.length, 1, 'the same broken store is reported once');
  assert.ok(String(rows[0].value.repair ?? '').length > 0, 'the row names the repair');
  // A DIFFERENT broken store is reported again.
  fs.writeFileSync(file, '{still not json');
  assert.equal(replayUndeliveredApprovalRenders({ cwd }, () => true), 0);
  const rows2 = fs.readFileSync(ledgerPath(cwd), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(l => l.type === 'terminal_approval_render_store_invalid');
  assert.equal(rows2.length, 2, 'a changed broken store is reported again');
});
