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
  buildApprovalChatLines,
  buildAuditCountsLine,
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

test("canonical render folds a lone approval with the verdict count, model-free", () => {
  const render = buildTerminalApprovalRender({
    goal: richGoal(),
    status: "complete",
    stopReason: "auditor auditor-model approved (detached)",
    archivePath: ".pi-glla/archive/20260907-approval-render.md",
    approval: "— auditor auditor-model approved on the provider retry.",
    record: "— record: .pi-glla/archive/20260907-approval-render.md",
  });
  assert.ok((render.chatLines[0] ?? "").startsWith("## Done: ship the post-objective summary with persist and replay — "), "chat opens with the request-echo Done headline");
  // Rich voice (field 20260911_*): sections + table + trailer. Headers,
  // numbered findings, table rows, and Next bullets share the chat; the
  // record pointer stays last.
  assert.ok(render.chatLines.includes("### Key Findings & Remediation"), "findings section present");
  assert.ok(render.chatLines.includes("### Verification Summary"), "verification table present");
  // v0.38.42 (field 20260909_140404): a lone approval folds with the
  // verdict count — no model ID, no redundant standalone audit bullet.
  assert.ok(
    render.chatLines.includes("• auditor approved on the provider retry (1 verdict)."),
    "single approval folds with the count, via-retry news kept",
  );
  assert.ok(!render.chatLines.some((l) => l.startsWith("• audit:")), "no standalone audit bullet when it would repeat the approval");
  assert.ok(!render.chatLines.some((l) => /auditor-model/.test(l)), "no model ID anywhere in the chat");
  const recordIdx = render.chatLines.findIndex((l) => l.startsWith("• record:"));
  assert.equal(recordIdx, render.chatLines.length - 1, "record pointer is the final line");
  assert.ok(!render.chatLines.some((l) => /^\s*Next\s*:/i.test(l)), "stale pre-verdict Next never reaches the chat");
  assert.ok(render.transcriptLines.includes("• auditor approved on the provider retry (1 verdict)."), "transcript carries the same canonical bullet, model-free");
  assert.ok(!render.transcriptLines.some((l) => /auditor-model/.test(l)), "no model ID in the transcript either");
  assert.ok(!render.transcriptLines.some((l) => /^\s*Next\s*:/i.test(l)), "transcript strips the stale Next too");
  assert.equal(render.approval, "— auditor auditor-model approved on the provider retry.", "the shared approval field keeps the full string for archive/persist consumers");
  assert.ok(render.recap.length > 0, "external single line still produced");
  assert.equal(render.outcome, (render.chatLines[0] ?? "").replace(/^## Done: ship the post-objective summary with persist and replay — /, ""), "outcome matches the chat headline");
});

test("standalone audit bullet survives only with news", () => {
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
  assert.ok(multi.chatLines.includes("• auditor approved."), "approval bullet still model-free");
  assert.ok(multi.chatLines.includes("• audit: auditor approved (2 verdicts)."), "multi-verdict counts bullet survives");
  // Lone disapproval: the counts bullet carries the disapproval news.
  const dis = richGoal();
  dis.auditHistory = [{ at: "2026-09-07T01:00:00.000Z", approved: false, disapproved: true, model: "m" }];
  const disRender = buildTerminalApprovalRender({ ...base, goal: dis, approval: "— auditor m disapproved." });
  assert.ok(disRender.chatLines.some((l) => l.startsWith("• audit: auditor disapproved")), "disapproval counts bullet survives");
  // Archive record still carries the full model ID (v0.38.42 contract:
  // the model leaves chat/transcript, never the record).
  const hooks = fs.readFileSync(path.resolve("extensions/loops/goal-auditor-hooks.ts"), "utf-8");
  assert.ok(hooks.includes("auditor ${result.model} approved (${origin})"), "archive reason still interpolates the full model ID");
});

test("counts line proofs the audit verdict from durable state only", () => {
  assert.equal(
    buildAuditCountsLine(richGoal()),
    "— audit: auditor approved (1 verdict).",
  );
  const two = richGoal();
  two.auditHistory = [...(two.auditHistory ?? []), { at: "2026-09-07T01:00:00.000Z", approved: false, disapproved: true, model: "m2" }];
  assert.match(buildAuditCountsLine(two), /auditor disapproved \(2 verdicts\)/, "latest verdict + plural count");
  const bare = seedGoal({ completionSummary: SIX }) as unknown as Goal;
  assert.equal(
    buildAuditCountsLine(bare),
    "— audit: no auditor verdict was recorded.",
    "absent facts named as absent, never invented",
  );
  assert.match(
    buildAuditCountsLine(richGoal(), "completed without audit (your choice)"),
    /completed without audit \(your choice\)/,
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
  const numbered = withLeftOut.chatLines.filter((l) => /^\d+\. \*\*/.test(l));
  assert.ok(numbered.length >= 1 && numbered.length <= 8, `numbered findings carry the evidence, got ${numbered.length}`);
  assert.ok(numbered.some((l) => /extensions\/completion-summary\.ts/.test(l)), "each finding carries its evidence inline");
  // Rich voice: SIX's concrete `Next: replay on next contact` survives in
  // the Next section, ahead of the non-do; the trailer closes last.
  const nextIdx = withLeftOut.chatLines.findIndex((l) => l.startsWith("- **Next**"));
  const leftOutIdx = withLeftOut.chatLines.findIndex((l) => l.startsWith("- **Left out**"));
  const recordIdx = withLeftOut.chatLines.findIndex((l) => l.startsWith("• record:"));
  assert.ok(nextIdx > 0 && leftOutIdx > nextIdx && recordIdx === withLeftOut.chatLines.length - 1, "next action, then non-do, then the record pointer last");
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
  assert.ok(render.chatLines.some((l) => /^\| Tests \| PASS \| full gate 2040 pass/.test(l)), "the human proof survives the strip in the table");
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
