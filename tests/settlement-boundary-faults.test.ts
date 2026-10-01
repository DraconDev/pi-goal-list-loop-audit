import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { state } from '../extensions/goal-state.js';
import type { Goal } from '../extensions/goal-loop-core.js';
import { createGoalSettlementBoundary } from '../extensions/loops/goal-orchestrator.js';
import { __testOnlyLoadState, __testOnlyRememberCtx, __testOnlyResetProcessState } from '../extensions/loops/goal.js';
import { archivedGoalPath, readArchiveIntent, finalizeArchiveIntent, readState } from '../extensions/goal-loop-core.js';
import { persistApprovalRender } from '../extensions/approval-render-store.js';
import { makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';
afterEach(() => __testOnlyResetProcessState());
function fixture() {
  __testOnlyResetProcessState();
  const cwd = tmpCwd();
  const goal = seedGoal({status:'active', objective:'durable terminal obligation'}) as unknown as Goal;
  seedState(cwd,{goal}); __testOnlyLoadState(cwd);
  const ctx=makeMockCtx(cwd); __testOnlyRememberCtx(ctx as any);
  return {cwd, goal, ctx};
}
test('typed settlement refuses success before its intent can be persisted', () => {
  const {cwd,goal,ctx}=fixture();
  const settlement=createGoalSettlementBoundary({writeArchiveIntent:()=>false});
  assert.equal(settlement.archiveCurrentGoal(ctx as any,'complete','approved'),false);
  assert.equal(fs.existsSync(archivedGoalPath(cwd,goal.id)),false);
  assert.equal(readState(cwd).goal?.id,goal.id);
  assert.equal(readArchiveIntent(cwd),null);
});
test('failed receipt transfer retains the terminal obligation across live-slot cleanup', () => {
  const {cwd,goal,ctx}=fixture();
  const render={goalId:goal.id, objective:goal.objective,chatLines:['Approved with evidence']};
  const settlement=createGoalSettlementBoundary({persistApprovalRender:()=>false});
  assert.equal(settlement.archiveCurrentGoal(ctx as any,'complete','approved',{}, {terminalRender:render}),true);
  const archive=fs.readFileSync(archivedGoalPath(cwd,goal.id),'utf8');
  assert.equal(state.goal,null, "the live in-memory slot is cleared while recovery retains its journal");
  assert.deepEqual(readArchiveIntent(cwd)?.terminalRender,render);
  assert.equal(finalizeArchiveIntent(cwd,goal.id,r=>persistApprovalRender(cwd,r)),true);
  assert.equal(readArchiveIntent(cwd),null);
  const outbox=JSON.parse(fs.readFileSync(path.join(cwd,'.pi-glla','pending-approval-renders.json'),'utf8'));
  assert.equal(outbox.filter((r:any)=>r.goalId===goal.id).length,1);
  assert.equal(fs.readFileSync(archivedGoalPath(cwd,goal.id),'utf8'),archive);
});

test('unreadable old outbox retains new archive intent until both summaries can be queued', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const {cwd,goal,ctx}=fixture();
  assert.equal(persistApprovalRender(cwd,{goalId:'older',objective:'older',chatLines:['older summary']}),true);
  const file=path.join(cwd,'.pi-glla','pending-approval-renders.json');
  const oldBytes=fs.readFileSync(file,'utf8');
  const render={goalId:goal.id,objective:goal.objective,chatLines:['new summary']};
  fs.chmodSync(file,0);
  try {
    const settlement=createGoalSettlementBoundary();
    assert.equal(settlement.archiveCurrentGoal(ctx as any,'complete','approved',{}, {terminalRender:render}),true);
    assert.deepEqual(readArchiveIntent(cwd)?.terminalRender,render);
    assert.equal(finalizeArchiveIntent(cwd,goal.id,r=>persistApprovalRender(cwd,r)),false);
  } finally {fs.chmodSync(file,0o600)}
  assert.equal(fs.readFileSync(file,'utf8'),oldBytes);
  assert.equal(finalizeArchiveIntent(cwd,goal.id,r=>persistApprovalRender(cwd,r)),true);
  assert.equal(readArchiveIntent(cwd),null);
  const ids=JSON.parse(fs.readFileSync(file,'utf8')).map((r:any)=>r.goalId);
  assert.deepEqual(ids,['older',goal.id]);
});
