import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const {ExtensionRunner}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js')).href);
const {createCanaryBudget}=await import(pathToFileURL(path.join(root,'scripts/canary-budget.mjs')).href);
const {createTestProcessRegistry,registerOwnedTestProcess,reapOwnedTestProcesses}=await import(pathToFileURL(path.join(root,'scripts/test-process-registry.mjs')).href);
const results=[];
for(const scenario of ['unknown-price','over-budget','second-request']) {
 const guard=createCanaryBudget({maxUsd:0.01}); const errors=[];
 const model={cost:scenario==='unknown-price'?undefined:{input:scenario==='over-budget'?100:0.01,output:0.01}};
 const payload={max_tokens:4096,tools:[{name:'complete_goal'}]};
 const runner={extensions:[{path:'glla-canary-budget-extension',handlers:new Map([['before_provider_request',[(event,ctx)=>guard(event.payload,ctx.model)]]])}],createContext:()=>({model}),emitError:e=>errors.push(e.error)};
 if(scenario==='second-request')await ExtensionRunner.prototype.emitBeforeProviderRequest.call(runner,payload);
 const returned=await ExtensionRunner.prototype.emitBeforeProviderRequest.call(runner,payload);
 results.push({scenario,hookErrors:errors,returnedOriginal:returned===payload,returnedOutputCap:returned.max_tokens,returnedTools:returned.tools.length});
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glla-reaudit-registry-'));
const env=createTestProcessRegistry(dir);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
await once(child,'spawn');
try {
 fs.chmodSync(dir,0o500);
 registerOwnedTestProcess(child,env);
 const result=await reapOwnedTestProcesses(env,{graceMs:10});
 let live=true;try{process.kill(child.pid,0)}catch{live=false}
 results.push({scenario:'unwritable-registry',registeredRecords:fs.readdirSync(dir).filter(n=>n.startsWith('process-')).length,cleanup:result,childStillLive:live});
}finally {
 fs.chmodSync(dir,0o700);
 try{process.kill(-child.pid,'SIGKILL')}catch{}
 if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');
 fs.rmSync(dir,{recursive:true,force:true});
}
console.log(JSON.stringify(results,null,2));
