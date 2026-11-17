import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compactHumanSummary, humanCheckTime, humanTextPreview, HUMAN_HANDOFF_GUIDANCE } from "../extensions/human-handoff.js";
import { buildActionReminder, registerActionReminderRenderer } from "../extensions/action-reminder.js";
import { buildTerminalApprovalRender, buildRichArchiveSection, buildRecordedFactsCompletionSummary } from "../extensions/completion-summary.js";
import { buildUiStatusCard } from "../extensions/goal-loop-display.js";
import { projectUiStatus } from "../extensions/ui-status.js";
import activate, { __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import { MockPi, seedGoal, seedState, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import { readState, type Goal, type State } from "../extensions/goal-loop-core.js";

function renderedReminder(reason: string, action?: string, expanded = false) {
  const pi = new MockPi(); registerActionReminderRenderer(pi.api);
  const reminder = buildActionReminder({ kind: "blocked", reason, action, resumeCommand: "/list resume" });
  const component = pi.messageRenderers.get("glla-action-reminder")!({ details: reminder.details, content: reminder.content },
    { outputPad: 1, expanded }, { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s }) as { render(width: number): string[] };
  return { reminder, text: component.render(100).join("\n") };
}

test("football-style wall is a preview with the original report available on expansion", () => {
  const lead = "A human reviewer needs to run the four desktop playtest tasks and record the results.";
  const tail = " Investigation: verifier details, historical paths, passing gates and durable judgments.".repeat(32);
  const reason = lead + tail + " SENTINEL-END";
  const action = "Follow docs/premium/HUMAN-PLAYTEST-QUICKSTART.md, save your observations, then reply here.";
  const collapsed = renderedReminder(reason, action);
  const expanded = renderedReminder(reason, action, true);
  assert.match(collapsed.text, /four desktop playtest tasks/);
  assert.match(collapsed.text, /HUMAN-PLAYTEST-QUICKSTART/);
  assert.match(collapsed.text, /More details/);
  assert.doesNotMatch(collapsed.text, /SENTINEL-END/);
  assert.match(expanded.text, /SENTINEL-END/);
  assert.doesNotMatch(expanded.text, /More details: expand/);
  assert.ok(expanded.text.split("\n").length > collapsed.text.split("\n").length * 2);
  assert.equal(collapsed.reminder.details.reason, reason, "display never truncates the durable report");
  assert.equal(collapsed.reminder.details.action, action);
  // Legacy missing-action cases must not invent playtest steps from arbitrary prose.
  assert.match(renderedReminder(reason).text, /Complete the requirement/);
});

test("a missing completion field never turns telemetry into human changes", () => {
  const goal = seedGoal({ completionSummary: "Outcome: Both panels now show readable field labels. Changed: Labels use the stored question text.",
    telemetry: { turns: 0, fileWrites: 37, bashCalls: 55, files: ["/home/user/project/internal.ts"] } }) as unknown as Goal;
  const input = { goal, status: "complete" as const, approval: "— completion audit approved.", record: "— record: saved.md", archivePath: "saved.md", stopReason: "auditor approved" };
  const human = buildTerminalApprovalRender(input).chatLines.join("\n");
  assert.match(human, /Both panels now show readable field labels/);
  assert.match(human, /Labels use the stored question text/);
  assert.doesNotMatch(human, /file-write|bash calls|terminal reason|internal.ts|status=|review the durable/);
  const archive = buildRichArchiveSection(goal, "complete", "saved.md").join("\n");
  assert.match(archive, /file-write/);
  assert.match(archive, /internal.ts/);
});

test("no supplied result means an honest missing explanation, not an invented fix", () => {
  const goal = seedGoal({ objective: "Fix the panels", completionSummary: undefined, telemetry: { turns: 1, fileWrites: 37, bashCalls: 55 } }) as unknown as Goal;
  const human = buildTerminalApprovalRender({ goal, status: "complete", approval: "— approved.", record: "— record: saved.md" }).chatLines.join("\n");
  assert.match(human, /plain-language result was not recorded/);
  assert.doesNotMatch(human, /file-write|bash calls|terminal reason|Objective.*archived/);
});

test("a previously persisted system fallback stays out of human changes on replay", () => {
  const goal = seedGoal({ objective: "Fix readable field names", telemetry: { turns: 0, fileWrites: 37, bashCalls: 55, files: ["/home/user/internal.ts"] } }) as unknown as Goal;
  goal.completionSummary = buildRecordedFactsCompletionSummary({ goal, status: "complete", archivePath: "saved.md", stopReason: "auditor approved" });
  const render = buildTerminalApprovalRender({ goal, status: "complete", approval: "— approved.", record: "— record: saved.md" });
  for (const human of [render.chatLines.join("\n"), render.transcriptLines.join("\n"), render.recap]) {
    assert.match(human, /plain-language result was not recorded/);
    assert.doesNotMatch(human, /file-write|bash calls|terminal reason|internal.ts|status=|review the durable/);
  }
  assert.match(goal.completionSummary, /file-write/);
});

test("compact completion shows primary changes; exact actions and limitations remain intact", () => {
  const action = '- **Next** — Run `verify --target "project with spaces"` after authorization.';
  const limit = '- **Unresolved** — The signed-in flow was not tested; do not assume it works.';
  const full = ["## Done — Field names are readable", "", "What Changed", "**1. Labels**", "- Readable questions replace internal identifiers", "  - implementation.ts:42 and the entire proof", ...Array.from({ length: 9 }, (_, i) => `- Supporting change ${i}`), "Remaining", limit, "Next", action].join("\n");
  const brief = compactHumanSummary(full);
  assert.equal(brief.omitted, true);
  assert.match(brief.content, /Readable questions replace internal identifiers/);
  assert.doesNotMatch(brief.content, /implementation.ts|Supporting change 8|\*\*1\. Labels/);
  assert.ok(brief.content.includes(action));
  assert.ok(brief.content.includes(limit));
  assert.match(brief.content, /expanded message and saved record/);
  assert.ok(full.includes("Supporting change 8"), "input is unchanged");
});

test("compact footer prioritizes the actual action and bounds the repeated reason, detailed status keeps it", () => {
  const reason = "A human playtest is needed. " + "Historical evidence and verifier mechanics. ".repeat(80) + "SENTINEL-END";
  const goal = seedGoal({ status: "paused", pauseKind: "blocked", policy: "list", pauseReason: reason,
    pauseSuggestedAction: "Run the four playtest tasks in HUMAN-PLAYTEST-QUICKSTART.md and report your observations." }) as unknown as Goal;
  const state = { goal } as State;
  const now = Date.now();
  const status = projectUiStatus(state, { now, generation: 1 });
  const compact = buildUiStatusCard(state, status, now, undefined, 100, true).join("\n");
  const detail = buildUiStatusCard(state, status, now, undefined, 160, false).join("\n");
  assert.match(compact, /next: Run the four playtest tasks/);
  assert.doesNotMatch(compact, /SENTINEL-END/);
  assert.match(compact, /details: \/glla status/);
  assert.match(detail, /SENTINEL-END/);
  assert.ok(compact.indexOf("next:") < compact.indexOf("why:"));
  assert.equal(goal.pauseReason, reason);
});

test("human handoff guidance reaches the real tool registrations", async () => {
  __testOnlyResetProcessState();
  const pi = new MockPi(); activate(pi.api);
  const cwd = tmpCwd(); seedState(cwd, { goal: seedGoal({ status: "active", autoContinue: false }) });
  const ctx = makeMockCtx(cwd);
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    for (const name of ["complete_goal", "pause_goal"]) {
      const definition = pi.tools.get(name) as { promptGuidelines?: string[] };
      assert.ok(definition?.promptGuidelines?.includes(HUMAN_HANDOFF_GUIDANCE), `${name} carries the shared policy`);
    }
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    __testOnlyResetProcessState();
  }
});

test("the actual pause tool sends one card and keeps the required action in external notifications", async () => {
  __testOnlyResetProcessState();
  const cwd = tmpCwd(); seedState(cwd, { goal: seedGoal({ status: "active", autoContinue: false }) });
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ notifyCmd: "capture-human-notice", autoResume: false }));
  const notices: string[] = [];
  const pi = new MockPi();
  pi.execHandler = (_cmd, args) => { notices.push(JSON.stringify(args)); return { code: 0, stdout: "", stderr: "" }; };
  activate(pi.api); const ctx = makeMockCtx(cwd);
  const reason = "Browser authorization is missing.";
  const action = "Run /chrome authorize, then reply here.";
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await pi.fire("agent_start", {}, ctx);
    await pi.runTool("pause_goal", { kind: "blocked", reason, suggestedAction: action,
      interruption: { reason: "missing-permission", evidence: "Browser control requires the user's explicit authorization." } }, ctx);
    assert.equal(pi.sent.filter(sent => sent.message.customType === "glla-action-reminder").length, 1);
    assert.ok(notices.some(notice => notice.includes("Your help is needed") && notice.includes(action)), JSON.stringify(notices));
    // Existing provider/privacy sanitization may generalize the reason;
    // the actionable handoff must still survive on the external surface.
    assert.ok(!ctx.ui.notifies.some(notice => notice.message.includes(reason)), "no second full transcript notification");
    assert.equal(readState(cwd).goal?.pauseSuggestedAction, action);
    assert.equal(readState(cwd).goal?.status, "paused");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    __testOnlyResetProcessState();
  }
});

test("code samples cannot turn a supporting section into a user-action section", () => {
  const source = "## Done\nSummary\nShort result.\n```md\nNext\nSome sample text.\n```\nA second short sentence.\nMore supporting text.\n• no completion review was recorded.\n• record: saved.md";
  const compact = compactHumanSummary(source);
  assert.doesNotMatch(compact.content, /Some sample text|More supporting text/);
  assert.match(compact.content, /Short result/);
  assert.match(compact.content, /no completion review was recorded/);
  assert.match(compact.content, /record: saved.md/);
});

test("time and preview projections are timezone explicit, safe and honest about abbreviation", () => {
  assert.equal(humanCheckTime("2026-10-18T12:44:36.455+02:00"), "18 Oct 2026, 10:44 UTC");
  assert.equal(humanCheckTime("unknown"), "unknown");
  const value = humanTextPreview("\x1b[2JReadable result. " + "supporting detail ".repeat(100));
  assert.match(value, /Readable result/);
  assert.match(value, /…$/);
  assert.doesNotMatch(value, /\x1b|\n/);
  assert.ok(value.length < 340);
});

test("collapsed reports retain results from every work area after a busy first area", () => {
  const source = [
    "## Done — Saves and release packages are consistent", "", "## Summary",
    "**What changed · Persistence**",
    ...Array.from({ length: 6 }, (_, i) => `- Persistence result ${i}`),
    "**What changed · Packaging**", "- Both browser packages contain matching manifests.",
    "**What changed · Recovery**", "- Interrupted saves recover the last confirmed edit.",
    "## Verification", "- Regression checks: 12 passed, 0 failed.",
    "## Follow-up items", "- Signed-in browser behavior was not checked.",
    "completion audit approved (1 review) · record: saved.md.",
  ].join("\n");
  const compact = compactHumanSummary(source);
  assert.equal(compact.omitted, true);
  assert.doesNotMatch(compact.content, /Persistence result 4/);
  for (const result of ["Both browser packages contain matching manifests.",
    "Interrupted saves recover the last confirmed edit.", "12 passed, 0 failed.",
    "Signed-in browser behavior was not checked.", "record: saved.md."]) {
    assert.ok(compact.content.includes(result), result);
  }
});

test("collapsed opening prose keeps the explanation beyond a notification budget", () => {
  const explanation = "The saved version now advances only after the write succeeds, so an interrupted request cannot replace a confirmed edit with an older revision. " +
    "Switching panels retains pending edits and reopening the project restores the last confirmed save, including when a background retry finishes late.";
  const compact = compactHumanSummary(`## Done — Saves keep confirmed edits\n## Summary\n${explanation}\n## Verification\n12 passed, 0 failed.`);
  assert.ok(explanation.length > 280);
  assert.ok(compact.content.includes(explanation));
  assert.equal(compact.omitted, false);
});
