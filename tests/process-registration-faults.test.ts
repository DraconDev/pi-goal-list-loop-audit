import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

for (const scenario of ['first-write', 'rename', 'owner-loss', 'refresh', 'primary-loss', 'obligation-write', 'obligation-owner-loss', 'initial-owner-loss', 'stat-denied', 'stat-malformed', 'stat-missing'] as const) {
  test(`process registration ${scenario} failure is visible and stops the owned child`, {
    skip: process.platform !== 'linux' || process.getuid?.() === 0, timeout: 30_000,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-registry-fault-'));
    const source = path.join(dir, 'fixture.mjs');
    const registry = pathToFileURL(path.resolve('scripts/test-process-registry.mjs')).href;
    fs.writeFileSync(source, `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      import {spawn} from 'node:child_process'; import {once} from 'node:events';
      import {createTestProcessRegistry,registerOwnedTestProcess,reapOwnedTestProcesses} from ${JSON.stringify(registry)};
      const dir=${JSON.stringify(dir)};
      const env=createTestProcessRegistry(dir);
      const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      await Promise.all([once(owned,'spawn'),once(foreign,'spawn')]);
      const oldRename=fs.renameSync, oldRead=fs.readFileSync;
      let refused=false;
      owned.on('error',()=>{refused=true});
      try {
        if (${JSON.stringify(scenario)}==='initial-owner-loss') fs.unlinkSync(dir+'/owner.json');
        if (${JSON.stringify(scenario)}==='first-write') fs.chmodSync(dir,0o500);
        if (${JSON.stringify(scenario)}==='obligation-write') fs.chmodSync(dir+'.obligations',0o500);
        if (${JSON.stringify(scenario)}==='rename') {
          fs.renameSync=(from,to)=>{if(to.startsWith(dir+'/process-')) throw new Error('injected rename refusal');return oldRename(from,to)};
          syncBuiltinESMExports();
        }
        if (['stat-denied','stat-malformed','stat-missing'].includes(${JSON.stringify(scenario)})) {
          fs.readFileSync=(file,...args)=>{
            if(String(file)==='/proc/'+owned.pid+'/stat') {
              if(${JSON.stringify(scenario)}==='stat-malformed')return 'malformed stat';
              throw Object.assign(new Error('injected identity refusal'),{code:${JSON.stringify(scenario)}==='stat-denied'?'EACCES':'ENOENT'});
            }
            return oldRead(file,...args);
          };syncBuiltinESMExports();
        }
        try {registerOwnedTestProcess(owned,env)} catch {refused=true}
        fs.readFileSync=oldRead;syncBuiltinESMExports();
        if (${JSON.stringify(scenario)}==='owner-loss') fs.unlinkSync(dir+'/owner.json');
        if (${JSON.stringify(scenario)}==='obligation-owner-loss') fs.unlinkSync(dir+'.obligations/owner.json');
        if (${JSON.stringify(scenario)}==='primary-loss') for(const file of fs.readdirSync(dir).filter(f=>f.startsWith('process-'))) fs.unlinkSync(dir+'/'+file);
        if (${JSON.stringify(scenario)}==='refresh') fs.chmodSync(dir,0o500);
        if (['owner-loss','refresh'].includes(${JSON.stringify(scenario)})) await new Promise(r=>setTimeout(r,800));
        fs.chmodSync(dir,0o700);fs.chmodSync(dir+'.obligations',0o700);fs.renameSync=oldRename;fs.readFileSync=oldRead;syncBuiltinESMExports();
        const cleanup=await reapOwnedTestProcesses(env,{graceMs:10});
        if(owned.exitCode===null&&owned.signalCode===null) await once(owned,'exit');
        console.log(JSON.stringify({refused,cleanup,ownedStopped:owned.exitCode!==null||owned.signalCode!==null,foreignLive:foreign.kill(0)}));
      } finally {
        fs.chmodSync(dir,0o700);fs.chmodSync(dir+'.obligations',0o700);fs.renameSync=oldRename;fs.readFileSync=oldRead;syncBuiltinESMExports();
        for (const child of [owned,foreign]) {
          if(child.exitCode===null&&child.signalCode===null) {child.kill('SIGKILL');await once(child,'exit')}
        }
        fs.rmSync(dir+'.obligations',{recursive:true,force:true});
      }
    `);
    try {
      const result = spawnSync("node", [source], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.refused, !['primary-loss','obligation-owner-loss'].includes(scenario));
      assert.ok(observed.cleanup.unverified > 0);
      assert.equal(observed.ownedStopped, true);
      assert.equal(observed.foreignLive, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(`${dir}.obligations`, { recursive: true, force: true }); }
  });
}

for (const scenario of ['already-exited', 'suite-group'] as const) {
  test(`proven ${scenario} child retires its declaration without a cleanup failure`, { skip: process.platform !== 'linux' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-registry-retired-'));
    const registry = pathToFileURL(path.resolve('scripts/test-process-registry.mjs')).href;
    const source = path.join(dir, 'fixture.mjs');
    fs.writeFileSync(source, `
      import fs from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';
      import {createTestProcessRegistry,registerOwnedTestProcess,reapOwnedTestProcesses} from ${JSON.stringify(registry)};
      const env=createTestProcessRegistry(${JSON.stringify(dir)});
      const child=spawn(process.execPath,['-e',${JSON.stringify(scenario === 'already-exited' ? '' : 'setInterval(()=>{},1000)')}],{detached:${scenario === 'already-exited'},stdio:'ignore'});
      await once(child,${JSON.stringify(scenario === 'already-exited' ? 'exit' : 'spawn')});
      try {
        registerOwnedTestProcess(child,env);
        const cleanup=await reapOwnedTestProcesses(env,{graceMs:10});
        console.log(JSON.stringify({cleanup,records:fs.readdirSync(env.GLLA_TEST_PROCESS_REGISTRY).filter(f=>f.startsWith('process-')).length,expectations:fs.readdirSync(env.GLLA_TEST_PROCESS_REGISTRY+'.obligations').filter(f=>f.startsWith('process-')).length,live:child.exitCode===null&&child.signalCode===null}));
      }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}}
    `);
    try {
      const result = spawnSync('node', [source], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.deepEqual(observed.cleanup, { reaped: 0, unverified: 0 });
      assert.equal(observed.records, 0);
      assert.equal(observed.expectations, 0);
      assert.equal(observed.live, scenario === 'suite-group');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(`${dir}.obligations`, { recursive: true, force: true }); }
  });
}
