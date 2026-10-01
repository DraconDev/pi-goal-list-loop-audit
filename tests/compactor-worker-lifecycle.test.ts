import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

function alive(pid: number): boolean {
  try {
    // A reparented zombie has stopped executing even before init reaps it.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

for (const scenario of ["SIGTERM", "timeout", "normal", "result-write-failure"] as const) {
  test(`compactor cleans its Pi tree on ${scenario}, including inherited pipes and TERM-ignoring children`, { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-compactor-lifecycle-"));
    let worker: ReturnType<typeof spawn> | undefined;
    let pids: number[] = [];
    try {
      const ready = path.join(cwd, "ready");
      const piPid = path.join(cwd, "pi-pid");
      const grandchildSource = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
      const piSource = `#!/usr/bin/env node
        const fs=require('node:fs'); const {spawn}=require('node:child_process');
        fs.writeFileSync(${JSON.stringify(piPid)},String(process.pid));
        spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:['ignore','inherit','inherit']});
        ${scenario === "timeout" ? "process.on('SIGTERM',()=>{});" : ""}
        ${scenario === "normal" || scenario === "result-write-failure" ? "process.stdout.write('useful brief');setTimeout(()=>process.exit(0),300);" : "setInterval(()=>{},1000);"}`;
      const pi = path.join(cwd, "pi");
      fs.writeFileSync(pi, piSource, { mode: 0o755 });
      fs.writeFileSync(path.join(cwd, "request.json"), JSON.stringify({ model: "stub/model", prompt: "brief", timeoutMs: scenario === "timeout" ? 1000 : 15_000 }));
      if (scenario === "result-write-failure") fs.mkdirSync(path.join(cwd, "result.json"));
      const bootstrap = path.join(cwd, "registration-window.mjs");
      if (scenario === "SIGTERM") fs.writeFileSync(bootstrap, `
        import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
        const read=fs.readFileSync;let held=false;
        fs.readFileSync=(file,...args)=>{
          if(!held && /^\\/proc\\/\\d+\\/stat$/.test(String(file))){
            held=true;const deadline=Date.now()+3000;
            while(!fs.existsSync(${JSON.stringify(ready)}) && Date.now()<deadline){}
            const settle=Date.now()+500;while(Date.now()<settle){}
          }
          return read(file,...args);
        };syncBuiltinESMExports();
      `);
      const args = scenario === "SIGTERM" ? ["--import", bootstrap] : [];
      worker = spawn("node", [...args, path.resolve("scripts/goal-compactor-worker.mjs"), "--job-dir", cwd], {
        env: { ...process.env, GLLA_PI_BINARY: pi }, stdio: "ignore",
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("compactor did not settle")), 20_000);
        worker!.once("error", error => { clearTimeout(timer); reject(error); });
        worker!.once("close", code => { clearTimeout(timer); resolve(code); });
      });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("Pi descendant did not become ready");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      pids = [Number(fs.readFileSync(piPid, "utf8")), Number(fs.readFileSync(ready, "utf8"))];
      if (scenario === "SIGTERM") worker.kill("SIGTERM");
      const code = await closed;
      assert.equal(code, scenario === "normal" ? 0 : 1);
      for (const pid of pids) assert.equal(alive(pid), false, `owned descendant ${pid} stopped`);
      if (scenario !== "result-write-failure") {
        const result = JSON.parse(fs.readFileSync(path.join(cwd, "result.json"), "utf8"));
        assert.equal(result.ok, scenario === "normal");
        if (scenario === "normal") assert.equal(result.brief, "useful brief");
      }
    } finally {
      if (worker?.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
