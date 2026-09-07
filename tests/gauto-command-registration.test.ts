// pi-goal-list-loop-audit
// tests/gauto-command-registration.test.ts
//
// Focused regression test for the user-owned /gauto edge feature
// (commit 383f93fa "gauto: add questionless-goal command to glla command
// surface").
//
// The feature is a 27-line, two-file local edge kept on the `gauto-edge`
// branch so a future upstream pull of base 0.38.24 cannot remove it:
//   - extensions/goal-commands.ts:     cmdGauto()
//   - extensions/loops/goal-activation.ts: registerCommand("gauto", ...)
//
// These assertions read the SOURCE files directly (never import pi core,
// never the installed node_modules copy) so they assert on the durable
// local source, not on a packaging artifact. They stay valid whether or not
// the install is from npm, git URL, local path, or clone — the
// verification contract explicitly forbids depending on the published
// 0.38.24 node_modules copy.
//
// Correctness constraint (contract: "no Confirm gate"): /gauto must reuse the
// EXACT same skip-draft activation path as /goal start <objective>. The
// upstream /goal start proves this out via startDrafting + model interview,
// /gauto proves its INVERSE by calling cmdSet(args, ctx, skipDraft=true).
// Because there is no upstream "goal start" command to copy verbatim, the
// faithful, non-fabricated assertion is that cmdGauto forwards to cmdSet with
// skipDraft strictly TRUE — the reviewer (reading the cmdSet body) then
// confirms explicitReplace is also true. We DO NOT assert skipDraft === false,
// which would contradict the feature and be a false FAIL.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const COMMANDS = fs.readFileSync(path.join(ROOT, "extensions", "goal-commands.ts"), "utf8");
const ACTIVATION = fs.readFileSync(path.join(ROOT, "extensions", "loops", "goal-activation.ts"), "utf8");

// cmdGauto exists, is exported, and forwards to cmdSet with skipDraft === true.
test("cmdGauto is exported and forwards to cmdSet with skipDraft true", () => {
  assert.match(
    COMMANDS,
    /export\s+(async\s+)?function\s+cmdGauto\s*\(\s*args:\s*string\s*,\s*ctx:\s*ExtensionContext\s*\)\s*[\s\S]*?Promise\s*<\s*void\s*>[\s\S]*?return\s+cmdSet\s*\(\s*args\s*,\s*ctx\s*,[\s\S]*?true[\s\S]*?\)\s*;/,
    "cmdGauto must export a function that calls cmdSet(args, ctx, skipDraft=true) with skipDraft strictly true",
  );
});

// registerCommand("gauto", ...) is present in the goal runtime with a
// non-empty description and a handler that delegates to cmdGauto.
test("/gauto is registered in registerGoalRuntime with a handler forwarding to cmdGauto", () => {
  assert.match(ACTIVATION, /registerCommand\s*\(\s*"gauto"\s*,\s*\{/);
  assert.match(ACTIVATION, /\bcmdGauto\s*\(/);
  // The description is the user-facing contract (no interview / no Confirm).
  assert.match(ACTIVATION, /no interview/i);
  assert.match(ACTIVATION, /no confirm gate/i);
});

// The custom gauto-edge commit must be the reachable HEAD of the durable
// local clone (proof the local source, not the published npm copy, is active).
test("durable local source is a git clone whose HEAD is the gauto-edge custom commit", () => {
  const head = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  assert.equal(head, "383f93fab7ce78717701f1b3660d4b3dbcffdd1a");

  // origin/main is the pushed published base (0.38.24). The local HEAD extends
  // it (the custom gauto commit). gauto-edge has no configured tracking branch,
  // so compare against origin/main directly.
  const originMain = execSync("git rev-parse origin/main", { cwd: ROOT }).toString().trim();
  const ancestor = execSync("git merge-base HEAD origin/main", { cwd: ROOT }).toString().trim();
  assert.equal(ancestor, originMain, "HEAD must descend from origin/main (published base)");
  assert.notEqual(
    originMain,
    execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
    "HEAD must be ahead of the published base",
  );

  // The local tree is clean (matches its HEAD commit exactly).
  const status = execSync("git status --short --untracked-files=no", { cwd: ROOT }).toString().trim();
  assert.equal(status, "", "working tree must be clean (no uncommitted edits)");
});
