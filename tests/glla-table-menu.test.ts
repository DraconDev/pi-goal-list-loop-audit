// pi-goal-list-loop-audit — v0.28.0
// tests/glla-table-menu.test.ts
//
// Pins the new TUI table renderer (SettingsMenuComponent). Drives
// handleInput() synthetically (no TUI required) to verify tab-switch +
// row-select + input routing. Renders at 3 widths (120/80/60) to verify
// column truncation.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildSettingsRows,
  SETTINGS_SECTIONS,
  SettingsMenuComponent,
  type SettingsRow,
} from "../extensions/settings-menu.ts";
import type { Settings } from "../extensions/goal-settings.ts";

// Use the same visibleWidth the renderer uses so our width assertions match
// the real column budget. Re-exported locally for test ergonomics.
import { visibleWidth as visibleWidthFromTui } from "@earendil-works/pi-tui";

/* --------------------------------------------------------------------- */
/*  Test doubles                                                         */
/* --------------------------------------------------------------------- */

const THEME = {
  fg(_color: "accent" | "muted" | "dim" | "warning" | "success", text: string) {
    return text; // strip colors for deterministic snapshots
  },
  bg(_color: "selectedBg", text: string) {
    return text; // strip colors for deterministic snapshots
  },
  bold(text: string) {
    return text;
  },
};

const HIGHLIGHT_THEME = {
  ...THEME,
  bg(_color: "selectedBg", text: string) {
    return `\x1b[48;5;24m${text}\x1b[49m`;
  },
};

/** Synthetic KeybindingsManager-like that maps plain input strings to canonical keys. */
const KB = {
  matches(data: string, key: string): boolean {
    const map: Record<string, string> = {
      "\r": "tui.select.confirm",
      "\n": "tui.select.confirm",
      "\x1b": "tui.select.cancel",
      "up": "tui.select.up",
      "down": "tui.select.down",
      "pageUp": "tui.select.pageUp",
      "pageDown": "tui.select.pageDown",
    };
    if (map[data] === key) return true;
    // Empty data → never matches
    return false;
  },
};

function makeComponent(rows: SettingsRow[], width = 120) {
  let capturedId: string | undefined = "INIT";
  const done = (id: string | undefined) => {
    capturedId = id;
  };
  const component = new SettingsMenuComponent(
    {
      rows,
      title: "test — glla settings table",
    },
    () => undefined,
    THEME,
    KB,
    done,
  );
  return {
    component,
    done: (): string | undefined => capturedId,
    lastId: (): string | undefined => (capturedId === "INIT" ? undefined : capturedId),
  };
}

/* --------------------------------------------------------------------- */
/*  Sample rows                                                          */
/* --------------------------------------------------------------------- */

const SAMPLE_ROWS: SettingsRow[] = buildSettingsRows(
  {
    subagentModelStrategy: "inherit-parent",
    notifyCmd: "notify-send $1",
    tokenLimit: 200000,
  } as Settings,
  {},
);

/* --------------------------------------------------------------------- */
/*  Pin 1: rendering                                                     */
/* --------------------------------------------------------------------- */

test("render: title row", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  const lines = component.render(120);
  assert.equal(lines[0], "test — glla settings table");
});

test("grouped entry points can open a specific settings section", () => {
  const rows = buildSettingsRows({} as Settings, {});
  const component = new SettingsMenuComponent(
    { rows, title: "test", initialSection: "stall-brakes" },
    () => undefined,
    THEME,
    KB,
    () => undefined,
  );
  assert.equal(component.getActiveSectionIdx(), SETTINGS_SECTIONS.findIndex((s) => s.id === "stall-brakes"));
  assert.ok(component.visibleRows().every((row) => row.section === "stall-brakes"));
});

test("render: tabs row lists all 8 sections", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  const lines = component.render(120);
  // Tabs row is index 1 (after title).
  for (const s of SETTINGS_SECTIONS) {
    assert.match(lines[1]!, new RegExp(s.label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), `tabs row mentions ${s.label}`);
  }
});

test("main agent tab starts with the current agent and drills in", () => {
  const rows = buildSettingsRows({ mainModelFallbacks: ["provider/backup"] } as Settings, {});
  let selected: string | undefined;
  const component = new SettingsMenuComponent(
    { rows, title: "test", initialSection: "main-agent" },
    () => undefined,
    THEME,
    KB,
    (id) => { selected = id; },
  );
  assert.deepEqual(component.visibleRows().map((row) => row.id), [
    "mainAgent",
    "mainModelFallbacks",
    "mainModelRetryMinutes",
    "hourlyRetryProbe",
    "mainModelFailback",
    "mainModelPrimaryProbeMinutes",
  ]);
  component.handleInput("\r");
  assert.equal(selected, "mainAgent");
});

test("render: at width=120, the keep-going section renders its rows (v0.28.23: +decisionPopup)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  // activeSectionIdx starts at 0 (keep-going).
  const lines = component.render(120);
  // line layout at width 120: [title, tabs, header, row0, row1, row2, footer]
  assert.ok(lines.length >= 7, `expected ≥7 lines, got ${lines.length}`);
  // The 3 keep-going rows must be visible somewhere between line 3 and the footer.
  const body = lines.slice(3, -1).join("\n");
  assert.match(body, /Auto-resume on load/);
  assert.match(body, /Decision popup/);
  assert.match(body, /Auto-accept drafts/);
  assert.match(body, /Aggressive mode/);
});

test("render: active row uses a full-width selected background", () => {
  const done = () => undefined;
  const component = new SettingsMenuComponent(
    { rows: SAMPLE_ROWS, title: "test — glla settings table" },
    () => undefined,
    HIGHLIGHT_THEME,
    KB,
    done,
  );
  const line = component.render(120)[4]!;
  assert.ok(line.startsWith("\x1b[48;5;24m▶ Auto-resume on load"));
  assert.ok(line.endsWith("\x1b[49m"));

  const inner = line.slice("\x1b[48;5;24m".length, -"\x1b[49m".length);
  assert.equal(
    visibleWidthFromTui(inner),
    120,
    "the selected background should consume the available table width",
  );
});

test("render: compact header row has KEY, VALUE, SOURCE columns", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const lines = component.render(120);
  const header = lines[2]!;
  assert.match(header, /KEY/);
  assert.match(header, /VALUE/);
  assert.match(header, /SOURCE/);
  assert.doesNotMatch(header, /DESCRIPTION/);
});

test("render: compact mode never exceeds terminal width even with a long VALUE in another section", () => {
  // Repro from ~/.pi/agent/pi-crash.log (2026-08-23): terminal 150, settings
  // header visible width 164. Compact mode sized VALUE from the longest
  // valueText across ALL sections (joined absolute extension paths), so even
  // the Keep-going tab overflowed and crashed pi. Include a production-length
  // KEY so keyW hits MAX_KEY_W (32) — short labels alone leave enough leftover
  // columns for a ~114-char path to fit without overflowing.
  const longPath =
    "/home/samed.guest/.pi/agent/npm/node_modules/pi-cursor-sdk, /home/samed.guest/.pi/agent/npm/node_modules/pi-webaio";
  assert.ok(longPath.length > 100, "fixture must be long enough to overflow a 150-col terminal");
  const rows: SettingsRow[] = [
    { id: "autoResume", section: "keep-going", label: "Auto-resume on load", valueText: "default", sourceText: "default", description: "short" },
    { id: "subagentFallbacks:scout", section: "subagents", label: "scout fallback agents", valueText: "none", sourceText: "default", description: "short" },
    {
      id: "auditorAllowedExtensions",
      section: "auditor",
      label: "Allowed extensions",
      valueText: longPath,
      sourceText: "global",
      description: "long absolute paths",
    },
  ];
  const { component } = makeComponent(rows, 150);
  const width = 150;
  const lines = component.render(width);
  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidthFromTui(lines[i]!);
    assert.ok(w <= width, `line ${i} visible width ${w} exceeds terminal ${width}: ${lines[i]}`);
  }
});

test("render: footer pin includes the optional details toggle", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const lines = component.render(120);
  const footer = lines[lines.length - 1]!;
  assert.match(footer, /←\/→ tab/);
  assert.match(footer, /↑\/↓ move/);
  assert.match(footer, /d details on/);
  assert.match(footer, /enter drill-in/);
  assert.match(footer, /esc exit/);
});

/* --------------------------------------------------------------------- */
/*  Pin 2: navigation                                                    */
/* --------------------------------------------------------------------- */

test("nav: Enter on the first row emits that row's id", () => {
  const { component, lastId } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\r");
  assert.equal(lastId(), "autoResume"); // first keep-going row
});

test("nav: Down arrow moves to the next visible row", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.handleInput("down");
  component.handleInput("\r");
  // Use the done directly: we cannot reach the closure variable, so we
  // synthesize by checking the selected index.
  assert.equal(component.getSelectedIdx(), 1);
});

test("nav: Down wrapping at the end of a section wraps to 0", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  // Press down (rows+2) times — wraps to 2 whatever the section size.
  const n = SAMPLE_ROWS.filter((r) => r.section === "keep-going").length;
  for (let i = 0; i < n + 2; i++) component.handleInput("down");
  assert.equal(component.getSelectedIdx(), 2);
});

test("nav: Esc emits undefined (close)", () => {
  const { component, lastId } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\x1b");
  assert.equal(lastId(), undefined);
});

test("nav: Tab advances to the next section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\t");
  assert.equal(component.getActiveSectionIdx(), 1); // main-agent
  assert.equal(component.getSelectedIdx(), 0);     // reset
});

test("nav: Back-tab (\\x1b[Z) retreats to the previous section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  // Move to last section, then back-tab.
  component.switchSection(6); // → "other" (idx 6)
  component.handleInput("\x1b[Z");
  assert.equal(component.getActiveSectionIdx(), 5); // → "stall-brakes"
});

test("nav: Right-arrow CSI sequence (\\x1b[C) advances section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\x1b[C");
  assert.equal(component.getActiveSectionIdx(), 1);
});

test("nav: Left-arrow CSI sequence (\\x1b[D) retreats section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.switchSection(1); // → agents
  component.handleInput("\x1b[D");
  assert.equal(component.getActiveSectionIdx(), 0);
});

/* --------------------------------------------------------------------- */
/*  Pin 3: truncation                                                    */
/* --------------------------------------------------------------------- */

test("details toggle: descriptions can be shown and truncated when requested", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 60);
  component.handleInput("d");
  const lines = component.render(60);
  // Find the body rows (skip title, tabs, header, footer).
  const body = lines.slice(3, -1);
  assert.ok(body.length >= 3, "expected at least 3 body rows for keep-going");
  // The description column should be truncated visibly within the width —
  // we assert that the suffix "(0m…" appears (truncateToWidth inserts it)
  // on at least one body row when width=60. This proves truncation kicked in.
  let anyTruncated = false;
  for (const line of body) {
    if (/…/.test(line)) {
      anyTruncated = true;
      break;
    }
  }
  assert.ok(anyTruncated, `expected at least one body row to show "…" at width=60`);
});

test("details toggle: at width=120 the description column shows most of the row text", () => {
  // Don't assert full passthrough — at 120 cols, the aggressiveMode description
  // ("ON by default: keep-going defaults (autoResume, cap 10, …); explicit
  // per-key settings still win") still fits in the descW budget. The truncate
  // suffix only kicks in when descW < description length.
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  component.handleInput("d");
  const lines = component.render(120);
  const body = lines.slice(3, -1).join("\n");
  // The aggressiveMode row should at minimum keep its opening phrase visible.
  assert.match(
    body,
    /ON by default: keep-going defaults/,
    "aggressiveMode description should remain visible at 120 cols",
  );
});

/* --------------------------------------------------------------------- */
/*  Pin 4: cache invariant                                               */
/* --------------------------------------------------------------------- */

test("cache: identical renders at the same width return the same array reference", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const first = component.render(120);
  const second = component.render(120);
  assert.equal(first, second, "second render must hit the same cached array");
});

test("cache: state change invalidates cache (move → next render produces new lines)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const first = component.render(120);
  component.handleInput("down");
  const second = component.render(120);
  assert.notEqual(first, second, "selection move must invalidate the render cache");
});

test("compact view expands VALUE so model + thinking are visible", () => {
  const rows: SettingsRow[] = [{
    id: "agent",
    section: "main-agent",
    label: "Current main agent",
    valueText: "openrouter/provider/a-very-long-model-id · max",
    sourceText: "runtime",
    description: "long optional hint",
  }];
  const { component } = makeComponent(rows, 120);
  component.switchSection(1);
  const line = component.render(120)[4]!;
  assert.match(line, /openrouter\/provider\/a-very-long-model-id · max/);
  component.handleInput("d");
  assert.doesNotMatch(component.render(120)[4]!, /openrouter\/provider\/a-very-long-model-id · max/);
  assert.equal(component.descriptionsVisible(), true);
});

/* --------------------------------------------------------------------- */
/*  Pin 5: structural                                                    */
/* --------------------------------------------------------------------- */

test("structural: Class implements Component (has render + invalidate + handleInput)", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  assert.equal(typeof component.render, "function");
  assert.equal(typeof component.handleInput, "function");
  assert.equal(typeof component.invalidate, "function");
});

test("structural: buildSettingsRows returns ≥20 rows across all 8 sections (coverage)", () => {
  const rows = buildSettingsRows({} as Settings, {});
  assert.ok(rows.length >= 20, `expected ≥20 rows, got ${rows.length}`);
});

/* --------------------------------------------------------------------- */
/*  Pin 1b: table-grid rendering (v0.28.18)                              */
/* --------------------------------------------------------------------- */

test("render: tab bar is color-only (v0.28.19: brackets dropped), all sections present", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const tabs = component.render(120)[1]!;
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(tabs.includes(s.label), `tab bar must name ${s.label}: ${tabs}`);
  }
  assert.doesNotMatch(tabs, /\[/, "no bracket chrome on tabs (color-only)");
});

test("render: a header rule with ┼ junctions follows the header row", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  component.handleInput("d");
  const lines = component.render(120);
  assert.match(lines[3]!, /─+┼─+┼─+┼─+/, `line 3 must be the header rule: ${lines[3]}`);
});

test("render: column separators align across header, rule, and every row (prefix counted)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const lines = component.render(120);
  const grid = [lines[2]!, lines[3]!, ...lines.slice(4, -1)];
  const firstSeps = grid.map((l) => l.indexOf("│") !== -1 ? l.indexOf("│") : l.indexOf("┼"));
  for (const pos of firstSeps) {
    assert.equal(pos, firstSeps[0], `first column boundary must align: ${JSON.stringify(firstSeps)}`);
  }
});

test("render: a too-long VALUE is truncated with … — it must NOT break the grid", () => {
  const rows: SettingsRow[] = [
    { id: "a", section: "keep-going", label: "Short", valueText: "off", sourceText: "default", description: "short row" },
    { id: "b", section: "keep-going", label: "Effective resolution", valueText: "session model · session model · session model", sourceText: "runtime", description: "long composite value" },
  ];
  const { component } = makeComponent(rows, 120);
  component.handleInput("d");
  const lines = component.render(120);
  const body = lines.slice(4, -1);
  const longRow = body.find((l) => l.includes("Effective resolution"))!;
  assert.ok(longRow.includes("…"), `long value must be truncated with ellipsis: ${longRow}`);
  const shortRow = body.find((l) => l.includes("Short"))!;
  assert.equal(
    longRow.indexOf("│"), shortRow.indexOf("│"),
    "the long value must not push its row's separators right",
  );
});

test("render: column widths are stable across tab switches (no grid reflow)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const headerA = component.render(120)[2]!;
  component.switchSection(+1); // agents
  const headerB = component.render(120)[2]!;
  component.switchSection(+4); // subagents
  const headerC = component.render(120)[2]!;
  assert.equal(headerB, headerA, "header must not reflow on tab switch");
  assert.equal(headerC, headerA, "header must not reflow on tab switch");
});
