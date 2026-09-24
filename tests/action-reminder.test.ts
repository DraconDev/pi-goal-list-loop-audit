import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAbortedAssistantNotice,
  buildActionReminder,
  registerActionReminderRenderer,
  type ActionReminderCopy,
} from "../extensions/action-reminder.js";
import { MockPi } from "./harness/mock-pi.js";

function renderReminder(reminder: ActionReminderCopy, width = 120): string {
  const pi = new MockPi();
  registerActionReminderRenderer(pi.api);
  const renderer = pi.messageRenderers.get("glla-action-reminder")!;
  const testTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
  const component = renderer(
    { customType: "glla-action-reminder", content: reminder.content, display: true, details: reminder.details },
    { expanded: false, outputPad: 1 },
    testTheme as never,
  ) as { render(width: number): string[] };
  return component.render(width).join("\n");
}

test("standby renderer keeps the background-wake explanation visible", () => {
  const text = renderReminder(buildActionReminder({
    kind: "standby",
    reason: "Waiting for the auditor.",
    resumeCommand: "/goal resume",
  }));
  assert.match(text, /GLLA waiting/);
  assert.match(text, /background completion wakes/);
  assert.doesNotMatch(text, /Next:/);
});

test("registers a dedicated GLLA reminder renderer", () => {
  const pi = new MockPi();
  registerActionReminderRenderer(pi.api);
  assert.equal(pi.messageRenderers.has("glla-action-reminder"), true);
});

test("blocked reminder is actionable and says the work is safely parked", () => {
  const reminder = buildActionReminder({
    kind: "blocked",
    reason: "The native browser popup needs a manual observation.",
    action: "Open the popup and record the result.",
    resumeCommand: "/list resume",
  });
  const text = renderReminder(reminder);
  assert.match(text, /GLLA action needed — work is safely parked/);
  assert.match(text, /Why: The native browser popup/);
  assert.match(text, /Next: Open the popup and record the result/);
  assert.match(text, /Resume: \/list resume/);
  assert.doesNotMatch(text, /Operation aborted/);
  assert.equal(reminder.details.safelyParked, true);
});

test("decision reminder is prominent, safely parked, and names the exact picker action", () => {
  const reminder = buildActionReminder({
    kind: "decision",
    reason: "Two valid architectures remain.",
    action: "Choose one in the decision card.",
    resumeCommand: "/list resume",
  });
  const text = renderReminder(reminder);
  assert.match(text, /GLLA decision needed — work is safely parked/);
  assert.match(text, /Why: Two valid architectures remain/);
  assert.match(text, /Next: Choose one in the decision card/);
  assert.match(text, /Resume: \/list resume/);
  assert.doesNotMatch(text, /Operation aborted/);
  assert.equal(reminder.details.kind, "decision");
  assert.equal(reminder.details.safelyParked, true);
});

test("standby reminder says background completion wakes the work", () => {
  const reminder = buildActionReminder({
    kind: "standby",
    reason: "Waiting for the background auditor.",
    resumeCommand: "/goal resume",
  });
  assert.match(reminder.content, /No action is needed/);
  assert.match(reminder.content, /wake/);
  assert.equal(reminder.details.safelyParked, true);
});

test("timed wait is automatic and does not invent a manual action", () => {
  const reminder = buildActionReminder({
    kind: "wait",
    reason: "The rate limit resets later.",
    resumeCommand: "/list resume",
    resumeAt: "2026-09-24T23:59:00.000Z",
  });
  const text = renderReminder(reminder);
  assert.match(text, /GLLA timed wait — work is safely parked/);
  assert.match(text, /Auto-resume: 2026-09-24T23:59:00\.000Z/);
  assert.doesNotMatch(text, /Next:/);
  assert.doesNotMatch(text, /Resume: \/list resume/);
  assert.equal(reminder.details.safelyParked, true);
});

test("assistant abort notice is a GLLA explanation, not generic transport text", () => {
  const notice = buildAbortedAssistantNotice({
    kind: "error",
    reason: "The turn reached its safety boundary.",
    action: "Inspect the saved work, then /goal resume.",
    resumeCommand: "/goal resume",
  });
  assert.match(notice, /GLLA paused this turn safely/);
  assert.match(notice, /Inspect the saved work/);
  assert.doesNotMatch(notice, /Operation aborted/);
});
