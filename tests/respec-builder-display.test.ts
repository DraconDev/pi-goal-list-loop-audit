import { setRespecAuditLive } from "../extensions/respec-builder-ui.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWidgetLines, buildStatusText } from "../extensions/goal-loop-display.js";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createRespecBuilder, adoptRespecRequirements, planRespecIncrement, blockRespecRequirement, claimRespecTask, beginRespecAudit } from "../extensions/respec-builder.js";
import type { State } from "../extensions/goal-loop-core.js";

test("a stopped project audit exposes its hold reason instead of implying a running auditor", () => {
  const adopted = adoptRespecRequirements(createRespecBuilder("Build export"), [{ id: "export", text: "Export", acceptance: "Round trip" }]);
  const planned = planRespecIncrement(adopted, [{ id: "export-task", text: "Build export", requirementIds: ["export"] }]);
  const builder = beginRespecAudit(claimRespecTask(planned, "export-task"), "attempt", "Round trip checked");
  const state = { goal: null, list: [], loop: { builder, active: false, stopReason: "stalled: 5 continuation refires landed no turn", target: builder.vision, startedAt: new Date().toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
  const plain = stripTerminalSequences(buildWidgetLines(state, null, Date.now(), undefined, 120)!.join("\n"));
  assert.match(plain, /Audit held/);
  assert.match(plain, /stalled: 5 continuation refires/);
  assert.match(plain, /\/loop resume/);
  assert.doesNotMatch(plain, /no action needed|Project · Auditing/);
});

test("project cards expose phase, unfinished coverage and recorded blockers within narrow widths", () => {
  const drafted = adoptRespecRequirements(createRespecBuilder("Develop login and export"), [{ id: "login", text: "Login", acceptance: "Credentials verified" }, { id: "export", text: "Export", acceptance: "Data round-trips" }]);
  const building = planRespecIncrement(drafted, [{ id: "auth", text: "Implement and exercise login behavior", requirementIds: ["login"] }]);
  const blocked = blockRespecRequirement(building, "login", "Identity service unavailable");
  for (const builder of [drafted, building, blocked]) {
    const state = { goal: null, list: [], loop: { builder, active: builder !== blocked, target: builder.vision, startedAt: new Date().toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
    for (const width of [1, 20, 40, 80, 120]) {
      const lines = buildWidgetLines(state, null, Date.now(), undefined, width)!;
      assert.ok(lines.every(line => visibleWidth(line) <= Math.max(0, width - 2)));
      assert.doesNotMatch(lines.join("\n"), /\x1b\[(?:\d+;)*3(?:;\d+)*m/);
      if (width >= 80) {
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /verified 0\/2/);
        assert.match(plain, /remaining 2/);
        if (builder === blocked) { assert.match(plain, /Identity service unavailable/); assert.match(plain, /held/); assert.match(plain, /\/loop blockers/); }
      }
    }
  }
});

test("an explicitly stopped project audit does not advertise an unavailable resume", () => {
  const builder = beginRespecAudit(claimRespecTask(planRespecIncrement(adoptRespecRequirements(createRespecBuilder("Export"), [{ id: "export", text: "Export", acceptance: "Round trip" }]), [{ id: "task", text: "Build export", requirementIds: ["export"] }]), "task"), "attempt", "Round trip checked");
  const state = { goal: null, list: [], loop: { builder, active: false, stopReason: "stopped by user (/loop stop)", target: builder.vision, startedAt: new Date().toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
  const plain = stripTerminalSequences(buildWidgetLines(state, null, Date.now(), undefined, 120)!.join("\n"));
  assert.match(plain, /Audit stopped/);
  assert.doesNotMatch(plain, /\/loop resume|Work held/);
});

test("completed project dismisses both live UI surfaces while preserving other work", () => {
  const builder = { ...createRespecBuilder("Completed project"), phase: "complete", requirements: [{ id: "done", text: "Done", acceptance: "Verified", status: "verified" }] };
  const state = { goal: null, list: [], loop: { builder, active: false, stopReason: "completed: all intended project requirements independently verified", target: "Completed project", startedAt: new Date().toISOString(), iteration: 2, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
  for (const width of [20, 60, 120]) {
    assert.equal(buildWidgetLines(state, null, Date.now(), undefined, width), undefined);
    assert.equal(buildStatusText(state, null, Date.now()), undefined);
  }
  const queued = { ...state, list: [{ id: "next", objective: "Next unfinished task", addedAt: new Date().toISOString() }] };
  assert.match(stripTerminalSequences(buildWidgetLines(queued, null, Date.now(), undefined, 120)!.join("\n")), /list queued/i);
  assert.match(stripTerminalSequences(buildStatusText(queued, null, Date.now())!), /list queued/i);
});


test("project tool waits show a ticking deadline and separate attempt/total clocks", () => {
  const builder = beginRespecAudit(claimRespecTask(planRespecIncrement(adoptRespecRequirements(createRespecBuilder("Export"), [{ id: "export", text: "Export", acceptance: "Round trip" }]), [{ id: "task", text: "Build export", requirementIds: ["export"] }]), "task"), "tool-wait-attempt", "Round trip checked");
  const now = 2000000;
  const state = { goal: null, list: [], loop: { builder, active: true, target: builder.vision, startedAt: new Date(now - 900000).toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
  const progress = { phase: "running" as const, workerPhase: "running", round: 2 as const, startedAt: now - 900000, attemptStartedAt: now - 180000, currentTool: "bash", currentToolStartedAt: now - 90000, toolTimeoutMs: 300000, lastActivityAt: now - 90000 };
  try {
    setRespecAuditLive(builder, progress);
    const card = stripTerminalSequences(buildWidgetLines(state, null, now, undefined, 250)!.join("\n"));
    assert.match(card, /waiting on bash.*90s \/ 300s timeout.*second pass.*attempt 3m.*total 15m/);
    assert.match(card, /timeout recovery is automatic/);
    assert.match(buildStatusText(state, null, now)!, /waiting on bash.*90s \/ 300s timeout/);
    assert.match(buildStatusText(state, null, now + 10000)!, /100s \/ 300s timeout/);
    for (const patch of [{ workerPhase: "tool_cancelled" }, { currentToolStartedAt: now + 1 }, { currentToolStartedAt: NaN }, { toolTimeoutMs: 0 }, { toolTimeoutMs: Infinity }, { lastActivityAt: now + 1 }, { currentToolStartedAt: now - 300000 }, { phase: "retrying" as const }]) {
      setRespecAuditLive(builder, { ...progress, ...patch });
      assert.doesNotMatch(buildStatusText(state, null, now)!, /waiting on bash/);
    }
    setRespecAuditLive(builder, { ...progress, currentTool: undefined, currentToolStartedAt: undefined });
    assert.doesNotMatch(buildStatusText(state, null, now)!, /waiting on bash/);
  } finally { setRespecAuditLive(builder); }
});

test('blocker inspection retains late operator instructions and distinguishes recorded claims from verification',async()=>{
 const {respecBlockerDetails}=await import('../extensions/respec-builder-ui.js');
 const builder=blockRespecRequirement(adoptRespecRequirements(createRespecBuilder('finish the visuals'),[
  {id:'DC-4',text:'Faction chrome',acceptance:'Pinned visual baselines pass'}]),'DC-4',
  'Render environment mismatch. '+('diagnostic details '.repeat(100))+'Operator action needed: dispatch regeneration on the pinned runner.');
 const before=JSON.stringify(builder),text=respecBlockerDetails(builder);
 assert.match(text,/recorded by the agent/);
 assert.match(text,/Operator action needed:/);
 assert.match(text,/dispatch regeneration on the pinned\s+runner/);
 assert.match(text,/unblock_project_requirement/);
 assert.match(text,/does not verify or complete/);
 assert.ok(text.split('\n').every(line=>line.length<=96));
 assert.equal(JSON.stringify(builder),before);
 const state={goal:null,list:[],loop:{builder,active:false,target:builder.vision,startedAt:new Date().toISOString(),iteration:1,maxIterations:0,plateauWindow:5,stallCount:0,bestValue:null,lastValue:null,history:[]}} as State;
 const card=stripTerminalSequences(buildWidgetLines(state,null,Date.now(),undefined,120)!.join('\n'));
 assert.match(card,/\/loop blockers/);
 assert.doesNotMatch(card,/resume when ready/,'all-blocked projects must not advertise a resume that will be refused');
});
