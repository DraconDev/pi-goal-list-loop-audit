import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
const {createTestProcessRegistry,registerOwnedTestProcess,reapOwnedTestProcesses}=await import(new URL('./scripts/test-process-registry.mjs', 'file://'+process.cwd()+'/').href);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glla-audit-identity-'));const env=createTestProcessRegistry(dir);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
await once(child,'spawn');
const original=fs.readFileSync;
try {
 fs.readFileSync=(file,...args)=>{if(String(file)===`/proc/${child.pid}/stat`)throw Object.assign(new Error('injected stat denial'),{code:'EACCES'});return original(file,...args)};
 syncBuiltinESMExports();
 let registrationError=null;try{registerOwnedTestProcess(child,env)}catch(e){registrationError=e.message}
 fs.readFileSync=original;syncBuiltinESMExports();
 const records=fs.readdirSync(dir).filter(f=>f.startsWith('process-')).length;
 const expectations=fs.readdirSync(dir+'.obligations').filter(f=>f.startsWith('process-')).length;
 const cleanup=await reapOwnedTestProcesses(env,{graceMs:10});
 console.log(JSON.stringify({scenario:'registration-stat-read-failure',registrationError,records,expectations,cleanup,childStillLive:child.kill(0)},null,2));
}finally {
 fs.readFileSync=original;syncBuiltinESMExports();
 if(child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,'SIGKILL');await once(child,'exit')}
 fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(dir+'.obligations',{recursive:true,force:true});
}
