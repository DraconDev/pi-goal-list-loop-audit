// v0.38.10 (emergency compactor handoff): chain parity, plan-B matrix,
// one-shot transition, behavioral spawn/skip/banner/page pins.
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  COMPACTOR_BRIEF_MAX_CHARS,
  COMPACTOR_KILL_GRACE_MS,
  __testOnlyResetCompactor,
  __testOnlySetSpawnWorker,
  buildBriefPacket,
  claimCompactorRefuseTransition,
  readHandoffBriefExcerpt,
  runGoalCompactionIfDue,
} from "../extensions/goal-compactor.js";
import {
  MAX_COMPACTOR_FALLBACKS,
  PLAN_B_MAX_ATTEMPTS,
  resolveCompactorChain,
  resolveCompactorModel,
  selectPlanBCandidates,
} from "../extensions/compactor-model.js";
import { buildPostCompactResync } from "../extensions/goal-continuation.js";
import { buildLoadHoldRecoveryLines } from "../extensions/goal-loop-display.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { clearContinuationTimer, resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

const G = globalThis as any;
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalSettings(value: Record<string, unknown>): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(value));
}
afterEach(() => {
  setGlobalSettings({ aggressiveMode: false });
  __testOnlyResetCompactor();
  __testOnlySetSpawnWorker(undefined);
  if (typeof G.onCompactionLanded === "function") G.onCompactionLanded();
});

// ── plan-B matrix (pure) ──────────────────────────────────────────────

function fakeRegistry(models: any[]) {
  return {
    getAvailable: () => models,
    hasConfiguredAuth: (m: any) => m.authed !== false,
  };
}
function m(ref: string, over: Record<string, unknown> = {}): any {
  const [provider, ...rest] = ref.split("/");
  return { provider, id: rest.join("/"), name: rest.join("/"), contextWindow: 500_000, cost: { input: 0, output: 0 }, authed: true, ...over };
}

test("plan B picks verified free big-context, largest first, max two", () => {
  const found = selectPlanBCandidates(
    fakeRegistry([m("p/small", { contextWindow: 150_000 }), m("p/big", { contextWindow: 1_000_000 }), m("p/mid", { contextWindow: 500_000 })]),
    { needTokens: 120_000, excludeRefs: [] },
  );
  assert.deepEqual(found.map((f) => f.ref), ["p/big", "p/mid"]);
  assert.equal(PLAN_B_MAX_ATTEMPTS, 2);
});

test("plan B disqualifies unknown metadata, paid, unauthed, forbidden, stuck", () => {
  const found = selectPlanBCandidates(
    fakeRegistry([
      m("p/unknown-window", { contextWindow: undefined }),
      m("p/unknown-cost", { cost: undefined }),
      m("p/paid", { cost: { input: 1, output: 2 } }),
      m("p/noauth", { authed: false }),
      m("p/banned", {}),
      m("anthropic/mock-model", {}),
      m("p/good", {}),
    ]),
    { needTokens: 100_000, excludeRefs: ["anthropic/mock-model"], forbiddenModels: ["banned"] },
  );
  assert.deepEqual(found.map((f) => f.ref), ["p/good"]);
});

test("plan B returns [] when the registry throws", () => {
  assert.deepEqual(
    selectPlanBCandidates({ getAvailable: () => { throw new Error("down"); }, hasConfiguredAuth: () => true }, { needTokens: 1, excludeRefs: [] }),
    [],
  );
});

// ── chain parity + transition + scope ─────────────────────────────────

test("compactor chain normalizes and caps 0-10 exactly like drafter", () => {
  assert.equal(MAX_COMPACTOR_FALLBACKS, 10);
  const ctx = { modelRegistry: fakeRegistry([]), cwd: tmpCwd() } as any;
  const refs = Array.from({ length: 12 }, (_, i) => `p/m${i}`);
  const { configuredRefs } = resolveCompactorChain(ctx, { compactorModel: "p/primary", compactorModelFallbacks: [...refs, "P/M0", "  "] });
  assert.equal(configuredRefs.length, 10);
  assert.equal(configuredRefs[0], "p/primary");
});

test("compactor chain never leases the stuck session model", () => {
  const ctx = { model: { provider: "anthropic", id: "mock-model" }, modelRegistry: fakeRegistry([]), cwd: tmpCwd() } as any;
  (ctx.modelRegistry as any).find = () => undefined;
  const { candidates } = resolveCompactorChain(ctx, { compactorModel: "anthropic/mock-model", compactorModelFallbacks: [] });
  assert.equal(candidates.length, 0, "stuck model configured explicitly still never selected");
});

test("refuse transition fires exactly once per episode", () => {
  __testOnlyResetCompactor();
  assert.equal(claimCompactorRefuseTransition(false), false);
  assert.equal(claimCompactorRefuseTransition(true), true, "first refuse of the episode");
  assert.equal(claimCompactorRefuseTransition(true), false, "same episode stays silent");
  assert.equal(claimCompactorRefuseTransition(false), false, "recovery re-arms");
  assert.equal(claimCompactorRefuseTransition(true), true, "next episode fires again");
});

test("audit 2026-09-06: compactor one-shot survives a restart mid-episode", async () => {
  const cwd = tmpCwd();
  let spawns = 0;
  const ctx = { cwd, modelRegistry: fakeRegistry([m("p/big")]) } as any;
  const deps = {
    settings: { compactorModelFallbacks: [] },
    needTokens: 10,
    spawnWorker: async () => { spawns++; return { ok: true, brief: "brief words" }; },
  } as any;
  const first = await runGoalCompactionIfDue(ctx, true, deps);
  assert.equal(first.fired, true, "first refuse of the episode fires");
  assert.equal(spawns, 1);
  // Simulate a restart: in-memory state is fresh (armed) but the disk
  // marker says this episode already fired.
  __testOnlyResetCompactor();
  const second = await runGoalCompactionIfDue(ctx, true, deps);
  assert.equal(second.fired, false, "restart mid-episode stays silent");
  assert.equal(spawns, 1, "no second spawn");
  // Recovery re-arms the next episode (marker removed).
  const rearm = await runGoalCompactionIfDue(ctx, false, deps);
  assert.equal(rearm.fired, false);
  __testOnlyResetCompactor();
  const third = await runGoalCompactionIfDue(ctx, true, deps);
  assert.equal(third.fired, true, "next episode fires again");
  assert.equal(spawns, 2);
});

test("audit 2026-09-06: worker timeout escalates SIGTERM to SIGKILL", () => {
  assert.equal(COMPACTOR_KILL_GRACE_MS, 5_000);
  const source = fs.readFileSync(new URL("../extensions/goal-compactor.ts", import.meta.url), "utf-8");
  assert.match(source, /child\.kill\("SIGTERM"\)/);
  assert.match(source, /child\.kill\("SIGKILL"\)/, "SIGTERM-only kill leaves zombies");
  assert.match(source, /COMPACTOR_KILL_GRACE_MS/);
});

test("brief scope: packet bounded, sections present, worker tool-less", () => {
  const packet = buildBriefPacket({
    objective: "o".repeat(9000),
    status: "active",
    pendingTasks: [{ id: "t1", title: "do it" }],
    lastVerdict: { label: "disapproved", at: "now", feedback: "fix x" },
    ledgerTail: ["a", "b"],
  });
  assert.ok(packet.length <= 6000, `packet capped, got ${packet.length}`);
  assert.match(packet, /\[GOAL STATE PACKET/);
  assert.match(packet, /Pending tasks:/);
  assert.match(packet, /fix x/);
  assert.equal(COMPACTOR_BRIEF_MAX_CHARS, 2000);
  const worker = fs.readFileSync("scripts/goal-compactor-worker.mjs", "utf-8");
  assert.match(worker, /"--no-tools"/, "worker runs tool-less");
  assert.ok(!worker.includes("--tools"), "no tool allowlist at all");
});

test("resync carries the brief excerpt only when present", () => {
  assert.match(buildPostCompactResync("brief words here"), /Handoff brief: brief words here/);
  assert.ok(!/Handoff brief/.test(buildPostCompactResync()), "no brief means no handoff line");
});

test("recovery banner quotes the handoff excerpt", () => {
  const lines = buildLoadHoldRecoveryLines({
    objective: "o", status: "active", nextTask: null,
    tally: { total: 0, approvals: 0, disapprovals: 0, lastAt: null, lastLabel: null },
    resumeCommand: "/goal resume", briefExcerpt: "the saver saw three tasks",
  });
  assert.ok(lines.some((l) => l.startsWith("handoff: the saver")), JSON.stringify(lines));
});

// ── behavioral ────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await tick(60);
  }
}

const STARVED = {
  messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "length", usage: { output: 1 } }],
};

async function starvedSession(opts: {
  settings: Record<string, unknown>;
  registry: any;
  spawn?: (script: string, jobDir: string, request: Record<string, unknown>) => Promise<{ ok: boolean; brief?: string; error?: string }>;
  execHandler?: MockPi["execHandler"];
  seedBrief?: string;
  model?: unknown;
}) {
  const cwd = tmpCwd();
  setGlobalSettings({ autoResume: true, aggressiveMode: false, ...opts.settings });
  seedState(cwd, { goal: seedGoal({ objective: "compactor handoff item — done when the brief path is proven" }), list: [] });
  if (opts.seedBrief !== undefined) {
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-glla", "handoff-brief.md"), opts.seedBrief + "\n");
  }
  const pi = new MockPi();
  if (opts.execHandler) pi.execHandler = opts.execHandler;
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `comp-${Date.now()}-${Math.random()}` } });
  (ctx as any).modelRegistry = opts.registry;
  if (opts.model !== undefined) (ctx as any).model = opts.model;
  (ctx as any).getContextUsage = () => ({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
  if (opts.spawn) __testOnlySetSpawnWorker(opts.spawn);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(60);
  resetContinuationDispatchState(cwd);
  clearContinuationTimer();
  return { cwd, pi, ctx };
}

async function engageTwice(pi: MockPi, ctx: any): Promise<void> {
  await pi.fire("agent_end", STARVED, ctx);
  await tick(120);
  await pi.fire("agent_end", STARVED, ctx);
  await tick(120);
}

test("refuse engages the compactor once with the chain model + packet scope", async () => {
  const spawns: Array<{ script: string; request: Record<string, unknown> }> = [];
  const execs: Array<{ cmd: string; args: string[] }> = [];
  const { cwd, pi, ctx } = await starvedSession({
    settings: { compactorModel: "provider/saver", notifyCmd: "true" },
    registry: { find: (p: string, id: string) => ({ provider: p, id }), hasConfiguredAuth: () => true, getAvailable: () => [] },
    spawn: async (script, _job, request) => {
      spawns.push({ script, request });
      return { ok: true, brief: "Objective: saver brief.\nNext task: t0.\nVerdicts: none.\nWatch-outs: none." };
    },
    execHandler: (cmd, args) => {
      execs.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  try {
    await engageTwice(pi, ctx);
    await waitFor(() => fs.existsSync(path.join(cwd, ".pi-glla", "handoff-brief.md")));
    assert.equal(spawns.length, 1, "exactly one spawn for the episode");
    assert.match(spawns[0]!.script, /goal-compactor-worker\.mjs$/);
    assert.equal((spawns[0]!.request as any).model, "provider/saver", "chain model, never the stuck session model");
    assert.match(String((spawns[0]!.request as any).prompt), /^\[GOAL STATE PACKET/, "disk-state packet scope");
    assert.match(String((spawns[0]!.request as any).prompt), /compactor handoff item/);
    await pi.fire("agent_end", STARVED, ctx);
    await tick(200);
    assert.equal(spawns.length, 1, "third engage stays silent");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"compactor_spawned"/);
    assert.match(ledger, /"compactor_brief_written"/);
    assert.match(ledger, /"via":"configured"/);
    const brief = fs.readFileSync(path.join(cwd, ".pi-glla", "handoff-brief.md"), "utf8");
    assert.ok(brief.length <= COMPACTOR_BRIEF_MAX_CHARS + 1);
    assert.equal(ctx.ui.matching("handoff brief ready").length, 1);
    const pages = execs.filter((e) => e.args.join(" ").includes("handoff brief"));
    assert.equal(pages.length, 1, "exactly one desktop page");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("chain empty falls back to the verified free registry model", async () => {
  const spawns: string[] = [];
  const big = { provider: "p", id: "big", name: "big", contextWindow: 500_000, cost: { input: 0, output: 0 } };
  const { cwd, pi, ctx } = await starvedSession({
    settings: {},
    registry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [
        { provider: "p", id: "small", name: "small", contextWindow: 50_000, cost: { input: 0, output: 0 } },
        { provider: "p", id: "rich", name: "rich", contextWindow: 900_000, cost: { input: 5, output: 5 } },
        big,
      ],
    },
    spawn: async (_s, _j, request) => {
      spawns.push(String((request as any).model));
      return { ok: true, brief: "plan-b brief" };
    },
  });
  try {
    await engageTwice(pi, ctx);
    await waitFor(() => spawns.length > 0);
    assert.deepEqual(spawns, ["p/big"], "small window and paid model skipped");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"compactor_plan_b_select"/);
    assert.match(ledger, /"toRef":"p\/big"/);
    assert.match(ledger, /"via":"plan-b"/);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("no model anywhere skips silently with ledger, ladder still paints", async () => {
  let spawned = 0;
  const { pi, ctx } = await starvedSession({
    settings: {},
    registry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    spawn: async () => {
      spawned++;
      return { ok: true, brief: "unreachable" };
    },
  });
  try {
    await engageTwice(pi, ctx);
    await tick(300);
    assert.equal(spawned, 0, "nothing to spawn");
    const ledger = fs.readFileSync((ctx as any).cwd + "/.pi-glla/active.jsonl", "utf8");
    assert.match(ledger, /"compactor_skipped_no_model"/);
    assert.equal(ctx.ui.matching("/new, then /goal resume").length, 2, "one ladder per engage; the skip never suppresses it");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("notifyCmd off keeps the brief, drops the page", async () => {
  const execs: unknown[] = [];
  const { cwd, pi, ctx } = await starvedSession({
    settings: { compactorModel: "provider/saver", notifyCmd: "off" },
    registry: { find: (p: string, id: string) => ({ provider: p, id }), hasConfiguredAuth: () => true, getAvailable: () => [] },
    spawn: async () => ({ ok: true, brief: "quiet brief" }),
    execHandler: (cmd, args) => {
      execs.push([cmd, args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  try {
    await engageTwice(pi, ctx);
    await waitFor(() => fs.existsSync(path.join(cwd, ".pi-glla", "handoff-brief.md")));
    assert.equal(execs.length, 0, "notifyCmd off means no page");
    assert.equal(ctx.ui.matching("handoff brief ready").length, 1, "in-session banner still paints");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("reload with a brief on disk quotes the handoff in the banner", async () => {
  const cwd = tmpCwd();
  setGlobalSettings({ aggressiveMode: false });
  seedState(cwd, { goal: {
    id: "20260903000000-cmp01",
    objective: "Stuck goal with a saver brief",
    status: "paused",
    policy: "goal",
    autoContinue: false,
    taskList: { tasks: [{ id: "t1", title: "Pending after rescue", status: "pending" }] },
    auditHistory: [],
  }, list: [] });
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "handoff-brief.md"), "Objective: saver saw it.\nNext task: t1.\n");
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `cmpbn-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  try {
    const banner = ctx.ui.matching("recovered from disk");
    assert.equal(banner.length, 1);
    assert.match(banner[0]?.message ?? "", /handoff: Objective: saver saw it\./, "warm handoff, not cold restart");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("resolveCompactorModel end to end prefers chain over plan B", () => {
  const cwd = tmpCwd();
  seedState(cwd, { list: [] });
  const ctx = {
    cwd,
    model: { provider: "anthropic", id: "mock-model" },
    modelRegistry: fakeRegistry([m("p/free-big")]),
  } as any;
  (ctx.modelRegistry as any).find = (p: string, id: string) => ({ provider: p, id });
  (ctx.modelRegistry as any).hasConfiguredAuth = () => true;
  const withChain = resolveCompactorModel(ctx, { compactorModel: "provider/saver", compactorModelFallbacks: [] }, 150_000);
  assert.equal(withChain.candidates[0]?.via, "configured");
  const planBOnly = resolveCompactorModel(ctx, { compactorModelFallbacks: [] }, 150_000);
  assert.equal(planBOnly.candidates[0]?.via, "plan-b");
  assert.equal(planBOnly.candidates[0]?.ref, "p/free-big");
});
