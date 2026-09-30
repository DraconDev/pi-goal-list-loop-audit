import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

test("real-host canary reports an explicit skip without opt-in or spawning Pi", () => {
  const result = spawnSync("node", ["scripts/real-host-canary.mjs"], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, GLLA_RUN_REAL_CANARY: "0", GLLA_PI_BINARY: "not-a-real-binary" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "skipped");
});

test("opt-in canary installs its request guard and records bounded host evidence (stub host)", { skip: process.platform === "win32", timeout: 30_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-canary-stub-"));
  try {
    const binary = path.join(dir, "pi.mjs");
    fs.writeFileSync(binary, `#!/usr/bin/env node
      import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url';
      if(process.argv.includes('--version')) { console.log('stub-host-1'); process.exit(0); }
      const extensionPaths=process.argv.flatMap((arg,i)=>arg==='-e'?[process.argv[i+1]]:[]);
      assert.ok(extensionPaths.some(file=>file.endsWith('extensions/loops/goal.ts')));
      assert.ok(process.argv.includes('--no-tools')&&process.argv.includes('--no-session'));
      const handlers=new Map(); const hook=extensionPaths.find(file=>file.endsWith('canary-budget-extension.mjs'));
      (await import(pathToFileURL(hook).href)).default({on:(event,handler)=>handlers.set(event,handler)});
      const model={provider:'stub',id:'bounded',cost:{input:1,output:2}};
      const payload=handlers.get('before_provider_request')({payload:{max_tokens:4096,tools:[{name:'complete_goal'}]}},{model});
      assert.equal(payload.max_tokens,32);assert.deepEqual(payload.tools,[]);
      handlers.get('agent_end')({messages:[{role:'assistant',content:[{type:'text',text:'GLLA_CANARY_OK'}],usage:{input:10,output:4},stopReason:'stop'}]});
      console.log('GLLA_CANARY_OK');`, { mode: 0o755 });
    const result = spawnSync("node", ["scripts/real-host-canary.mjs"], { encoding: "utf8", timeout: 20_000,
      env: { ...process.env, GLLA_RUN_REAL_CANARY: "1", GLLA_CANARY_MODEL: "stub/bounded", GLLA_PI_BINARY: binary } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "passed");
    assert.equal(report.piVersion, "stub-host-1");
    assert.equal(report.request.requests, 1);
    assert.equal(report.request.maxOutputTokens, 32);
    assert.equal(report.outcome.matched, true);
    assert.match(report.scope, /not a completion-audit/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
