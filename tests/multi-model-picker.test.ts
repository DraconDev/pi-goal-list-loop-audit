// tests/multi-model-picker.test.ts
//
// Multi-select variant of ModelPickerComponent for ordered model lists
// (main-model fallbacks, forbidden-models list, subagent fallbacks).
//
// The interaction model is: type a search query → navigate with ↑/↓ → press
// space to toggle the highlighted model in/out of the selection → tab enters
// order mode (↑/↓ moves a chain row) → enter confirms with the refs in toggle
// order. Esc cancels with undefined. Session and manual rows render but are
// not toggleable.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { buildModelPickItems } from "../extensions/model-picker.ts";
import { MultiModelPickerComponent, type MultiModelPickerResult } from "../extensions/multi-model-picker.ts";

const THEME = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};
const HIGHLIGHT_THEME = {
  ...THEME,
  bg: (_c: string, t: string) => `<selected>${t}</selected>`,
};
const KB = {
  matches: (data: string, key: string) =>
    (key === "tui.select.confirm" && data === "\r") ||
    (key === "tui.select.cancel" && data === "\x1b") ||
    (key === "tui.select.up" && data === "\x1b[A") ||
    (key === "tui.select.down" && data === "\x1b[B"),
};

const MODELS = [
  { provider: "minimax", id: "MiniMax-M3", name: "MiniMax-M3" },
  { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax-M2.7" },
  { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
];

type PickerResult = MultiModelPickerResult;

function makePicker(
  items: ReturnType<typeof buildModelPickItems>,
  initialSelected?: string[],
  maxSelections?: number,
  includeInheritOption = false,
  initialInheritFromSession = false,
) {
  let rendered = 0;
  let result: PickerResult = "unset" as unknown as PickerResult;
  const comp = new MultiModelPickerComponent(
    {
      title: "Main model backups",
      items,
      initialSelected,
      maxSelections,
      includeInheritOption,
      initialInheritFromSession,
    },
    () => { rendered++; },
    THEME,
    KB,
    (r) => { result = r; },
  );
  return {
    comp,
    get result() { return result; },
    get renders() { return rendered; },
  };
}

test("multi-model-picker: items-build integration — session/manual still render as non-toggleable rows", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  // First row is the session-clear override, last is the manual escape hatch.
  assert.equal(p.comp.filteredItems()[0]!.kind, "session");
  assert.equal(p.comp.filteredItems()[p.comp.filteredItems().length - 1]!.kind, "manual");
  assert.deepEqual(p.comp.getSelected(), []);
  assert.equal(p.comp.getSelectedIdx(), 0);
  assert.ok(p.renders === 0, "no render at construction");
});

test("multi-model-picker: explicit inherit choice is distinct from session/manual rows", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, [], undefined, true);
  const filtered = p.comp.filteredItems();
  assert.equal(filtered[0]!.kind, "inherit");
  assert.equal(filtered[1]!.kind, "session");
  assert.equal(filtered[filtered.length - 1]!.kind, "manual");
  assert.match(filtered[0]!.label, /inherit from session/);

  // Inheritance is a dynamic choice, not a provider/model ref or the legacy
  // session-clear/manual no-op rows.
  p.comp.handleInput(" ");
  assert.equal(p.comp.getInheritFromSession(), true);
  assert.deepEqual(p.comp.getSelected(), []);
  p.comp.handleInput("\r");
  assert.deepEqual(p.result, { refs: [], inheritFromSession: true });

  const initiallyInherited = makePicker(items, ["anthropic/claude-opus-4-7"], undefined, true, true);
  assert.equal(initiallyInherited.comp.getInheritFromSession(), true);
  assert.ok(initiallyInherited.comp.render(100).some((line) => line.includes("[inherit]")));
});

test("multi-model-picker: typing fuzzy-filters the list; backspace widens", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  for (const ch of "minimax-m3") p.comp.handleInput(ch);
  assert.equal(p.comp.getQuery(), "minimax-m3");
  const filtered = p.comp.filteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.ref, "minimax/MiniMax-M3");
  p.comp.handleInput("\x7f");
  assert.equal(p.comp.getQuery(), "minimax-m");
  assert.ok(p.comp.filteredItems().length > 1, "backspace widens the filter");
});

test("multi-model-picker: ↑/↓ move the selection (wrap at ends)", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\x1b[B");
  assert.equal(p.comp.getSelectedIdx(), 1);
  p.comp.handleInput("\x1b[B");
  assert.equal(p.comp.getSelectedIdx(), 2);
  p.comp.handleInput("\x1b[A");
  assert.equal(p.comp.getSelectedIdx(), 1);
  // Wrap up from the top.
  p.comp.handleInput("\x1b[A");
  assert.equal(p.comp.getSelectedIdx(), 0);
  p.comp.handleInput("\x1b[A");
  assert.equal(p.comp.getSelectedIdx(), items.length - 1);
});

test("multi-model-picker: space toggles the highlighted model in/out of the selection", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  // Session row is highlighted by default — space is a no-op there.
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), []);
  // Navigate to the first model row (index 1) and toggle it on.
  p.comp.handleInput("\x1b[B");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), ["anthropic/claude-opus-4-7"]);
  // Toggle it off again — selection goes back to empty.
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), []);
});

test("multi-model-picker: selection order matches toggle order, not list order", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  // The picker is constructed AFTER the user has already picked two
  // fallbacks in canonical order, then they add a third later. The
  // order in the done callback must be: initial[0], initial[1], new —
  // not list order.
  const p = makePicker(items, ["minimax/MiniMax-M3", "anthropic/claude-opus-4-7"]);
  assert.deepEqual(p.comp.getSelected(), [
    "minimax/MiniMax-M3",
    "anthropic/claude-opus-4-7",
  ]);
  // Navigate to the openrouter model (at the bottom of the list) and toggle it.
  // It is at index items.length - 2 (manual is last).
  const targetIdx = items.length - 2;
  // Currently the cursor is at the top after construction; walk down to it.
  for (let i = 0; i < targetIdx; i++) p.comp.handleInput("\x1b[B");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), [
    "minimax/MiniMax-M3",
    "anthropic/claude-opus-4-7",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
  // Navigate up to the second initial model and toggle it off — the
  // remaining selection must still be in original order.
  for (let i = 0; i < targetIdx - 1; i++) p.comp.handleInput("\x1b[A");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), [
    "minimax/MiniMax-M3",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
});

test("multi-model-picker: enter confirms with the refs in selection order", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["minimax/MiniMax-M3"]);
  // Add a second one in a deliberate order.
  while (p.comp.getSelectedIdx() < items.length - 1) p.comp.handleInput("\x1b[B");
  // Step back to the openrouter row (one before the manual row).
  p.comp.handleInput("\x1b[A");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), [
    "minimax/MiniMax-M3",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
  p.comp.handleInput("\r");
  assert.deepEqual(p.result, [
    "minimax/MiniMax-M3",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
});

test("multi-model-picker: brackets reorder the configured try sequence", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["minimax/MiniMax-M3", "anthropic/claude-opus-4-7"]);
  // Search makes the second configured ref the highlighted row, then `[`
  // moves it ahead of the first backup without changing membership.
  for (const ch of "opus") p.comp.handleInput(ch);
  p.comp.handleInput("\x1b[B"); // fuzzy matching also leaves the sonnet row; move to opus
  assert.deepEqual(p.comp.getSelected(), ["minimax/MiniMax-M3", "anthropic/claude-opus-4-7"]);
  p.comp.handleInput("[");
  assert.deepEqual(p.comp.getSelected(), ["anthropic/claude-opus-4-7", "minimax/MiniMax-M3"]);
  assert.match(p.comp.render(100).join("\\n"), /1 backup  anthropic\/claude-opus-4-7/);
});

test("multi-model-picker: current session model is slot 0 and cannot be added as its own backup", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = new MultiModelPickerComponent(
    { title: "Main model backups", items, currentRef: "minimax/MiniMax-M3" },
    () => undefined,
    THEME,
    KB,
    () => undefined,
  );
  // Filter may include the session row as well; move to the actual model row.
  for (const ch of "minimax-m3") p.handleInput(ch);
  p.handleInput("\x1b[B");
  p.handleInput(" ");
  assert.deepEqual(p.getSelected(), []);
  assert.match(p.render(100).join("\\n"), /current session model \(slot 0\)/);
});

test("multi-model-picker: configured unavailable and blocked refs remain visible with reasons", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3", {
    excludeRefs: ["anthropic"],
    preserveRefs: ["anthropic/claude-opus-4-7", "ghost/provider-model"],
    includeSessionRow: false,
    includeManualRow: false,
  });
  assert.equal(items[0]!.disabledReason, "blocked by policy");
  assert.equal(items[1]!.disabledReason, "unavailable or unauthenticated");
  const p = new MultiModelPickerComponent(
    { title: "Main model backups", items, initialSelected: ["anthropic/claude-opus-4-7", "ghost/provider-model"], currentRef: "minimax/MiniMax-M3" },
    () => undefined,
    THEME,
    KB,
    () => undefined,
  );
  const text = p.render(100).join("\\n");
  assert.match(text, /0 current  minimax\/MiniMax-M3/);
  assert.match(text, /1 backup  anthropic\/claude-opus-4-7 · blocked by policy/);
  assert.match(text, /2 backup  ghost\/provider-model · unavailable or unauthenticated/);
});

test("multi-model-picker: tab enters order mode; enter still confirms", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["anthropic/claude-opus-4-7"]);
  p.comp.handleInput("\t");
  assert.ok(p.comp.isOrderMode(), "tab enters order mode");
  assert.equal(p.result, "unset", "no confirm on tab");
  // Order mode does not change membership or cursor semantics.
  assert.deepEqual(p.comp.getSelected(), ["anthropic/claude-opus-4-7"]);
  // Enter still confirms from order mode.
  p.comp.handleInput("\r");
  assert.deepEqual(p.result, ["anthropic/claude-opus-4-7"]);
});

test("multi-model-picker: order mode — ↑/↓ moves the chain row and the cursor follows", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["minimax/MiniMax-M3", "anthropic/claude-opus-4-7", "openrouter/anthropic/claude-sonnet-4.5"]);
  p.comp.handleInput("\t");
  assert.equal(p.comp.getOrderIdx(), 0);
  // Move the first backup down two slots: it must follow the cursor.
  p.comp.handleInput("\x1b[B");
  p.comp.handleInput("\x1b[B");
  assert.deepEqual(p.comp.getSelected(), [
    "anthropic/claude-opus-4-7",
    "openrouter/anthropic/claude-sonnet-4.5",
    "minimax/MiniMax-M3",
  ]);
  assert.equal(p.comp.getOrderIdx(), 2, "cursor follows the moved row");
  // Up moves it back to the top.
  p.comp.handleInput("\x1b[A");
  p.comp.handleInput("\x1b[A");
  assert.deepEqual(p.comp.getSelected(), [
    "minimax/MiniMax-M3",
    "anthropic/claude-opus-4-7",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
  assert.equal(p.comp.getOrderIdx(), 0);
});

test("multi-model-picker: order mode — tab returns to browse without confirming; space is suspended", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["anthropic/claude-opus-4-7"]);
  p.comp.handleInput("\t");
  assert.ok(p.comp.isOrderMode());
  // Space must not toggle membership while ordering.
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), ["anthropic/claude-opus-4-7"]);
  // Typing must not pollute the search query while ordering.
  p.comp.handleInput("opus");
  assert.equal(p.comp.getQuery(), "");
  p.comp.handleInput("\t");
  assert.ok(!p.comp.isOrderMode(), "tab exits order mode");
  assert.equal(p.result, "unset", "exiting order mode is not a confirm");
  // Browse mode works again afterwards — move to the model row and toggle it off.
  p.comp.handleInput("\x1b[B");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), []);
});

test("multi-model-picker: order mode — empty chain is a no-op and esc still cancels", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\t");
  assert.ok(p.comp.isOrderMode());
  p.comp.handleInput("\x1b[B");
  p.comp.handleInput("\x1b[A");
  assert.deepEqual(p.comp.getSelected(), []);
  p.comp.handleInput("\x1b");
  assert.equal(p.result, undefined, "esc cancels even from order mode");
});

test("multi-model-picker: render truncates a long title to the terminal width", () => {
  // Regression: untruncated titles (main/auditor fallback help text) crashed
  // pi with "Rendered line N exceeds terminal width".
  const longTitle =
    "Main agent fallback models — try order is current → fallback 1 → fallback 2 … (space add/remove, tab order mode with ↑/↓, enter save); forbidden models are skipped";
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = new MultiModelPickerComponent(
    { title: longTitle, items, currentRef: "minimax/MiniMax-M3" },
    () => undefined,
    THEME,
    KB,
    () => undefined,
  );
  const width = 140;
  const lines = p.render(width);
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
    );
  }
  assert.match(lines[0]!, /Main agent fallback models/);
  assert.match(lines[0]!, /…/);
  assert.ok(!lines[0]!.includes("forbidden models are skipped"), "trailing help text is truncated");
});

test("multi-model-picker: order mode — the active chain row is highlighted and the footer switches", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const component = new MultiModelPickerComponent(
    { title: "Main model backups", items, initialSelected: ["minimax/MiniMax-M3", "anthropic/claude-opus-4-7"] },
    () => undefined,
    HIGHLIGHT_THEME,
    KB,
    () => undefined,
  );
  component.handleInput("\t");
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.match(text, /<selected>→\s+1 backup  minimax\/MiniMax-M3/, "first chain row is the active cursor");
  assert.match(text, /order mode — arrows move this backup/, "mode line names order mode");
  assert.match(text, /↑\/↓ reorder · tab browse · enter save · esc cancel/, "order-mode footer");
  // Move the cursor to the end and confirm the highlight follows the moved row
  // (it is now rank 2, so the displaced first row is unhighlighted).
  component.handleInput("\x1b[B");
  component.handleInput("\x1b[B");
  const moved = component.render(80).join("\n");
  assert.match(moved, /<selected>→\s+2 backup  minimax\/MiniMax-M3/, "moved row stays the active cursor at its new rank");
  assert.match(moved, /^  1 backup  anthropic\/claude-opus-4-7/m, "displaced row renders unhighlighted");
});

test("multi-model-picker: empty selection confirms as an empty array (not undefined)", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\r");
  assert.deepEqual(p.result, []);
});

test("multi-model-picker: esc cancels with undefined (regardless of selection)", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["minimax/MiniMax-M3"]);
  p.comp.handleInput("\x1b");
  assert.equal(p.result, undefined);
});

test("multi-model-picker: session row is not toggleable — space is a no-op", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  assert.equal(p.comp.filteredItems()[0]!.kind, "session");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), []);
  // Enter on the session row would still be a confirm — but with no
  // selection set, it returns an empty list. The session row is
  // reserved for the single-select clear-override flow.
  p.comp.handleInput("\r");
  assert.deepEqual(p.result, []);
});

test("multi-model-picker: manual row is not toggleable — space is a no-op", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  // Filter down to just the manual row.
  for (const ch of "manual") p.comp.handleInput(ch);
  const filtered = p.comp.filteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.kind, "manual");
  p.comp.handleInput(" ");
  assert.deepEqual(p.comp.getSelected(), []);
});

test("multi-model-picker: main backup cap refuses the 11th selection", () => {
  const models = Array.from({ length: 11 }, (_, i) => ({
    provider: "provider",
    id: `model-${i + 1}`,
    name: `Model ${i + 1}`,
  }));
  const items = buildModelPickItems(models, "provider/model-1", { includeSessionRow: true, includeManualRow: true });
  const p = makePicker(items, undefined, 10);
  for (let i = 0; i < 11; i++) {
    p.comp.handleInput("\x1b[B");
    p.comp.handleInput(" ");
  }
  assert.equal(p.comp.getSelected().length, 10);
  assert.match(p.comp.render(100).join("\\n"), /maximum reached/);
});

test("multi-model-picker: initialSelected preserves stale refs for explicit cleanup", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  // A stale configured ref remains visible in the try-order summary instead
  // of disappearing merely because the registry cannot resolve it today.
  const p = makePicker(items, ["ghost-provider/ghost-model", "anthropic/claude-opus-4-7"]);
  assert.deepEqual(p.comp.getSelected(), ["ghost-provider/ghost-model", "anthropic/claude-opus-4-7"]);
});

test("multi-model-picker: render — title, search, marked rows, and footer hint are all present", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items, ["minimax/MiniMax-M3"]);
  const lines = p.comp.render(80);
  const text = lines.join("\n");
  assert.ok(text.includes("Main model backups"), "title present");
  assert.ok(text.includes("search:"), "search line present");
  // The selected row carries its explicit try-order rank.
  assert.ok(text.includes("[1]"), "selected rank present");
  // Unselected rows show the empty marker.
  assert.ok(text.includes("[ ]"), "unselected marker present");
  assert.ok(text.includes("minimax/MiniMax-M3"), "selected row label present");
  assert.ok(text.includes("space add/remove · tab order · enter save · esc cancel"), "footer hint present");
});

test("multi-model-picker: render — highlighted row uses the available width for selection", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  // Row 0 is the session row (kind !== "model"). Skip it to focus on a
  // model row that produces an explicit rank / `[ ]` marker.
  const component = new MultiModelPickerComponent(
    { title: "Main model backups", items },
    () => undefined,
    HIGHLIGHT_THEME,
    KB,
    () => undefined,
  );
  component.handleInput("\x1b[B"); // move highlight to the first model row
  const lines = component.render(80);
  const highlighted = lines.find((l) => l.startsWith("<selected>"));
  assert.ok(highlighted, "highlighted row is wrapped in selectedBg");
  assert.match(highlighted!, /^<selected>→ \[ \] /);
  assert.ok(highlighted!.endsWith("</selected>"));
});

test("multi-model-picker: render — selected row keeps its rank even when not highlighted", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const component = new MultiModelPickerComponent(
    { title: "Main model backups", items, initialSelected: ["minimax/MiniMax-M3"] },
    () => undefined,
    HIGHLIGHT_THEME,
    KB,
    () => undefined,
  );
  component.handleInput("\x1b[B"); // move highlight to the first model row (not the selected one)
  const lines = component.render(80);
  const text = lines.join("\n");
  // The selected row (M3) is at index 1 in the items list — its rank must
  // appear even though the highlight is elsewhere.
  assert.match(text, /\[1\] .*minimax\/MiniMax-M3/);
  // The first model row (highlighted) still shows the [ ] marker.
  assert.match(text, /<selected>→ \[ \] anthropic\/claude-opus-4-7/);
});

// ---------------------------------------------------------------------------
// unorderedSet mode (auditor allowed extensions): plain checkbox set picker
// ---------------------------------------------------------------------------

function makeSetPicker(items: ReturnType<typeof buildModelPickItems>, initialSelected?: string[]) {
  let result: PickerResult = "unset" as unknown as PickerResult;
  const comp = new MultiModelPickerComponent(
    {
      title: "Auditor allowed extensions",
      items,
      initialSelected,
      unorderedSet: true,
    },
    () => undefined,
    THEME,
    KB,
    (r) => { result = r; },
  );
  return { comp, get result() { return result; } };
}

test("multi-model-picker set mode: rows render as [X]/[ ] with no positional digits", () => {
  const items = buildModelPickItems(MODELS, "none/none");
  const p = makeSetPicker(items, ["anthropic/claude-opus-4-7"]);
  p.comp.handleInput("\x1b[B"); // highlight the first model row (the selected one)
  const text = p.comp.render(80).join("\n");
  assert.match(text, /\[X\] .*anthropic\/claude-opus-4-7/);
  assert.doesNotMatch(text, /\[[0-9]+\]/);
  // The summary pane says "selected", not "backup", and has no order footer.
  assert.match(text, /1 selected  anthropic\/claude-opus-4-7/);
  assert.doesNotMatch(text, /tab = order mode|tab order/);
});

test("multi-model-picker set mode: selection order is invariant under toggle sequence", () => {
  const items = buildModelPickItems(MODELS, "none/none");
  // Toggle order A: sonnet first, then opus.
  // Drive toggles through a helper that highlights the row with the given
  // ref, so the test does not depend on fuzzy-filter ranking.
  const toggleRef = (p: ReturnType<typeof makeSetPicker>, ref: string) => {
    // Clear any query, then walk the list top-to-bottom.
    while (p.comp.getQuery().length > 0) p.comp.handleInput("\x7f");
    const filtered = p.comp.filteredItems();
    const target = filtered.findIndex((it) => it.ref === ref);
    if (target < 0) throw new Error(`ref not found: ${ref}`);
    const cur = p.comp.getSelectedIdx();
    const n = filtered.length;
    const down = ((target - cur) % n + n) % n;
    for (let i = 0; i < down; i++) p.comp.handleInput("\x1b[B");
    p.comp.handleInput(" ");
  };
  const a = makeSetPicker(items);
  toggleRef(a, "openrouter/anthropic/claude-sonnet-4.5");
  toggleRef(a, "anthropic/claude-opus-4-7");
  // Toggle order B: opus first, then sonnet.
  const b = makeSetPicker(items);
  toggleRef(b, "anthropic/claude-opus-4-7");
  toggleRef(b, "openrouter/anthropic/claude-sonnet-4.5");
  // Both produce the same canonical (item-list) order.
  assert.deepEqual(a.comp.getSelected(), ["anthropic/claude-opus-4-7", "openrouter/anthropic/claude-sonnet-4.5"]);
  assert.deepEqual(b.comp.getSelected(), a.comp.getSelected());
  a.comp.handleInput("\r");
  assert.deepEqual(a.result, a.comp.getSelected());
});

test("multi-model-picker set mode: tab is a no-op and never enters order mode", () => {
  const items = buildModelPickItems(MODELS, "none/none");
  const p = makeSetPicker(items, ["anthropic/claude-opus-4-7"]);
  p.comp.handleInput("\t");
  assert.equal(p.comp.isOrderMode(), false);
  // Even double-tab (which in ordered mode would toggle off) stays off, and
  // arrows keep browsing rather than reordering.
  p.comp.handleInput("\t");
  assert.equal(p.comp.isOrderMode(), false);
  const before = p.comp.getSelected();
  p.comp.handleInput("\x1b[A");
  p.comp.handleInput("\x1b[B");
  assert.deepEqual(p.comp.getSelected(), before);
});

test("multi-model-picker set mode: brackets are a no-op (no reordering)", () => {
  const items = buildModelPickItems(MODELS, "none/none");
  const p = makeSetPicker(items, ["anthropic/claude-opus-4-7", "openrouter/anthropic/claude-sonnet-4.5"]);
  const before = p.comp.getSelected();
  p.comp.handleInput("[");
  p.comp.handleInput("]");
  assert.deepEqual(p.comp.getSelected(), before);
});

test("multi-model-picker set mode: initial selection is canonicalized to item order", () => {
  const items = buildModelPickItems(MODELS, "none/none");
  const p = makeSetPicker(items, ["openrouter/anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4-7"]);
  assert.deepEqual(p.comp.getSelected(), ["anthropic/claude-opus-4-7", "openrouter/anthropic/claude-sonnet-4.5"]);
});
