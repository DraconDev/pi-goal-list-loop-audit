// pi-goal-list-loop-audit — same session, new SessionManager object.
//
// Field incident (Screenshot_20260917_195237): the MAIN session was refused
// with "you are running in a subagent session", and a refresh fixed it. pi
// can deliver the SAME resumed session with a NEW SessionManager object, so
// the foreign-session guard must compare session identity (getSessionId),
// not object identity — the same way the lifecycle path already does with
// sameSessionIdentity (goal-activation.ts). Object identity strands the main
// session as foreign until a refresh rebinds the owner.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function managedSession(id: string, tag: string): unknown {
  // Same logical session, distinct manager object, no session-file probe —
  // the exact shape where tool-call absorption cannot save the caller and
  // only the identity comparison decides.
  return { name: tag, getSessionId: () => id };
}

async function boot(pi: MockPi, cwd: string, manager: unknown): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: manager });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return ctx;
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("195237: same session id on a new manager object is the owner, not a subagent", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "blocked on the sudo-mode auth for the live demo",
      pauseSuggestedAction: "Complete the auth, then run /goal resume",
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const owner = await boot(pi, cwd, managedSession("session-abc", "owner-before-refresh"));
  try {
    const reborn = makeMockCtx(cwd, { sessionManager: managedSession("session-abc", "owner-after-swap") });
    const result = await pi.runTool("resume_goal", { reason: "user waived the demo" }, reborn) as {
      content: Array<{ text: string }>;
    };
    assert.doesNotMatch(
      result.content[0]!.text,
      /subagent session/,
      "the same logical session is never told it is a subagent",
    );
    assert.match(result.content[0]!.text, /active again/, "the owner call lands");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, owner);
  }
});

test("v0.38.92: a dethroned main is told about the lost root, never called a subagent", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "blocked on the sudo-mode auth for the live demo",
      pauseSuggestedAction: "Complete the auth, then run /goal resume",
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const owner = await boot(pi, cwd, managedSession("session-abc", "owner-before-steal"));
  try {
    // Another live session takes the root: the owner is now dethroned.
    (globalThis as any).processOwnerDeniedCwd = cwd;
    try {
      const reborn = makeMockCtx(cwd, { sessionManager: managedSession("session-abc", "owner-after-steal") });
      const result = await pi.runTool("resume_goal", { reason: "user waived the demo" }, reborn) as {
        content: Array<{ text: string }>;
      };
      assert.doesNotMatch(
        result.content[0]!.text,
        /subagent session/,
        "a dethroned main is never told it is a subagent",
      );
      assert.match(
        result.content[0]!.text,
        /holds this folder's state root/,
        "the refusal names the lost root",
      );
      assert.match(
        result.content[0]!.text,
        /not a subagent refusal/,
        "the refusal anticipates the confusion",
      );
    } finally {
      (globalThis as any).processOwnerDeniedCwd = null;
    }
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, owner);
  }
});

test("195237: a genuinely different session is still refused", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "blocked on the sudo-mode auth for the live demo",
      pauseSuggestedAction: "Complete the auth, then run /goal resume",
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const owner = await boot(pi, cwd, managedSession("session-abc", "owner-before-refresh"));
  try {
    const stranger = makeMockCtx(cwd, { sessionManager: managedSession("session-xyz", "someone-else") });
    const result = await pi.runTool("resume_goal", { reason: "user waived the demo" }, stranger) as {
      content: Array<{ text: string }>;
    };
    assert.match(
      result.content[0]!.text,
      /subagent session/,
      "a different session id stays foreign and fails closed",
    );
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, owner);
  }
});
