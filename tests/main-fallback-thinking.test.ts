import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleSettingChoice } from '../extensions/loops/goal.js';
import { loadGlobalSettings, normalizeLoadedSettings, saveSettings } from '../extensions/goal-settings.js';
import { sanitizeMainModelRecovery } from '../extensions/goal-loop-core.js';
import { buildSettingsRows } from '../extensions/settings-menu.js';
import { makeMockCtx, tmpCwd } from './harness/mock-pi.js';

const globalPath=process.env.GLLA_GLOBAL_SETTINGS_PATH!;
test('main fallback picker saves a distinct supported thinking level per model and displays it', async () => {
 const before=fs.readFileSync(globalPath,'utf8');
 try {
  fs.writeFileSync(globalPath,'{}');
  const cwd=tmpCwd(),ctx:any=makeMockCtx(cwd);
  const models=[{provider:'p',id:'first',reasoning:true},{provider:'p',id:'second',reasoning:true},{provider:'p',id:'plain',reasoning:false}];
  ctx.model={provider:'p',id:'primary',reasoning:true};ctx.thinkingLevel='high';
  ctx.modelRegistry={getAvailable:()=>models,find:(provider:string,id:string)=>models.find(m=>m.provider===provider&&m.id===id),hasConfiguredAuth:()=>true};
  ctx.ui.customStubMode=true;ctx.ui.customImpl=async()=>models.map(m=>`p/${m.id}`);
  const seen:string[]=[];
  ctx.ui.selectImpl=async(title:string,options:string[])=>{seen.push(title);return options.find(o=>o.startsWith(title.includes('first')?'low ':'medium '));};
  await handleSettingChoice('mainModelFallbacks',ctx);
  let settings=loadGlobalSettings();
  assert.deepEqual(settings.mainModelFallbackThinkingLevels,{'p/first':'low','p/second':'medium','p/plain':'off'});
  assert.equal(seen.length,2,'non-reasoning model needs no impossible thinking choice');
  const row=buildSettingsRows(settings,{}, {sessionThinkingLevel:'high'}).find(r=>r.id==='mainModelFallbacks')!;
  assert.match(row.valueText,/p\/first · low/);assert.match(row.valueText,/p\/second · medium/);
  ctx.ui.selectImpl=async(_title:string,options:string[])=>options[0];
  await handleSettingChoice('mainModelFallbacks',ctx);
  settings=loadGlobalSettings();
  assert.deepEqual(settings.mainModelFallbackThinkingLevels,{'p/plain':'off'},'inherit removes individual overrides');
  ctx.ui.customImpl=async()=>[];
  await handleSettingChoice('mainModelFallbacks',ctx);
  assert.equal(loadGlobalSettings().mainModelFallbackThinkingLevels,undefined,'clearing the chain clears its thinking pins');
 } finally {fs.writeFileSync(globalPath,before);}
});

test('fallback thinking settings and primary restoration are bounded durable values',()=>{
 const normalized=normalizeLoadedSettings({mainModelFallbacks:['p/first'],mainModelFallbackThinkingLevels:{'P/FIRST':'low','p/removed':'high','p/first':'invalid' as any}});
 assert.deepEqual(normalized.mainModelFallbackThinkingLevels,{'p/first':'low'});
 const saved=sanitizeMainModelRecovery({primary:'p/main',primaryThinkingLevel:'high',attempted:[],attempts:1,kind:'loop'});
 assert.equal(saved?.primaryThinkingLevel,'high');
 assert.equal(sanitizeMainModelRecovery({...saved,primaryThinkingLevel:'invalid'})?.primaryThinkingLevel,undefined);
 const cwd=tmpCwd();saveSettings('project',cwd,{mainModelFallbackThinkingLevels:{'p/first':'high'}});
 assert.equal(fs.readFileSync(cwd+'/.pi-glla/settings.json','utf8').includes('mainModelFallbackThinkingLevels'),false,'recovery configuration is global-only');
});
