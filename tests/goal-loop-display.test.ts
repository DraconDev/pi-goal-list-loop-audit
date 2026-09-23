import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildWidgetLines, truncateObjective } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";

const NOW = Date.parse("2026-08-17T20:10:00Z");

function goal(): Goal {
  return {
    id: "20260817200522-y5az91",
    objective: "Show model provenance on the active goal",
    status: "active",
    policy: "list",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-17T20:05:22Z",
    updatedAt: "2026-08-17T20:05:22Z",
  };
}

test("active goal card pins primary, ordered fallbacks, skipped forbidden refs, and handled models", () => {
  const state: State = { goal: goal(), list: [] };
  const lines = buildWidgetLines(
    state,
    null,
    NOW,
    undefined,
    120,
    {
      modelProvenance: {
        primary: "opencode-go/gpt-5.6-luna",
        primarySource: "inherited",
        fallbackRefs: ["openai/gpt-5.1", "anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"],
        skippedForbiddenRefs: ["anthropic/claude-sonnet-4-5"],
        handledTurn: "openai/gpt-5.1",
        handledAudit: "google/gemini-2.5-pro",
        handledAuditSource: "fallback-pin",
      },
    },
  )!;
  const rendered = lines.join("\n");

  assert.match(rendered, /model: primary opencode-go\/gpt-5\.6-luna · inherited from session/);
  assert.match(rendered, /fallbacks: openai\/gpt-5\.1 → anthropic\/claude-sonnet-4-5 → google\/gemini-2\.5-pro/);
  assert.match(rendered, /skipped forbidden: anthropic\/claude-sonnet-4-5/);
  assert.match(rendered, /handled turn: openai\/gpt-5\.1/);
  assert.match(rendered, /handled audit: google\/gemini-2\.5-pro · via fallback/);
  assert.match(lines.at(-1)!, /^└─ handled audit:/, "the final provenance row closes the tree");

  const pinned = buildWidgetLines(
    state,
    null,
    NOW,
    undefined,
    120,
    { modelProvenance: { primary: "anthropic/claude-sonnet-4-5", primarySource: "pinned" } },
  )!;
  assert.match(pinned.join("\n"), /model: primary anthropic\/claude-sonnet-4-5 · pinned/);
  assert.match(pinned.at(-1)!, /^└─ model:/, "a lone provenance row closes the tree");
});

test("v0.38.28: duplicate handled-turn provenance is omitted; lone inherited row is dropped", () => {
  const lines = buildWidgetLines(
    { goal: goal(), list: [] },
    null,
    NOW,
    undefined,
    120,
    {
      modelProvenance: {
        primary: "opencode-go/muse-spark-1.3-contributor",
        primarySource: "inherited",
        handledTurn: "opencode-go/muse-spark-1.3-contributor",
      },
    },
  )!;
  const rendered = lines.join("\n");
  assert.doesNotMatch(rendered, /handled turn:/, "same primary/handled model is redundant");
  assert.doesNotMatch(rendered, /model: primary/, "a lone inherited row restates pi's own status line");
  assert.equal(lines.length, 1, "head-only card, nothing dangling");
});

test("v0.38.29: active recovery is a compact model row, not a duplicate report", () => {
  const state = {
    goal: goal(),
    list: [],
    mainModelRecovery: {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 1,
      pendingModelSwitch: "provider/backup-two",
      skipped: [{ ref: "provider/backup-one", reason: "unregistered" as const }],
      reason: "model switch in flight",
      kind: "goal" as const,
    },
  } as State;
  const lines = buildWidgetLines(
    state,
    null,
    NOW,
    undefined,
    160,
    {
      mainModelFallbacks: ["provider/backup-one", "provider/backup-two"],
      modelProvenance: {
        primary: "provider/primary",
        primarySource: "inherited",
        handledTurn: "provider/primary",
      },
    },
  )!;
  const rendered = lines.join("\n");
  assert.match(rendered, /recovery: switching → provider\/backup-two · primary provider\/primary · attempts 1 · skipped 1/);
  assert.doesNotMatch(rendered, /Main-model recovery|Order:|Current:|Pending switch:|Attempted:|Skipped:/);
  assert.doesNotMatch(rendered, /handled turn:/);
  assert.match(lines.at(-1)!, /^└─ recovery:/, "a recovery-only detail block is closed");
});

test("v0.38.29: settled recovery does not leave Markdown noise in the head", () => {
  const lines = buildWidgetLines(
    {
      goal: { ...goal(), objective: "**Ship** the `compact` card" },
      list: [],
      mainModelRecovery: {
        primary: "provider/primary",
        active: "provider/primary",
        attempted: ["provider/primary"],
        attempts: 0,
        reason: "selected",
        kind: "goal" as const,
      },
    } as State,
    null,
    NOW,
    undefined,
    160,
  )!;
  assert.match(lines[0]!, /Ship the compact card/);
  assert.doesNotMatch(lines[0]!, /\*\*|`/);
  assert.match(lines.find((line) => line.startsWith("└─ model:")) ?? "", /provider\/primary/);
});

test("card head cuts the objective at a clause boundary, never mid-word", () => {
  const objective = "Studio visual overhaul (ViewStats-style velocity bar): rebuild StudioRail on the chat PremiumSidebar pattern (collapse, search)";
  const out = truncateObjective(objective, 120);
  assert.ok(out.endsWith("pattern…"), `cuts at the parenthetical, not mid-word: ${out}`);
  assert.ok(out.length <= 120);
  assert.doesNotMatch(out, /colla…/);
  // A tighter budget stops at the earlier colon instead of mid-word.
  const tight = truncateObjective(objective, 80);
  assert.ok(tight.endsWith("bar)…"), `colon cut reads intentional: ${tight}`);
  assert.ok(tight.length <= 80);
});

test("truncateObjective keeps clause boundaries with emoji and CJK prefixes", () => {
  const emoji = truncateObjective("😀 ship: details after the boundary and more", 30);
  assert.equal(emoji, "😀 ship: details…", "emoji must not shift the clause boundary");
  const cjk = truncateObjective("目标：修复审计路径并补充测试覆盖", 16);
  assert.equal(cjk, "目标：修复…", "wide glyphs still cut at the clause boundary");
});

test("truncateObjective falls back to a character cut with no usable boundary", () => {
  assert.equal(truncateObjective("abcdefghijklmnopqrstuvwxyz0123456789", 10), "abcdefghi…");
  assert.equal(truncateObjective("short", 80), "short");
  // Boundary below the floor is not a summary — cut characters instead.
  assert.equal(truncateObjective("ab: cdefghijklmnopqrstuvwxyz", 12), "ab: cdefghi…");
});

test("active card with an action row closes the tree", () => {
  const lines = buildWidgetLines(
    { goal: goal(), list: [] },
    null,
    NOW,
    undefined,
    120,
    {
      modelProvenance: {
        primary: "opencode-go/muse-spark-1.3-contributor",
        primarySource: "inherited",
      },
      recent: [{ name: "bash", arg: "cd /home/dracon/Dev/dracon-platform", ms: 13_000, ok: true, at: NOW }],
    },
  )!;
  const rendered = lines.join("\n");
  assert.doesNotMatch(rendered, /model: primary/, "steady-state model row is dropped");
  assert.match(lines.at(-1)!, /^└─ ✓ bash/, "the action row closes the card instead of promising more");
});
