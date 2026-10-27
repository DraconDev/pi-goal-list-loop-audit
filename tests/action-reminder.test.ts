import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildAbortedAssistantNotice, buildActionReminder, frameTweakSuggestion, registerActionReminderRenderer, type ActionReminderCopy } from "../extensions/action-reminder.js";
import { tweakSuggestionTruncated } from "../extensions/goal-loop-core.js";
import { humanCheckTime } from "../extensions/human-handoff.js";
import { MockPi } from "./harness/mock-pi.js";

function render(reminder: ActionReminderCopy, expanded = false, width = 120): string {
  const pi = new MockPi(); registerActionReminderRenderer(pi.api);
  const renderer = pi.messageRenderers.get("glla-action-reminder")!;
  const component = renderer({ customType: "glla-action-reminder", content: reminder.content, display: true, details: reminder.details },
    { expanded, outputPad: 1 }, { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s }) as { render(width: number): string[] };
  const lines = component.render(width);
  assert.ok(lines.every(line => visibleWidth(line) <= width), `fits ${width} columns`);
  return lines.join("\n");
}

for (const action of [undefined, "/list resume", "Run '/list resume'.", "`/glla resume`"]) {
  test(`legacy blocker does not pretend resume solves the requirement (${action})`, () => {
    const reminder = buildActionReminder({ kind: "blocked", reason: "Complete the $0 checkout and confirm the receipt.", action, resumeCommand: "/list resume" });
    for (const text of [reminder.content, render(reminder)]) {
      assert.match(text, /Complete the \$0 checkout and confirm the receipt/);
      assert.match(text, /Next: Complete the requirement/);
      assert.match(text, /Then use \/list resume/);
      assert.match(text, /Resuming alone does not fix/);
      assert.doesNotMatch(text, /Next: (?:Run )?[`']?\/(?:list|glla) resume/);
      assert.ok(text.indexOf("Why:") < text.indexOf("Then use"));
    }
    assert.equal(reminder.details.reason, "Complete the $0 checkout and confirm the receipt.");
    assert.equal(reminder.details.safelyParked, true);
  });
}

test("concrete action and conditional retry survive both reminder surfaces", () => {
  const reminder = buildActionReminder({ kind: "blocked", reason: "Browser authorization is missing.", action: "Authorize browser access, then reply here.", resumeCommand: "/goal resume" });
  for (const text of [reminder.content, render(reminder)]) {
    assert.match(text, /Next: Authorize browser access, then reply here/);
    assert.match(text, /Then use \/goal resume/);
    assert.ok(text.indexOf("Next:") < text.indexOf("Then use"));
    assert.match(text, /Your work is saved/);
    assert.doesNotMatch(text, /Operation aborted/);
  }
  assert.equal(reminder.details.parkState, "stopped");
});

test("legacy renderer rebuilds copy without changing the saved reason or action", () => {
  const pi = new MockPi(); registerActionReminderRenderer(pi.api);
  const details = { kind: "blocked", reason: "Confirm the checkout receipt.", resumeCommand: "/list resume" };
  const before = JSON.stringify(details);
  const renderer = pi.messageRenderers.get("glla-action-reminder")!;
  const component = renderer({ details, content: "Next: /list resume" }, { outputPad: 1 },
    { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s }) as { render(width: number): string[] };
  const text = component.render(120).join("\n");
  assert.match(text, /Confirm the checkout receipt/);
  assert.match(text, /Next: Complete the requirement/);
  assert.doesNotMatch(text, /Next: \/list resume/);
  assert.equal(JSON.stringify(details), before);
});

for (const action of [undefined, "Choose one in the decision card."]) {
  test(`decision preserves the picker handoff (${action})`, () => {
    const reminder = buildActionReminder({ kind: "decision", reason: "Choose the rollout approach.", action, resumeCommand: "/list resume" });
    for (const text of [reminder.content, render(reminder)]) {
      assert.match(text, /Choose/);
      assert.match(text, /decision card/);
      assert.doesNotMatch(text, /Next: \/list resume/);
    }
    assert.equal(reminder.details.kind, "decision");
    assert.equal(reminder.details.safelyParked, true);
  });
}

test("redirect remains a handoff to work now, not a stopped turn", () => {
  const reminder = buildActionReminder({ kind: "blocked", reason: "The user redirected the current turn.", action: "Handle the new request now: inspect the inbox", resumeCommand: "/goal resume", parkState: "redirect" });
  const text = render(reminder);
  assert.match(text, /handling your new request now/);
  assert.match(text, /inspect the inbox/);
  assert.match(text, /while I handle the new request/);
  assert.doesNotMatch(text, /this turn stopped/);
  assert.equal(reminder.details.parkState, "redirect");
});

test("diagnostics are expandable supporting detail, not a competing primary message", () => {
  const reminder = buildActionReminder({ kind: "blocked", reason: "A required credential is missing.", action: "Configure the credential.", resumeCommand: "/goal resume", diagnostic: "provider request id=req-42" });
  assert.doesNotMatch(render(reminder), /req-42/);
  assert.match(render(reminder), /More details/);
  const expanded = render(reminder, true);
  assert.ok(expanded.indexOf("Diagnostic:") > expanded.indexOf("Next: Configure"));
  assert.match(expanded, /req-42/);
  assert.equal(reminder.details.diagnostic, "provider request id=req-42");
});

test("standby explains the automatic background handoff with its active-session condition", () => {
  const reminder = buildActionReminder({ kind: "standby", reason: "Waiting for the auditor.", resumeCommand: "/goal resume" });
  for (const text of [reminder.content, render(reminder)]) {
    assert.match(text, /No action is needed while this session is active/);
    assert.match(text, /background result when it arrives/);
    assert.doesNotMatch(text, /Resume:|Next:/);
  }
  assert.equal(reminder.details.parkState, "automatic");
});

test("timed wait names the next progress check without claiming completion or a live wake", () => {
  const at = "2026-09-24T23:59:00.000Z";
  const reminder = buildActionReminder({ kind: "wait", reason: "The soak needs more elapsed time.", resumeCommand: "/list resume", resumeAt: at });
  for (const text of [reminder.content, render(reminder)]) {
    assert.ok(text.includes(humanCheckTime(at)));
    assert.match(text.replace(/\s+/g, ' '), /progress check, not a promise of completion/);
    assert.match(text, /session is active and automatic checks are enabled/);
    assert.doesNotMatch(text, /Resume: \/list resume|owned wake|admitted heartbeat/);
  }
  assert.equal(reminder.details.resumeAt, at);
  assert.equal(reminder.details.parkState, "automatic");
});

test("abort notice points to the canonical card instead of duplicating its reason and action", () => {
  const reason = "The turn reached its safety boundary.";
  const notice = buildAbortedAssistantNotice({ kind: "error", reason, action: "Inspect the saved work, then /goal resume.", resumeCommand: "/goal resume" });
  assert.match(notice, /intentionally/);
  assert.match(notice, /action card/);
  assert.doesNotMatch(notice, /Operation aborted|safety boundary/);
  const at = "2026-09-24T23:59:00.000Z";
  const wait = buildAbortedAssistantNotice({ kind: "wait", reason, resumeCommand: "/goal resume", resumeAt: at });
  assert.ok(wait.includes(humanCheckTime(at)));
  assert.match(wait, /progress check/);
  assert.doesNotMatch(wait, /safety boundary|\/goal resume/);
});

test("reminders fit narrow widths and strip unsafe terminal sequences", () => {
  const reminder = buildActionReminder({ kind: "blocked", reason: "verify\x1b[2J the result", action: "resume\x9b after checking", diagnostic: "details\x1b[2J", resumeCommand: "/goal resume" });
  for (const expanded of [false, true]) for (const width of [0, 1, 20, 40, 80]) {
    assert.doesNotMatch(render(reminder, expanded, width), /\x1b\[2J|\x9b/);
  }
});

// v0.39.55 (field 2026-10-27): the card told the user to type a tweak whose
// replacement was cut off mid-word ("darkwave" -> "darkw"). A truncated quote
// cannot be completed by rendering — the missing text is gone — so the card
// must not present the fragment as a typeable command.
test("a truncated tweak proposal is never presented as a command to type", () => {
  const fieldAction = `Run /goal tweak replacing this objective line "- Lane 1 Vera Vantel: genre darksynth, 15 tracks (~42 min)." with "- Lane 1 Vera Vantel: genres darksynth + darkw`;
  assert.equal(tweakSuggestionTruncated(fieldAction), true, "the field shape detects as truncated");
  assert.equal(tweakSuggestionTruncated(`Run '/goal tweak "Fix X."'`), false, "a balanced quote is complete");
  assert.equal(tweakSuggestionTruncated("/goal resume"), false, "non-tweak prose is not tweak-truncated");
  assert.equal(tweakSuggestionTruncated("tweak the thing"), false, "quoteless prose has no quote to unbalance");
  const framed = frameTweakSuggestion(fieldAction)!;
  assert.match(framed, /Question: should this tweak be applied\?/, "still a question, not an order");
  assert.doesNotMatch(framed, /darkw/, "the broken fragment is not offered for copy-paste");
  assert.doesNotMatch(framed, /Run \/goal tweak replacing/, "the untypeable command is not presented");
  assert.match(framed, /run \/goal tweak with no arguments/, "directs to the interactive flow instead");
  const reminder = buildActionReminder({ kind: "blocked", reason: "Scope text disagrees with the approved mix.", action: fieldAction, resumeCommand: "/goal resume" });
  const rendered = render(reminder);
  const flat = rendered.replace(/\s+/g, " ");
  assert.doesNotMatch(flat, /darkw/, "the card never shows the fragment");
  assert.match(flat, /no arguments to review and edit it interactively/, "the card shows the fallback");
});

test("a complete tweak proposal keeps its exact command verbatim", () => {
  const action = `Run /goal tweak replacing this objective line "- Lane 1." with "- Lane 1: genres darksynth + darkwave."`;
  assert.equal(tweakSuggestionTruncated(action), false);
  const framed = frameTweakSuggestion(action)!;
  assert.ok(framed.includes(action), "the whole command is preserved for copy-paste");
});

test("tweak proposals remain questions and retain the exact command for consent", () => {
  const action = `Run '/goal tweak "5. update the contract"'`;
  const reminder = buildActionReminder({ kind: "blocked", reason: "The contract conflicts with the verifier.", action, resumeCommand: "/list resume" });
  assert.match(render(reminder), /Question: should this tweak be applied\?/);
  assert.ok(render(reminder).includes(action));
  assert.doesNotMatch(render(reminder), /Next: Run/);
  for (const other of ["Open the popup and record the result.", "/goal resume", ""]) assert.equal(frameTweakSuggestion(other), undefined);
  assert.ok(frameTweakSuggestion(`Run '/list tweak "drop item 3"'`)?.includes(`/list tweak "drop item 3"`));
});
