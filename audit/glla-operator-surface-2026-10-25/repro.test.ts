// pi-goal-list-loop-audit — audit 2026-10-25
// audit/glla-operator-surface-2026-10-25/repro.test.ts
//
// Reproducer for the `/glla` operator-surface audit. These tests assert the
// INTENDED contract and intentionally FAIL on the reviewed implementation
// (v0.39.52, ad1ea932a).
//
// Finding 1 — the "Version indicator" (`versionDisplay`) editor has no
//   settings row, so the interactive table offers no way to reach it while the
//   docs, the v0.39.49 changelog and the operator note all promise a row.
// Finding 2 — the postaudit sub-menu re-reads the LEGACY `reviewer` key, which
//   load-migration deletes on every read, so the editor always merges over the
//   DEFAULTS: a second edit silently discards the first one.
//
// Run from the repository root:
//   bun test --parallel=1 --max-concurrency=1 --timeout=120000 \
//     audit/glla-operator-surface-2026-10-25/repro.test.ts
//
// No model/provider requests are made. The postaudit tests drive the real
// editor through the exported handleSettingChoice() dispatch — the identical
// code path the interactive "Postaudit" row and `/glla postaudit` both reach.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildSettingsRows } from "../../extensions/settings-menu.js";
import { handleSettingChoice } from "../../extensions/loops/goal-settings-ui.js";
import { loadSettings, projectSettingsPath } from "../../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tmpCwd } from "../../tests/harness/mock-pi.js";

const pi = new MockPi();
const { default: activate } = await import("../../extensions/loops/goal.js");
activate(pi.api);

// ────────────────────────────────────────────────────────────────────
// Finding 1 — every settings editor must be reachable from a row
// ────────────────────────────────────────────────────────────────────

test("every settings editor is reachable from a row in the /glla settings table", () => {
  const src = fs.readFileSync("extensions/loops/goal-settings-ui.ts", "utf8");
  const body = src.slice(src.indexOf("export async function handleSettingChoice"));
  assert.ok(body.length > 1000, "the editor dispatcher anchors the sweep");
  const editorIds = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
  const rowIds = buildSettingsRows({} as never, {}).map((r) => r.id);
  // A settings editor the operator cannot reach is dead code dressed as a
  // feature: the headless list shows the value, the docs promise a row, and
  // only a hand-edited settings JSON can change it.
  const unreachable = editorIds.filter((id) => !rowIds.includes(id));
  assert.deepEqual(
    unreachable,
    [],
    `settings editors with no reachable row: ${unreachable.join(", ")} — an editor the operator cannot open is not a feature`,
  );
});

test("the documented 'Version indicator' row exists in the /glla settings table", () => {
  // docs/SETTINGS.md: "Set it with **Version indicator** in `/glla` settings."
  // CHANGELOG.md v0.39.49: "with a **Version indicator** row in `/glla` settings".
  const doc = fs.readFileSync("docs/SETTINGS.md", "utf8");
  assert.match(doc, /Set it with \*\*Version indicator\*\* in `\/glla` settings/, "the documented promise is still in the reference");
  const rows = buildSettingsRows({} as never, {});
  const row = rows.find((r) => r.id === "versionDisplay");
  assert.ok(row, "the settings table has a Version indicator row");
  assert.match(row.label, /version indicator/i, "the row is labelled the way the docs name it");
});

// ────────────────────────────────────────────────────────────────────
// Finding 2 — the postaudit editor must not discard earlier edits
// ────────────────────────────────────────────────────────────────────

interface Pick {
  title: string;
  options: string[];
}

test("the postaudit sub-menu shows the configuration the operator actually saved", async () => {
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd) as any;
  const seen: Pick[] = [];
  let step = 0;
  ctx.ui.selectImpl = async (title: string, options: string[]) => {
    seen.push({ title, options: [...options] });
    step += 1;
    if (step === 1) return options.find((o) => o.startsWith("Enabled"));
    if (step === 2) return options.find((o) => o.startsWith("Mode"));
    return options.find((o) => o === "Done");
  };

  await handleSettingChoice("postaudit", ctx);

  assert.ok(seen.length >= 2, "the sub-menu was shown at least twice");
  const afterToggle = seen[1]!.options.find((o) => o.startsWith("Enabled"));
  assert.match(
    afterToggle ?? "",
    /Enabled — OFF/,
    "after turning the post-completion audit OFF the menu must show it OFF, not the default ON",
  );
});

test("a postaudit edit must not discard the options an earlier edit saved", async () => {
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd) as any;
  let step = 0;
  ctx.ui.selectImpl = async (_title: string, options: string[]) => {
    step += 1;
    if (step === 1) return options.find((o) => o.startsWith("Enabled"));
    if (step === 2) return options.find((o) => o.startsWith("Mode"));
    return options.find((o) => o === "Done");
  };

  await handleSettingChoice("postaudit", ctx);

  const saved = loadSettings(cwd).postaudit as { enabled?: boolean; mode?: string } | undefined;
  assert.ok(saved, "the postaudit block was saved");
  assert.equal(saved.mode, "auto", "the Mode edit was applied");
  assert.equal(
    saved.enabled,
    false,
    "the earlier Enabled edit survived — a later edit must merge over the SAVED block, not over the defaults",
  );

  // The same claim on disk, read straight from the project settings file.
  const onDisk = JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8"));
  assert.equal(onDisk.postaudit?.enabled, false, "the saved block on disk keeps the earlier edit");
});
