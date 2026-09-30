import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

test("Node callers survive noisy early-closing filters and retain head failure/cancellation", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-pipeline-lifecycle-"));
  try {
    fs.writeFileSync(path.join(cwd, "noisy.cjs"), "process.stdout.write('x'.repeat(65536)); process.exitCode=Number(process.argv[2]||0);");
    const bin = path.join(cwd, "filter-bin");
    const marker = path.join(cwd, "filter-ready");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "head"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');process.stdin.resume();setInterval(()=>{},1000);`, { mode: 0o755 });
    const jiti = pathToFileURL(path.resolve("node_modules/jiti/lib/jiti.mjs")).href;
    const modulePath = path.resolve("extensions/goal-loop-shield.ts");
    const source = `import assert from 'node:assert/strict'; import fs from 'node:fs';
      import {createJiti} from ${JSON.stringify(jiti)};
      const {runMechanicalPreAuditChecks}=await createJiti(import.meta.url).import(${JSON.stringify(modulePath)});
      for(const filter of ['head -n 0','head -n 1','grep -q x']) {
        const result=await runMechanicalPreAuditChecks(${JSON.stringify(cwd)},['node noisy.cjs | '+filter],5000);
        assert.equal(result.passed,true);
      }
      const failed=await runMechanicalPreAuditChecks(${JSON.stringify(cwd)},['node noisy.cjs 9 | head -n 0'],5000);
      assert.equal(failed.passed,false); assert.equal(failed.exitCode,9);
      const controller=new AbortController(); controller.abort();
      const cancelled=await runMechanicalPreAuditChecks(${JSON.stringify(cwd)},['node noisy.cjs | head -n 0'],5000,controller.signal);
      assert.equal(cancelled.outcome,'inconclusive'); assert.equal(cancelled.inconclusiveReason,'aborted');
      process.env.PATH=${JSON.stringify(bin + path.delimiter)}+process.env.PATH;
      const activeController=new AbortController();
      const active=runMechanicalPreAuditChecks(${JSON.stringify(cwd)},['node noisy.cjs | head -n 0'],5000,activeController.signal);
      const deadline=Date.now()+10000;
      while(!fs.existsSync(${JSON.stringify(marker)})) {
        if(Date.now()>deadline) throw new Error('filter never started');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      activeController.abort();
      const activeCancelled=await active;
      assert.equal(activeCancelled.outcome,'inconclusive'); assert.equal(activeCancelled.inconclusiveReason,'aborted');
      console.log('verified noisy filter lifecycle');`;
    const child = spawn("node", ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`pipeline child timed out: ${output}`)); }, 45_000);
      child.once("error", error => { clearTimeout(deadline); reject(error); });
      child.once("close", value => { clearTimeout(deadline); resolve(value); });
    });
    assert.equal(code, 0, output);
    assert.match(output, /verified noisy filter lifecycle/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
