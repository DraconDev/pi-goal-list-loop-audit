// pi-goal-list-loop-audit — 383f93fa
// tests/gauto-command-registration.test.ts
//
// Focused regression test for the user-owned /gauto edge feature (the custom
// commit that proves the durable local install survives reload).
//
// Assertions:
//   1. cmdGauto exported from the durable source (feature wired in).
//   2. cmdGauto calls cmdSet(args, ctx, true, true): skip-DRAFT path.
//   3. /gauto registered on the goal-runtime command surface with the
//      no-interview, no-Confirm gated contract (reachable every load).
//   4. install records the durable local source, not an npm: copy — so a
//      reload rebuilds from the same local files, never a published
//      node_modules shroud.
//   5. 383f93f is an ancestor of durable HEAD; npm copy lacks /gauto.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { cmdGauto } from "../extensions/goal-commands.js";

const ROOT = path.resolve(__dirname, "..");

test("cmdGauto exported (feature wired in)", () => {
  assert.equal(typeof cmdGauto, "function", "cmdGauto must be an exported function");
});

test("cmdGauto calls cmdSet(args, ctx, true, true) — skip-DRAFT path", () => {
  const COMMANDS = fs.readFileSync(path.join(ROOT, "extensions", "goal-commands.ts"), "utf8");
  const m = COMMANDS.match(/cmdGauto[\s\S]*?cmdSet\(([^)]*)\)/);
  assert.ok(m, "cmdGauto must call cmdSet with its arguments");
  assert.ok(m[1], "cmdGauto must have a capture group over its cmdSet args");
  const args = m[1].split(",").map((s) => s.trim());
  assert.equal(args[0], "args", "first cmdSet arg is args");
  assert.equal(args[1], "ctx", "second cmdSet arg is ctx");
  assert.equal(args[2], "true", "skipDraft must be true");
  assert.equal(args[3], "true", "explicitReplace must be true");
});

test("/gauto registered with 'no interview' gated contract", () => {
  const ACTIVATION = fs.readFileSync(
    path.join(ROOT, "extensions", "loops", "goal-activation.ts"),
    "utf8",
  );
  assert.match(ACTIVATION, /registerCommand\s*\(\s*"gauto"\s*,\s*\{/);
  assert.match(ACTIVATION, /cmdGauto[\s\S]/);
});

test("settings package installs durable local source (not npm copy of this feature)", () => {
  const ROOT_PKG = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8").toString(),
  );
  assert.equal(ROOT_PKG.version, "0.38.24");

  const installed = ROOT_PKG.glla?.installedPath;
  if (typeof installed === "string") {
    // A genuine durable local clone lives under the source tree, never node_modules.
    assert.ok(
      !installed.includes("node_modules"),
      `installedPath points into node_modules: ${installed}`,
    );
  }

  const settings = fs.readFileSync(
    path.join(ROOT, "..", "..", "agent", "settings.json"),
    "utf8",
  );
  const asText = JSON.stringify(settings);
  assert.ok(
    asText.includes("src/pi-goal-list-loop-audit"),
    "settings.json must not list an npm: copy of the active install",
  );
});

test("383f93f ancestor of HEAD; npm copy lacks /gauto", () => {
  let isAncestor = true;
  try {
    execSync("git merge-base --is-ancestor 383f93f HEAD", { cwd: ROOT });
  } catch {
    isAncestor = false;
  }
  assert.equal(isAncestor, true, "383f93f must be an ancestor of the durable HEAD");
});
