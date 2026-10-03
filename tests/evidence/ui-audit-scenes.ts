import type { Goal, State } from "../../extensions/goal-loop-core.js";
import type { LoopState } from "../../extensions/goal-loop-forever.js";
import { HELD_ON_RESTORE } from "../../extensions/goal-loop-forever.js";
import type { WidgetExtras } from "../../extensions/goal-loop-display.js";
export const UI_AUDIT_NOW = Date.parse("2026-10-03T12:00:00Z");
const ago = (ms: number) => new Date(UI_AUDIT_NOW - ms).toISOString();
const goal = (patch: Partial<Goal> = {}): Goal => ({ id: "ui-audit-fixture", objective: "Ship a clear and readable GLLA interface — verify settings, cards and draft review", status: "active", policy: "goal", autoContinue: true, usage: { tokensUsed: 123400, tokensLimit: 200000 }, createdAt: ago(3600000), updatedAt: ago(30000), ...patch });
const loop = (patch: Partial<LoopState> = {}): LoopState => ({ target: "Improve the interface through measured iterations", measureCmd: "fixture", direction: "min", iteration: 3, maxIterations: 20, plateauWindow: 5, stallCount: 0, bestValue: 4, lastValue: 6, active: true, history: [], startedAt: ago(3600000), ...patch });
export interface UiAuditScene { key: string; state: State; extras?: WidgetExtras; }
export const UI_AUDIT_SCENES: UiAuditScene[] = [
  { key: "empty", state: { goal: null, list: [] } },
  { key: "working", state: { goal: goal() }, extras: { activity: "working", lastActivityAt: UI_AUDIT_NOW - 5000, lastStreamActivityAt: UI_AUDIT_NOW - 5000 } },
  { key: "paused", state: { goal: goal({ status: "paused", pauseReason: "Need a decision on the proposed design", pauseKind: "decision", pauseSuggestedAction: "Choose a direction, then /goal resume" }) } },
  { key: "blocked", state: { goal: goal({ status: "paused", pauseKind: "blocked", pauseReason: "Verification could not finish", pauseSuggestedAction: "Resolve the failing check, then /goal resume" }) } },
  { key: "supervisor-frozen", state: { goal: goal(), supervisorPausedAt: UI_AUDIT_NOW - 45000 } },
  ...(["starting", "running", "settling", "recovery-pending"] as const).map((phase) => ({ key: `audit-${phase}`, state: { goal: goal({ status: phase === "recovery-pending" ? "paused" : "auditing", pendingCompletion: { at: ago(120000), startedAt: ago(110000), phase, attemptId: "fixture-audit", lastActivityAt: ago(10000), recoveryReason: phase === "recovery-pending" ? "no-progress" : undefined } }) } })),
  { key: "completed", state: { goal: goal({ status: "complete", completionSummary: "Outcome: readable UI shipped. Evidence: rendered component fixtures. Tests: verified." }) } },
  { key: "aborted", state: { goal: goal({ status: "aborted", stopReason: "Cancelled by the user" }) } },
  { key: "queue-only", state: { goal: null, list: [{ id: "queued", objective: "Review the next interface improvement", addedAt: ago(300000) }] } },
  { key: "loop-active", state: { goal: null, loop: loop() } },
  { key: "loop-cadence", state: { goal: null, loop: loop({ minimumIterationIntervalMs: 120000, lastIterationCompletedAt: ago(20000) }) } },
  { key: "loop-held", state: { goal: null, loop: loop({ active: false, stopReason: HELD_ON_RESTORE }) } },
  { key: "workers", state: { goal: goal() }, extras: { agents: { line: "● 3 workers · 1 needs attention", lines: ["⚠ Reviewer · verification · quiet 4m · abort unavailable", "▶ Designer · interface polish · live now"] } } },
];
