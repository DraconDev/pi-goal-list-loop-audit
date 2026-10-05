import { seedState } from "./harness/mock-pi.js";
// pi-goal-list-loop-audit — v0.38.104 between-tasks compaction.
//
// Field 2026-09-27: the 200k compaction rule was believed to be set and was
// never observed firing. It was never a TRIGGER — `PLAN_B_FALLBACK_NEED = 200_000`
// only sizes the compactor MODEL for a session that large and gates nothing.
//
// The two paths that did exist:
//   - 85%-of-context band -> ctx.ui.notify("run /compact now"). A NOTICE, not
//     an action, and on a 1M window 85% is ~850k.
//   - starvation -> needs 2 consecutive length-stops, i.e. the context already
//     dead. That is the deathmarch.
//
// This is the missing third path: a TOKEN count, fired BETWEEN tasks, which
// actually compacts and writes a handoff brief.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  shouldCompactBetweenTasks,
  maybeCompactTranscriptAtBoundary,
  compactorBoundaryMarkerPath,
  compactorFiredMarkerPath,
  GOAL_COMPACT_TOKEN_THRESHOLD,
  PLAN_B_FALLBACK_NEED,
  __testOnlyResetCompactor,
  __testOnlySetSpawnWorker,
} from "../extensions/goal-compactor.ts";

test("v0.38.104 the 200k rule is a token threshold, and it is distinct from the model-size hint", () => {
  assert.equal(GOAL_COMPACT_TOKEN_THRESHOLD, 200_000, "the number the user set is the trigger");
  // Both are 200k today, but they are different things: one gates the
  // compaction, the other sizes the model. Pinning them apart is the point --
  // conflating them is what made the rule invisible.
  assert.equal(typeof PLAN_B_FALLBACK_NEED, "number");
});

test("v0.38.104 compaction is due past the threshold, not below it", () => {
  assert.equal(shouldCompactBetweenTasks({ tokens: 199_999 }).compact, false);
  assert.equal(shouldCompactBetweenTasks({ tokens: 200_000 }).compact, true);
  assert.equal(shouldCompactBetweenTasks({ tokens: 850_000 }).compact, true);
});

test("v0.38.104 a token count, not a percentage — the same goal on a 1M window still fires at 200k", () => {
  // 200k is 20% of a 1M window. The old 85% band would not have fired until
  // ~850k, by which point summarization is at its worst. This is the reason a
  // percentage is the wrong instrument.
  const decision = shouldCompactBetweenTasks({ tokens: 200_000 });
  assert.equal(decision.compact, true);
  assert.match(decision.reason, /between tasks/);
});

test("v0.38.104 it fires ONCE per episode and re-arms as the goal grows back", () => {
  assert.equal(shouldCompactBetweenTasks({ tokens: 400_000, alreadyFired: true }).compact, false,
    "a compaction empties the transcript, so one per episode is correct");
  // Re-arms naturally: after the transcript fills again it is due again.
  assert.equal(shouldCompactBetweenTasks({ tokens: 400_000, alreadyFired: false }).compact, true);
});

test("v0.38.104 an unknown context count never compacts blindly", () => {
  for (const tokens of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = shouldCompactBetweenTasks({ tokens: tokens as number | null | undefined });
    assert.equal(d.compact, false, `tokens=${String(tokens)} must not compact`);
  }
});

test("v0.38.104 the threshold is overridable but must be positive", () => {
  assert.equal(shouldCompactBetweenTasks({ tokens: 50_000, threshold: 40_000 }).compact, true);
  assert.equal(shouldCompactBetweenTasks({ tokens: 500_000, threshold: 0 }).compact, true,
    "a non-positive override falls back to the default rather than disabling the safety net");
});

// ---- v0.38.105: the boundary fires a REAL transcript compaction ----
//
// Field 2026-09-29: 600-900k-token sessions never compacted. The v0.38.104
// trigger only wrote a handoff brief and asked for a manual /new, and pi
// auto-compaction only fires near exhaustion. The extension API owns
// ctx.compact — the turn boundary now uses it.

function mkBoundaryCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-compact-boundary-"));
}

function boundaryCtx(cwd: string, opts: {
  tokens?: number;
  idle?: boolean;
  pending?: boolean;
  compact?: ((options?: unknown) => void) | null;
} = {}) {
  const compacts: unknown[] = [];
  const notifies: string[] = [];
  const ctx = {
    cwd,
    getContextUsage: opts.tokens === undefined ? undefined : () => ({ tokens: opts.tokens }),
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => opts.pending ?? false,
    ui: { notify: (message: string) => { notifies.push(message); } },
    ...(opts.compact === null ? {} : { compact: opts.compact ?? ((options?: unknown) => { compacts.push(options); }) }),
  };
  return { ctx: ctx as never, compacts, notifies };
}

function ledgerTypes(cwd: string): string[] {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

// The handoff brief worker is deliberately unawaited (the transcript trigger
// never waits on it); let it land before tmp cleanup so no write races rmSync.
function settleBrief(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

afterEach(() => {
  __testOnlyResetCompactor();
  __testOnlySetSpawnWorker(undefined);
});

const LIVE_FLAGS = { supervising: true, auditInFlight: false, paused: false };

test("v0.38.105 the boundary fires ctx.compact past 200k and ledgers it", async () => {
  const cwd = mkBoundaryCwd();
  try {
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: x.\nNext task: y.\nVerdicts: none.\nWatch-outs: none." }));
    const { ctx, compacts } = boundaryCtx(cwd, { tokens: 250_000 });
    const fired = await maybeCompactTranscriptAtBoundary(ctx, LIVE_FLAGS);
    assert.equal(fired, true);
    assert.equal(compacts.length, 1, "the transcript trigger fires exactly once");
    assert.ok(ledgerTypes(cwd).includes("compactor_transcript_firing"), "the firing is ledgered");
    assert.ok(fs.existsSync(compactorBoundaryMarkerPath(cwd)), "the episode marker lands");
    await settleBrief();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.38.105 one firing per episode; a shrunk transcript re-arms", async () => {
  const cwd = mkBoundaryCwd();
  try {
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: x.\nNext task: y.\nVerdicts: none.\nWatch-outs: none." }));
    const first = boundaryCtx(cwd, { tokens: 250_000 });
    assert.equal(await maybeCompactTranscriptAtBoundary(first.ctx, LIVE_FLAGS), true);
    const second = boundaryCtx(cwd, { tokens: 240_000 });
    assert.equal(await maybeCompactTranscriptAtBoundary(second.ctx, LIVE_FLAGS), false, "no refire while still large");
    assert.equal(second.compacts.length, 0);
    const shrunk = boundaryCtx(cwd, { tokens: 50_000 });
    assert.equal(await maybeCompactTranscriptAtBoundary(shrunk.ctx, LIVE_FLAGS), false, "a shrunk transcript only re-arms");
    assert.ok(!fs.existsSync(compactorBoundaryMarkerPath(cwd)), "hysteresis cleared the marker");
    const regrown = boundaryCtx(cwd, { tokens: 210_000 });
    assert.equal(await maybeCompactTranscriptAtBoundary(regrown.ctx, LIVE_FLAGS), true, "the next growth episode fires again");
    assert.equal(regrown.compacts.length, 1);
    await settleBrief();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.38.105 quiet boundaries: below threshold, busy, unsupervised, audit, paused, unknown, no trigger", async () => {
  const cwd = mkBoundaryCwd();
  try {
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: x.\nNext task: y.\nVerdicts: none.\nWatch-outs: none." }));
    const cases: Array<[string, Parameters<typeof maybeCompactTranscriptAtBoundary>[1], Parameters<typeof boundaryCtx>[1]]> = [
      ["below threshold", LIVE_FLAGS, { tokens: 150_000 }],
      ["busy host", LIVE_FLAGS, { tokens: 250_000, idle: false }],
      ["pending messages", LIVE_FLAGS, { tokens: 250_000, pending: true }],
      ["nothing supervised", { supervising: false, auditInFlight: false, paused: false }, { tokens: 250_000 }],
      ["audit in flight", { supervising: true, auditInFlight: true, paused: false }, { tokens: 250_000 }],
      ["supervisor paused", { supervising: true, auditInFlight: false, paused: true }, { tokens: 250_000 }],
      ["unknown tokens", LIVE_FLAGS, {}],
      ["no compact trigger", LIVE_FLAGS, { tokens: 250_000, compact: null }],
    ];
    for (const [name, flags, opts] of cases) {
      const { ctx, compacts } = boundaryCtx(cwd, opts);
      assert.equal(await maybeCompactTranscriptAtBoundary(ctx, flags), false, name);
      assert.equal(compacts.length, 0, `${name}: no trigger`);
    }
    assert.ok(!fs.existsSync(compactorBoundaryMarkerPath(cwd)), "no episode marker from quiet boundaries");
    assert.ok(!ledgerTypes(cwd).includes("compactor_transcript_firing"), "no firing ledgered");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.38.105 the boundary never re-arms the starvation path's brief one-shot", async () => {
  // A starvation fire at 190k sits below the 200k boundary threshold. The
  // boundary must not clear that marker while evaluating — doing so would
  // break the one-shot the compactor-handoff tests pin.
  const cwd = mkBoundaryCwd();
  try {
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    fs.writeFileSync(compactorFiredMarkerPath(cwd), JSON.stringify({ at: new Date().toISOString() }) + "\n");
    const { ctx } = boundaryCtx(cwd, { tokens: 190_000 });
    assert.equal(await maybeCompactTranscriptAtBoundary(ctx, LIVE_FLAGS), false);
    assert.ok(fs.existsSync(compactorFiredMarkerPath(cwd)), "the starvation marker survives the boundary");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a synchronous compact throw releases the boundary for ordinary continuation", async () => {
  const cwd = mkBoundaryCwd();
  try {
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: continue." }));
    const { ctx } = boundaryCtx(cwd, { tokens: 205_508, compact: () => { throw new Error("summarizer unavailable"); } });
    assert.equal(maybeCompactTranscriptAtBoundary(ctx, LIVE_FLAGS), false, "no launched attempt owns the next turn");
    assert.ok(fs.existsSync(compactorBoundaryMarkerPath(cwd)), "a failed attempt retains retry suppression");
    assert.equal(maybeCompactTranscriptAtBoundary(ctx, LIVE_FLAGS), false);
    await settleBrief();
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});


test("successful compaction rearms after grace even when context never falls below half the target", async () => {
  const cwd = mkBoundaryCwd(), originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Continue work." }));
    const first = boundaryCtx(cwd, { tokens: 259650 });
    assert.equal(maybeCompactTranscriptAtBoundary(first.ctx, LIVE_FLAGS), true);
    (first.compacts[0] as { onComplete(): void }).onComplete();
    const grown = boundaryCtx(cwd, { tokens: 685727 });
    assert.equal(maybeCompactTranscriptAtBoundary(grown.ctx, LIVE_FLAGS), false, "success cannot immediately cause a compaction loop");
    now += 180001;
    assert.equal(maybeCompactTranscriptAtBoundary(grown.ctx, LIVE_FLAGS), false, "rearming yields one ordinary work boundary");
    assert.equal(fs.existsSync(compactorBoundaryMarkerPath(cwd)), false, "completed attempt must not suppress future opportunities forever");
    assert.equal(maybeCompactTranscriptAtBoundary(grown.ctx, LIVE_FLAGS), true);
    assert.equal(grown.compacts.length, 1);
  } finally { Date.now = originalNow; await settleBrief(); fs.rmSync(cwd, { recursive: true, force: true }); }
});


test("legacy successful markers rearm from durable completion, while failed attempts stay one-shot", async () => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const success = mkBoundaryCwd(), failure = mkBoundaryCwd();
  try {
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Continue work." }));
    const old = boundaryCtx(success, { tokens: 259650 });
    assert.equal(maybeCompactTranscriptAtBoundary(old.ctx, LIVE_FLAGS), true);
    seedState(success, { goal: null, lastCompactionAt: now + 1 });
    const failed = boundaryCtx(failure, { tokens: 250000 });
    assert.equal(maybeCompactTranscriptAtBoundary(failed.ctx, LIVE_FLAGS), true);
    const callbacks = failed.compacts[0] as { onError(e: Error): void; onComplete(): void };
    callbacks.onError(new Error("summarizer output cap"));
    callbacks.onComplete(); // a late callback cannot turn a failed attempt into success
    now += 180002;
    assert.equal(maybeCompactTranscriptAtBoundary(boundaryCtx(success, { tokens: 685727 }).ctx, LIVE_FLAGS), false);
    assert.equal(fs.existsSync(compactorBoundaryMarkerPath(success)), false);
    assert.equal(maybeCompactTranscriptAtBoundary(boundaryCtx(success, { tokens: 685727 }).ctx, LIVE_FLAGS), true);
    assert.equal(maybeCompactTranscriptAtBoundary(boundaryCtx(failure, { tokens: 700000 }).ctx, LIVE_FLAGS), false);
    assert.ok(fs.existsSync(compactorBoundaryMarkerPath(failure)));
    assert.ok(!ledgerTypes(failure).includes("compactor_transcript_done"));
  } finally { Date.now = originalNow; await settleBrief(); fs.rmSync(success, { recursive: true, force: true }); fs.rmSync(failure, { recursive: true, force: true }); }
});
