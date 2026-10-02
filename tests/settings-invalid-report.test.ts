import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  __testOnlyResetInvalidSettingReports,
  drainInvalidSettingReports,
  loadSettings,
  normalizeLoadedSettings,
  projectSettingsPath,
  type Settings,
} from "../extensions/goal-settings.js";
import { tmpCwd } from "./harness/mock-pi.js";

test("C10: dropped junk values report once per distinct value; undefined defaults stay silent", () => {
  __testOnlyResetInvalidSettingReports();
  normalizeLoadedSettings({ tokenLimit: "lots", auditCap: -5 } as unknown as Settings);
  const first = drainInvalidSettingReports();
  assert.deepEqual(
    first.map((r) => [r.key, r.raw]).sort(),
    [["auditCap", "-5"], ["tokenLimit", '"lots"']].sort(),
  );
  // Same junk again: deduped, no per-load spam.
  normalizeLoadedSettings({ tokenLimit: "lots" } as unknown as Settings);
  assert.deepEqual(drainInvalidSettingReports(), []);
  // New junk value for the same key: re-reported.
  normalizeLoadedSettings({ tokenLimit: "plenty" } as unknown as Settings);
  assert.deepEqual(drainInvalidSettingReports(), [{ key: "tokenLimit", raw: '"plenty"' }]);
  // Explicit-undefined defaults delete as a matter of course — not junk.
  normalizeLoadedSettings({ drafterThinkingLevel: undefined, auditorMirrorSessionExtensions: undefined } as unknown as Settings);
  assert.deepEqual(drainInvalidSettingReports(), []);
  __testOnlyResetInvalidSettingReports();
});

test("C10: loadSettings ledgers dead hand-edited values as settings_invalid_ignored", () => {
  __testOnlyResetInvalidSettingReports();
  const cwd = tmpCwd();
  fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
  fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ tokenLimit: "lots" }));
  try {
    const effective = loadSettings(cwd);
    assert.equal(effective.tokenLimit, undefined, "junk still normalizes away");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.match(ledger, /"settings_invalid_ignored"/);
    assert.match(ledger, /"key":"tokenLimit"/);
    // Second load: throttled, no duplicate line.
    loadSettings(cwd);
    const ledger2 = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
    assert.equal(ledger2.split("\n").filter((line) => line.includes("settings_invalid_ignored")).length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    __testOnlyResetInvalidSettingReports();
  }
});
