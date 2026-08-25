// pi-goal-list-loop-audit — v0.35.62
// tests/subagent-host-boundary.test.ts
//
// Host/worker boundary regressions. pi-subagents binds extensions inside child
// sessions, including persistent children; those contexts must never claim or
// mutate the MAIN goal/list state plane. Subagent lifecycle telemetry is a
// separate host event-bus path and must remain visible.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlyRegisterAgentTools,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, invalidateHostSession, makeMockCtx, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

function hostCtx(cwd: string, name = "main-host"): MockCtx {
  return makeMockCtx(cwd, {
    sessionManager: {
      name,
      getSessionFile: () => path.join(cwd, `${name}.jsonl`),
      getSessionId: () => `${name}-session-1`,
    },
  });
}

function workerCtx(cwd: string, sessionManager: unknown): MockCtx {
  const ctx = makeMockCtx(cwd, { sessionManager });
  // pi-subagents' AgentSession binds extensions with the default headless
  // print context. This is the boundary signal independent of persistence:
  // both in-memory and persist_session children must remain workers.
  (ctx as any).mode = "print";
  ctx.hasUI = false;
  return ctx;
}

afterEach(() => {
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
});

test("v0.35.62: a worker cannot be the first claimant, while host telemetry still records Explore", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  const before = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  const worker = workerCtx(cwd, { name: "Explore", getSessionFile: () => undefined });

  await pi.fire("session_start", { reason: "startup" }, worker);
  assert.equal(
    fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"),
    before,
    "a child session_start does not register the root, restore state, or write host ledger entries",
  );

  const host = hostCtx(cwd);
  try {
    await pi.fire("session_start", { reason: "startup" }, host);
    // Co-resident Bun test files can share the module singleton's lazy tool
    // flag while each owns a fresh MockPi registry. Pin the host-side
    // registration explicitly; the boundary under test is admission, not
    // the unrelated per-fixture registry cache.
    __testOnlyRegisterAgentTools(pi.api);
    const added = await pi.runTool("list_add", { items: ["host-owned item — done when pinned"] }, host);
    assert.doesNotMatch(added.content[0]!.text, /only the MAIN session owns/);
    assert.equal(readState(cwd).goal?.objective.includes("host-owned item"), true);

    // The child remains a worker, but the MAIN event bus keeps the legitimate
    // visibility path alive and durable.
    pi.emitBus("subagents:started", { id: "explore-1", type: "Explore", description: "trace host boundary" });
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"type":"subagent_session"/);
    assert.match(ledger, /explore-1/);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, host).catch(() => {});
  }
});

test("v0.35.62: foreign slash commands cannot mutate the host list", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  const host = hostCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, host);
  __testOnlyRegisterAgentTools(pi.api);
  const worker = workerCtx(cwd, { name: "Explore" });

  try {
    await pi.command("list", "add foreign command item — done when blocked", worker);
    assert.equal(
      Boolean(readState(cwd).goal?.objective.includes("foreign command item"))
        || Boolean(readState(cwd).list?.some((item) => item.objective.includes("foreign command item"))),
      false,
      "a child slash command cannot enqueue or activate host work",
    );
    assert.ok(worker.ui.matching("only the MAIN session owns").length >= 1);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, host).catch(() => {});
  }
});

test("v0.35.62: persistent workers cannot masquerade as silent host successors", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  const host = hostCtx(cwd, "original-host");
  await pi.fire("session_start", { reason: "startup" }, host);
  __testOnlyRegisterAgentTools(pi.api);
  invalidateHostSession(pi, host);
  const persistentWorker = workerCtx(cwd, {
    name: "persistent-Explore",
    getSessionFile: () => path.join(cwd, "persistent-child.jsonl"),
    getSessionDir: () => cwd,
    getSessionId: () => "persistent-child-1",
  });

  try {
    const refused = await pi.runTool("list_add", { items: ["persistent child mutation — done when blocked"] }, persistentWorker);
    assert.match(refused.content[0]!.text, /only the MAIN session owns/);
    assert.equal(
      Boolean(readState(cwd).goal?.objective.includes("persistent child mutation"))
        || Boolean(readState(cwd).list?.some((item) => item.objective.includes("persistent child mutation"))),
      false,
    );

    // A real file-backed replacement remains admitted, preserving the silent
    // host lifecycle path needed by existing reload/rebind behavior.
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    const replacement = hostCtx(cwd, "replacement-host");
    const accepted = await pi.runTool("list_add", { items: ["legitimate successor item — done when pinned"] }, replacement);
    assert.doesNotMatch(accepted.content[0]!.text, /only the MAIN session owns/);
    assert.equal(readState(cwd).goal?.objective.includes("legitimate successor item"), true);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    await pi.fire("session_shutdown", { reason: "quit" }, host).catch(() => {});
  }
});
