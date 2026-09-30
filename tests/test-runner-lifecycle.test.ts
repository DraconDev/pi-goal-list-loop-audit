import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

async function runStub(source: string, signal?: NodeJS.Signals): Promise<{ code: number | null; output: string }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-runner-lifecycle-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    fs.writeFileSync(path.join(cwd, "bun"), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
    child = spawn("node", [path.resolve("scripts/run-tests.mjs"), "--all"], {
      env: { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH}`, GLLA_TEST_RUNNER_QUIET: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let signalled = false;
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
      output += chunk.toString();
      if (signal && !signalled && output.includes("STUB_READY")) {
        signalled = true;
        child!.kill(signal);
      }
    });
    return await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { child!.kill("SIGKILL"); reject(new Error(`runner observation timed out: ${output}`)); }, 20_000);
      child!.once("error", error => { clearTimeout(deadline); reject(error); });
      child!.once("close", code => { clearTimeout(deadline); resolve({ code, output }); });
    });
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("runner propagates failing exit even when both pipes close before the child exits", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const result = await runStub("process.stdout.end(); process.stderr.end(); setTimeout(() => process.exit(7), 300);");
  assert.equal(result.code, 7);
  assert.match(result.output, /finished.*exit 7/);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`runner fails on ${signal} even when its child cooperatively exits zero`, { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const result = await runStub("process.on('SIGTERM', () => process.exit(0)); console.log('STUB_READY'); setInterval(() => {}, 1000);", signal);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
  });
}

test("runner escalates a child that ignores TERM and still reports interruption", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const result = await runStub("process.on('SIGTERM', () => {}); console.log('STUB_READY'); setInterval(() => {}, 1000);", "SIGTERM");
  assert.equal(result.code, 143);
});
