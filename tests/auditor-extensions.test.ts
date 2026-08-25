// pi-goal-list-loop-audit — v0.36.0
// tests/auditor-extensions.test.ts
//
// Behavioral pins for the auditor extension allowlist (GitHub issue:
// "Allow extension-based model providers in detached auditor sessions"):
//   • discovery mirrors what a normal pi session loads (settings packages/
//     extensions, user + project extension dirs)
//   • normalization is bounded, deduped, deterministic
//   • CLI arg expansion only emits --extension for non-empty lists
//   • the settings round-trip (menu handler → saveSettings → loadSettings)
//     persists auditorAllowedExtensions without loss
//   • the worker receives the allowlist through the hashed request and
//     appends --extension specs after the unchanged isolation flags

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

import {
  auditorExtensionArgs,
  discoverAuditorExtensions,
  normalizeAuditorAllowedExtensions,
  resolveAuditorAllowedExtensions,
  resolveAuditorExtensionSpec,
} from "../extensions/auditor-extensions.js";
import { globalSettingsPath, loadSettings, saveSettings } from "../extensions/goal-settings.js";
import { requestHash } from "../extensions/goal-loop-auditor-process.js";
import { handleSettingChoice } from "../extensions/loops/goal.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const GLOBAL_FILE = globalSettingsPath();
const ORIGINAL = fs.existsSync(GLOBAL_FILE) ? fs.readFileSync(GLOBAL_FILE, "utf-8") : null;
const ORIGINAL_ENV = process.env.GLLA_GLOBAL_SETTINGS_PATH;

function restoreGlobal(): void {
  delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
  if (ORIGINAL === null) {
    try { fs.unlinkSync(GLOBAL_FILE); } catch { /* didn't exist */ }
  } else {
    fs.writeFileSync(GLOBAL_FILE, ORIGINAL);
  }
}

test("normalizeAuditorAllowedExtensions is bounded, deduped, deterministic", () => {
  assert.deepEqual(normalizeAuditorAllowedExtensions(undefined), []);
  assert.deepEqual(normalizeAuditorAllowedExtensions("npm:foo"), []);
  assert.deepEqual(
    normalizeAuditorAllowedExtensions([" npm:foo ", "", "npm:foo", "npm:bar", 42, null]),
    ["npm:foo", "npm:bar"],
  );
  const many = Array.from({ length: 40 }, (_, i) => `npm:pkg-${i}`);
  assert.equal(normalizeAuditorAllowedExtensions(many).length, 32);
});

test("discovery resolves settings packages/extensions to concrete install paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glla-ext-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-ext-cwd-"));
  try {
    const agentDir = path.join(home, ".pi", "agent");
    // Installed user-scope packages: plain, scoped, and git sources.
    fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "pi-webaio"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "@scope", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "git", "github.com", "u", "r"), { recursive: true });
    // Relative extensions[] entry: resolved against the user agentDir (pi's
    // getBaseDirForScope base), NOT the auditor's future cwd.
    fs.mkdirSync(path.join(agentDir, "reldir"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "relext.ts"), "export default () => {};\n");
    fs.mkdirSync(path.join(agentDir, "extensions", "bundle-dir"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "extensions", "local.ts"), "export default () => {};\n");
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:pi-webaio", "npm:@scope/pkg@1.2.3", "git:github.com/u/r@v1", "npm:not-installed-here"],
        extensions: ["./relext.ts", "/opt/extra.ts"],
      }),
    );
    // Project-scope package install + relative entry against <cwd>/.pi.
    fs.mkdirSync(path.join(cwd, ".pi", "npm", "node_modules", "project-only"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi", "relext-project.ts"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:project-only"], extensions: ["./relext-project.ts"] }));

    const found = discoverAuditorExtensions(home, cwd);
    const specs = found.map((entry) => entry.spec);
    // packages spec → resolved install path (NOT the raw spec).
    assert.ok(specs.includes(path.join(agentDir, "npm", "node_modules", "pi-webaio")));
    assert.ok(specs.includes(path.join(agentDir, "npm", "node_modules", "@scope", "pkg")));
    assert.ok(specs.includes(path.join(agentDir, "git", "github.com", "u", "r")));
    assert.ok(specs.includes(path.join(cwd, ".pi", "npm", "node_modules", "project-only")));
    // Relative extensions[] entries resolved against the settings base dir.
    assert.ok(specs.includes(path.join(agentDir, "relext.ts")));
    assert.ok(specs.includes(path.join(cwd, ".pi", "relext-project.ts")));
    // Directory discovery still yields absolute paths.
    assert.ok(specs.some((spec) => spec.endsWith(path.join("extensions", "local.ts"))));
    assert.ok(specs.some((spec) => spec.endsWith(path.join("extensions", "bundle-dir"))));
    // A package that is NOT installed is skipped, not emitted as an
    // unloadable spec; an absolute path that does not exist is dropped too.
    assert.ok(!specs.some((spec) => spec.includes("not-installed-here")));
    assert.ok(!specs.includes("/opt/extra.ts"));
    // Every emitted spec is an existing absolute path.
    for (const spec of specs) assert.ok(path.isAbsolute(spec) && fs.existsSync(spec), `not loadable: ${spec}`);
    // Deduped by spec.
    assert.equal(specs.length, new Set(specs).size);
    const webaio = found.find((entry) => entry.spec.endsWith(path.join("node_modules", "pi-webaio")))!;
    assert.equal(webaio.source, "package");
    assert.equal(webaio.raw, "npm:pi-webaio");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveAuditorExtensionSpec maps npm/git/local specs to existing paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glla-ext-res-"));
  try {
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "pi-webaio"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "git", "github.com", "u", "r"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "relext.ts"), "export default () => {};\n");
    fs.writeFileSync(path.join(home, "x.ts"), "export default () => {};\n");
    const opts = { home };
    assert.equal(resolveAuditorExtensionSpec("npm:pi-webaio", opts), path.join(agentDir, "npm", "node_modules", "pi-webaio"));
    assert.equal(resolveAuditorExtensionSpec("npm:pi-webaio@^2.0.0", opts), path.join(agentDir, "npm", "node_modules", "pi-webaio"));
    // Version refs never leak into the install path.
    assert.equal(resolveAuditorExtensionSpec("git:github.com/u/r@v1", opts), path.join(agentDir, "git", "github.com", "u", "r"));
    assert.equal(resolveAuditorExtensionSpec("git:git@github.com:u/r.git", opts), path.join(agentDir, "git", "github.com", "u", "r"));
    assert.equal(resolveAuditorExtensionSpec("git:https://github.com/u/r#main", opts), path.join(agentDir, "git", "github.com", "u", "r"));
    // Relative path resolves against the settings base (agentDir), `~` expands.
    assert.equal(resolveAuditorExtensionSpec("./relext.ts", opts), path.join(agentDir, "relext.ts"));
    assert.equal(resolveAuditorExtensionSpec("~/x.ts", opts), path.join(home, "x.ts"));
    // Fail-closed: uninstalled packages / unknown schemes / missing paths.
    assert.equal(resolveAuditorExtensionSpec("npm:absent", opts), undefined);
    assert.equal(resolveAuditorExtensionSpec("weird:scheme", opts), undefined);
    assert.equal(resolveAuditorExtensionSpec("./missing.ts", opts), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveAuditorAllowedExtensions drops unresolvable entries fail-closed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glla-ext-allow-"));
  try {
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "pi-webaio"), { recursive: true });
    // Raw hand-edited specs AND already-resolved absolute paths both work;
    // duplicates collapse; unresolvable entries are skipped.
    assert.deepEqual(
      resolveAuditorAllowedExtensions(["npm:pi-webaio", path.join(agentDir, "npm", "node_modules", "pi-webaio"), "npm:absent", ""], home),
      [path.join(agentDir, "npm", "node_modules", "pi-webaio")],
    );
    assert.deepEqual(resolveAuditorAllowedExtensions(undefined, home), []);
    assert.deepEqual(resolveAuditorAllowedExtensions(["npm:absent"], home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request allowedExtensions rides the hashed payload with resolved paths", () => {
  const base = {
    protocolVersion: 1,
    attemptId: "a1",
    cwd: "/tmp/x",
    prompt: "p",
    model: "m",
    thinkingLevel: "high",
    createdAt: "2026-08-22T00:00:00.000Z",
    wallDeadlineAt: 1,
  };
  const withExts = { ...base, allowedExtensions: ["npm:pi-webaio"] };
  assert.notEqual(requestHash(base), requestHash(withExts));
  // Resolved paths (what dispatch actually sends) also hash distinctly.
  const withResolved = { ...base, allowedExtensions: ["/home/u/.pi/agent/npm/node_modules/pi-webaio"] };
  assert.notEqual(requestHash(base), requestHash(withResolved));
  assert.notEqual(requestHash(withExts), requestHash(withResolved));
});

test("auditorExtensionArgs only emits args for a non-empty allowlist", () => {
  assert.deepEqual(auditorExtensionArgs(undefined), []);
  assert.deepEqual(auditorExtensionArgs([]), []);
  assert.deepEqual(auditorExtensionArgs(["/resolved/path/one", "/resolved/path/two"]), [
    "--extension", "/resolved/path/one",
    "--extension", "/resolved/path/two",
  ]);
});

test("mandatory hermetic auditor-extension validation loads the resolved allowlist path", () => {
  // The release gate invokes the REAL pi with an isolated
  // PI_CODING_AGENT_DIR and PI_OFFLINE=1. The repository fixture registers a
  // provider without credentials, network, or a temporary package install.
  // Keep the default path mandatory: an absent optional live package must not
  // turn this boundary check into a passing skip.
  const env = { ...process.env };
  delete env.GLLA_LIVE_PI;
  delete env.GLLA_LIVE_EXT_PKG;
  const r = execFileSync(
    "timeout",
    ["120", process.execPath, path.join(repoRoot, "scripts", "verify-auditor-extensions-offline.mjs")],
    { env, encoding: "utf8" },
  );
  assert.match(r, /glla-auditor-fixture/);
  assert.match(r, /VERIFIED offline auditor extension loading/);
});

test("settings round-trip: menu pick persists, load normalizes, clear removes", async () => {
  let cwd = "";
  try {
    process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(os.tmpdir(), `glla-ext-settings-${process.pid}.json`);
    cwd = tmpCwd();
    // HERMETIC fixture (field: CI 2026-08-22): on a machine with no
    // ~/.pi/agent extensions the discovered list is empty and the handler
    // falls back to the input prompt — the TUI picker branch never runs.
    // Seed ONE project-scope extension so discovery is non-empty everywhere.
    fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
    const hermeticExt = path.join(cwd, ".pi", "extensions", "hermetic-ext.js");
    fs.writeFileSync(hermeticExt, "export default {};\n");
    const ctx = makeMockCtx(cwd);
    // TUI path: the mock invokes the custom factory and resolves the picker
    // result through customImpl.
    ctx.ui.customImpl = async () => [hermeticExt, "/opt/extra.ts"];
    await handleSettingChoice("auditorAllowedExtensions", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(ctx.cwd).auditorAllowedExtensions, [hermeticExt, "/opt/extra.ts"]);
    assert.ok(ctx.ui.matching("Auditor allowed extensions saved").length > 0);

    // Headless path: custom is a stub that never invokes the factory —
    // the comma-separated input fallback saves too.
    ctx.ui.customStubMode = true;
    ctx.ui.customImpl = async () => undefined;
    ctx.ui.inputImpl = async () => "npm:other";
    await handleSettingChoice("auditorAllowedExtensions", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(ctx.cwd).auditorAllowedExtensions, ["npm:other"]);

    // Saving an empty selection removes the key entirely (back to the
    // default extension-less auditor).
    ctx.ui.inputImpl = async () => "";
    await handleSettingChoice("auditorAllowedExtensions", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(ctx.cwd).auditorAllowedExtensions, []);
    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(), "utf-8"));
    assert.equal(raw.auditorAllowedExtensions, undefined);
  } finally {
    if (ORIGINAL_ENV === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = ORIGINAL_ENV;
    restoreGlobal();
  }
});

test("saveSettings writes the allowlist and hand-edited junk is normalized on load", () => {
  try {
    process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(os.tmpdir(), `glla-ext-settings2-${process.pid}.json`);
    const cwd = tmpCwd();
    saveSettings("global", cwd, { auditorAllowedExtensions: ["npm:pi-webaio"] });
    assert.deepEqual(loadSettings(cwd).auditorAllowedExtensions, ["npm:pi-webaio"]);
    // Hand-edited file with junk entries survives as a clean, deduped list.
    fs.writeFileSync(
      globalSettingsPath(),
      JSON.stringify({ auditorAllowedExtensions: ["", "npm:pi-webaio", "npm:bar", 5] }),
    );
    assert.deepEqual(loadSettings(cwd).auditorAllowedExtensions, ["npm:pi-webaio", "npm:bar"]);
  } finally {
    if (ORIGINAL_ENV === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = ORIGINAL_ENV;
    restoreGlobal();
  }
});
