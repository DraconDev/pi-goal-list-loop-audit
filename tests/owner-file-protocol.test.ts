import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { publishOwnerRecord, withOwnerMutation } from "../extensions/owner-file-protocol.js";

const load = `import fs from 'node:fs'; import {createJiti} from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/jiti/lib/jiti.mjs")).href)};
  const {withOwnerMutation,publishOwnerRecord}=await createJiti(import.meta.url).import(${JSON.stringify(path.resolve("extensions/owner-file-protocol.ts"))});`;

function launch(source: string) {
  const child = spawn("node", ["--input-type=module", "-e", `${load}\n${source}`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(output || "owner contender timed out")); }, 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve(code); });
  });
  return { child, done, output: () => output };
}

test("competing Node processes serialize owner mutations and publish only complete records", { timeout: 30_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-owner-contention-"));
  const file = path.join(cwd, "owner.json");
  const workers: ReturnType<typeof launch>[] = [];
  try {
    publishOwnerRecord(file, { count: 0 });
    for (let i = 0; i < 6; i++) workers.push(launch(`
      const file=${JSON.stringify(file)};
      for(let i=0;i<15;i++) {
        const result=withOwnerMutation(file,()=>{
          const sentinel=file+'.critical'; const fd=fs.openSync(sentinel,'wx');
          try {
            const current=JSON.parse(fs.readFileSync(file,'utf8'));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
            publishOwnerRecord(file,{count:current.count+1});
            return true;
          } finally {fs.closeSync(fd);fs.unlinkSync(sentinel);}
        },10000);
        if(!result) throw new Error('mutation refused');
      }`));
    const codes = await Promise.all(workers.map(worker => worker.done));
    codes.forEach((code, i) => assert.equal(code, 0, workers[i]!.output()));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).count, 90);
    assert.equal(fs.readdirSync(`${file}.mutations`).filter(name => name.endsWith(".json")).length, 0);
  } finally {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a live mutation times out contenders; SIGKILL recovery never removes a successor lock", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-owner-dead-"));
  const file = path.join(cwd, "owner.json");
  const ready = path.join(cwd, "ready");
  const holder = launch(`withOwnerMutation(${JSON.stringify(file)},()=>{
    fs.writeFileSync(${JSON.stringify(ready)},'ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
  });`);
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error(holder.output() || "holder did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let entered = false;
    assert.equal(withOwnerMutation(file, () => { entered = true; }, 40), undefined);
    assert.equal(entered, false, "a contender never expires a live ticket");
    holder.child.kill("SIGKILL");
    await holder.done;
    assert.equal(withOwnerMutation(file, () => {
      publishOwnerRecord(file, { successor: true }); return true;
    }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { successor: true });
    assert.equal(withOwnerMutation(file, () => true), true, "the dead participant does not poison later acquisition");
  } finally {
    if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill("SIGKILL");
    await holder.done;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
