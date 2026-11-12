// pi-goal-list-loop-audit — v0.39.70
// tests/report-polish.test.ts
//
// The end-of-task card next to Claude Code / Codex / OpenCode, plus the two
// field-observed slowness policies that are not receipts:
//
//   #7  sections are separated by a blank row (the spacing used to read
//       inverted: a gap under each heading, none between sections);
//   #8  a grouped-change label displays as the AREA, not a repeated
//       `What changed ·` heading — durable content keeps the full label;
//   #9  a diff stat since the goal started, immune to auto-commits;
//   #11 moving a trailing path:line pointer out of a sentence does not leave
//       the preposition dangling;
//   #4  a contract that names its own gate (`npm run release:check`) is not
//       "high-stakes language"; real deploy/publish objectives still are;
//   #6  "upgrade your plan / purchase credits" with no reset hint is a spent
//       plan even under an HTTP 429.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";

import { registerSummaryRenderer } from "../extensions/summary-renderer.ts";
import { buildChangeStat, buildFinalRepoStateLines, buildRichTerminalParts, changeStatLine, composeRichTerminalLines, extractEvidenceTokens } from "../extensions/completion-summary.ts";
import { extractFindingEvidence } from "../extensions/finding-lead.ts";
import { workingTreeFingerprint } from "../extensions/gate-receipts.ts";
import { highStakesScanText, LIGHT_AUDIT_CEILINGS, resolveAuditTier } from "../extensions/goal-loop-auditor-process.ts";
import { isBillingError, isSpentPlanWall, quotaSignal } from "../extensions/quota-retry.ts";
import { classifyMainModelFailure, isEagerRetryFailure, isQuotaHorizonExempt } from "../extensions/main-model-recovery.ts";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { MockPi } from "./harness/mock-pi.ts";

function render(content: string, width = 120): string[] {
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  const message = { content, details: { terminalApprovalGoalId: "polish" } };
  const rows = (pi.messageRenderers.get("goal-event")!(message as never, { outputPad: 1, expanded: true } as never, theme) as Component).render(width);
  return rows.map((row) => stripTerminalSequences(row).trimEnd().replace(/^ /, ""));
}

const CARD = composeRichTerminalLines(buildRichTerminalParts({
  outcome: "The card reads as one report", countsLine: "", chat: true,
  groups: [
    { title: "Layout", findings: ["Sections are spaced like a report — blank row between them"] },
    { title: "Evidence", findings: ["GLLA-run gates show as PASS rows — receipts"] },
  ],
  details: ["Next: Ship it."],
  gates: [{ gate: "Typecheck", command: "npm run check", notes: "exited 0" }],
  changeLine: "3 files changed, +40 −12",
})).join("\n");

test("#7: one blank row separates sections; the heading sits directly on its body", () => {
  const rows = render(CARD);
  const at = (text: string) => rows.findIndex((row) => row === text);
  for (const heading of ["Summary", "Verification", "Next steps"]) {
    const i = at(heading);
    assert.ok(i > 0, `${heading} rendered:\n${rows.join("\n")}`);
    assert.equal(rows[i - 1], "", `a blank row precedes ${heading}`);
  }
  const layout = at("Layout");
  assert.equal(rows[layout + 1]?.startsWith("- "), true, "an area label sits directly above its bullets");
  assert.equal(rows[layout - 1], "", "areas are separated from what came before");
});

test("#8: area labels display as the area; durable content keeps the full label", () => {
  assert.match(CARD, /\*\*What changed · Layout\*\*/, "durable content unchanged");
  const rows = render(CARD);
  assert.ok(rows.includes("Layout"));
  assert.ok(!rows.some((row) => /What changed ·/.test(row)), `no repeated prefix on screen:\n${rows.join("\n")}`);
});

test("#9: the change line renders under the lede", () => {
  assert.match(CARD, /\n3 files changed, \+40 −12\n/);
  assert.ok(render(CARD).includes("3 files changed, +40 −12"));
});

test("#9: the diff stat compares content snapshots, so auto-commits cannot hide it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-stat-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const start = workingTreeFingerprint(dir)!;
  assert.deepEqual(buildChangeStat(dir, start), { files: 0, added: 0, removed: 0, rows: [], more: 0 });
  assert.equal(changeStatLine(buildChangeStat(dir, start)), "No file changes since the goal started.");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  git("add", "-A"); git("commit", "-qm", "daemon auto-commit");
  const stat = buildChangeStat(dir, start)!;
  assert.equal(stat.files, 2);
  assert.equal(stat.added, 3);
  assert.equal(stat.removed, 1);
  assert.equal(changeStatLine(stat), "2 files changed, +3 −1");
  assert.deepEqual(stat.rows, ["a.txt +2 −1", "b.txt +1 −0"]);
  const repo = buildFinalRepoStateLines(dir, stat)!;
  assert.ok(repo.includes("Tree clean"), "git status alone would have said nothing changed");
  assert.ok(repo.includes("Since goal start: 2 files changed, +3 −1"));
  assert.equal(buildChangeStat(dir, undefined), undefined, "no start snapshot → no invented stat");
});

test("#11: a trailing pointer does not leave its preposition dangling", () => {
  assert.equal(extractEvidenceTokens("sections, not an audit log for extensions/a.ts:12").text, "sections, not an audit log");
  assert.equal(extractFindingEvidence("fixed in a.ts:5.").text, "fixed.");
  assert.equal(extractFindingEvidence("kept extensions/a.ts:3 working in").text, "kept working in", "mid-sentence pointer: prose untouched");
  assert.equal(extractFindingEvidence("plain prose ending in").text, "plain prose ending in", "no pointer, no edit");
});

test("#4: contract gate commands are not high-stakes language; real stakes still escalate", () => {
  const quiet = { turns: 30, fileWrites: 8, bashCalls: 30 };
  assert.equal(resolveAuditTier({ telemetry: quiet, objective: "Fix the card spacing", verificationContract: "- `npm run release:check` exits 0\n- run release:check", spotCheckRate: 0 }).tier, "light");
  assert.equal(resolveAuditTier({ telemetry: quiet, objective: "Publish v1.2 to npm", spotCheckRate: 0 }).tier, "full");
  assert.equal(resolveAuditTier({ telemetry: quiet, objective: "Deploy the new release to prod.", spotCheckRate: 0 }).tier, "full");
  assert.doesNotMatch(highStakesScanText("ran `npm run release:check` and bun run deploy:preview"), /release|deploy/);
  assert.ok(LIGHT_AUDIT_CEILINGS.bashCalls >= 60 && LIGHT_AUDIT_CEILINGS.fileWrites >= 25, "ceilings sit above an ordinary goal");
});

test("#6: a spent plan under a 429 is an account wall; reset-hinted limits stay rate limits", () => {
  const minimax = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"}}';
  assert.equal(isSpentPlanWall(minimax), true);
  // quota-class (prompt backup rotation in a supervised goal), never billing
  // (which would first spend the same-model budget on a plan that cannot heal)
  assert.equal(quotaSignal(minimax), "plan-quota");
  assert.equal(isBillingError(minimax), false);
  assert.equal(isQuotaHorizonExempt(minimax), true, "keeps the quota-class cadence and prompt rotation");
  assert.equal(isEagerRetryFailure(classifyMainModelFailure(minimax)), false, "never hammered on the eager 5s window");
  assert.equal(isEagerRetryFailure(classifyMainModelFailure("429 rate limit exceeded")), true, "a plain rate limit keeps its eager window");
  assert.equal(quotaSignal("429 usage limit reached, resets at 15:00 UTC. Upgrade your plan for more."), "rate-limit");
  assert.equal(quotaSignal("429 rate limit exceeded"), "rate-limit");
  const minimaxRate = '429 {"error":{"type":"rate_limit_error","message":"Token Plan rate limit reached: Upgrade your Token Plan or switch to pay-as-you-go API usage. (2062)"}}';
  assert.equal(isSpentPlanWall(minimaxRate), false, "2062 is a request-rate window, not a spent plan");
  assert.equal(quotaSignal(minimaxRate), "rate-limit");
  assert.equal(quotaSignal("429 Too Many Requests"), "rate-limit");
  assert.equal(quotaSignal("membership concurrency limit exceeded: 11/10 — upgrade your plan"), "plan-quota", "a concurrency wall keeps its own lane");
});
