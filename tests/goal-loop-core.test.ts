/**
 * pi-goal-list-loop-audit — v0.1.0
 * tests/goal-loop-core.test.ts
 *
 * Smoke tests for the core state machine, schema, and renderer.
 * These do not depend on pi; they exercise pure logic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  type Goal,
  appendLedger,
  archivedGoalPath,
  buildTaskSummary,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  ledgerPath,
  newGoalId,
  nowIso,
  piGlaDir,
  readGoalMd,
  readState,
  mergeSettings,
  auditFeedbackExcerpt,
  auditVerdictLabel,
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  formatGoalAuditHistory,
  renderGoalMarkdown,
  shouldAutoResumeOnSessionStart,
  statusLabel,
  sumNewAssistantTokens,
  DEFAULT_TOKEN_LIMIT,
  writeGoalMd,
  missingGllaTools,
  GLLA_TOOL_NAMES,
} from "../extensions/goal-loop-core.ts";

// ---- helpers ----

function tmpCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gla-test-"));
  return d;
}

// ---- tests ----

test("piGlaDir returns the canonical path", () => {
  assert.equal(piGlaDir("/x/y"), path.join("/x/y", ".pi-glla"));
});

test("newGoalId format", () => {
  const id = newGoalId();
  assert.match(id, /^\d{14}-[a-z0-9]{6}$/);
});

test("statusLabel covers all states", () => {
  assert.equal(statusLabel("active"), "active");
  assert.equal(statusLabel("auditing"), "auditing");
  assert.equal(statusLabel("complete"), "complete");
  assert.equal(statusLabel("paused"), "paused");
  assert.equal(statusLabel("aborted"), "aborted");
  assert.equal(statusLabel(null), "no goal");
});

test("audit display classification keeps semantic verdicts separate from infra and shield outcomes", () => {
  const entries = [
    { approved: true, disapproved: false },
    { approved: false, disapproved: true },
    { approved: false, disapproved: false, impossible: true },
    { approved: true, disapproved: false, regressionShieldPassed: false },
    { approved: false, disapproved: false, error: "auditor stalled" },
  ];
  assert.deepEqual(entries.map(auditVerdictLabel), [
    "approved",
    "disapproved",
    "impossible",
    "shield-blocked",
    "infrastructure failure",
  ]);

  const history = entries.map((entry, i) => ({
    at: `2026-07-19T00:0${i}:00Z`,
    model: `test/${i}`,
    report: `report ${i}`,
    ...entry,
  }));
  const goal = {
    id: "audit-display",
    objective: "keep categories honest",
    status: "active" as const,
    policy: "goal" as const,
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
    auditHistory: history,
  };
  const markdown = renderGoalMarkdown(goal);
  for (const label of ["approved", "disapproved", "impossible", "shield-blocked", "infrastructure failure"]) {
    assert.match(markdown, new RegExp(`— ${label} —`), `${label} remains explicit in the auditor prompt state`);
  }
  const auditLines = formatGoalAuditHistory(goal).split("\n");
  assert.equal(auditLines.length, entries.length);
  assert.notEqual(auditLines[0]![0], auditLines[3]![0], "shield-blocked does not share approved's glyph");
  assert.notEqual(auditLines[1]![0], auditLines[4]![0], "infrastructure failure does not share disapproved's glyph");
});

test("list policy and aborted status remain separate display facts", () => {
  const md = renderGoalMarkdown({
    id: "aborted-list-item",
    objective: "cancelled list work",
    status: "aborted",
    policy: "list",
    autoContinue: false,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
    stopReason: "list cancelled",
  });
  assert.match(md, /\*\*Status\*\*: aborted/);
  assert.match(md, /\*\*Policy\*\*: list/);
  assert.match(md, /\*\*Stop reason\*\*: list cancelled/);
});

test("findNextPendingTask BFSes subtasks", () => {
  const tasks = [
    {
      id: "1",
      title: "first",
      status: "complete" as const,
      subtasks: [
        { id: "1.1", title: "a", status: "complete" as const },
        { id: "1.2", title: "b", status: "pending" as const },
      ],
    },
    { id: "2", title: "second", status: "pending" as const },
  ];
  const next = findNextPendingTask(tasks);
  assert.ok(next);
  // BFS pops in order: 1 (complete, push subtasks), then 2 (pending) before 1.2.
  // So the next pending task is the sibling at depth 1, not the deeper subtask.
  assert.equal(next!.id, "2");
});

test("findNextPendingTask returns subtask when no sibling pending", () => {
  const tasks = [
    {
      id: "1",
      title: "first",
      status: "complete" as const,
      subtasks: [
        { id: "1.1", title: "a", status: "complete" as const },
        { id: "1.2", title: "b", status: "pending" as const },
      ],
    },
  ];
  const next = findNextPendingTask(tasks);
  assert.ok(next);
  assert.equal(next!.id, "1.2");
});

test("buildTaskSummary counts complete", () => {
  const tasks = [
    { id: "1", title: "a", status: "complete" as const },
    { id: "2", title: "b", status: "pending" as const },
    { id: "3", title: "c", status: "complete" as const },
  ];
  assert.equal(buildTaskSummary(tasks), "2/3 done");
});

test("renderGoalMarkdown renders sections", () => {
  const goal: Goal = {
    id: "test-1",
    objective: "Make widget foo.",
    status: "active",
    policy: "goal",
    autoContinue: true,
    verificationContract: "npm test (0 failures)",
    usage: { tokensUsed: 100, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
  const md = renderGoalMarkdown(goal);
  assert.ok(md.includes("# Goal"));
  assert.ok(md.includes("## Objective"));
  assert.ok(md.includes("Make widget foo."));
  assert.ok(md.includes("## Verification contract"));
  assert.ok(md.includes("npm test"));
});

test("v0.34.91: renderGoalMarkdown includes the completion recap section", () => {
  const goal: Goal = {
    id: "test-1",
    objective: "Make widget foo.",
    status: "complete",
    policy: "goal",
    autoContinue: true,
    completionSummary: "Shipped the widget with 12 tests; the float alignment bug is fixed.",
    usage: { tokensUsed: 100, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
  const md = renderGoalMarkdown(goal);
  assert.ok(md.includes("## Completion summary"), "the recap has a durable home in the goal .md → archive");
  assert.ok(md.includes("Shipped the widget with 12 tests"), "the recap text lands verbatim");
  const without = renderGoalMarkdown({ ...goal, completionSummary: undefined });
  assert.ok(!without.includes("## Completion summary"), "no empty section when the recap is absent");
});

test("writeGoalMd persists + readGoalMd returns", () => {
  const cwd = tmpCwd();
  try {
    const goal: Goal = {
      id: "test-2",
      objective: "Test write.",
      status: "active",
      policy: "goal",
      autoContinue: true,
      usage: { tokensUsed: 0, tokensLimit: 1000 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeGoalMd(cwd, goal);
    assert.ok(fs.existsSync(goalMdPath(cwd, "test-2")));
    assert.ok(readGoalMd(cwd, "test-2")!.includes("Test write."));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readState returns default when no ledger", () => {
  const cwd = tmpCwd();
  try {
    const s = readState(cwd);
    assert.equal(s.goal, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("appendLedger + readState roundtrip", () => {
  const cwd = tmpCwd();
  try {
    appendLedger(cwd, "test_event", { foo: "bar" });
    assert.ok(fs.existsSync(ledgerPath(cwd)));
    appendLedger(cwd, "state", { goal: null });
    const s = readState(cwd);
    assert.equal(s.goal, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readState sanitizes a saved main-model recovery without dropping its retry plan", () => {
  const cwd = tmpCwd();
  try {
    appendLedger(cwd, "state", {
      goal: null,
      mainModelRecovery: {
        primary: "provider/primary",
        attempted: Array.from({ length: 100 }, (_, i) => `provider/model-${i}`),
        attempts: -4,
        reason: "provider wall",
        retryAt: "not-a-date",
        primaryProbeAt: new Date(Date.now() + 60_000).toISOString(),
        primaryProbeInFlight: true,
        autoRetryUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const recovery = readState(cwd).mainModelRecovery!;
    assert.equal(recovery.kind, "goal", "legacy records default to goal recovery");
    assert.equal(recovery.attempts, 0);
    assert.ok(recovery.attempted.length <= 11, "restored attempted refs are bounded to primary plus ten backups");
    assert.equal(recovery.attempted[0], "provider/primary");
    assert.equal(recovery.retryAt, undefined);
    assert.ok(recovery.primaryProbeAt);
    assert.equal(recovery.primaryProbeInFlight, true);
    assert.ok(recovery.autoRetryUntil);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("sumNewAssistantTokens accumulates assistant usage only", () => {
  const seen = new Set<string>();
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", timestamp: 1, usage: { totalTokens: 100 } },
    { role: "assistant", timestamp: 2, usage: { totalTokens: 250 } },
    { role: "assistant", timestamp: 3 }, // no usage → skipped
  ];
  assert.equal(sumNewAssistantTokens(msgs, seen), 350);
});

test("sumNewAssistantTokens dedupes replayed messages", () => {
  const seen = new Set<string>();
  const turn1 = [{ role: "assistant", timestamp: 1, usage: { totalTokens: 100 } }];
  assert.equal(sumNewAssistantTokens(turn1, seen), 100);
  // same message replayed in a later event (agent_end may include history)
  const turn2 = [
    { role: "assistant", timestamp: 1, usage: { totalTokens: 100 } },
    { role: "assistant", timestamp: 2, usage: { totalTokens: 50 } },
  ];
  assert.equal(sumNewAssistantTokens(turn2, seen), 50);
});

test("sumNewAssistantTokens ignores zero/negative/invalid usage", () => {
  const seen = new Set<string>();
  const msgs = [
    { role: "assistant", timestamp: 1, usage: { totalTokens: 0 } },
    { role: "assistant", timestamp: 2, usage: { totalTokens: -5 } },
    { role: "assistant", timestamp: 3, usage: { totalTokens: "many" } },
  ];
  assert.equal(sumNewAssistantTokens(msgs, seen), 0);
});

test("mergeSettings: later layers win per key", () => {
  const out = mergeSettings(
    { a: 1, b: 2, c: 3 } as Record<string, unknown>,
    { b: 20 },
    { c: 30 },
  );
  assert.deepEqual(out, { a: 1, b: 20, c: 30 });
});

test("mergeSettings: undefined in a layer means 'not set here'", () => {
  const out = mergeSettings(
    { a: 1, b: 2 } as Record<string, unknown>,
    { a: undefined, b: 99 },
  );
  assert.deepEqual(out, { a: 1, b: 99 });
});

test("mergeSettings: null/missing layers are skipped", () => {
  const out = mergeSettings({ a: 1 } as Record<string, unknown>, null, undefined, { b: 2 });
  assert.deepEqual(out, { a: 1, b: 2 });
});

test("mergeSettings: does not mutate the base", () => {
  const base = { a: 1 } as Record<string, unknown>;
  mergeSettings(base, { a: 5 });
  assert.equal(base.a, 1);
});

test("auditFeedbackExcerpt: bounds executor feedback at the configured character count", () => {
  assert.equal(DEFAULT_AUDIT_FEEDBACK_CHARS, 0);
  // v0.25.4: capped excerpts keep the TAIL (the auditor's Required-fixes
  // section lives there) with a head-truncation marker.
  assert.equal(auditFeedbackExcerpt("abcdefghij", 6), "[head truncated — full report via /goal status]\n…efghij");
});

test("auditFeedbackExcerpt: zero returns the full auditor report", () => {
  assert.equal(auditFeedbackExcerpt("full evidence report", 0), "full evidence report");
});

test("ensureDirs creates the .pi-glla tree", () => {
  const cwd = tmpCwd();
  try {
    ensureDirs(cwd);
    assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "goals")));
    assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "archive")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("sumNewAssistantTokens counts input+output, not cache reads (v0.12.0)", () => {
  const seen = new Set<string>();
  const msgs = [
    // 800k cache-read + 50k real → count 50k, not 850k
    { role: "assistant", timestamp: 1, usage: { input: 40_000, output: 10_000, cacheRead: 800_000, totalTokens: 850_000 } },
  ];
  assert.equal(sumNewAssistantTokens(msgs, seen), 50_000);
});

test("sumNewAssistantTokens falls back to totalTokens when no split", () => {
  const seen = new Set<string>();
  const msgs = [{ role: "assistant", timestamp: 1, usage: { totalTokens: 250 } }];
  assert.equal(sumNewAssistantTokens(msgs, seen), 250);
});

test("DEFAULT_TOKEN_LIMIT is 0 — the guard is opt-in (v0.12.0)", () => {
  assert.equal(DEFAULT_TOKEN_LIMIT, 0);
});

test("piGlaDir migrates a legacy .pi-gla dir exactly once (v0.17.0)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mig-"));
  fs.mkdirSync(path.join(cwd, ".pi-gla", "goals"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-gla", "active.jsonl"), "{\"a\":1}\n");
  const dir = piGlaDir(cwd);
  assert.equal(dir, path.join(cwd, ".pi-glla"));
  assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "active.jsonl")), "state moved");
  assert.ok(!fs.existsSync(path.join(cwd, ".pi-gla")), "legacy dir gone");
  // idempotent: second call does not clobber
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "{\"a\":2}\n");
  piGlaDir(cwd);
  assert.equal(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), "{\"a\":2}\n");
  // if BOTH exist, the new dir wins and legacy is left alone
  fs.mkdirSync(path.join(cwd, ".pi-gla"), { recursive: true });
  piGlaDir(cwd);
  assert.ok(fs.existsSync(path.join(cwd, ".pi-gla")), "legacy untouched when new exists");
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ---- session-restore gate (v0.21.0) ----

test("restore gate (v0.28.21 default): NOTHING auto-resumes on session load — the item loads HELD", () => {
  // User directive: "load it on session load but not auto start it".
  // The 0.26.9 reload/fork auto-resume default is gone; only the explicit
  // autoresume=on setting (unattended rigs) auto-resumes.
  for (const reason of ["startup", "new", "resume", "reload", "fork", undefined]) {
    assert.equal(shouldAutoResumeOnSessionStart(reason, undefined), false, String(reason));
  }
});

test("restore gate: autoresume=on auto-resumes everywhere (unattended rigs)", () => {
  for (const reason of ["startup", "new", "resume", "reload", "fork", undefined]) {
    assert.equal(shouldAutoResumeOnSessionStart(reason, true), true, String(reason));
  }
});

test("restore gate: autoresume=off never auto-resumes", () => {
  for (const reason of ["startup", "new", "resume", "reload", "fork", undefined]) {
    assert.equal(shouldAutoResumeOnSessionStart(reason, false), false, String(reason));
  }
});


// =================================================================
// v0.24.5: tool-visibility self-heal
// =================================================================

test("v0.24.5 missingGllaTools: empty active set returns all glla tool names", () => {
  const missing = missingGllaTools([]);
  assert.equal(missing.length, GLLA_TOOL_NAMES.length);
  for (const name of GLLA_TOOL_NAMES) {
    assert.ok(missing.includes(name), `expected ${name} in missing`);
  }
});

test("v0.24.5 missingGllaTools: only glla tool names are tracked (no false positives on base tools)", () => {
  const baseTools = ["read", "bash", "edit", "write", "ask_user_question", "todo", "advisor"];
  const missing = missingGllaTools(baseTools);
  assert.equal(missing.length, GLLA_TOOL_NAMES.length, "every glla tool is missing from base-only set");
});

test("v0.24.5 missingGllaTools: modlist-snapshot example (the real bug)", () => {
  // The exact list modlist's default profile had before the v0.24.5 fix.
  const modlistDefault = ["read", "bash", "edit", "write", "ask_user_question", "todo", "advisor"];
  const missing = missingGllaTools(modlistDefault);
  // Every glla tool was hidden — the bug.
  assert.equal(missing.length, GLLA_TOOL_NAMES.length);
  assert.ok(missing.includes("complete_goal"));
  assert.ok(missing.includes("propose_loop_draft"));
});

test("v0.24.5 missingGllaTools: all tools present → empty missing list", () => {
  const missing = missingGllaTools([...GLLA_TOOL_NAMES, "read", "bash"]);
  assert.deepEqual(missing, []);
});

test("v0.24.5 missingGllaTools: missing just one tool → that single name", () => {
  const allButOne = GLLA_TOOL_NAMES.filter((n) => n !== "complete_goal");
  const missing = missingGllaTools(allButOne);
  assert.deepEqual([...missing], ["complete_goal"]);
});

// ---- state-root tests ----

import { globalSettingsPath, setRuntimeSessionDir, resolveRuntimeSessionDir, stateRootPending } from "../extensions/goal-loop-core.ts";
import { loadSettings, saveSettings } from "../extensions/goal-settings.js";

/** Hermetic state-root fixture: point the global settings file at a temp
 * file, register a temp session dir, and hand back restore + cleanup. */
function stateRootFixture(opts: { stateRoot?: string } = {}): { sessionDir: string; cwd: string; globalFile: string; restore: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-root-cwd-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-root-sess-"));
  const globalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glla-root-gl-")), "settings.json");
  fs.writeFileSync(globalFile, JSON.stringify({ stateRoot: opts.stateRoot ?? "workingDir" }));
  const prevGlobal = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const prevSessionFile = process.env.PI_SESSION_FILE;
  delete process.env.PI_SESSION_FILE;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
  return {
    sessionDir,
    cwd,
    globalFile,
    restore: () => {
      if (prevGlobal === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
      else process.env.GLLA_GLOBAL_SETTINGS_PATH = prevGlobal;
      if (prevSessionFile === undefined) delete process.env.PI_SESSION_FILE;
      else process.env.PI_SESSION_FILE = prevSessionFile;
      setRuntimeSessionDir(undefined);
      fs.rmSync(path.dirname(globalFile), { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

test("stateRoot default (unset/workingDir): piGlaDir stays <cwd>/.pi-glla", () => {
  const fx = stateRootFixture();
  try {
    assert.equal(piGlaDir(fx.cwd), path.join(fx.cwd, ".pi-glla"));
    // workingDir mode never touches the session dir
    assert.equal(fs.readdirSync(fx.sessionDir).length, 0);
  } finally {
    fx.restore();
  }
});

test("stateRoot sessionDir mode: piGlaDir is <top-level session dir>/pi-glla — no UUID or session-file component", () => {
  const fx = stateRootFixture({ stateRoot: "sessionDir" });
  try {
    setRuntimeSessionDir(fx.sessionDir);
    const dir = piGlaDir(fx.cwd);
    assert.equal(dir, path.join(fx.sessionDir, "pi-glla"));
    assert.ok(dir.endsWith("/pi-glla") || dir.endsWith("\\pi-glla"), `top-level only, got ${dir}`);
    // switching roots leaves the old tree untouched and starts empty
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false, "old root untouched");
  } finally {
    fx.restore();
  }
});

test("stateRoot sessionDir mode falls back to workingDir when no session dir can be resolved", () => {
  const fx = stateRootFixture({ stateRoot: "sessionDir" });
  try {
    setRuntimeSessionDir(undefined);
    delete process.env.PI_SESSION_FILE;
    assert.equal(piGlaDir(fx.cwd), path.join(fx.cwd, ".pi-glla"), "fail-safe fallback");
    // PI_SESSION_FILE fallback: dirname of the session file
    process.env.PI_SESSION_FILE = path.join(fx.sessionDir, "some-uuid-session.jsonl");
    assert.equal(resolveRuntimeSessionDir(), fx.sessionDir);
    assert.equal(piGlaDir(fx.cwd), path.join(fx.sessionDir, "pi-glla"));
  } finally {
    fx.restore();
  }
});

test("stateRoot setting round-trips through the GLOBAL file; project copies are stripped", () => {
  const fx = stateRootFixture();
  try {
    saveSettings("global", fx.cwd, { stateRoot: "sessionDir" });
    assert.equal(loadSettings(fx.cwd).stateRoot, "sessionDir");
    // a project-level copy must not survive (global-only key).
    // deferral: with sessionDir mode active, a runtime session dir
    // must be registered first — exactly what real runtimes do after
    // session_start. The pending case has its own test above.
    setRuntimeSessionDir(fx.sessionDir);
    saveSettings("project", fx.cwd, { stateRoot: "sessionDir" });
    const projRaw = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "pi-glla", "settings.json"), "utf8")) as Record<string, unknown>;
    assert.ok(!("stateRoot" in projRaw), "stateRoot stripped from project scope");
    // toggling back removes nothing else and does not create the other root
    saveSettings("global", fx.cwd, { stateRoot: undefined });
    assert.equal(loadSettings(fx.cwd).stateRoot, "workingDir");
    assert.equal(JSON.parse(fs.readFileSync(fx.globalFile, "utf8")).stateRoot, undefined);
  } finally {
    fx.restore();
  }
});

// ---- state-root deferral: sessionDir mode must never CREATE <cwd>/.pi-glla ----

test("stateRoot sessionDir pending (no session dir): ensureDirs/appendLedger defer — no cwd tree created", () => {
  const fx = stateRootFixture({ stateRoot: "sessionDir" });
  try {
    setRuntimeSessionDir(undefined);
    delete process.env.PI_SESSION_FILE;
    assert.equal(stateRootPending(), true, "pending while session dir unresolved");
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "test_event", { ok: true });
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false, "cwd tree NOT created while pending");
  } finally {
    fx.restore();
  }
});

test("stateRoot sessionDir resolved: ensureDirs/appendLedger create only <sessionDir>/pi-glla", () => {
  const fx = stateRootFixture({ stateRoot: "sessionDir" });
  try {
    setRuntimeSessionDir(fx.sessionDir);
    assert.equal(stateRootPending(), false);
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "test_event", { ok: true });
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false, "no cwd tree in sessionDir mode");
    assert.ok(fs.existsSync(path.join(fx.sessionDir, "pi-glla", "goals")), "session tree created");
    assert.ok(fs.existsSync(path.join(fx.sessionDir, "pi-glla", "active.jsonl")), "ledger written under session root");
  } finally {
    fx.restore();
  }
});

test("stateRoot workingDir default: ensureDirs still creates and uses <cwd>/.pi-glla", () => {
  const fx = stateRootFixture({ stateRoot: "workingDir" });
  try {
    setRuntimeSessionDir(undefined);
    assert.equal(stateRootPending(), false, "never pending in workingDir mode");
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "test_event", { ok: true });
    assert.ok(fs.existsSync(path.join(fx.cwd, ".pi-glla", "goals")), "cwd tree created");
    assert.ok(fs.existsSync(path.join(fx.cwd, ".pi-glla", "active.jsonl")));
    assert.equal(fs.existsSync(path.join(fx.sessionDir, "pi-glla")), false);
  } finally {
    fx.restore();
  }
});

test("switching to sessionDir mode leaves an existing leftover <cwd>/.pi-glla untouched", () => {
  const fx = stateRootFixture({ stateRoot: "sessionDir" });
  try {
    // pre-existing cwd tree from the workingDir era
    fs.mkdirSync(path.join(fx.cwd, ".pi-glla", "goals"), { recursive: true });
    fs.writeFileSync(path.join(fx.cwd, ".pi-glla", "marker.txt"), "keep me");
    setRuntimeSessionDir(fx.sessionDir);
    ensureDirs(fx.cwd);
    appendLedger(fx.cwd, "test_event", {});
    assert.ok(fs.existsSync(path.join(fx.cwd, ".pi-glla", "marker.txt")), "leftover tree not deleted");
    assert.deepEqual(fs.readdirSync(path.join(fx.cwd, ".pi-glla")).sort(), ["goals", "marker.txt"], "leftover tree unchanged");
    assert.ok(fs.existsSync(path.join(fx.sessionDir, "pi-glla", "goals")));
  } finally {
    fx.restore();
  }
});

test("project-scope saveSettings throws (defers) while sessionDir mode is pending — no cwd creation", () => {
  const fx = stateRootFixture({ stateRoot: "sessionDir" });
  try {
    setRuntimeSessionDir(undefined);
    delete process.env.PI_SESSION_FILE;
    let threw = false;
    try {
      saveSettings("project", fx.cwd, { auditFeedbackChars: 1 });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "pending project save is refused");
    assert.equal(fs.existsSync(path.join(fx.cwd, ".pi-glla")), false, "refusal must not create the cwd tree");
  } finally {
    fx.restore();
  }
});
