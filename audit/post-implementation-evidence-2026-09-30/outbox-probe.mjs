import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'glla-reaudit-outbox-'));
process.env.GLLA_GLOBAL_SETTINGS_PATH=path.join(cwd,'settings.json');
fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH,JSON.stringify({stateRoot:'workingDir'}));
const jiti=createJiti(path.join(process.cwd(),'package.json'));
const {persistApprovalRender,approvalRenderStorePath}=await jiti.import(path.join(process.cwd(),'extensions/approval-render-store.ts'));
try {
 const first=persistApprovalRender(cwd,{goalId:'first',objective:'first pending summary',chatLines:['first summary']});
 const file=approvalRenderStorePath(cwd);
 fs.chmodSync(file,0);
 let readError;try{fs.readFileSync(file)}catch(e){readError=e.code}
 const second=persistApprovalRender(cwd,{goalId:'second',objective:'second pending summary',chatLines:['second summary']});
 const stored=JSON.parse(fs.readFileSync(file,'utf8'));
 console.log(JSON.stringify({scenario:'unreadable-existing-outbox',firstPersist:first,readError,secondPersist:second,pendingGoalIds:stored.map(r=>r.goalId),firstObligationLost:!stored.some(r=>r.goalId==='first')},null,2));
} finally {fs.rmSync(cwd,{recursive:true,force:true})}
