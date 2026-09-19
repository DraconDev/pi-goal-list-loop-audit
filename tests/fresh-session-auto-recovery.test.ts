// pi-goal-list-loop-audit — v0.34.119
// tests/fresh-session-auto-recovery.test.ts
//
// Pins the stale-ctx recovery boundary. Pi's compact subsystem throws a
// stale signature and only /new clears the cached context. The public event
// ExtensionContext does NOT expose newSession; that method exists only on
// ExtensionCommandContext. v0.34.117 incorrectly cast ExtensionAPI and
// claimed automatic recovery, but the real SDK has no ExtensionAPI.newSession.
// v0.34.119 must be honest: use a future command-capable context if pi exposes
// one, otherwise fall back to the terminal park with /new guidance.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attemptFreshSessionRecovery } from "../extensions/goal-recovery.ts";

const GOAL_RECOVERY_SRC = fs.readFileSync("extensions/goal-recovery.ts", "utf-8");
const GOAL_CONTINUATION_SRC = fs.readFileSync("extensions/goal-continuation.ts", "utf-8");
const GOAL_LOOP_SRC = fs.readFileSync("extensions/goal-loop.ts", "utf-8");

test("attemptFreshSessionRecovery: helper checks the actual context capability, not ExtensionAPI", () => {
  assert.match(GOAL_RECOVERY_SRC, /export function attemptFreshSessionRecovery\(ctx: ExtensionContext, where: string\): boolean/);
  assert.match(GOAL_RECOVERY_SRC, /const freshCtx = ctx as FreshSessionContext/);
  assert.doesNotMatch(GOAL_RECOVERY_SRC, /api\.newSession\(\)/, "ExtensionAPI has no public newSession method");
  assert.match(GOAL_RECOVERY_SRC, /startNewSession\.call\(freshCtx, \{/, "forward-compatible call only when the host supplies a command-capable context");
  assert.match(GOAL_RECOVERY_SRC, /withSession:/, "replacement work must use the fresh context supplied by the host");
  assert.match(GOAL_RECOVERY_SRC, /fresh_session_recovery_triggered/, "ledger event when a host actually exposes the recovery capability");
  assert.match(GOAL_RECOVERY_SRC, /fresh_session_recovery_skipped/, "ledger event when the event context cannot replace the session");
});

test("attemptFreshSessionRecovery: returns false when the event context lacks newSession", () => {
  assert.match(GOAL_RECOVERY_SRC, /typeof startNewSession !== "function"/);
  assert.match(GOAL_RECOVERY_SRC, /event context has no newSession; pi exposes it only on ExtensionCommandContext/);
  assert.match(GOAL_RECOVERY_SRC, /return false;/);
});

test("runtime: current event-shaped context skips because pi does not expose newSession there", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-stale-event-"));
  const notices: string[] = [];
  const ctx = { cwd, ui: { notify: (message: string) => notices.push(message) } } as any;
  assert.equal(attemptFreshSessionRecovery(ctx, "test-event-context"), false);
  assert.equal(notices.length, 0, "the helper leaves the terminal path responsible for the single user-facing warning");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /event context has no newSession/);
});

test("runtime: a future command-capable host context is actually invoked and ledgered", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-stale-command-"));
  const notices: string[] = [];
  let called = 0;
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
    newSession: (options?: { withSession?: (ctx: any) => void | Promise<void> }) => {
      called += 1;
      options?.withSession?.({
        cwd,
        ui: { notify: (message: string) => notices.push(message) },
      });
    },
  } as any;
  assert.equal(attemptFreshSessionRecovery(ctx, "test-command-context"), true);
  assert.equal(called, 1);
  assert.equal(notices.length, 1);
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /fresh_session_recovery_triggered/);
});

test("runtime: rejected or callback-free async recovery fails closed", async () => {
  for (const [label, newSession] of [
    ["reject", () => Promise.reject(new Error("host rejected replacement"))],
    ["no-callback", () => Promise.resolve(undefined)],
  ] as const) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `glla-stale-${label}-`));
    const ctx = {
      cwd,
      ui: { notify: () => {} },
      newSession,
    } as any;
    assert.equal(attemptFreshSessionRecovery(ctx, `test-${label}`), false, `${label} must not claim recovery`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /fresh_session_recovery_failed/, `${label} records failed recovery`);
  }
});

test("every stale-ctx send site routes through attemptFreshSessionRecovery before falling back to goStaleTerminal", () => {
  // Five sites observed in the codebase; each must try auto-recovery first.
  const sites = [
    { where: "retryContinuationDispatch", in: GOAL_CONTINUATION_SRC },
    { where: "sendContinuation", in: GOAL_CONTINUATION_SRC },
    { where: "sendStallEscalation", in: GOAL_CONTINUATION_SRC },
    { where: "sendLengthContinue", in: GOAL_CONTINUATION_SRC },
    { where: "sendLoopTurn", in: GOAL_LOOP_SRC },
  ];
  for (const { where, in: src } of sites) {
    assert.match(
      src,
      new RegExp(`if \\(!attemptFreshSessionRecovery\\(ctx, "${where}"\\)\\) goStaleTerminal\\(ctx, "${where}"\\);`),
      `${where} must try auto-recovery before the terminal park`,
    );
  }
});

test("stale display guidance names /new, not /reload, for the actual cached-ctx wedge", () => {
  const display = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
  assert.match(display, /stale handle · \/new \(or a fresh session_start\) rebinds/);
  assert.doesNotMatch(display, /stale handle · \/reload \(or a fresh session_start\) rebinds/);
});
