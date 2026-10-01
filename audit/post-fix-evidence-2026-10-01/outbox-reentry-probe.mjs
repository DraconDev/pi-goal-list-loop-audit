import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(path.join(process.cwd(),'package.json'));const {createJiti}=require('jiti');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'glla-audit-reentry-'));
process.env.GLLA_GLOBAL_SETTINGS_PATH=path.join(cwd,'settings.json');fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH,'{"stateRoot":"workingDir"}');
const jiti=createJiti(path.join(process.cwd(),'package.json'));
const {persistApprovalRender,replayUndeliveredApprovalRenders,approvalRenderStorePath}=await jiti.import(path.join(process.cwd(),'extensions/approval-render-store.ts'));
try {
 const first=persistApprovalRender(cwd,{goalId:'first',objective:'first',chatLines:['first']});
 let nestedPersist;
 const replayed=replayUndeliveredApprovalRenders({cwd},()=>{nestedPersist=persistApprovalRender(cwd,{goalId:'second',objective:'second',chatLines:['second']});return true});
 const records=JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd),'utf8'));
 console.log(JSON.stringify({scenario:'enqueue-during-delivery',firstPersist:first,nestedPersist,replayed,records,secondPendingLost:!records.some(r=>r.goalId==='second')},null,2));
}finally{fs.rmSync(cwd,{recursive:true,force:true})}
