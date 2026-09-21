// pi-goal-list-loop-audit — v0.38.76
// tests/auditor-challenge.test.ts
//
// Auditor challenge round: a round-1 approval earns one bounded
// falsification pass in a fresh worker-spawned session. These tests drive
// the REAL worker script with a prompt-branching fake pi binary:
// confirm preserves approval, a challenge disapproval flips the verdict
// (final-line rule), non-approvals run single-round, and a failed
// challenge falls back to byte-identical round-1 output (fail-open,
// recorded — never silent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { requestHash } from "../extensions/goal-loop-auditor-process.ts";

const WORKER = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
const AUDIT_OUTPUT = "<evidence>\nartifact exists; tests pass\n</evidence>\n<approved/>";
const CHALLENGE_CONFIRM = "Re-checked the artifact and the test run.\n<approved/>";
const CHALLENGE_FLIP = "The test run cited above never executed: no test output exists.\n<disapproved/>";

const FAKE_PI = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const line = input.slice(0, input.indexOf("\\n"));
  const prompt = JSON.parse(line).message;
  const isChallenge = prompt.includes("AUDITOR CHALLENGE ROUND");
  const mode = isChallenge ? (process.env.FAKE_CHALLENGE_MODE || "confirm") : "audit";
  if (mode === "crash") process.exit(3);
  if (!isChallenge && process.env.FAKE_ROUND1_CRASH === "yes") process.exit(3);
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = !isChallenge
    ? (process.env.FAKE_AUDIT_OUTPUT || "")
    : mode === "flip" ? ${JSON.stringify(CHALLENGE_FLIP)} : ${JSON.stringify(CHALLENGE_CONFIRM)};
  emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "x" } });
  emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
`;

type WorkerResult = { ok: boolean; output: string; challenge?: string; error?: string };

async function stopWorker(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
    } else {
      try { child.kill("SIGTERM"); } catch {}
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      } else {
        try { child.kill("SIGKILL"); } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function runWorker(env: NodeJS.ProcessEnv): Promise<{ result: WorkerResult; jobDir: string; cleanup: () => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glla-challenge-"));
  const jobDir = path.join(root, ".pi-glla", "audit-jobs", "attempt-challenge");
  fs.mkdirSync(jobDir, { recursive: true });
  const fakePi = path.join(root, "fake-pi.mjs");
  fs.writeFileSync(fakePi, FAKE_PI, { mode: 0o700 });
  const requestWithoutHash = {
    protocolVersion: 1,
    attemptId: "attempt-challenge",
    cwd: root,
    prompt: "Audit brief: verify the artifact. End with <approved/> or <disapproved/>.",
    model: "test/challenge-model",
    thinkingLevel: "off",
  };
  const request = { ...requestWithoutHash, requestHash: requestHash(requestWithoutHash) };
  fs.writeFileSync(path.join(jobDir, "request.json"), JSON.stringify(request));
  fs.writeFileSync(path.join(jobDir, "lock"), JSON.stringify({ protocolVersion: 1, attemptId: "attempt-challenge", pid: process.pid, role: "parent" }));
  const child = spawn(process.execPath, [WORKER, "--job-dir", jobDir], {
    env: { ...process.env, GLLA_PI_BINARY: fakePi, ...env },
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const resultPath = path.join(jobDir, "result.json");
  const deadline = Date.now() + 30_000;
  let result: WorkerResult | undefined;
  while (Date.now() < deadline) {
    try {
      result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as WorkerResult;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  await stopWorker(child);
  assert.ok(result, "worker published result.json");
  return {
    result: result!,
    jobDir,
    cleanup: async () => { await fs.promises.rm(root, { recursive: true, force: true }); },
  };
}

function finalLine(output: string): string {
  return output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
}

test("challenge: approval earns a falsification round; re-confirm preserves the verdict", async () => {
  const { result, cleanup } = await runWorker({ FAKE_AUDIT_OUTPUT: AUDIT_OUTPUT, FAKE_CHALLENGE_MODE: "confirm" });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.challenge, "confirmed");
    assert.ok(result.output.includes(AUDIT_OUTPUT), "round-1 report preserved verbatim");
    assert.ok(result.output.includes("--- auditor challenge round (falsification pass) ---"));
    assert.ok(result.output.includes(CHALLENGE_CONFIRM));
    assert.equal(finalLine(result.output), "<approved/>");
  } finally {
    await cleanup();
  }
});

test("challenge: a challenge disapproval flips the verdict by final line", async () => {
  const { result, cleanup } = await runWorker({ FAKE_AUDIT_OUTPUT: AUDIT_OUTPUT, FAKE_CHALLENGE_MODE: "flip" });
  try {
    assert.equal(result.ok, true, "the worker succeeded — the VERDICT flipped, not the run");
    assert.equal(result.challenge, "flipped");
    assert.ok(result.output.includes(AUDIT_OUTPUT), "round-1 evidence stays for the shield and forensics");
    assert.equal(finalLine(result.output), "<disapproved/>");
  } finally {
    await cleanup();
  }
});

test("challenge: round-1 disapprovals run single-round", async () => {
  const { result, cleanup } = await runWorker({ FAKE_AUDIT_OUTPUT: "Fix the gap.\n<disapproved/>", FAKE_CHALLENGE_MODE: "flip" });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.challenge, "not-applicable");
    assert.ok(!result.output.includes("challenge round"), "no second spawn for non-approvals");
    assert.equal(finalLine(result.output), "<disapproved/>");
  } finally {
    await cleanup();
  }
});

test("challenge: a failed challenge falls back to byte-identical round-1 output", async () => {
  const { result, cleanup } = await runWorker({ FAKE_AUDIT_OUTPUT: AUDIT_OUTPUT, FAKE_CHALLENGE_MODE: "crash" });
  try {
    assert.equal(result.ok, true, "fail-open to the round-1 approval");
    assert.match(result.challenge ?? "", /^skipped: /, "the skip is recorded, never silent");
    assert.equal(result.output, AUDIT_OUTPUT, "byte-identical fallback — no separator, no partial round-2 text");
  } finally {
    await cleanup();
  }
});

test("challenge: a failed round 1 still fails without challenging", async () => {
  const { result, cleanup } = await runWorker({ FAKE_AUDIT_OUTPUT: AUDIT_OUTPUT, FAKE_CHALLENGE_MODE: "confirm", FAKE_ROUND1_CRASH: "yes" });
  try {
    assert.equal(result.ok, false, "round-1 infrastructure failure keeps historical semantics");
    assert.equal(result.challenge, "not-applicable");
  } finally {
    await cleanup();
  }
});
