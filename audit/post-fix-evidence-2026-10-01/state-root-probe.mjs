import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(path.join(process.cwd(),'package.json'));const {createJiti}=require('jiti');
const jiti=createJiti(path.join(process.cwd(),'package.json'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glla-audit-root-selection-'));const cwd=path.join(dir,'cwd'), session=path.join(dir,'session');fs.mkdirSync(cwd);fs.mkdirSync(session);
process.env.GLLA_GLOBAL_SETTINGS_PATH=path.join(dir,'settings.json');fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH,'{"stateRoot":"sessionDir"}');
const root=await jiti.import(path.join(process.cwd(),'extensions/glla-state-root.ts'));
const store=await jiti.import(path.join(process.cwd(),'extensions/approval-render-store.ts'));
const core=await jiti.import(path.join(process.cwd(),'extensions/goal-loop-core.ts'));
root.setRuntimeSessionDir(session);
try {
 const at=new Date().toISOString();
 const goal={id:'root-goal',objective:'persistent objective',status:'active',policy:'goal',autoContinue:true,usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,cost:0,turns:0},createdAt:at,updatedAt:at};
 core.appendLedger(cwd,'state',{goal,list:[],loop:null});
 const before=root.resolveGllaStateDir(cwd);const beforeGoalId=core.readState(cwd).goal?.id??null;const first=store.persistApprovalRender(cwd,{goalId:'first',objective:'first',chatLines:['first']});
 fs.chmodSync(process.env.GLLA_GLOBAL_SETTINGS_PATH,0);
 const during=root.resolveGllaStateDir(cwd);const duringGoalId=core.readState(cwd).goal?.id??null;const pending=root.stateRootPending();const second=store.persistApprovalRender(cwd,{goalId:'second',objective:'second',chatLines:['second']});
 fs.chmodSync(process.env.GLLA_GLOBAL_SETTINGS_PATH,0o600);
 const after=root.resolveGllaStateDir(cwd);const afterGoalId=core.readState(cwd).goal?.id??null;
 const selected=JSON.parse(fs.readFileSync(path.join(after,'pending-approval-renders.json'),'utf8')).map(r=>r.goalId);
 const unintended=JSON.parse(fs.readFileSync(path.join(cwd,'.pi-glla','pending-approval-renders.json'),'utf8')).map(r=>r.goalId);
 console.log(JSON.stringify({scenario:'unreadable-state-root-selector',before,during,after,beforeGoalId,duringGoalId,afterGoalId,pending,firstPersist:first,secondPersist:second,selectedPendingGoalIds:selected,unintendedCwdGoalIds:unintended},null,2));
} finally {root.setRuntimeSessionDir(undefined);fs.chmodSync(process.env.GLLA_GLOBAL_SETTINGS_PATH,0o600);fs.rmSync(dir,{recursive:true,force:true})}
