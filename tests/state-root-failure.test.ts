import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLedger, ensureDirs, piGlaDir, readState } from '../extensions/goal-loop-core.js';
import { setRuntimeSessionDir, stateRootPending, withStateRootSnapshot } from '../extensions/glla-state-root.js';
import { persistApprovalRender, approvalRenderStorePath } from '../extensions/approval-render-store.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-root-failure-'));
  const cwd = path.join(dir, 'cwd'), session = path.join(dir, 'session'), file = path.join(dir, 'settings.json');
  fs.mkdirSync(cwd); fs.mkdirSync(session);
  fs.writeFileSync(file, JSON.stringify({stateRoot:'sessionDir'}));
  const prior = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = file;
  setRuntimeSessionDir(session);
  return {dir,cwd,session,file,restore:()=>{
    setRuntimeSessionDir(undefined);
    if(prior===undefined)delete process.env.GLLA_GLOBAL_SETTINGS_PATH;else process.env.GLLA_GLOBAL_SETTINGS_PATH=prior;
    fs.rmSync(dir,{recursive:true,force:true});
  }};
}

for (const failure of ['permission','malformed','invalid-selector'] as const) {
  test(`known session root remains readable and mutations defer on ${failure}`, {
    skip: failure==='permission' && (process.platform==='win32'||process.getuid?.()===0),
  },()=>{
    const fx=fixture();
    try {
      const at=new Date().toISOString();
      const goal={id:'preserved',objective:'preserved',status:'active',policy:'goal',autoContinue:true,usage:{tokensUsed:0,tokensLimit:0},createdAt:at,updatedAt:at};
      assert.equal(appendLedger(fx.cwd,'state',{goal,list:[],loop:null}),true);
      assert.equal(persistApprovalRender(fx.cwd,{goalId:'first',objective:'first',chatLines:['first']}),true);
      const store=approvalRenderStorePath(fx.cwd), before=fs.readFileSync(store,'utf8');
      if(failure==='permission')fs.chmodSync(fx.file,0);else fs.writeFileSync(fx.file,failure==='malformed'?'{broken':'{"stateRoot":"typo"}');
      assert.equal(stateRootPending(),true);
      assert.equal(piGlaDir(fx.cwd),path.join(fx.session,'pi-glla'));
      assert.equal(readState(fx.cwd).goal?.id,'preserved');
      assert.equal(appendLedger(fx.cwd,'must_defer',{}),false);
      assert.equal(persistApprovalRender(fx.cwd,{goalId:'second',objective:'second',chatLines:['second']}),false);
      assert.equal(fs.readFileSync(store,'utf8'),before);
      assert.equal(fs.existsSync(path.join(fx.cwd,'.pi-glla')),false);
      fs.chmodSync(fx.file,0o600);fs.writeFileSync(fx.file,'{"stateRoot":"sessionDir"}');
      assert.equal(stateRootPending(),false);
      assert.equal(persistApprovalRender(fx.cwd,{goalId:'second',objective:'second',chatLines:['second']}),true);
      assert.deepEqual(JSON.parse(fs.readFileSync(store,'utf8')).map((r:any)=>r.goalId),['first','second']);
    }finally{fs.chmodSync(fx.file,0o600);fx.restore()}
  });
}

for (const failure of ['unreadable','invalid-json'] as const) {
  test(`cold ${failure} selector does not authorize a fallback root`,{
    skip: failure==='unreadable'&&(process.platform==='win32'||process.getuid?.()===0),
  },()=>{
    const fx=fixture();
    try {
      if(failure==='unreadable')fs.chmodSync(fx.file,0);else fs.writeFileSync(fx.file,'null');
      assert.equal(stateRootPending(),true);
      assert.throws(()=>piGlaDir(fx.cwd),/state root unresolved/);
      assert.throws(()=>readState(fx.cwd),/state root unresolved/);
      assert.equal(appendLedger(fx.cwd,'must_defer',{}),false);
      assert.equal(persistApprovalRender(fx.cwd,{goalId:'new',objective:'new',chatLines:['new']}),false);
      ensureDirs(fx.cwd);
      assert.equal(fs.existsSync(path.join(fx.cwd,'.pi-glla')),false);
      assert.equal(fs.existsSync(path.join(fx.session,'pi-glla')),false);
    }finally{fs.chmodSync(fx.file,0o600);fx.restore()}
  });
}

test('absent selector uses the default, while a persistence operation pins a validated root',()=>{
  const fx=fixture();
  try {
    withStateRootSnapshot(()=>{
      assert.equal(piGlaDir(fx.cwd),path.join(fx.session,'pi-glla'));
      fs.writeFileSync(fx.file,'{"stateRoot":"workingDir"}');
      assert.equal(appendLedger(fx.cwd,'pinned',{}),true);
      assert.equal(piGlaDir(fx.cwd),path.join(fx.session,'pi-glla'));
      assert.equal(fs.existsSync(path.join(fx.cwd,'.pi-glla')),false);
    });
    assert.equal(piGlaDir(fx.cwd),path.join(fx.cwd,'.pi-glla'));
    fs.unlinkSync(fx.file);
    assert.equal(stateRootPending(),false);
    assert.equal(appendLedger(fx.cwd,'default',{}),true);
    assert.equal(fs.existsSync(path.join(fx.cwd,'.pi-glla','active.jsonl')),true);
  }finally{fx.restore()}
});
