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
