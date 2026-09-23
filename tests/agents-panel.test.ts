// pi-goal-list-loop-audit — v0.35.29
// tests/agents-panel.test.ts
//
// GitHub issue #15 implementation: /glla agents panel + child transcript
// tail + detailed widget rows, per docs/DESIGN-subagent-visibility.md (scope
// agreed 2026-08-22: panel + tail + widget projection; live stream rejected).
//
// Rendering is pure and fixture-tested here; the command dispatch and the
// widget append are exercised through the real MockPi surfaces.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { upsertSubagentHangProbe, markSubagentHangProgress, endSubagentHangProbe } from "../extensions/goal-heartbeat.js";
import { renderAgentsPanel, renderAgentsWidgetLine, renderAgentsWidgetLines, tailChildTranscript, formatTranscriptEntry, truncate, TRANSCRIPT_SCAN_MAX_BYTES, type AgentsPanelRow } from "../extensions/goal-agents-panel.js";
import { buildStatusText, buildWidgetLines } from "../extensions/goal-loop-display.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function row(overrides: Partial<AgentsPanelRow> = {}): AgentsPanelRow {
  return {
    recordId: "rec-1",
    agentType: "explore",
    summary: "map model picker",
    status: "running",
    phase: "active",
    spawnedAt: NOW - 4 * MIN,
    startedAt: NOW - 4 * MIN,
    lastProgressAt: NOW - 10_000,
    toolUses: 18,
    outputTokens: 2100,
    silentMs: 10_000,
    evidence: "live",
    ...overrides,
  };
}

const pi = new MockPi();
activate(pi.api);

function gllaCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: { name: "main-session-manager-agents-panel" } });
}

test("v0.35.29 #15: the panel ranks hung > running > ended and caps at 20 rows with a notice", () => {
  const rows = [
    row({ recordId: "r-run", status: "running", silentMs: 5_000 }),
    row({ recordId: "r-hung", agentType: "plan", summary: "audit contract", status: "hung", silentMs: 26 * MIN, evidence: "record-frozen" }),
    row({ recordId: "r-end", status: "ended", endedOk: true, endedAt: NOW - MIN }),
    ...Array.from({ length: 25 }, (_, i) => row({ recordId: `r-fill-${i}`, status: "ended" as const, endedOk: true, endedAt: NOW - (i + 2) * MIN })),
  ];
  const lines = renderAgentsPanel(rows, NOW, true);
  const joined = lines.join("\n");
  // Hung first with its liveness hint; running next; ended after.
  assert.ok(joined.indexOf("HUNG?") < joined.indexOf("RUNNING"), "hung sorts above running");
  assert.ok(joined.indexOf("RUNNING") < joined.indexOf("ENDED ok"), "running sorts above ended");
  assert.match(joined, /record-frozen/, "evidence class is shown for hung children");
  assert.match(joined, /check the Agents panel/, "the liveness hint rides hung rows");
  assert.match(joined, /more \(oldest ended trimmed — cap 20\)/, "the cap notice names the trim");
});

test("v0.35.29 #15: empty state explains where evidence comes from", () => {
  const lines = renderAgentsPanel([], NOW, false);
  assert.match(lines.join("\n"), /No subagents tracked yet/);
  assert.match(lines.join("\n"), /event probes/);
});

test("v0.35.64: the panel makes a child-specific abort request visible", () => {
  const lines = renderAgentsPanel([
    row({ status: "hung", action: "abort-requested", silentMs: 31 * MIN, evidence: "record-frozen" }),
  ], NOW, true).join("\n");
  assert.match(lines, /ABORTING/);
  assert.match(lines, /child-specific abort requested/);
  assert.doesNotMatch(lines, /parent was aborted/);
});

test("v0.35.29 #15: the compact worker summary hides at zero and warns on the least-live child", () => {
  assert.equal(renderAgentsWidgetLine([row({ status: "ended", phase: "ended", endedOk: true })]), undefined, "all-ended → hidden");
  const line = renderAgentsWidgetLine([
    row({ recordId: "a", silentMs: MIN }),
    row({ recordId: "b", agentType: "plan", status: "hung", phase: "hung", silentMs: 26 * MIN }),
  ]);
  assert.ok(line!.includes("2 agents"));
  assert.ok(line!.includes("plan quiet 26m"));
  assert.ok(line!.endsWith("⚠"), "hung busiest child raises the warning glyph");
});

test("v0.38.23: detailed widget rows are single-line glyph-first with age, plus a command-free overflow", () => {
  const active = row({ recordId: "active-1", agentType: "Explore", summary: "inspect auth flow", phase: "active", startedAt: NOW - 3 * MIN, silentMs: 5_000 });
  const detail = renderAgentsWidgetLines([active], NOW, 1);
  assert.deepEqual(detail, ["▶ Explore · inspect auth flow · active 5s"]);

  const lines = renderAgentsWidgetLines([
    active,
    row({ recordId: "hung-2", agentType: "Plan", summary: "audit recovery", status: "hung", phase: "hung", silentMs: 26 * MIN }),
    row({ recordId: "queued-3", agentType: "Plan", summary: "wait for slot", status: "queued", phase: "queued", silentMs: 2_000 }),
  ], NOW, 2);
  assert.equal(lines.length, 3, "two single-line rows plus an explicit overflow count");
  assert.match(lines[0]!, /^⚠ Plan · audit recovery · quiet 26m00s$/, "hung sorts first with the warning glyph");
  assert.match(lines[1]!, /^▶ Explore · inspect auth flow · active 5s$/);
  assert.equal(lines[2], "… 1 more agents", "overflow names its count, no command hint");
});

test("v0.35.66: --tail matches the exact child identity and formats entries tolerantly", () => {
  const dir = "/tmp/fake-sessions";
  const files = ["b.jsonl", "a.jsonl"];
  const contents: Record<string, string> = {
    "a.jsonl": [
      JSON.stringify({ type: "session_info", name: "explore#rec-1234" }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "starting: map model picker" }] } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
      JSON.stringify({ type: "tool_call", role: "tool", content: "read x.ts" }),
      "not-json-garbage",
      JSON.stringify({ message: { content: "final report text" } }),
    ].join("\n"),
    "b.jsonl": JSON.stringify({ message: { role: "user", content: "unrelated" } }),
  };
  const result = tailChildTranscript(dir, row({ recordId: "rec-123456", summary: "map model picker" }), {
    lines: 3,
    listDir: () => files,
    statMtime: (f) => (f.endsWith("a.jsonl") ? 200 : 100), // a newer AND matching
    readFile: (f) => Buffer.from(contents[path.basename(f)] ?? ""),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, ["[tool] read x.ts", "[raw] not-json-garbage", "[?] final report text"]);

});

test("v0.35.66: --tail selects the exact persisted child identity among same-type transcripts", () => {
  const dir = "/tmp/fake-sessions";
  const targetId = "12345678-target";
  const files = ["newer.jsonl", "target.jsonl"];
  const contents: Record<string, string> = {
    // This newer Explore transcript deliberately shares the target summary.
    // A generic agentType/summary scan would return this wrong file.
    "newer.jsonl": [
      JSON.stringify({ type: "session", id: "other-session" }),
      JSON.stringify({ type: "session_info", name: "Explore#87654321" }),
      JSON.stringify({ role: "assistant", content: "same summary — unrelated child" }),
    ].join("\n"),
    "target.jsonl": [
      JSON.stringify({ type: "session", id: "target-session" }),
      JSON.stringify({ type: "session_info", name: "Explore#12345678" }),
      JSON.stringify({ role: "assistant", content: "target child transcript" }),
    ].join("\n"),
  };
  const readTail = (file: string, maxBytes?: number): Buffer => {
    const raw = Buffer.from(contents[path.basename(file)] ?? "");
    return maxBytes === undefined ? raw : raw.subarray(Math.max(0, raw.length - maxBytes));
  };
  const readHead = (file: string, maxBytes?: number): Buffer => {
    const raw = Buffer.from(contents[path.basename(file)] ?? "");
    return maxBytes === undefined ? raw : raw.subarray(0, maxBytes);
  };
  const result = tailChildTranscript(dir, {
    recordId: targetId,
    agentType: "Explore",
    summary: "same summary",
  }, {
    listDir: () => files,
    statMtime: (f) => (f.endsWith("newer.jsonl") ? 200 : 100),
    readFile: readTail,
    readHeader: readHead,
  });
  assert.equal(result.ok, true);
  assert.match(result.detail, /target\.jsonl/);
  assert.match(result.lines.join("\n"), /target child transcript/);
  assert.doesNotMatch(result.lines.join("\n"), /unrelated child/);
});

test("v0.37.1: --tail uses the persisted session id to find an older transcript", () => {
  const targetId = "12345678-target";
  const sessionId = "target-session";
  const oldFile = `2026-08-01T00-00-00.000Z_${sessionId}.jsonl`;
  const files = [
    ...Array.from({ length: 26 }, (_, i) => `newer-${String(i).padStart(2, "0")}.jsonl`),
    oldFile,
  ];
  const target = [
    JSON.stringify({ type: "session", id: sessionId }),
    JSON.stringify({ type: "session_info", name: "Explore#12345678" }),
    JSON.stringify({ role: "assistant", content: "old tracked child transcript" }),
  ].join("\n");
  const result = tailChildTranscript("/tmp/fake-sessions", {
    recordId: targetId,
    sessionId,
    agentType: "Explore",
  }, {
    listDir: () => files,
    statMtime: (f) => f.endsWith(oldFile) ? 1 : 200,
    readFile: (f) => Buffer.from(path.basename(f) === oldFile ? target : ""),
  });
  assert.equal(result.ok, true, `older direct candidate: ${result.detail}`);
  assert.match(result.detail, /target-session\.jsonl/);
  assert.match(result.lines.join("\n"), /old tracked child transcript/);
});

test("v0.35.66: --tail refuses a same-type transcript without exact child identity", () => {
  const result = tailChildTranscript("/tmp/fake-sessions", {
    recordId: "12345678-target",
    agentType: "Explore",
    summary: "shared summary",
  }, {
    listDir: () => ["unrelated.jsonl"],
    statMtime: () => 1,
    readFile: () => Buffer.from([
      JSON.stringify({ type: "session_info", name: "Explore#87654321" }),
      JSON.stringify({ role: "assistant", content: "shared summary" }),
    ].join("\n")),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /exact identity/);
  assert.match(result.detail, /searched 1 transcripts/);
});

test("v0.36.0: --tail rejects a message that merely mentions the target identity", () => {
  const targetId = "12345678-target";
  const result = tailChildTranscript("/tmp/fake-sessions", {
    recordId: targetId,
    agentType: "Explore",
    summary: "shared summary",
  }, {
    listDir: () => ["unrelated.jsonl"],
    statMtime: () => 1,
    readFile: () => Buffer.from([
      JSON.stringify({ type: "session_info", name: "Explore#87654321" }),
      JSON.stringify({ role: "assistant", content: `The target is Explore#${targetId.slice(0, 8)}, but this is unrelated.` }),
    ].join("\n")),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /exact identity in session_info\.name/);
});

test("v0.35.29 #15: --tail is LOUD when nothing matches or the dir is unreadable", () => {
  const miss = tailChildTranscript("/tmp/fake-sessions", row(), {
    listDir: () => ["x.jsonl"],
    readFile: () => Buffer.from(JSON.stringify({ message: { content: "nothing relevant" } })),
    statMtime: () => 1,
  });
  assert.equal(miss.ok, false);
  assert.match(miss.detail, /no session file in \/tmp\/fake-sessions matches/);
  assert.match(miss.detail, /searched 1 transcripts/);

  const broken = tailChildTranscript("/tmp/nope", row(), { listDir: () => { throw new Error("ENOENT"); } });
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /cannot list \/tmp\/nope/);
});

test("v0.35.29 #15: formatTranscriptEntry survives shape drift without throwing", () => {
  assert.equal(formatTranscriptEntry(""), undefined);
  assert.match(formatTranscriptEntry('{"role":"user","content":"hello"}')!, /^\[user\] hello$/);
  assert.match(formatTranscriptEntry("[1,2]")!, /^\[raw\]/);
});

test("v0.35.29 #15: end-to-end — /glla agents renders real probe data; widget segment rides the goal card", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "agents visibility item", status: "active" }) });
  const ctx = gllaCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);

  // Real probes via the heartbeat's registry.
  upsertSubagentHangProbe("probe-live-1", "Explore", "map model picker");
  markSubagentHangProgress("probe-live-1");
  upsertSubagentHangProbe("probe-hung-1", "Plan", "audit contract draft");
  // Backdate the hung child's progress past the 5m hang threshold.
  const probes = (await import("../extensions/goal-heartbeat.js")).__testOnlySubagentHangProbes();
  const hung = probes.find((p) => p.recordId === "probe-hung-1");
  assert.ok(hung);
  hung.lastProgressAt = Date.now() - 26 * 60_000;
  try {
    await pi.command("glla", "agents", ctx);
    const notified = ctx.ui.notifies.map((n) => n.message).join("\n");
    assert.match(notified, /glla agents/);
    assert.match(notified, /Explore · map model picker/);
    assert.match(notified, /RUNNING/);
    assert.match(notified, /Plan · audit contract draft/);
    assert.match(notified, /HUNG\?/);
    assert.match(notified, /id probe-live-1/);
    assert.match(notified, /ACTIVE|UNKNOWN/);
    // Audit 2026-09-07: the age label never says "silent" — fresh bands
    // read `active {age}`, everything else `quiet {age}`.
    assert.match(notified, /quiet 26m/);
    assert.match(notified, /active 0s/);
    assert.doesNotMatch(notified, /silent/);

    // The aggregate status command keeps its semantics and does not duplicate
    // the detailed worker roster; /glla agents is the deep inspection path.
    await pi.command("glla", "status", ctx);
    const aggregate = ctx.ui.notifies.at(-1)!.message;
    assert.match(aggregate, /glla status/);
    assert.match(aggregate, /goal \[goal\] (?:active|paused)/);
    assert.doesNotMatch(aggregate, /map model picker|audit contract draft|HUNG\?/);

    // Unknown --tail id answers loudly.
    await pi.command("glla", "agents --tail does-not-exist", ctx);
    assert.match(ctx.ui.notifies.at(-1)!.message, /No tracked subagent matches "does-not-exist"/);

    // Widget: two tracked children → segment present on the goal card.
    const lines = buildWidgetLines((await import("../extensions/goal-state.js")).state, undefined, Date.now(), undefined, 120, {});
    void lines; // extras path covered below via goal-ui refreshUI indirectly

    await pi.command("goal", "cancel", ctx);
  } finally {
    endSubagentHangProbe("probe-live-1");
    endSubagentHangProbe("probe-hung-1");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.65: buildWidgetLines places detailed worker rows before the card footer and supports an agent-only card", () => {
  const state = {
    loop: undefined,
    mainModelRecovery: undefined,
    goal: {
      id: "20260101000000-aaa", objective: "x", verificationContract: "", status: "active", policy: "goal",
      autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 }, createdAt: "", updatedAt: "", revision: 0,
      turns: 0, fileWrites: 0, bashCalls: 0,
    },
    list: [],
  } as never;
  const base = buildWidgetLines(state, undefined, Date.now(), undefined, 120, {})!;
  const withAgents = buildWidgetLines(state, undefined, NOW, undefined, 120, { agents: { line: "● 2 agents · Explore quiet 26m", lines: ["Explore · inspect auth · id active-1 · RUNNING · ACTIVE · 3m00s · active 5s"] } })!;
  assert.ok(!base.some((l) => l.includes("agent:")), "hidden at zero tracked children");
  const compactStatus = buildStatusText(state, undefined, NOW, undefined, { agents: { line: "● 2 agents · Explore quiet 26m", lines: [] } })!;
  assert.match(compactStatus, /2 agents · Explore quiet 26m/);
  const stateRecord = state as unknown as { goal: Record<string, unknown>; [key: string]: unknown };
  // Audit 2026-09-07: the summary rides the auditing status too — a
  // hung/aborting child must never hide behind the audit (HUNG-never-silent).
  const auditStatus = buildStatusText({ ...stateRecord, goal: { ...stateRecord.goal, status: "auditing" } } as never, undefined, NOW, undefined, { agents: { line: "● 2 agents · Explore quiet 26m", lines: [] } })!;
  assert.match(auditStatus, /2 agents/);
  const agentAt = withAgents.findIndex((l) => l.includes("Explore · inspect auth"));
  assert.ok(agentAt >= 0, "worker detail stays inside the card");
  const footerAt = withAgents.findIndex((l) => l.startsWith("└─"));
  // v0.38.23: empty queue means no separate queue footer. Closed card
  // (field 2026-09-08 220808): with no queue the detail row itself
  // terminates the tree — worker rows must never land AFTER a footer.
  assert.ok(footerAt === -1 || agentAt <= footerAt, "detail never lands after the footer");

  // Audit 2026-09-07: no invented header — bare rows stand alone, and
  // the count line leads when the snapshot carries one.
  const agentOnly = buildWidgetLines({ loop: undefined, mainModelRecovery: undefined, goal: undefined, list: [] } as never, undefined, NOW, undefined, 120, { agents: { lines: ["▶ Explore · inspect auth · active 5s"] } })!;
  assert.equal(agentOnly[0], "└─ ▶ Explore · inspect auth · active 5s", "orphan rows render bare and closed, no invented header");
  assert.doesNotMatch(agentOnly.join("\n"), /active workers/);
  const agentOnlyCounted = buildWidgetLines({ loop: undefined, mainModelRecovery: undefined, goal: undefined, list: [] } as never, undefined, NOW, undefined, 120, { agents: { line: "● 1 agent · Explore active 5s", lines: ["▶ Explore · inspect auth · active 5s"] } })!;
  assert.equal(agentOnlyCounted[0], "● 1 agent · Explore active 5s", "the count line leads orphan rows when present");
});

// v0.35.45 (audit finding): /glla agents --tail rendered child-transcript
// lines through ctx.ui.notify WITHOUT ANSI/control-char sanitization — a
// hostile child transcript could emit terminal escape sequences.
test("v0.35.45: formatTranscriptEntry strips ANSI escapes and control chars on ALL paths", () => {
  const hostile = '{"role":"assistant","content":"\\u001b[2J\\u001b[Hreset\\u0007 the screen"}';
  assert.match(formatTranscriptEntry(hostile)!, /\[assistant\] reset the screen/);
  assert.doesNotMatch(formatTranscriptEntry(hostile)!, /\u001B|\u0007/);
  // The verbatim [raw] path is sanitized too — unparseable lines can carry
  // raw escape bytes straight from a hostile transcript.
  const raw = 'garbage \u001b]0;pwned\u0007 title with \u001b[31mcolor';
  const out = formatTranscriptEntry(raw)!;
  assert.ok(out.startsWith("[raw] "), `raw fallback: ${out}`);
  assert.doesNotMatch(out, /\u001B|\u0007/);
  const hostileRole = formatTranscriptEntry('{"role":"\\u001b[2Jfake","content":"hello"}')!;
  assert.equal(hostileRole, "[fake] hello");
  assert.doesNotMatch(hostileRole, /\u001B/);
});

test("v0.35.45: the candidate scan reads a bounded tail per file, not full transcripts", () => {
  // Injected reader records maxBytes; production passes a tail-aware reader.
  let sawMaxBytes: Array<number | undefined> = [];
  const dir = fs.mkdtempSync(path.join("/tmp", "glla-scan-"));
  fs.writeFileSync(path.join(dir, "a.jsonl"), [
    JSON.stringify({ type: "session_info", name: "explore#rec-1234" }),
    JSON.stringify({ role: "user", content: "map model picker needle here" }),
  ].join("\n"));
  const res = tailChildTranscript(dir, row({ recordId: "rec-123456", summary: "map model picker" }), {
    readFile: (file, maxBytes) => { sawMaxBytes.push(maxBytes); return fs.readFileSync(file); },
    listDir: (d) => fs.readdirSync(d),
    statMtime: (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } },
  });
  assert.ok(res.ok, `scan matched: ${res.detail}`);
  assert.equal(sawMaxBytes.length >= 1, true, "the scan went through the reader");
  assert.equal(sawMaxBytes[0], TRANSCRIPT_SCAN_MAX_BYTES, "the scan requested the bounded-tail window");
});

test("audit-2026-09-06: panel renders the doc-promised blocks row and Recent hangs footer", async () => {
  const { renderAgentsPanel, blockedByLabel } = await import("../extensions/goal-agents-panel.js");
  assert.equal(blockedByLabel([]), undefined, "no wait → no label");
  assert.equal(blockedByLabel(["Agent"]), "parent subagent wait (Agent)");
  assert.equal(blockedByLabel(["Agent", "Agent", "subagent"]), "parent subagent wait (Agent/subagent)", "deduped");
  const rows = [
    row({ recordId: "live-1", status: "running", phase: "active", blockedBy: "parent subagent wait (Agent)" }),
    row({ recordId: "ended-1", status: "ended", phase: "ended", blockedBy: "parent subagent wait (Agent)" }),
  ];
  const lines = renderAgentsPanel(rows, Date.now(), true, ["plan\u001b[2J 31m ago"]);
  const text = lines.join("\n");
  assert.match(text, /└ blocks: parent subagent wait \(Agent\) \(zombie stand-down active\)/, "live row carries blocks");
  assert.equal(text.match(/└ blocks:/g)?.length ?? 0, 1, "ended rows never carry blocks");
  assert.match(text, /Recent hangs: plan 31m ago/, "footer present with sanitized hangs");
  assert.doesNotMatch(text, /\u001B|\u0007/);
  const bare = renderAgentsPanel([row({ recordId: "x", status: "running", phase: "active" })], Date.now(), true);
  assert.doesNotMatch(bare.join("\n"), /blocks:|Recent hangs/, "no wait + no hangs → neither row");
});

test("audit-2026-09-06: snapshot labels live rows with the observed parent wait only", async () => {
  const hb = await import("../extensions/goal-heartbeat.js");
  // Order-independent: set the in-flight map directly (the event→map path
  // is already pinned by behavioral-orchestrator; here the production
  // tool_call gate would correctly drop events for this foreign fixture
  // ctx after earlier tests' shutdown). Clean up in finally.
  const flight = (globalThis as any).inFlightToolCalls as Map<string, { name: string; at: number }>;
  flight.set("wait-blocks-1", { name: "subagent", at: Date.now() });
  hb.__testOnlyClearSubagentHangProbes();
  hb.upsertSubagentHangProbe("probe-blocked-1", "scout", "check stuff", Date.now());
  try {
    const snap = hb.getSubagentAgentsSnapshot(Date.now());
    assert.equal(
      snap.agents.find((a) => a.recordId === "probe-blocked-1")?.blockedBy,
      "parent subagent wait (subagent)",
      "live row names the observed wait",
    );
    flight.delete("wait-blocks-1");
    const cleared = hb.getSubagentAgentsSnapshot(Date.now());
    assert.equal(
      cleared.agents.find((a) => a.recordId === "probe-blocked-1")?.blockedBy,
      undefined,
      "no in-flight wait → no blocks label",
    );
  } finally {
    flight.delete("wait-blocks-1");
    hb.endSubagentHangProbe("probe-blocked-1");
    hb.__testOnlyClearSubagentHangProbes();
  }
});

test("audit-2026-09-06: --tail with an ambiguous prefix lists candidates instead of picking silently", async () => {
  const hb = await import("../extensions/goal-heartbeat.js");
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "tail ambiguity item", status: "active" }) });
  const ctx = gllaCtx(cwd);
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  await pi.fire("session_start", { reason: "reload" }, ctx);
  hb.__testOnlyClearSubagentHangProbes();
  hb.upsertSubagentHangProbe("ambig-aaa-1", "scout", "first", Date.now());
  hb.upsertSubagentHangProbe("ambig-aaa-2", "scout", "second", Date.now());
  try {
    await pi.command("glla", "agents --tail ambig-aaa", ctx);
    const msg = ctx.ui.notifies.at(-1)!.message;
    assert.match(msg, /matches 2 tracked subagents/, "ambiguity is announced");
    assert.match(msg, /ambig-aaa-1/, "first candidate named");
    assert.match(msg, /ambig-aaa-2/, "second candidate named");
    // Exact id still resolves directly.
    await pi.command("glla", "agents --tail ambig-aaa-1", ctx);
    assert.doesNotMatch(ctx.ui.notifies.at(-1)!.message, /matches 2 tracked/, "exact id skips disambiguation");
  } finally {
    hb.endSubagentHangProbe("ambig-aaa-1");
    hb.endSubagentHangProbe("ambig-aaa-2");
    hb.__testOnlyClearSubagentHangProbes();
  }
});
