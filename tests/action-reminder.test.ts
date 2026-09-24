import assert from "node:assert/strict";
import test from "node:test";
import { buildAbortedAssistantNotice, buildActionReminder, registerActionReminderRenderer } from "../extensions/action-reminder.js";
import { MockPi } from "./harness/mock-pi.js";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

test("standby renderer keeps the background-wake explanation visible", () => {
  const pi = new MockPi();
  registerActionReminderRenderer(pi.api);
  const renderer = pi.messageRenderers.get("glla-action-reminder")!;
  const reminder = buildActionReminder({ kind: "standby", reason: "Waiting for the auditor.", resumeCommand: "/goal resume" });
  const component = renderer({ customType: "glla-action-reminder", content: reminder.content, display: true, details: reminder.details }, { expanded: false, outputPad: 1 }, initTheme("dark") as unknown as Theme) as { render(width: number): string[] };
  const text = component.render(120).join("\n");
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
    action: "Open the popup, then /goal resume.",
    resumeCommand: "/goal resume",
  });
  assert.match(reminder.content, /Action needed/);
  assert.match(reminder.content, /safely parked/);
  assert.match(reminder.content, /Why: The native browser popup/);
  assert.match(reminder.content, /Next: Open the popup/);
  assert.equal(reminder.details.safelyParked, true);
});

test("decision reminder names the picker and does not invent a manual blocker", () => {
  const reminder = buildActionReminder({
    kind: "decision",
    reason: "Two valid architectures remain.",
    action: "Choose one in the decision card.",
    resumeCommand: "/goal resume",
  });
  assert.match(reminder.content, /decision card/);
  assert.match(reminder.content, /Choose an option/);
  assert.equal(reminder.details.kind, "decision");
});

test("standby reminder says background completion wakes the work", () => {
  const reminder = buildActionReminder({
    kind: "standby",
    reason: "Waiting for the background auditor.",
    resumeCommand: "/goal resume",
  });
  assert.match(reminder.content, /No action is needed/);
  assert.match(reminder.content, /wake/);
  assert.equal(reminder.details.safelyParked, false);
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
