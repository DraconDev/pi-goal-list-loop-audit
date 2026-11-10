/**
 * v0.39.x (field, 2026-11-10): the mechanical pre-audit gate DROPPED a leading
 * `cd <dir>` from a contract command and ran the remainder in the session's own
 * working directory.
 *
 * What happened: a goal whose work lived in a sibling checkout carried the
 * contract item `` `cd web/games && bun run build` exits 0 ``. The extractor
 * kept only allowlisted runner segments, so `cd web/games` vanished and
 * `bun run build` ran in the session directory, which has no `build` script.
 * The gate printed `error: Script not found "build"` and the deterministic
 * fast-fail disapproved a finished goal that two independent LLM audit rounds
 * had already approved. The defect is not "the gate is strict" — it is that the
 * gate ran something other than what the contract said.
 *
 * These tests pin the two halves that must stay true at once: the directory the
 * contract names is honoured (so a cross-repo contract works), and the gate is
 * not weakened into arbitrary shell (a `cd` is never executed; it only becomes
 * the child's cwd, and it must be an existing directory).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractMechanicalCheckCommands,
  extractMechanicalCheckSteps,
  runMechanicalPreAuditChecks,
} from "../extensions/goal-loop-shield.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `glla-cd-${prefix}-${process.pid}-`));
}

/** A throwaway project whose `probe` script records the directory it ran in. */
function makeProbeProject(root: string, name = "sub"): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const script = "node -e \"require('node:fs').writeFileSync('probe.txt','ok','utf8')\"";
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "probe", scripts: { probe: script } }, null, 2));
  return dir;
}

test("extraction keeps the directory a contract names", () => {
  const steps = extractMechanicalCheckSteps("`cd web/games && bun run build` exits 0");
  assert.deepEqual(steps, [{ command: "bun run build", cwd: "web/games" }]);
  // The command-only projection is unchanged, so existing callers and tests
  // keep their meaning.
  assert.deepEqual(extractMechanicalCheckCommands("`cd web/games && bun run build` exits 0"), ["bun run build"]);
});

test("extraction honours absolute directories and carries them forward", () => {
  assert.deepEqual(extractMechanicalCheckSteps("`cd /opt/checkout/web && bun test` passes"), [
    { command: "bun test", cwd: "/opt/checkout/web" },
  ]);
  // One directory for the rest of the fragment, in order.
  assert.deepEqual(extractMechanicalCheckSteps("`cd web && bun test a && bun test b`"), [
    { command: "bun test a", cwd: "web" },
    { command: "bun test b", cwd: "web" },
  ]);
  // A later cd replaces it.
  assert.deepEqual(extractMechanicalCheckSteps("`cd a && bun test x && cd b && bun test y`"), [
    { command: "bun test x", cwd: "a" },
    { command: "bun test y", cwd: "b" },
  ]);
});

test("extraction never turns a cd into a command, and rejects unsafe targets", () => {
  // Nothing extracted from a fragment that only changes directory.
  assert.deepEqual(extractMechanicalCheckSteps("`cd web/games`"), []);
  // A target a shell would interpret is not a directory: the step keeps the
  // caller's cwd rather than being silently redirected somewhere real.
  for (const target of ["$(pwd)", "`pwd`", "~/web", "-p", "web>x", "web|x", "web/ga*mes"]) {
    const steps = extractMechanicalCheckSteps(`\`cd ${target} && bun run build\``);
    assert.deepEqual(steps, [{ command: "bun run build" }], `unsafe cd target ${JSON.stringify(target)} must not become a cwd`);
  }
  // A trailing separator is just a separator: `cd web/games;` still names a
  // real directory, so it is honoured rather than treated as unsafe.
  assert.deepEqual(extractMechanicalCheckSteps("`cd web/games; && bun run build`"), [
    { command: "bun run build", cwd: "web/games" },
  ]);
});

test("the runner executes the step in the named directory", async () => {
  const root = tempDir("honour");
  const sub = makeProbeProject(root);
  try {
    const res = await runMechanicalPreAuditChecks(root, [{ command: "bun run probe", cwd: "sub" }], 60_000);
    assert.equal(res.passed, true, res.output);
    assert.equal(fs.existsSync(path.join(sub, "probe.txt")), true, "the script must have run inside sub/");
    assert.equal(fs.existsSync(path.join(root, "probe.txt")), false, "and must NOT have run in the caller's cwd");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the same command without the cd reproduces the field failure", async () => {
  // This is the exact class of failure the fix removes: the caller's directory
  // has no such script, so the gate fails for a directory nobody asked for.
  const root = tempDir("control");
  makeProbeProject(root);
  try {
    const res = await runMechanicalPreAuditChecks(root, ["bun run probe"], 60_000);
    assert.equal(res.passed, false);
    assert.match(res.output ?? "", /Script not found|not found/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing directory is a loud contract error, never a silent redirect", async () => {
  const root = tempDir("missing");
  try {
    const res = await runMechanicalPreAuditChecks(root, [{ command: "bun run probe", cwd: "no-such-dir" }], 60_000);
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, 126);
    assert.match(res.output ?? "", /names a working directory that does not exist/);
    assert.match(res.output ?? "", new RegExp(path.join("no-such-dir").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redirected evidence states where the command ran", async () => {
  const root = tempDir("note");
  const sub = makeProbeProject(root);
  try {
    const failing = await runMechanicalPreAuditChecks(
      root,
      [{ command: "node --definitely-not-a-real-option", cwd: "sub" }],
      60_000,
    );
    assert.equal(failing.passed, false);
    assert.match(failing.output ?? "", new RegExp(`\\[cwd: ${sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
    // A same-directory step keeps evidence free of noise.
    const local = await runMechanicalPreAuditChecks(root, ["node --definitely-not-a-real-option"], 60_000);
    assert.equal(local.passed, false);
    assert.doesNotMatch(local.output ?? "", /\[cwd: /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
