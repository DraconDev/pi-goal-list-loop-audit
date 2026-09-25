// pi-goal-list-loop-audit — v0.38.99
// tests/audit-settlement-restart.test.ts
//
// The detached audit's lifecycle transitions, driven through a REAL cold
// reload (MockPi + session_start against durable .pi-glla state). These are
// the transitions the objective names, each observed from the durable record a
// restart would read:
//
//   stale/no-progress  an attempt-owning claim with no worker left (or no
//                      durable activity past the window) parks as
//                      recovery-needed — never archived, never rendered as a
//                      completion, and the claim survives intact.
//   active settlement  a claim whose approval is already durable (`settling`)
//                      finishes its archive on the next session, without
//                      re-running the auditor.
//   approval           the finished settlement is terminal: the archive exists
//                      and the summary is queued exactly once.
//   recovery-needed    a settlement whose archive fence refuses keeps the
//                      APPROVED claim (so it is re-drivable) and emits no
//                      terminal success.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { archivedGoalPath, readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function renders(cwd: string): Array<{ goalId: string; chatLines: string[]; deliveredAt?: string }> {
  const file = path.join(cwd, ".pi-glla", "pending-approval-renders.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** A stored claim whose approval is durable and whose archive never landed. */
function settlingGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return seedGoal({
    status: "auditing",
    objective: "approved work whose archive was interrupted",
    completionSummary: "Outcome: shipped the thing. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
    auditHistory: [{
      at: ago(90_000),
      approved: true,
      disapproved: false,
      model: "openai/gpt-test",
      revision: 0,
      regressionShieldPassed: true,
      durationMs: 42_000,
      report: "<approved>evidence cited</approved>",
    }],
    pendingCompletion: {
      at: ago(120_000),
      phase: "settling",
      startedAt: ago(120_000),
      lastActivityAt: ago(60_000),
      verdictAt: ago(30_000),
      attemptId: "settle-attempt",
      completionSummary: "Outcome: shipped the thing. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
    },
    ...overrides,
  });
}

async function boot(pi: MockPi, cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `lifecycle-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return ctx;
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
});

// ---- stale / no-progress: an orphaned attempt is recovery-needed, not done ----

test("restart: a running claim whose worker is gone parks as recovery-needed and never looks complete", async () => {
  const cwd = tmpCwd();
  const lastActivityAt = ago(41 * 60_000);
  seedState(cwd, {
    goal: seedGoal({
      status: "auditing",
      objective: "orphaned attempt — done when pinned",
      pendingCompletion: {
        at: ago(45 * 60_000),
        phase: "running",
        startedAt: ago(45 * 60_000),
        lastActivityAt,
        attemptId: "orphan-attempt",
        completionSummary: "claim under audit",
      } as any,
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await tick();
    const goal = readState(cwd).goal as any;
    assert.equal(goal.status, "paused", "an orphaned attempt is parked, not trusted as live");
    assert.equal(goal.pendingCompletion?.phase, "recovery-pending", "the durable lifecycle names it recovery-needed");
    assert.equal(goal.pendingCompletion?.attemptId, "orphan-attempt", "the claim survives with its identity");
    assert.equal(goal.pendingCompletion?.lastActivityAt, lastActivityAt, "the last-activity evidence is preserved for forensics");
    assert.equal(fs.existsSync(archivedGoalPath(cwd, goal.id)), false, "an unresolved audit is never archived");
    assert.equal(renders(cwd).length, 0, "an unresolved audit never renders a terminal summary");
    assert.ok(!ledgerTypes(cwd).includes("audit_settlement_completed"), "no settlement is claimed");
    const notices = ctx.ui.notifies.map((entry) => entry.message).join("\n");
    assert.match(notices, /stored claim is safe/, "the recovery path is offered, not a completion");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("restart: a claim whose worker never reported is recovery-needed, with no invented activity", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "auditing",
      objective: "launched but never started — done when pinned",
      pendingCompletion: {
        at: ago(90_000),
        phase: "starting",
        startedAt: ago(90_000),
        attemptId: "cold-start-attempt",
        completionSummary: "claim awaiting a worker",
      } as any,
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    const goal = readState(cwd).goal as any;
    assert.equal(goal.pendingCompletion?.phase, "recovery-pending", "a starting claim is an interrupted claim after a restart");
    assert.equal(goal.pendingCompletion?.lastActivityAt, undefined, "no worker event is ever invented");
    assert.equal(fs.existsSync(archivedGoalPath(cwd, goal.id)), false);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

// ---- active settlement: the approved claim finishes its archive on restart ----

test("restart: a settling claim completes its archive without re-running the auditor", async () => {
  const cwd = tmpCwd();
  const goal = settlingGoal();
  seedState(cwd, { goal });
  const goalId = (goal as { id: string }).id;
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await tick();
    assert.equal(fs.existsSync(archivedGoalPath(cwd, goalId)), true, "the interrupted settlement is finished on the next session");
    const archive = fs.readFileSync(archivedGoalPath(cwd, goalId), "utf8");
    assert.match(archive, /\*\*Status\*\*: complete/, "the archive records the approved terminal state");
    const types = ledgerTypes(cwd);
    assert.ok(types.includes("audit_settlement_resumed"), "the re-drive is ledgered");
    assert.ok(types.includes("audit_settlement_completed"), "the settlement reports completion");
    assert.ok(!types.includes("audit_started"), "an approved settlement is never re-audited");
    const stored = readState(cwd).goal as any;
    assert.equal(stored?.pendingCompletion, undefined, "the archive released the claim");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

// ---- approval: terminal exactly once, and only after the archive ----

test("restart: a finished settlement is approved once — one render, and the render follows the archive", async () => {
  const cwd = tmpCwd();
  const goal = settlingGoal();
  seedState(cwd, { goal });
  const goalId = (goal as { id: string }).id;
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await tick(200);
    const stored = renders(cwd);
    assert.equal(stored.length, 1, "the terminal summary is queued exactly once");
    assert.equal(stored[0]!.goalId, goalId);
    const text = stored[0]!.chatLines.join("\n");
    assert.match(text, /## Done — shipped the thing\./, "the queued render is the user-facing recap card");
    assert.match(text, /completion audit approved after session recovery/, "the card says the audit approved");
    assert.ok(!text.includes("auditor: settling"), "the card never reports an unresolved audit as finished");

    // A second session contact must not duplicate the terminal render.
    const second = new MockPi();
    activate(second.api);
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
    const ctx2 = makeMockCtx(cwd, { sessionManager: { name: `lifecycle-second-${Date.now()}` } });
    await second.fire("session_start", { reason: "reload" }, ctx2);
    await tick(200);
    assert.equal(renders(cwd).length, 1, "settlement is idempotent across contacts");
    assert.equal(fs.existsSync(archivedGoalPath(cwd, goalId)), true, "the archive fence still holds");
    await second.fire("session_shutdown", { reason: "test-end" }, ctx2);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

// ---- recovery-needed: a refused archive keeps the approved claim ----

test("restart: a refused archive keeps the approved claim and emits no terminal success", async () => {
  const cwd = tmpCwd();
  const goal = settlingGoal();
  seedState(cwd, { goal });
  const goalId = (goal as { id: string }).id;
  // Immutable-fence: an existing same-id archive makes archiveCurrentGoal
  // refuse, which is exactly the "approved but not archived" case.
  const fence = archivedGoalPath(cwd, goalId);
  fs.mkdirSync(path.dirname(fence), { recursive: true });
  fs.writeFileSync(fence, "# pre-existing archive\n");

  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await tick();
    const stored = readState(cwd).goal as any;
    assert.equal(stored?.status, "paused", "a refused archive parks instead of closing");
    // v0.38.99: the claim STAYS `settling` — the approval is durable and the
    // archive is owed. Parking it as `recovery-pending` made the next resume
    // launch a second auditor over already-approved work, and the session-start
    // re-drive (which only accepts `settling`) skipped it entirely.
    assert.equal(stored?.pendingCompletion?.phase, "settling", "the blocked settlement keeps its lifecycle phase");
    assert.equal(stored?.pendingCompletion?.recoveryReason, "approval-archive-failed", "the blocker is named durably");
    assert.equal(stored?.pendingCompletion?.attemptId, "settle-attempt", "claim identity is preserved");
    assert.equal(renders(cwd).length, 0, "no terminal summary is produced for a settlement that did not land");
    assert.ok(!ledgerTypes(cwd).includes("audit_settlement_completed"), "completion is never claimed");
    const notices = ctx.ui.notifies.map((entry) => entry.message).join("\n");
    assert.match(notices, /finishes the approved settlement|No new audit is needed|existing archive/i, "the notice points at the real recovery step");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

// ---- fault -> repair -> recovery: the promised path actually completes ----

test("recovery: after the fault is repaired, /goal resume finishes the settlement WITHOUT re-auditing", async () => {
  const cwd = tmpCwd();
  const goal = settlingGoal();
  seedState(cwd, { goal });
  const goalId = (goal as { id: string }).id;
  const fence = archivedGoalPath(cwd, goalId);
  fs.mkdirSync(path.dirname(fence), { recursive: true });
  fs.writeFileSync(fence, "# pre-existing archive\n");

  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await tick();
    assert.equal((readState(cwd).goal as any)?.pendingCompletion?.phase, "settling", "the fault parks the settlement, not the audit");

    // REPAIR: the conflicting archive is gone, so the terminal archive can
    // land. The user then does exactly what the pause text promised.
    fs.rmSync(fence);
    await pi.command("goal", "resume", ctx as never);
    await tick(200);

    assert.equal(fs.existsSync(archivedGoalPath(cwd, goalId)), true, "the settlement completes on resume");
    assert.match(
      fs.readFileSync(archivedGoalPath(cwd, goalId), "utf8"),
      /\*\*Status\*\*: complete/,
      "the archive records the approved terminal state",
    );
    const types = ledgerTypes(cwd);
    assert.ok(types.includes("audit_settlement_resumed"), "the re-drive is ledgered");
    assert.ok(types.includes("audit_settlement_completed"), "the settlement reports completion");
    assert.ok(!types.includes("audit_started"), "NO second auditor: approved work is never re-audited");
    assert.equal(renders(cwd).length, 1, "the terminal summary is queued once the archive lands");
    assert.equal(renders(cwd)[0]!.goalId, goalId);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("recovery: a restart after the fault is repaired also finishes the settlement without re-auditing", async () => {
  const cwd = tmpCwd();
  const goal = settlingGoal();
  seedState(cwd, { goal });
  const goalId = (goal as { id: string }).id;
  const fence = archivedGoalPath(cwd, goalId);
  fs.mkdirSync(path.dirname(fence), { recursive: true });
  fs.writeFileSync(fence, "# pre-existing archive\n");

  // First process: the fault parks the settlement.
  const first = new MockPi();
  activate(first.api);
  const ctx = await boot(first, cwd);
  await tick();
  await first.fire("session_shutdown", { reason: "quit" }, ctx);
  assert.equal((readState(cwd).goal as any)?.pendingCompletion?.phase, "settling");

  // REPAIR, then a cold restart: session_start re-drives the owed archive.
  fs.rmSync(fence);
  const second = new MockPi();
  activate(second.api);
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx2 = makeMockCtx(cwd, { sessionManager: { name: `lifecycle-restart-${Date.now()}` } });
  await second.fire("session_start", { reason: "reload" }, ctx2);
  await tick(200);

  assert.equal(fs.existsSync(archivedGoalPath(cwd, goalId)), true, "the restart finishes the owed settlement");
  assert.ok(ledgerTypes(cwd).includes("audit_settlement_resumed"), "the re-drive is ledgered");
  assert.ok(!ledgerTypes(cwd).includes("audit_started"), "no auditor is launched for approved work");
  await second.fire("session_shutdown", { reason: "test-end" }, ctx2);
});

// ---- the lifecycle evidence itself survives a round trip through disk ----

test("lifecycle evidence survives the durable state boundary (sanitized, not dropped)", () => {
  const cwd = tmpCwd();
  const goal = settlingGoal({
    pendingCompletion: {
      at: ago(10_000),
      phase: "starting",
      startedAt: ago(9_000),
      lastActivityAt: "not-a-timestamp",
      attemptId: "sanitize-attempt",
    } as any,
  });
  const startedAt = ago(9_000);
  seedState(cwd, { goal: seedGoal({ ...(goal as object), pendingCompletion: { ...(goal as any).pendingCompletion, startedAt } }) });
  __testOnlyLoadState(cwd);
  const claim = (readState(cwd).goal as any).pendingCompletion;
  assert.equal(claim.phase, "starting", "the starting phase survives the read boundary");
  assert.equal(claim.lastActivityAt, undefined, "garbage activity evidence degrades to absent, never to a fake stamp");
  assert.equal(claim.startedAt, new Date(startedAt).toISOString());
});
