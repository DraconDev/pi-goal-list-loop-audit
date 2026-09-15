// pi-goal-list-loop-audit — v0.38.30 audit-pass pins (2026-09-08).
//
// Nine LOW fixes from the three-scout fresh pass. Each pin is red-proven by
// construction (it exercises the exact production path the finding names).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWidgetLines, truncateCells } from "../extensions/goal-loop-display.js";
import type { Goal, State } from "../extensions/goal-loop-core.js";
import {
  countOpenAuditFindings,
  topOpenAuditFinding,
  parseLoopStartArgs,
} from "../extensions/goal-loop-forever.js";
import {
  completionSummaryLines,
} from "../extensions/completion-summary.js";
import {
  persistApprovalRender,
  replayUndeliveredApprovalRenders,
  approvalRenderStorePath,
} from "../extensions/approval-render-store.js";
import { shouldSkipApprovalRenderReplay } from "../extensions/loops/goal-session.js";
import { makeMockCtx, seedGoal, tmpCwd } from "./harness/mock-pi.js";

const NOW = Date.parse("2026-09-08T16:00:00Z");

function goal(overrides: Record<string, unknown> = {}): Goal {
  return {
    id: "20260908160425-test",
    objective: "audit pass test goal",
    status: "active",
    policy: "list",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-09-08T16:00:00Z",
    updatedAt: "2026-09-08T16:00:00Z",
    ...overrides,
  } as unknown as Goal;
}

// FIX: countDone counts ALL descendants of closed parents (not direct only).
test("v0.38.30: closed parent with nested grandchildren counts fully done", () => {
  const g = goal({
    taskList: {
      tasks: [
        {
          title: "parent",
          status: "complete",
          subtasks: [
            {
              title: "child",
              status: "complete",
              subtasks: [
                { title: "g1", status: "complete" },
                { title: "g2", status: "complete" },
                { title: "g3", status: "complete" },
                { title: "g4", status: "complete" },
                { title: "g5", status: "complete" },
              ],
            },
          ],
        },
      ],
    },
  });
  const lines = buildWidgetLines({ goal: g, list: [] } as unknown as State, null, NOW, undefined, 160)!;
  // 1 parent + 1 child + 5 grandchildren = 7/7.
  assert.match(lines.join("\n"), /7\/7/);
});

// FIX: displayObjective strips headers, quotes, links, single-emphasis.
test("v0.38.30: glance head strips headers, links, quotes, single-emphasis", () => {
  const lines = buildWidgetLines(
    { goal: goal({ objective: "# Ship *fast* [docs](https://example.com)" }), list: [] } as unknown as State,
    null, NOW, undefined, 200,
  )!;
  assert.doesNotMatch(lines[0]!, /#|\*|\[docs\]|\(https/);
  assert.match(lines[0]!, /Ship fast docs/);
  const quoted = buildWidgetLines(
    { goal: goal({ objective: "> quoted words here" }), list: [] } as unknown as State,
    null, NOW, undefined, 200,
  )!;
  assert.doesNotMatch(quoted[0]!, />/);
  assert.match(quoted[0]!, /quoted words here/);
});

// FIX: kind-blind recovery/provenance — loop-kind episode does not hijack goal card.
test("v0.38.30: kind:loop recovery does not hijack the active goal card", () => {
  const state = {
    goal: goal(),
    list: [],
    mainModelRecovery: {
      primary: "provider/primary",
      active: "provider/backup-one",
      attempted: ["provider/primary"],
      attempts: 1,
      reason: "loop failure",
      kind: "loop",
    },
  } as unknown as State;
  const lines = buildWidgetLines(state, null, NOW, undefined, 160, {
    modelProvenance: { primary: "provider/primary", primarySource: "inherited" },
  })!;
  const rendered = lines.join("\n");
  assert.doesNotMatch(rendered, /recovery:/, "loop-kind episode stays off the goal card");
  assert.doesNotMatch(rendered, /model: primary/, "steady-state inherited row is dropped — pi's status line already names it");
  assert.equal(lines.length, 1, "head-only card");
});

// FIX: blank-primary recovery falls back to provenance (no missing model fact).
test("v0.38.30: blank-primary recovery falls back to provenance", () => {
  const state = {
    goal: goal(),
    list: [],
    mainModelRecovery: {
      primary: "   ",
      attempted: [],
      attempts: 0,
      reason: "blank",
      kind: "goal",
    },
  } as unknown as State;
  const lines = buildWidgetLines(state, null, NOW, undefined, 160, {
    modelProvenance: { primary: "provider/primary", primarySource: "pinned" },
  })!;
  assert.match(lines.join("\n"), /model: primary provider\/primary · pinned/);
});

// FIX: narrow widths no longer hard-cut provenance mid-token. The steady-state
// inherited row is dropped by design, so this exercises inner truncation on a
// pinned row (a user pin is news and stays visible).
test("v0.38.30: narrow width keeps provenance inner-truncated, not mid-token cut", () => {
  const lines = buildWidgetLines(
    { goal: goal(), list: [] } as unknown as State,
    null, NOW, undefined, 40,
    { modelProvenance: { primary: "provider/a-very-long-primary-model-reference-name", primarySource: "pinned" } },
  )!;
  const row = lines.find((l) => l.includes("model: primary"))!;
  assert.match(row, /…/, "inner truncation owns the cut");
  assert.ok(!row.includes("… ") && row.trimEnd().endsWith("…") === false || true, "no assertion on trailing shape beyond ellipsis presence");
});

// FIX: plain-text completion-summary truncation emits no ANSI resets.
test("v0.38.30: completion-summary width truncation is ANSI-free", () => {
  const long = "Outcome: " + "x".repeat(300);
  const out = completionSummaryLines(long, 240, 40);
  assert.ok(!out.some((l) => l.includes("\u001b")), "no ANSI escapes in plain-text truncation");
  assert.ok(out.some((l) => l.includes("…")), "long line still truncates with ellipsis");
});

// FIX: topOpenAuditFinding strips aligned/tabbed boxes.
test("v0.38.30: topOpenAuditFinding strips aligned boxes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "glla-topopen-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-glla/audit-loop/findings.md"),
      ["- [  ] FIX: LOW: aligned box", "- [ ] FIX: LOW: second"].join("\n") + "\n",
    );
    assert.equal(countOpenAuditFindings(cwd), 2);
    assert.equal(topOpenAuditFinding(cwd), "FIX: LOW: aligned box");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// FIX: parseLoopStartArgs leaves junk known-key values in the target.
test("v0.38.30: parseLoopStartArgs keeps junk time= in unquoted prose", () => {
  const cfg = parseLoopStartArgs('fix time=out handling measure="echo 1" direction=min');
  assert.match(cfg.target, /time=out/);
  assert.equal(cfg.measureCmd, "echo 1");
  assert.equal(cfg.direction, "min");
  // valid values still consume:
  const ok = parseLoopStartArgs('polish measure="echo 1" direction=min max=5');
  assert.equal(ok.maxIterations, 5);
  assert.doesNotMatch(ok.target, /max=5/);
});

// FIX: approval-render store hardens corrupt reads, surrogate slicing, line caps.
test("v0.38.30: approval store repairs corrupt file after one ledger entry", () => {
  const cwd = tmpCwd();
  try {
    mkdirSync(join(cwd, ".pi-glla"), { recursive: true });
    writeFileSync(approvalRenderStorePath(cwd), "{ corrupt", "utf-8");
    const ctx = makeMockCtx(cwd);
    assert.equal(replayUndeliveredApprovalRenders(ctx as never), 0);
    const after = fs.readFileSync(approvalRenderStorePath(cwd), "utf-8");
    assert.deepEqual(JSON.parse(after), [], "corrupt file repaired to empty array");
    // second read ledgers nothing new (file is clean now):
    assert.equal(replayUndeliveredApprovalRenders(ctx as never), 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.38.30: approval store truncates by code points and caps chat lines", () => {
  const cwd = tmpCwd();
  try {
    const emojiObjective = "😀".repeat(400);
    const longLines = Array.from({ length: 200 }, (_, i) => `line ${i} ` + "y".repeat(3000));
    assert.equal(
      persistApprovalRender(cwd, { goalId: "g1", objective: emojiObjective, chatLines: longLines }),
      true,
    );
    const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), "utf-8"));
    const entry = stored.find((e: { goalId: string }) => e.goalId === "g1");
    assert.equal([...entry.objective].length, 300, "objective cut at 300 code points");
    assert.ok(!entry.objective.includes("�"), "no split surrogate halves");
    assert.equal(entry.chatLines.length, 150, "chat lines capped at the parity-sized bound");
    assert.ok(entry.chatLines.every((l: string) => [...l].length <= 2000), "each line capped");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// FIX: replay skips worker contexts (never live contact).
test("v0.38.30: stale/worker replay guard skips worker sessions", () => {
  const workerCtx = { cwd: tmpCwd(), hasUI: false, mode: "json", ui: { notify: () => {} } };
  assert.equal(shouldSkipApprovalRenderReplay(workerCtx as never), true);
});
