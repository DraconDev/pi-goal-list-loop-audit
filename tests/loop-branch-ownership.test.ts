// Active branch-mode loops must own every mutating Git boundary. A branch
// switch during an iteration must park the loop before add/commit/reset, and
// the finish path must not reset or check out from a foreign branch.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedLoop, seedState, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function boot(cwd: string): Promise<MockCtx> {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, {
    sessionManager: { name: `branch-owner-${Date.now()}-${Math.random()}` },
  });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

function realGitExec(cwd: string, calls: string[][]) {
  return (cmd: string, args: string[], opts: unknown) => {
    calls.push([cmd, ...args]);
    try {
      return {
        code: 0,
        stdout: execFileSync(cmd, args, {
          cwd: (opts as { cwd?: string })?.cwd ?? cwd,
          encoding: "utf8",
        }),
        stderr: "",
      };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(error) };
    }
  };
}

afterEach(() => {
  pi.execHandler = null;
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("active branch loop parks before commit when HEAD moved to the user's branch", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Audit Test");
  git(cwd, "config", "user.email", "audit@example.test");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "-m", "init");
  git(cwd, "checkout", "-b", "pi-glla-loop/test");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi-glla/\n");
  git(cwd, "add", ".gitignore");
  git(cwd, "commit", "-m", "ignore state");

  const branch = "pi-glla-loop/test";
  seedState(cwd, {
    loop: seedLoop({
      branchName: branch,
      originalBranch: "main",
      measureCmd: "echo 2",
      direction: "max",
      bestValue: 1,
      lastValue: 1,
      iteration: 1,
    }),
  });
  git(cwd, "checkout", "main");
  const calls: string[][] = [];
  pi.execHandler = realGitExec(cwd, calls);
  const ctx = await boot(cwd);
  try {
    await pi.fire("agent_end", {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "HYPOTHESIS: improve the metric" }],
        stopReason: "end_turn",
      }],
    }, ctx);

    const loop = readState(cwd).loop as { active: boolean; stopReason?: string; iteration: number };
    assert.equal(loop.active, false, "loop parks when branch ownership is lost");
    assert.match(loop.stopReason ?? "", /^branch changed — expected pi-glla-loop\/test, current main/);
    assert.equal(loop.iteration, 2, "the measured iteration remains durable");
    assert.ok(ledgerTypes(cwd).includes("loop_git_branch_changed"));
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "add"), "no staging on the user's branch");
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "commit"), "no commit on the user's branch");
    assert.equal(git(cwd, "branch", "--show-current"), "main", "HEAD is not repaired or moved by the guard");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("terminal commit failure preserves the uncommitted iteration and skips destructive finish", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Audit Test");
  git(cwd, "config", "user.email", "audit@example.test");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "-m", "init");
  const branch = "pi-glla-loop/commit-fail";
  git(cwd, "checkout", "-b", branch);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi-glla/\n");
  git(cwd, "add", ".gitignore");
  git(cwd, "commit", "-m", "ignore state");
  seedState(cwd, {
    loop: seedLoop({ branchName: branch, originalBranch: "main", measureCmd: "echo 2", direction: "max", bestValue: 2, lastValue: 2, iteration: 1, maxIterations: 1 }),
  });
  await pi.fire("session_start", { reason: "reload" }, makeMockCtx(cwd, { sessionManager: { name: "terminal-writer" } }));
  fs.writeFileSync(path.join(cwd, "terminal.txt"), "must survive\n");
  await pi.fire("session_shutdown", { reason: "test-reset" }, makeMockCtx(cwd, { sessionManager: { name: "terminal-writer" } }));
  const calls: string[][] = [];
  pi.execHandler = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "commit") return { code: 1, stdout: "", stderr: "injected commit failure" };
    return realGitExec(cwd, calls)(cmd, args, opts);
  };
  const ctx = await boot(cwd);
  try {
    await pi.fire("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "HYPOTHESIS: final" }], stopReason: "end_turn" }],
    }, ctx);
    const loop = readState(cwd).loop as { active: boolean; stopReason?: string };
    assert.equal(loop.active, false);
    assert.match(loop.stopReason ?? "", /git terminal commit failed/i);
    assert.equal(fs.readFileSync(path.join(cwd, "terminal.txt"), "utf8"), "must survive\n");
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "reset"), "no destructive reset after commit failure");
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "checkout"), "no checkout after commit failure");
    assert.equal(git(cwd, "branch", "--show-current"), branch);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("reset failure during finish keeps the terminal branch and never attempts checkout", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Audit Test");
  git(cwd, "config", "user.email", "audit@example.test");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "-m", "init");
  const branch = "pi-glla-loop/reset-fail";
  git(cwd, "checkout", "-b", branch);
  seedState(cwd, { loop: seedLoop({ branchName: branch, originalBranch: "main" }) });
  const calls: string[][] = [];
  pi.execHandler = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "reset") return { code: 1, stdout: "", stderr: "injected reset failure" };
    return realGitExec(cwd, calls)(cmd, args, opts);
  };
  const ctx = await boot(cwd);
  try {
    await pi.command("loop", "stop", ctx);
    const loop = readState(cwd).loop as { active: boolean; stopReason?: string };
    assert.equal(loop.active, false);
    assert.match(loop.stopReason ?? "", /git reset failed/i);
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "checkout"));
    assert.equal(git(cwd, "branch", "--show-current"), branch);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("/loop stop on a branch-mode loop parked on a foreign branch attempts no reset or checkout", async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Audit Test");
  git(cwd, "config", "user.email", "audit@example.test");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "-m", "init");
  const branch = "pi-glla-loop/stop-guard";
  git(cwd, "checkout", "-b", branch);

  seedState(cwd, {
    loop: seedLoop({ branchName: branch, originalBranch: "main" }),
  });
  git(cwd, "checkout", "main");
  const calls: string[][] = [];
  pi.execHandler = realGitExec(cwd, calls);
  const ctx = await boot(cwd);
  try {
    await pi.command("loop", "stop", ctx);
    const loop = readState(cwd).loop as { active: boolean; stopReason?: string };
    assert.equal(loop.active, false);
    assert.match(loop.stopReason ?? "", /^branch changed/);
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "reset"), "finish performs no reset on foreign HEAD");
    assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "checkout"), "finish performs no checkout on foreign HEAD");
    assert.equal(git(cwd, "branch", "--show-current"), "main");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
