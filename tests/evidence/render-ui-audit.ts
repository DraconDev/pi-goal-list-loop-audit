// Actual production component/card renderings; no hand-written UI replicas.
import * as fs from "node:fs";
import * as path from "node:path";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { SettingsMenuComponent, buildSettingsRows, SETTINGS_SECTIONS } from "../../extensions/settings-menu.js";
import { DEFAULT_SETTINGS } from "../../extensions/goal-settings.js";
import { ModelPickerComponent, buildModelPickItems } from "../../extensions/model-picker.js";
import { MultiModelPickerComponent } from "../../extensions/multi-model-picker.js";
import { ConfirmDraftComponent } from "../../extensions/confirm-draft.js";
import { buildWidgetLines, buildStatusText } from "../../extensions/goal-loop-display.js";
import { buildActionReminder, registerActionReminderRenderer } from "../../extensions/action-reminder.js";
import { MockPi } from "../harness/mock-pi.js";
import { UI_AUDIT_SCENES, UI_AUDIT_NOW } from "./ui-audit-scenes.js";
const out = path.resolve(process.env.GLLA_UI_EVIDENCE_DIR ?? path.resolve(import.meta.dirname, "../../audit/full-ui-audit-2026-10-03"));
fs.mkdirSync(out, { recursive: true });
const frames: { key: string; theme: string; width: number; height: number; lines: string[] }[] = [];
const settings = { ...DEFAULT_SETTINGS, auditorModel: "anthropic/claude-sonnet-4-5", mainModelFallbacks: ["openai/gpt-5", "google/gemini-2.5-pro"] };
const rows = buildSettingsRows(settings, {});
const items = buildModelPickItems(Array.from({ length: 30 }, (_, i) => ({ provider: i % 2 ? "openai" : "anthropic", id: `model-${i.toString().padStart(2, "0")}` })), "openai/session", { includeSessionRow: false, includeManualRow: false });
const kb = { matches: (data: string, key: string) => key === `tui.select.${({ down: "down", pgdown: "pageDown" } as Record<string, string>)[data]}` };
for (const appearance of ["dark", "light"]) {
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, `../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), "truecolor");
  for (const width of [40, 60, 80, 120]) {
    const height = 20;
    const add = (key: string, lines: string[]) => frames.push({ key, theme: appearance, width, height, lines });
    for (const section of SETTINGS_SECTIONS) {
      const component = new SettingsMenuComponent({ rows, title: "GLLA settings · defaults save globally", initialSection: section.id, getHeight: () => height }, () => {}, theme, kb, () => {});
      add(`settings-${section.id}`, component.render(width));
      if (section.id === "auditor") { component.handleInput("d"); add("settings-auditor-details", component.render(width)); }
    }
    const search = new SettingsMenuComponent({ rows, title: "GLLA settings", getHeight: () => height }, () => {}, theme, kb, () => {});
    search.handleInput("/"); search.handleInput("timeout"); add("settings-search", search.render(width));
    const single = new ModelPickerComponent({ title: "Auditor model", items, getHeight: () => height }, () => {}, theme, kb, () => {});
    for (let i = 0; i < 20; i++) single.handleInput("down"); add("model-picker", single.render(width));
    const multi = new MultiModelPickerComponent({ title: "Fallback models", items, currentRef: "openai/session", initialSelected: items.slice(0, 10).map(item => item.ref!), getHeight: () => height }, () => {}, theme, kb, () => {});
    add("fallback-picker", multi.render(width)); multi.handleInput("\t"); for (let i = 0; i < 7; i++) multi.handleInput("down"); add("fallback-order", multi.render(width));
    const draft = new ConfirmDraftComponent({ title: "Confirm goal", body: "Improve the complete GLLA interface.\n\n" + Array.from({ length: 20 }, (_, i) => `- Requirement ${i + 1}: prove the interface is readable and the action has the promised result.`).join("\n\n"), options: ["Yes", "Yes — always auto-accept drafts for this project", "No"], getHeight: () => height }, () => {}, theme, kb, () => {});
    add("draft-start", draft.render(width)); for (let i = 0; i < 30; i++) draft.handleInput("pgdown"); add("draft-end", draft.render(width)); draft.handleInput("down"); add("draft-consent", draft.render(width));
    const pi = new MockPi(); registerActionReminderRenderer(pi.api);
    for (const kind of ["blocked", "decision", "error", "wait", "standby"] as const) {
      const reminder = buildActionReminder({ kind, reason: "Verification needs one more observation before work can continue.", action: kind === "blocked" ? "Resolve the failing check, then /goal resume." : undefined, resumeCommand: "/goal resume" });
      const component = pi.messageRenderers.get("glla-action-reminder")!({ details: reminder.details }, { outputPad: 1 }, theme) as { render(width: number): string[] };
      add(`reminder-${kind}`, component.render(width));
    }
    for (const scene of UI_AUDIT_SCENES) add(scene.key, [...(buildWidgetLines(scene.state, null, UI_AUDIT_NOW, theme, width, scene.extras) ?? ["(no ambient UI)"]), "", buildStatusText(scene.state, null, UI_AUDIT_NOW, theme, scene.extras, width) ?? "(no status)"]);
  }
}
fs.writeFileSync(path.join(out, "rendered-frames.json"), JSON.stringify(frames, null, 2) + "\n");
console.log(`Rendered ${frames.length} actual component/card frames across two host themes and four widths.`);
