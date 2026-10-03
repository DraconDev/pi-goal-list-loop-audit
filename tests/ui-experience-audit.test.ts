import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildSettingsRows, SettingsMenuComponent, SETTINGS_SECTIONS, type SettingsMenuFactoryDeps } from "../extensions/settings-menu.js";
import { ModelPickerComponent, buildModelPickItems, type ModelPickerFactoryDeps } from "../extensions/model-picker.js";
import { MultiModelPickerComponent, type MultiModelPickerDeps } from "../extensions/multi-model-picker.js";
import { ConfirmDraftComponent, type ConfirmDraftFactoryDeps } from "../extensions/confirm-draft.js";
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
const kb = { matches: (data: string, key: string) => key === `tui.select.${({ up: "up", down: "down", pgup: "pageUp", pgdown: "pageDown", enter: "confirm", esc: "cancel" } as Record<string, string>)[data]}` };
const rows = buildSettingsRows({ auditorModel: "provider/a-very-long-model-name-to-inspect-without-losing-the-tail" }, {});
function menu(extra: Record<string, unknown> = {}) { return new SettingsMenuComponent({ rows, title: "GLLA settings", ...extra } as SettingsMenuFactoryDeps, () => {}, theme, kb, () => {}); }
const items = buildModelPickItems(Array.from({ length: 30 }, (_, i) => ({ provider: "fixture", id: `model-${i.toString().padStart(2, "0")}` })), "fixture/current", { includeSessionRow: false, includeManualRow: false });
function assertFits(lines: string[], width: number, height: number) { assert.ok(lines.length <= height, `${lines.length} lines exceed ${height}`); for (const line of lines) assert.ok(visibleWidth(line) <= width, `overflow: ${line}`); }

test("settings keep the active final tab visible on narrow terminals", () => {
  const component = menu({ initialSection: "other" });
  assert.match(component.render(60)[1]!, /Other/);
});
test("narrow settings show both the focused setting and its effective value", () => {
  const component = menu({ initialSection: "auditor" });
  const text = component.render(40).join("\n");
  assert.match(text, /Auditor agent/);
  assert.match(text, /provider\/a-very/);
});
test("reopened settings focus the edited row and each tab remembers its cursor", () => {
  const component = menu({ initialSelectedId: "mainModelRetryMinutes" });
  assert.equal(component.visibleRows()[component.getSelectedIdx()]?.id, "mainModelRetryMinutes");
  component.switchSection(1); component.move(1); component.switchSection(-1);
  assert.equal(component.visibleRows()[component.getSelectedIdx()]?.id, "mainModelRetryMinutes");
});
test("settings window keeps the cursor, navigation and details within a short terminal", () => {
  const component = menu({ initialSection: "other", getHeight: () => 12 });
  component.move(-1);
  assertFits(component.render(60), 60, 12);
  assert.match(component.render(60).join("\n"), new RegExp(component.visibleRows().at(-1)!.label));
  component.handleInput("d");
  assertFits(component.render(60), 60, 12);
});
test("settings search finds rows across sections and Esc clears search before closing", () => {
  let closed = false;
  const component = new SettingsMenuComponent({ rows, title: "settings" }, () => {}, theme, kb, () => { closed = true; });
  component.handleInput("/"); component.handleInput("Auditor model");
  assert.equal(component.visibleRows()[0]?.id, "auditorModel");
  component.handleInput("esc"); assert.equal(closed, false);
  assert.equal(component.visibleRows()[0]?.section, SETTINGS_SECTIONS[0]!.id);
  component.handleInput("esc"); assert.equal(closed, true);
});
test("settings details allow reading the full long value", () => {
  const component = menu({ initialSelectedId: "auditorModel" });
  component.handleInput("d");
  assert.ok(component.render(60).join("").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s/g, "").includes("provider/a-very-long-model-name-to-inspect-without-losing-the-tail"));
});
test("single picker respects terminal height and keeps the selected model visible", () => {
  const component = new ModelPickerComponent({ title: "Choose model", items, getHeight: () => 12 } as ModelPickerFactoryDeps, () => {}, theme, kb, () => {});
  for (let i = 0; i < 22; i++) component.handleInput("down");
  assertFits(component.render(60), 60, 12);
  assert.match(component.render(60).join("\n"), /→ fixture\/model-22/);
});
test("large unordered selections fit a short multi-picker without hiding its cursor", () => {
  const component = new MultiModelPickerComponent({ title: "Extensions", items, initialSelected: items.map(i => i.ref!), unorderedSet: true, getHeight: () => 18 } as MultiModelPickerDeps, () => {}, theme, kb, () => {});
  for (let i = 0; i < 22; i++) component.handleInput("down");
  assertFits(component.render(60), 60, 18);
  assert.match(component.render(60).join("\n"), /→ \[X\] fixture\/model-22/);
  assert.match(component.render(60).join("\n"), /30 selected/);
});
test("picker backspace deletes a complete Unicode character", () => {
  for (const component of [new ModelPickerComponent({ title: "model", items }, () => {}, theme, kb, () => {}), new MultiModelPickerComponent({ title: "models", items }, () => {}, theme, kb, () => {})]) {
    component.handleInput("a🚀"); component.handleInput("\x7f");
    assert.equal(component.getQuery(), "a");
  }
});
test("long draft reviews scroll while their decisions remain visible", () => {
  const component = new ConfirmDraftComponent({ title: "Review draft", body: Array.from({ length: 45 }, (_, i) => `Contract item ${i + 1}: verify the outcome.`).join("\n\n"), options: ["Yes", "No"], getHeight: () => 18 } as ConfirmDraftFactoryDeps, () => {}, theme as unknown as Theme, kb, () => {});
  assertFits(component.render(60), 60, 18);
  assert.match(component.render(60).join("\n"), /Contract item 1:/);
  assert.match(component.render(60).join("\n"), /Yes/);
  for (let i = 0; i < 20; i++) component.handleInput("pgdown");
  assertFits(component.render(60), 60, 18);
  assert.match(component.render(60).join("\n"), /Contract item 45:/);
  assert.equal(component.getSelectedItem(), "Yes", "review scrolling must not change the decision");
});

test("ordered pickers fit short terminals with current, inherit and cap notices", () => {
  for (const height of [8, 12, 18, 24]) {
    const component = new MultiModelPickerComponent({ title: "Fallbacks", items, initialSelected: items.map(item => item.ref!), currentRef: "fixture/current", includeInheritOption: true, maxSelections: 10, getHeight: () => height }, () => {}, theme, kb, () => {});
    assertFits(component.render(60), 60, height);
    component.handleInput("\t");
    for (let i = 0; i < 8; i++) component.handleInput("down");
    assertFits(component.render(60), 60, height);
    assert.match(component.render(60).join("\n"), /→ \[9\] fixture\/model-00/);
  }
});
test("settings sanitize terminal controls without changing saved strings", () => {
  const settings = { notifyCmd: "echo first\nsecond\x1b[2J" };
  const row = buildSettingsRows(settings, {}).find(row => row.id === "notifyCmd")!;
  assert.ok(!/[\x00-\x1f\x7f]/.test(row.valueText));
  assert.equal(settings.notifyCmd, "echo first\nsecond\x1b[2J");
});

test("settings details and all tab windows fit very short terminals", () => {
  for (const section of SETTINGS_SECTIONS) for (const height of [8, 12, 18, 24]) {
    const component = menu({ initialSection: section.id, getHeight: () => height });
    for (const width of [40, 60, 80, 120]) {
      assertFits(component.render(width), width, height);
      component.handleInput("d"); assertFits(component.render(width), width, height);
      component.handleInput("d");
    }
  }
});

test("lifecycle cards and status rows fit every explicit terminal width", async () => {
  const { UI_AUDIT_SCENES, UI_AUDIT_NOW } = await import("./evidence/ui-audit-scenes.js");
  const { buildStatusText, buildWidgetLines } = await import("../extensions/goal-loop-display.js");
  for (const scene of UI_AUDIT_SCENES) for (const width of [0, 1, 20, 40, 60, 80, 120]) {
    const status = buildStatusText(scene.state, null, UI_AUDIT_NOW, theme, scene.extras, width);
    assert.ok(visibleWidth(status ?? "") <= width, `${scene.key} status exceeds width ${width}`);
    for (const line of buildWidgetLines(scene.state, null, UI_AUDIT_NOW, theme, width, scene.extras) ?? []) assert.ok(visibleWidth(line) <= Math.max(0, width - 2), `${scene.key} widget exceeds width ${width}`);
  }
});

test("draft review keeps project consent readable and uses the supplied keybindings", () => {
  for (const height of [8, 12, 18, 24]) {
    let accepted: string | undefined;
    const choice = "Yes — always auto-accept drafts for this project";
    const component = new ConfirmDraftComponent({ title: "Review", body: "A complete draft contract.\n\n".repeat(20), options: ["Yes", choice, "No"], getHeight: () => height }, () => {}, theme as unknown as Theme, kb, (value) => { accepted = value; });
    assertFits(component.render(40), 40, height);
    component.handleInput("down");
    assert.equal(component.getSelectedItem(), choice);
    assertFits(component.render(40), 40, height);
    assert.match(component.render(40).join("\n"), /this project/);
    component.handleInput("enter"); assert.equal(accepted, choice);
  }
});

test("untrusted picker labels and draft bodies cannot emit terminal commands", () => {
  const unsafe = "safe\x1b[2J\x9b31m";
  const registry = [{ kind: "model" as const, ref: "fixture/safe", label: unsafe, searchText: "safe" }];
  const single = new ModelPickerComponent({ title: unsafe, items: registry }, () => {}, theme, kb, () => {});
  const multi = new MultiModelPickerComponent({ title: unsafe, items: registry, getHeight: () => 18 }, () => {}, theme, kb, () => {});
  const draft = new ConfirmDraftComponent({ title: unsafe, body: `First paragraph.\n\n${unsafe}\n\nLast paragraph.`, options: ["Yes", "No"] }, () => {}, theme as unknown as Theme, kb, () => {});
  for (const component of [single, multi, draft]) assert.ok(!/\x1b\[2J|\x9b/.test(component.render(60).join("\n")));
  assert.match(draft.render(60).join("\n"), /Last paragraph/);
  for (const component of [single, multi]) { component.handleInput("test\x9b"); assert.equal(component.getQuery(), "test"); }
});
