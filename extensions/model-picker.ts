// pi-goal-list-loop-audit — v0.29.17
// extensions/model-picker.ts
//
// A /model-style fuzzy picker for model-valued settings (Auditor model,
// subagent model pins). Why this exists:
//   • ctx.ui.select renders EVERY option unsorted with no search — a full
//     model registry is hundreds of rows; unusable (field: the auditor
//     model was left on a quota-dead openrouter key partly because fixing
//     it meant hand-typing provider/model into a bare input).
//   • pi's own /model dialog (ModelSelectorComponent) needs ModelRuntime
//     and SettingsManager internals that extensions never receive.
//   So we rebuild the same interaction shape — a search line with a
//   fuzzy-filtered list — from pi-tui primitives (fuzzyFilter) over
//   ctx.modelRegistry, hosted via ctx.ui.custom, exactly like the v0.28.0
//   settings table. Unit-testable via synthetic handleInput calls.
//
// Item order: "session model" (clear override) first, then configured
// refs in their saved order, remaining configured-auth models sorted by
// provider/id, and "type manually…" last.

import { fuzzyFilter, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingsMenuTheme, KeybindingsManagerLike } from "./settings-menu.ts";

export type ModelPickKind = "session" | "inherit" | "model" | "manual";

export interface ModelPickItem {
  kind: ModelPickKind;
  /** provider/model-id for kind === "model". */
  ref?: string;
  /** Row label shown in the list. */
  label: string;
  /** Text the fuzzy filter matches against. */
  searchText: string;
  /** A preserved configured ref that cannot currently be selected. */
  disabledReason?: string;
  /** True for the explicit dynamic session-inheritance choice. */
  inheritFromSession?: boolean;
}

export interface RegistryModelLike {
  provider: string;
  id: string;
  name?: string;
}

/** Build the picker's static item list from registry models (already
 * filtered to configured-auth providers by the caller). Session row first,
 * manual-entry row last; models sorted by provider then id.
 *
 * v0.34.118: `excludeRefs` lets a caller build a purpose-specific picker.
 * Backup selectors use it to hide forbidden models; the forbidden-model
 * selector uses it to hide current backups. `includeSessionRow` and
 * `includeManualRow` let ordered-list selectors show only actual models —
 * the session/manual rows are useful for single-value overrides but are
 * no-op rows in a multi-select list. Filtering belongs here rather than
 * only in the settings handler so every picker has one obvious boundary
 * and tests can pin it directly. */
export function buildModelPickItems(
  models: RegistryModelLike[],
  sessionLabel: string,
  opts: {
    excludeRefs?: readonly string[];
    /** Keep configured refs visible even when they are unavailable or
     * excluded by policy. The editor can then show why they will not run
     * instead of silently dropping them on confirm. */
    preserveRefs?: readonly string[];
    includeSessionRow?: boolean;
    includeManualRow?: boolean;
  } = {},
): ModelPickItem[] {
  // `excludeRefs` contains either canonical refs or policy entries such as
  // `sonnet`; use the same case-insensitive substring semantics as
  // `isForbiddenModel` so a raw setting hides every matching provider/id.
  const excluded = (opts.excludeRefs ?? [])
    .filter((ref): ref is string => typeof ref === "string")
    .map((ref) => ref.trim().toLowerCase())
    .filter(Boolean);
  const matchesExcluded = (ref: string): boolean => excluded.some((entry) => ref.toLowerCase().includes(entry));
  const preserved: string[] = [];
  const preservedSeen = new Set<string>();
  for (const candidate of opts.preserveRefs ?? []) {
    if (typeof candidate !== "string") continue;
    const ref = candidate.trim();
    const key = ref.toLowerCase();
    if (!ref || preservedSeen.has(key)) continue;
    preservedSeen.add(key);
    preserved.push(ref);
  }
  const sorted = models
    .filter((m) => {
      const ref = `${m.provider}/${m.id}`.toLowerCase();
      return !excluded.some((entry) => ref.includes(entry));
    })
    .sort((a, b) =>
      a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
    );
  const modelItems = sorted.map((m) => {
    const ref = `${m.provider}/${m.id}`;
    return {
      kind: "model" as const,
      ref,
      label: m.name && m.name !== m.id ? `${ref} — ${m.name}` : ref,
      searchText: `${ref} ${m.name ?? ""}`,
    };
  });
  const itemByKey = new Map(modelItems.map((item) => [item.ref!.toLowerCase(), item]));
  // Put the already configured chain first. This makes the persisted order
  // readable even before the user presses a key; the remaining registry
  // models follow in their stable provider/id order.
  const orderedModels: ModelPickItem[] = [];
  const added = new Set<string>();
  for (const configuredRef of preserved) {
    const key = configuredRef.toLowerCase();
    const available = itemByKey.get(key);
    if (available) {
      orderedModels.push(available);
      added.add(key);
      continue;
    }
    const blocked = matchesExcluded(configuredRef);
    orderedModels.push({
      kind: "model",
      ref: configuredRef,
      label: `${configuredRef} — ${blocked ? "blocked by policy" : "unavailable or unauthenticated"}`,
      searchText: `${configuredRef} ${blocked ? "blocked forbidden policy" : "unavailable unauthenticated"}`,
      disabledReason: blocked ? "blocked by policy" : "unavailable or unauthenticated",
    });
    added.add(key);
  }
  for (const item of modelItems) {
    if (!added.has(item.ref!.toLowerCase())) orderedModels.push(item);
  }
  return [
    ...(opts.includeSessionRow === false ? [] : [{
      kind: "session" as const,
      label: `session model (${sessionLabel}) — clear the override`,
      searchText: "session model default clear override follow",
    }]),
    ...orderedModels,
    ...(opts.includeManualRow === false ? [] : [{
      kind: "manual" as const,
      label: "type provider/model manually…",
      searchText: "manual type custom provider model id",
    }]),
  ];
}

export interface ModelPickerFactoryDeps {
  title: string;
  items: ModelPickItem[];
  /** Cap on visible list rows (window scrolls with the selection). */
  maxVisibleRows?: number;
}

export class ModelPickerComponent {
  private readonly title: string;
  private readonly items: ModelPickItem[];
  private readonly maxRows: number;
  private readonly requestRender: () => void;
  private readonly theme: SettingsMenuTheme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly done: (item: ModelPickItem | undefined) => void;

  private query = "";
  private selectedIdx = 0;

  constructor(
    deps: ModelPickerFactoryDeps,
    requestRender: () => void,
    theme: SettingsMenuTheme,
    keybindings: KeybindingsManagerLike,
    done: (item: ModelPickItem | undefined) => void,
  ) {
    this.title = deps.title;
    this.items = deps.items;
    this.maxRows = deps.maxVisibleRows ?? 12;
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  /** Current search query. Exposed for tests. */
  getQuery(): string {
    return this.query;
  }

  /** Index into the filtered list. Exposed for tests. */
  getSelectedIdx(): number {
    return this.selectedIdx;
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

  render(width: number): string[] {
    const w = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold(truncateToWidth(this.title, w, "…"))));
    lines.push("");
    const searchLine = `search: ${this.query}`;
    lines.push(this.theme.fg("muted", truncateToWidth(searchLine, w, "…") + "▏"));
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
        const row = truncateToWidth(it.label, w - 2, "…");
        if (idx === sel) {
          // Use the available horizontal space for a high-contrast active
          // state. Accent-only text was easy to miss in dark terminals and
          // left the selected model indistinguishable from its neighbours.
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
    lines.push(this.theme.fg("dim", "type to filter · ↑/↓ move · enter select · esc cancel"));
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const it = this.filteredItems()[this.selectedIdx];
      this.done(it);
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

// Re-export for callers that only need the width helper's type signature.
export { visibleWidth };
