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

for (const scenario of ['allowed', 'unknown-price', 'over-budget', 'unsupported-cap', 'oversized', 'second-request', 'receipt-write'] as const) {
  test(`generated canary uses actual Pi dispatcher and ${scenario} transport behavior`, { timeout: 30_000 }, async () => {
    const { buildCanaryExtensionSource } = await import('../scripts/canary-extension.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-canary-dispatch-'));
    try {
      const receipt = scenario === 'receipt-write' ? path.join(dir, 'absent', 'receipt.json') : path.join(dir, 'receipt.json');
      const hook = path.join(dir, 'hook.mjs');
      fs.writeFileSync(hook, buildCanaryExtensionSource({ maxUsd: 0.01, receipt, outcome: path.join(dir, 'outcome.json') }));
      const dispatcher = path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
      const source = path.join(dir, 'host.mjs');
      fs.writeFileSync(source, `
        import fs from 'node:fs';import {pathToFileURL} from 'node:url';
        const {ExtensionRunner}=await import(pathToFileURL(${JSON.stringify(dispatcher)}).href);
        const handlers=new Map();
        (await import(pathToFileURL(${JSON.stringify(hook)}).href)).default({on:(event,handler)=>handlers.set(event,[handler])});
        const model={cost:${scenario === 'unknown-price' ? 'undefined' : scenario === 'over-budget' ? '{input:100,output:100}' : '{input:0.01,output:0.01}'}};
        const runner={extensions:[{path:'glla-canary',handlers}],createContext:()=>({model}),emitError:e=>{throw new Error('guard failure escaped into swallowed hook path: '+e.error)}};
        const payload=${scenario === 'unsupported-cap' ? '{input:"test"}' : scenario === 'oversized' ? '{max_tokens:4096,input:"x".repeat(9000)}' : '{max_tokens:4096,tools:[{name:"complete_goal"}],tool_choice:"auto"}'};
        const transportFile=${JSON.stringify(path.join(dir, 'transport.jsonl'))};
        const transport=async()=>{
          const capped=await ExtensionRunner.prototype.emitBeforeProviderRequest.call(runner,payload);
          fs.appendFileSync(transportFile,JSON.stringify(capped)+'\\n');
        };
        await transport();
        ${scenario === 'second-request' ? 'await transport();' : ''}
      `);
      const result = spawnSync("node", [source], { encoding: 'utf8', timeout: 20_000 });
      const transportFile = path.join(dir, 'transport.jsonl');
      const calls = fs.existsSync(transportFile) ? fs.readFileSync(transportFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      assert.equal(result.status, scenario === 'allowed' ? 0 : 78, result.stderr);
      assert.equal(calls.length, scenario === 'allowed' || scenario === 'second-request' ? 1 : 0);
      if (calls.length) {
        assert.equal(calls[0].max_tokens, 32);
        assert.deepEqual(calls[0].tools, []);
        assert.equal(calls[0].tool_choice, undefined);
      }
      if (scenario !== 'receipt-write') {
        const recorded = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        assert.equal(recorded.attempts, scenario === 'second-request' ? 2 : 1);
        assert.equal(recorded.refused, scenario !== 'allowed');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
