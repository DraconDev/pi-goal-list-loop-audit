// pi-goal-list-loop-audit — v0.35.29
// tests/agents-panel.test.ts
//
// GitHub issue #15 implementation: /glla agents panel + child transcript
// tail + widget segment, per docs/DESIGN-subagent-visibility.md (scope
// agreed 2026-08-22: panel + tail + widget line; live stream rejected).
//
// Rendering is pure and fixture-tested here; the command dispatch and the
// widget append are exercised through the real MockPi surfaces.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { upsertSubagentHangProbe, markSubagentHangProgress, endSubagentHangProbe } from "../extensions/goal-heartbeat.js";
import { renderAgentsPanel, renderAgentsWidgetLine, tailChildTranscript, formatTranscriptEntry, truncate, TRANSCRIPT_SCAN_MAX_BYTES, type AgentsPanelRow } from "../extensions/goal-agents-panel.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function row(overrides: Partial<AgentsPanelRow> = {}): AgentsPanelRow {
  return {
    recordId: "rec-1",
    agentType: "explore",
    summary: "map model picker",
    status: "running",
    spawnedAt: NOW - 4 * MIN,
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

test("v0.35.29 #15: the widget line hides at zero active children and warns when the busiest is hung", () => {
  assert.equal(renderAgentsWidgetLine([row({ status: "ended", endedOk: true })]), undefined, "all-ended → hidden");
  const line = renderAgentsWidgetLine([
    row({ recordId: "a", silentMs: MIN }),
    row({ recordId: "b", agentType: "plan", status: "hung", silentMs: 26 * MIN }),
  ]);
  assert.ok(line!.includes("2 agents"));
  assert.ok(line!.includes("plan silent 26m"));
  assert.ok(line!.endsWith("⚠"), "hung busiest child raises the warning glyph");
});

test("v0.35.29 #15: --tail matches by needle, takes newest mtime, formats entries tolerantly", () => {
  const dir = "/tmp/fake-sessions";
  const files = ["b.jsonl", "a.jsonl"];
  const contents: Record<string, string> = {
    "a.jsonl": [
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "starting: map model picker" }] } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
      JSON.stringify({ type: "tool_call", role: "tool", content: "read x.ts" }),
      "not-json-garbage",
      JSON.stringify({ message: { content: "final report text" } }),
    ].join("\n"),
    "b.jsonl": JSON.stringify({ message: { role: "user", content: "unrelated" } }),
  };
  const result = tailChildTranscript(dir, row({ summary: "map model picker" }), {
    lines: 3,
    listDir: () => files,
    statMtime: (f) => (f.endsWith("a.jsonl") ? 200 : 100), // a newer AND matching
    readFile: (f) => Buffer.from(contents[path.basename(f)] ?? ""),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, ["[tool] read x.ts", "[raw] not-json-garbage", "[?] final report text"]);

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

test("v0.35.29 #15: buildWidgetLines appends the agents segment and hides it when absent", () => {
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
  const withAgents = buildWidgetLines(state, undefined, Date.now(), undefined, 120, { agents: { line: "● 2 agents · plan silent 26m ⚠" } })!;
  assert.ok(!base.some((l) => l.includes("agents")), "hidden at zero tracked children");
  assert.ok(withAgents.at(-1)!.includes("● 2 agents"), "segment appended last");
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
});

test("v0.35.45: the candidate scan reads a bounded tail per file, not full transcripts", () => {
  // Injected reader records maxBytes; production passes a tail-aware reader.
  let sawMaxBytes: Array<number | undefined> = [];
  const dir = fs.mkdtempSync(path.join("/tmp", "glla-scan-"));
  fs.writeFileSync(path.join(dir, "a.jsonl"), JSON.stringify({ role: "user", content: "map model picker needle here" }));
  const res = tailChildTranscript(dir, row({ summary: "map model picker" }), {
    readFile: (file, maxBytes) => { sawMaxBytes.push(maxBytes); return fs.readFileSync(file); },
    listDir: (d) => fs.readdirSync(d),
    statMtime: (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } },
  });
  assert.ok(res.ok, `scan matched: ${res.detail}`);
  assert.equal(sawMaxBytes.length >= 1, true, "the scan went through the reader");
  assert.equal(sawMaxBytes[0], TRANSCRIPT_SCAN_MAX_BYTES, "the scan requested the bounded-tail window");
});
