import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createTestProcessRegistry, reapOwnedTestProcesses } from "../scripts/test-process-registry.mjs";

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

for (const scenario of ["normal", "signal"] as const) {
  test(`runner reaps a TERM-ignoring group descendant after ${scenario} leader exit`, { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
    const descendant = "process.on('SIGTERM',()=>{});console.log('DESCENDANT_PID='+process.pid);console.log('STUB_READY');setInterval(()=>{},1000);";
    let pid: number | undefined;
    try {
      const result = await runStub(`
        const {spawn}=require('node:child_process');
        process.on('SIGTERM',()=>process.exit(0));
        spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
        ${scenario === "normal" ? "setTimeout(()=>process.exit(0),500);" : "setInterval(()=>{},1000);"}
      `, scenario === "signal" ? "SIGTERM" : undefined);
      pid = Number(result.output.match(/DESCENDANT_PID=(\d+)/)?.[1]);
      assert.ok(pid > 1, result.output);
      assert.equal(result.code, scenario === "normal" ? 0 : 143);
      let executing = false;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        executing = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch {}
      assert.equal(executing, false, "the descendant stopped despite the leader already exiting");
    } finally {
      if (pid && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
}

for (const scenario of ["normal", "signal"] as const) {
  test(`runner reaps a registered detached worker and its TERM-ignoring descendant on ${scenario} exit`, { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
    const registry = pathToFileURL(path.resolve("scripts/test-process-registry.mjs")).href;
    const descendant = "process.on('SIGTERM',()=>{});console.log('OWNED_PID='+process.pid);console.log('STUB_READY');setInterval(()=>{},1000);";
    const workerSource = `const {spawn}=require('node:child_process');
      console.log('OWNED_PID='+process.pid);
      spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
      setInterval(()=>{},1000);`;
    const pids: number[] = [];
    try {
      const result = await runStub(`(async()=>{
        const {registerOwnedTestProcess}=await import(${JSON.stringify(registry)});
        const {spawn}=require('node:child_process');
        const worker=spawn(process.execPath,['-e',${JSON.stringify(workerSource)}],{detached:true,stdio:['ignore','pipe','inherit']});
        registerOwnedTestProcess(worker);
        worker.stdout.on('data',chunk=>{process.stdout.write(chunk);
          ${scenario === "normal" ? "if(String(chunk).includes('STUB_READY')) setTimeout(()=>process.exit(0),100);" : ""}
        });
        setInterval(()=>{},1000);
      })();`, scenario === "signal" ? "SIGTERM" : undefined);
      pids.push(...[...result.output.matchAll(/OWNED_PID=(\d+)/g)].map(match => Number(match[1])));
      assert.equal(pids.length, 2, result.output);
      assert.equal(result.code, scenario === "normal" ? 0 : 143, result.output);
      assert.match(result.output, /detached cleanup: .*owned groups; 0 unverified/);
      for (const pid of pids) {
        let executing = false;
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          executing = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
        } catch {}
        assert.equal(executing, false, `detached descendant ${pid} stopped`);
      }
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
}

test("registry refuses to signal a record naming a reused leader identity", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-registry-identity-"));
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const env = createTestProcessRegistry(dir);
    const pid = child.pid!;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    fs.writeFileSync(path.join(dir, "process-forged.json"), JSON.stringify({
      token: env.GLLA_TEST_PROCESS_TOKEN, leader: { pid, birth: "previous-generation" }, anchors: [{ pid, birth }],
    }));
    const result = await reapOwnedTestProcesses(env);
    assert.equal(result.unverified, 1);
    assert.equal(result.reaped, 0);
    assert.equal(child.kill(0), true, "the unrelated process survives the stale record");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.obligations`, { recursive: true, force: true });
  }
});

test('runner refuses a green suite after a swallowed registration write failure', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0, timeout: 30_000,
}, async () => {
  const registry = pathToFileURL(path.resolve('scripts/test-process-registry.mjs')).href;
  const result = await runStub(`(async()=>{
    const fs=require('node:fs');const {spawn}=require('node:child_process');
    const {registerOwnedTestProcess}=await import(${JSON.stringify(registry)});
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    await new Promise(r=>worker.once('spawn',r));
    fs.chmodSync(process.env.GLLA_TEST_PROCESS_REGISTRY,0o500);
    try{registerOwnedTestProcess(worker)}catch{}
    fs.chmodSync(process.env.GLLA_TEST_PROCESS_REGISTRY,0o700);
    worker.once('exit',()=>process.exit(0));
  })();`);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /unverified survivors\/records/);
  const retained = result.output.match(/cleanup evidence retained at (.+)/)?.[1];
  assert.ok(retained, result.output);
  fs.rmSync(retained, { recursive: true, force: true });
  fs.rmSync(`${retained}.obligations`, { recursive: true, force: true });
});
