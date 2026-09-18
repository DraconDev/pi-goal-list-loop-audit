// pi-goal-list-loop-audit — v0.38.65
// tests/auditor-session-mirror.test.ts
//
// Field 151158: the session-inherited auditor ref agnes/agnes-3.0-flash
// resolves in the MAIN session (pi-agnes-tools is a session package) but
// the detached worker spawns with auditorAllowedExtensions=[] (fully
// isolated), so every attempt exits "Model not found" and the identical
// park jams the list head. Verdict: CODE fix — the worker must mirror the
// session's packages for provider parity by default, with an opt-out that
// restores today's full isolation. Pins:
//   • sessionMirrorExtensionSpecs returns raw user+project package specs
//   • GLLA itself is never mirrored (by package name and by resolved path)
//   • mergeAuditorAllowedExtensions unions user allowlist + mirror (user first)
//   • mirror disabled (false) yields the user allowlist alone
//   • unresolvable mirror entries still drop fail-closed at resolve time

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  mergeAuditorAllowedExtensions,
  resolveAuditorAllowedExtensions,
  sessionMirrorExtensionSpecs,
} from "../extensions/auditor-extensions.js";
import { globalSettingsPath, loadSettings, saveSettings } from "../extensions/goal-settings.js";
import { handleSettingChoice } from "../extensions/loops/goal.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ORIGINAL_ENV = process.env.GLLA_GLOBAL_SETTINGS_PATH;

function fakeHome(packages: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mirror-home-"));
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages }));
  return home;
}

test("sessionMirrorExtensionSpecs returns raw user settings package specs", () => {
  const home = fakeHome(["npm:pi-agnes-tools", "../../Dev/pi-plugins/pi-agnes-tools"]);
  const specs = sessionMirrorExtensionSpecs(home);
  assert.deepEqual(specs, ["npm:pi-agnes-tools", "../../Dev/pi-plugins/pi-agnes-tools"]);
});

test("sessionMirrorExtensionSpecs appends project settings specs, deduped", () => {
  const home = fakeHome(["npm:pi-agnes-tools"]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mirror-cwd-"));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ packages: ["npm:pi-agnes-tools", "npm:project-pkg"] }),
  );
  const specs = sessionMirrorExtensionSpecs(home, cwd);
  assert.deepEqual(specs, ["npm:pi-agnes-tools", "npm:project-pkg"]);
});

test("sessionMirrorExtensionSpecs never mirrors GLLA itself", () => {
  const home = fakeHome([
    "npm:pi-agnes-tools",
    "npm:pi-goal-list-loop-audit",
    "../../Dev/pi-plugins/pi-goal-list-loop-audit",
  ]);
  const specs = sessionMirrorExtensionSpecs(home);
  assert.deepEqual(specs, ["npm:pi-agnes-tools"]);
});

test("mergeAuditorAllowedExtensions unions user allowlist first, then mirror", () => {
  const merged = mergeAuditorAllowedExtensions(
    ["npm:pi-webaio", "npm:pi-agnes-tools"],
    ["npm:pi-agnes-tools", "npm:pi-notify-agent"],
    true,
  );
  assert.deepEqual(merged, ["npm:pi-webaio", "npm:pi-agnes-tools", "npm:pi-notify-agent"]);
});

test("mergeAuditorAllowedExtensions with mirror off keeps the user allowlist alone", () => {
  const merged = mergeAuditorAllowedExtensions(
    ["npm:pi-webaio"],
    ["npm:pi-agnes-tools"],
    false,
  );
  assert.deepEqual(merged, ["npm:pi-webaio"]);
});

test("mergeAuditorAllowedExtensions with mirror on and empty user list yields the mirror", () => {
  const merged = mergeAuditorAllowedExtensions([], ["npm:pi-agnes-tools"], true);
  assert.deepEqual(merged, ["npm:pi-agnes-tools"]);
});

test("unresolvable mirror entries still drop fail-closed at resolve time", () => {
  const home = fakeHome([]);
  const resolved = resolveAuditorAllowedExtensions(
    ["../../definitely/not/here-pkg", "npm:also-not-installed-xyz"],
    home,
  );
  assert.deepEqual(resolved, []);
});

test("settings round-trip: mirror opt-out persists, on clears, junk normalizes", async () => {
  const cwd = tmpCwd();
  try {
    process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(os.tmpdir(), `glla-mirror-settings-${process.pid}.json`);
    const ctx = makeMockCtx(cwd);
    ctx.ui.selectImpl = async (_title, options) =>
      options.find((option) => option.startsWith("off")) ?? options[0];
    await handleSettingChoice("auditorMirrorSessionExtensions", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(ctx.cwd).auditorMirrorSessionExtensions, false);
    ctx.ui.selectImpl = async (_title, options) =>
      options.find((option) => option.startsWith("on")) ?? options[0];
    await handleSettingChoice("auditorMirrorSessionExtensions", ctx as unknown as ExtensionContext);
    assert.equal(loadSettings(ctx.cwd).auditorMirrorSessionExtensions, undefined);
    // Hand-edited junk falls back to on (absent).
    saveSettings("global", cwd, { auditorMirrorSessionExtensions: "yes" as unknown as boolean });
    assert.equal(loadSettings(cwd).auditorMirrorSessionExtensions, undefined);
  } finally {
    if (ORIGINAL_ENV === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = ORIGINAL_ENV;
  }
});
