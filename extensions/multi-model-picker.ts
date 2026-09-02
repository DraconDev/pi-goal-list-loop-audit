// pi-goal-list-loop-audit — v0.29.17
// extensions/multi-model-picker.ts
//
// Multi-select variant of ModelPickerComponent for ordered model lists
// (main-model fallbacks, forbidden-models list, subagent fallbacks).
//
// Why this exists:
//   • The single-select picker doesn't scale to ordered lists — the user
//     needs to add 3-5 fallbacks in priority order, and the picker needs
//     to remember what was already picked between confirm and re-edit.
//   • Selection order is explicit: new items append, and `[ ]` moves the
//     highlighted selected item earlier/later without changing membership.
//
// UX:
//   • Space (" ") toggles the highlighted item. Models are toggleable;
//     session-row and manual-row both render but pressing space on them
//     is a no-op (they're not model refs to pick). An optional explicit
//     inherit-from-session row is a dynamic choice, distinct from both.
//   • Tab enters/exits ORDER MODE: while active, ↑/↓ moves the highlighted
//     chain row earlier/later in the try order (membership unchanged). The
//     active chain row is highlighted in the summary pane. Browsing/search
//     keys are suspended in order mode so ↑/↓ are unambiguous.
//   • Enter confirms with the current selection, refs in selection order.
//     Esc cancels with undefined.
//   • Selection state is visually ranked: `[1]`, `[2]`, … show the exact
//     persisted try order; `[ ]` means unselected. The marker is independent
//     of the highlighted row — ranks stay visible while navigating.
//
// Pure UI — no fs, no path, no os. Imports: ./model-picker.ts for the
// item type, ./settings-menu.ts for the theme/keybindings shapes, and
// @earendil-works/pi-tui for fuzzyFilter / truncateToWidth / visibleWidth.

import { fuzzyFilter, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingsMenuTheme, KeybindingsManagerLike } from "./settings-menu.ts";
import type { ModelPickItem } from "./model-picker.ts";

// Re-export so callers can import the item type from this module too.
export type { ModelPickItem };

export interface MultiModelPickerDeps {
  title: string;
  items: ModelPickItem[];
  /** Refs already in the selection, in canonical order. */
  initialSelected?: string[];
  /** The model occupying slot 0 in the runtime try order. */
  currentRef?: string;
  /** Cap on visible list rows (window scrolls with the selection). */
  maxVisibleRows?: number;
  /** Maximum number of model refs that may be selected. Undefined = no cap. */
  maxSelections?: number;
  /** Add a distinct dynamic "inherit from session" choice row. */
  includeInheritOption?: boolean;
  /** Initial state for the explicit inherit choice. */
  initialInheritFromSession?: boolean;
  /** Unordered-set mode: rows render as `[X]`/`[ ]` checkboxes, the
   * selection is always kept in item-list (discovery) order regardless
   * of toggle sequence, and Tab order-mode / bracket reordering are
   * disabled. For allowlists where order is meaningless. */
  unorderedSet?: boolean;
}

export interface MultiModelPickerSelection {
  refs: string[];
  inheritFromSession: boolean;
}

/** The legacy string[] result remains the default; enabling the inherit row
 * returns a selection object so callers cannot confuse inheritance with the
 * old session-clear or manual-entry rows. */
export type MultiModelPickerResult = string[] | MultiModelPickerSelection | undefined;

export class MultiModelPickerComponent {
  private readonly title: string;
  private readonly items: ModelPickItem[];
  private readonly includeInheritOption: boolean;
  private readonly maxRows: number;
  private readonly maxSelections: number | undefined;
  private readonly currentRef: string | undefined;
  private readonly unorderedSet: boolean;
  private readonly requestRender: () => void;
  private readonly theme: SettingsMenuTheme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly done: (result: MultiModelPickerResult) => void;

  private query = "";
  private selectedIdx = 0;
  /** Ordered list of selected refs — toggle order, not list order. */
  private readonly selection: string[];
  /** Explicit dynamic choice; it never becomes a fake provider/model ref. */
  private inheritFromSession: boolean;
  /** Order mode: ↑/↓ move the chain instead of navigating the list. */
  private orderMode = false;
  /** Chain index the order-mode cursor sits on (follows the moved row). */
  private orderIdx = 0;

  constructor(
    deps: MultiModelPickerDeps,
    requestRender: () => void,
    theme: SettingsMenuTheme,
    keybindings: KeybindingsManagerLike,
    done: (result: MultiModelPickerResult) => void,
  ) {
    this.title = deps.title;
    this.includeInheritOption = deps.includeInheritOption === true || deps.items.some((item) => item.kind === "inherit");
    const inheritItem: ModelPickItem = {
      kind: "inherit",
      label: "inherit from session — use the live session model",
      searchText: "inherit from session live session model",
      inheritFromSession: true,
    };
    this.items = this.includeInheritOption && !deps.items.some((item) => item.kind === "inherit")
      ? [inheritItem, ...deps.items]
      : deps.items;
    this.maxRows = deps.maxVisibleRows ?? 12;
    this.maxSelections = deps.maxSelections !== undefined && Number.isInteger(deps.maxSelections) && deps.maxSelections >= 0
      ? deps.maxSelections
      : undefined;
    this.currentRef = typeof deps.currentRef === "string" && deps.currentRef.trim() ? deps.currentRef.trim() : undefined;
    this.unorderedSet = deps.unorderedSet === true;
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    const itemRef = new Map<string, string>();
    for (const item of this.items) {
      if (item.kind === "model" && item.ref) itemRef.set(item.ref.toLowerCase(), item.ref);
    }
    const initial: string[] = [];
    const seen = new Set<string>();
    for (const candidate of deps.initialSelected ?? []) {
      if (typeof candidate !== "string") continue;
      const ref = candidate.trim();
      const key = ref.toLowerCase();
      if (!ref || seen.has(key)) continue;
      seen.add(key);
      // Prefer the registry's canonical spelling, but retain a stale ref so
      // the order is visible and it is not silently deleted on save.
      initial.push(itemRef.get(key) ?? ref);
    }
    this.selection = this.maxSelections === undefined ? initial : initial.slice(0, this.maxSelections);
    if (this.unorderedSet) this.canonicalizeSelection();
    this.inheritFromSession = this.includeInheritOption && deps.initialInheritFromSession === true;
  }

  /** Reorder the selection into item-list order (discovery order); refs
   * not present in the list (stale saved entries) keep their relative
   * order at the end. In set mode this runs after every mutation so the
   * persisted array is invariant under toggle sequence. */
  private canonicalizeSelection(): void {
    const rank = new Map<string, number>();
    this.items.forEach((item, i) => {
      if (item.kind === "model" && item.ref) rank.set(item.ref.toLowerCase(), i);
    });
    const known: string[] = [];
    const stale: string[] = [];
    for (const ref of this.selection) {
      if (rank.has(ref.toLowerCase())) known.push(ref);
      else stale.push(ref);
    }
    known.sort((a, b) => rank.get(a.toLowerCase())! - rank.get(b.toLowerCase())!);
    this.selection.length = 0;
    this.selection.push(...known, ...stale);
  }

  /** Current search query. Exposed for tests. */
  getQuery(): string {
    return this.query;
  }

  /** Index into the filtered list. Exposed for tests. */
  getSelectedIdx(): number {
    return this.selectedIdx;
  }

  /** Selected refs in selection order (toggle order). Exposed for tests. */
  getSelected(): string[] {
    return [...this.selection];
  }

  /** Whether the explicit inherit choice is enabled. Exposed for tests. */
  getInheritFromSession(): boolean {
    return this.inheritFromSession;
  }

  /** Filtered items for the current query. Exposed for tests. */
  filteredItems(): ModelPickItem[] {
    if (!this.query.trim()) return this.items;
    return fuzzyFilter(this.items, this.query.trim(), (it) => it.searchText);
  }

  private refresh(): void {
    this.requestRender();
  }

  private move(delta: number): void {
    const n = this.filteredItems().length;
    if (n === 0) return;
    this.selectedIdx = ((this.selectedIdx + delta) % n + n) % n;
    this.refresh();
  }

  private selectionIndex(ref: string | undefined): number {
    if (!ref) return -1;
    const key = ref.toLowerCase();
    return this.selection.findIndex((candidate) => candidate.toLowerCase() === key);
  }

  private selectedItem(): ModelPickItem | undefined {
    const filtered = this.filteredItems();
    return filtered[this.selectedIdx];
  }

  private isCurrent(ref: string | undefined): boolean {
    return !!ref && !!this.currentRef && ref.toLowerCase() === this.currentRef.toLowerCase();
  }

  private effectiveDisabledReason(item: ModelPickItem | undefined): string | undefined {
    if (!item || item.kind !== "model" || !item.ref) return undefined;
    return item.disabledReason ?? (this.isCurrent(item.ref) ? "current session model (slot 0)" : undefined);
  }

  private toggle(): void {
    const it = this.selectedItem();
    if (!it) return;
    if (it.kind === "inherit") {
      if (this.includeInheritOption) {
        this.inheritFromSession = !this.inheritFromSession;
        this.refresh();
      }
      return;
    }
    if (it.kind !== "model" || !it.ref) return;
    const idx = this.selectionIndex(it.ref);
    if (idx >= 0) {
      // Removing a stale/blocked ref is always allowed: the user is fixing
      // the setting explicitly rather than having the editor do it silently.
      this.selection.splice(idx, 1);
    } else {
      if (this.effectiveDisabledReason(it)) return;
      if (this.maxSelections !== undefined && this.selection.length >= this.maxSelections) {
        this.refresh();
        return;
      }
      this.selection.push(it.ref);
    }
    if (this.unorderedSet) this.canonicalizeSelection();
    this.refresh();
  }

  /** Move the highlighted selected ref earlier/later in the try order. */
  private moveSelectedOrder(delta: number): void {
    const it = this.selectedItem();
    const idx = this.selectionIndex(it?.ref);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= this.selection.length) return;
    const current = this.selection[idx]!;
    this.selection[idx] = this.selection[next]!;
    this.selection[next] = current;
    this.refresh();
  }

  /**
   * Order-mode reorder: move the chain row under the order cursor by
   * `delta` and keep the cursor on that row so repeated presses keep
   * moving the same item. Membership never changes.
   */
  private moveChainRow(delta: number): void {
    if (this.selection.length === 0) return;
    const next = this.orderIdx + delta;
    if (next < 0 || next >= this.selection.length) return;
    const current = this.selection[this.orderIdx]!;
    this.selection[this.orderIdx] = this.selection[next]!;
    this.selection[next] = current;
    this.orderIdx = next;
    this.refresh();
  }

  private setOrderMode(on: boolean): void {
    if (this.unorderedSet) return; // set mode: ordering is meaningless
    if (this.orderMode === on) return;
    this.orderMode = on;
    this.orderIdx = 0;
    this.refresh();
  }

  /** Whether order mode is active. Exposed for tests. */
  isOrderMode(): boolean {
    return this.orderMode;
  }

  /** Chain index of the order-mode cursor. Exposed for tests. */
  getOrderIdx(): number {
    return this.orderIdx;
  }

  private isSelected(ref: string | undefined): boolean {
    return this.selectionIndex(ref) >= 0;
  }

  private orderLabel(ref: string | undefined): string {
    const idx = this.selectionIndex(ref);
    return idx >= 0 ? `[${idx + 1}]` : "[ ]";
  }

  private itemMarker(item: ModelPickItem): string {
    if (item.kind === "inherit") return this.inheritFromSession ? "[inherit]" : "[ ]";
    if (this.unorderedSet) return this.isSelected(item.ref) ? "[X]" : "[ ]";
    return this.orderLabel(item.ref);
  }

  private result(): MultiModelPickerResult {
    if (!this.includeInheritOption) return [...this.selection];
    return { refs: [...this.selection], inheritFromSession: this.inheritFromSession };
  }

  private itemForRef(ref: string): ModelPickItem | undefined {
    const key = ref.toLowerCase();
    return this.items.find((item) => item.kind === "model" && item.ref?.toLowerCase() === key);
  }

  render(width: number): string[] {
    const w = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold(truncateToWidth(this.title, w, "…"))));
    if (this.unorderedSet) {
      lines.push(this.theme.fg("muted", "selected extensions are loaded by the auditor; order does not matter:"));
    } else if (this.currentRef) {
      lines.push(this.theme.fg("muted", "try order on a provider failure (one supervised model at a time):"));
      lines.push(truncateToWidth(`  0 current  ${this.currentRef}`, w, "…"));
    } else {
      lines.push(this.theme.fg("muted", "configured try order (first eligible ref wins):"));
    }
    if (this.includeInheritOption) {
      const inheritedRef = this.currentRef ?? "current session model";
      const state = this.inheritFromSession ? "on" : "off";
      lines.push(truncateToWidth(`  inherit session  ${inheritedRef} · ${state}`, w, "…"));
    }
    if (this.selection.length === 0) {
      lines.push(this.theme.fg("dim", this.currentRef
        ? "  — no backups; keep probing the current model"
        : this.unorderedSet ? "  — no extensions allowed (fully isolated auditor)" : "  — no fallback refs configured"));
    } else {
      for (let i = 0; i < this.selection.length; i++) {
        const ref = this.selection[i]!;
        const item = this.itemForRef(ref);
        const status = this.effectiveDisabledReason(item) ? ` · ${this.effectiveDisabledReason(item)}` : "";
        const row = truncateToWidth(`  ${i + 1} ${this.unorderedSet ? "selected" : "backup"}  ${ref}${status}`, w, "…");
        if (this.orderMode && i === this.orderIdx) {
          // In order mode the active chain row is the cursor: ↑/↓ moves it.
          const selectedRow = this.theme.bold(`→ ${row}`);
          const paddedRow = selectedRow + " ".repeat(Math.max(0, w - visibleWidth(selectedRow)));
          lines.push(this.theme.bg("selectedBg", paddedRow));
        } else {
          lines.push(row);
        }
      }
    }
    lines.push("");
    const searchLine = this.orderMode ? "order mode — arrows move this backup" : `search: ${this.query}`;
    lines.push(this.theme.fg("muted", truncateToWidth(searchLine, w, "…") + "▏"));
    if (this.maxSelections !== undefined) {
      const count = `${this.selection.length}/${this.maxSelections}`;
      lines.push(this.theme.fg(this.selection.length >= this.maxSelections ? "warning" : "muted", `selected: ${count}`));
    }
    if (this.includeInheritOption) {
      lines.push(this.theme.fg("muted", `inherit from session: ${this.inheritFromSession ? "selected" : "not selected"}`));
    }
    lines.push(this.theme.fg("dim", this.unorderedSet
      ? "space select/deselect · enter save · esc cancel"
      : this.orderMode
      ? "↑/↓ moves the highlighted backup · tab returns to browsing"
      : "selected rows are tried top-to-bottom · tab = order mode"));
    lines.push("");
    const filtered = this.filteredItems();
    if (filtered.length === 0) {
      lines.push(this.theme.fg("warning", "  no matches — keep typing, or Esc to cancel"));
    } else {
      const sel = Math.min(this.selectedIdx, filtered.length - 1);
      const half = Math.floor(this.maxRows / 2);
      const start = Math.max(0, Math.min(sel - half, filtered.length - this.maxRows));
      const window = filtered.slice(start, start + this.maxRows);
      if (start > 0) lines.push(this.theme.fg("dim", `  ↑ ${start} more`));
      for (let i = 0; i < window.length; i++) {
        const idx = start + i;
        const it = window[i]!;
        const marker = this.itemMarker(it);
        const disabledReason = this.effectiveDisabledReason(it);
        const disabled = disabledReason && !this.isSelected(it.ref) ? ` · ${disabledReason}` : "";
        const row = truncateToWidth(`${marker} ${it.label}${disabled}`, w - 2, "…");
        if (idx === sel) {
          // Use the available horizontal space for a high-contrast active
          // state. Accent-only text was easy to miss in dark terminals and
          // left the selected model indistinguishable from its neighbours.
          // The order marker is unrelated to the highlight — a selected
          // non-highlighted row keeps its rank, and vice versa.
          const selectedRow = this.theme.bold(`→ ${row}`);
          const paddedRow = selectedRow + " ".repeat(Math.max(0, w - visibleWidth(selectedRow)));
          lines.push(this.theme.bg("selectedBg", paddedRow));
        } else {
          lines.push(`  ${row}`);
        }
      }
      const remaining = filtered.length - (start + window.length);
      if (remaining > 0) lines.push(this.theme.fg("dim", `  ↓ ${remaining} more`));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", this.unorderedSet
      ? "space select/deselect · enter save · esc cancel"
      : this.orderMode
      ? "↑/↓ reorder · tab browse · enter save · esc cancel"
      : this.maxSelections !== undefined && this.selection.length >= this.maxSelections
        ? "space add/remove · tab order · enter save · esc cancel · maximum reached"
        : "space add/remove · tab order · enter save · esc cancel"));
    return lines;
  }

  handleInput(data: string): void {
    if (this.orderMode) {
      // Order mode: only ordering, mode-exit, and confirm/cancel keys act.
      // Search/toggle keys are suspended so ↑/↓ are unambiguous.
      if (this.keybindings.matches(data, "tui.select.up")) {
        this.moveChainRow(-1);
        return;
      }
      if (this.keybindings.matches(data, "tui.select.down")) {
        this.moveChainRow(+1);
        return;
      }
      if (data === "[") {
        this.moveChainRow(-1);
        return;
      }
      if (data === "]") {
        this.moveChainRow(+1);
        return;
      }
      if (data === "\t") {
        this.setOrderMode(false);
        return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.done(this.result());
        return;
      }
      if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
        this.done(undefined);
        return;
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.result());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(+1);
      return;
    }
    // Tab switches to order mode instead of confirming: ordering an ordered
    // fallback chain is a first-class step, not a hidden bracket key.
    if (data === "\t") {
      this.setOrderMode(true);
      return;
    }
    // Brackets still reorder the highlighted selected model in browse mode
    // (same semantics as the order-mode arrows, but without leaving browse).
    // In set mode there is no order — a no-op.
    if (data === "[" && !this.unorderedSet) {
      this.moveSelectedOrder(-1);
      return;
    }
    if (data === "]" && !this.unorderedSet) {
      this.moveSelectedOrder(+1);
      return;
    }
    // Space toggles the highlighted model in/out of the selection. Session
    // and manual rows are intentionally no-op (they have no ref). This
    // overrides the default "append to query" behavior — search queries
    // are paged through with up/down + space, not by typing spaces.
    if (data === " ") {
      this.toggle();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIdx = 0;
        this.refresh();
      }
      return;
    }
    // Printable input (single keystrokes and pasted runs alike). Ignore
    // escape/CSI sequences — they start with \x1b and were handled above.
    if (!data.startsWith("\x1b")) {
      const printable = [...data].filter((ch) => ch >= " ").join("");
      if (printable.length > 0) {
        this.query += printable;
        this.selectedIdx = 0;
        this.refresh();
      }
    }
  }

  invalidate(): void {
    // Stateless beyond the query/selection — nothing to clear.
  }
}
