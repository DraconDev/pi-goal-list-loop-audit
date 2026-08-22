# Design — subagent visibility (`/glla agents`, issue #15)

Status: SCOPE AGREED with the user 2026-08-22 (panel + transcript tail +
widget line; live activity stream explicitly rejected as too noisy).
This document is the implementation contract for the follow-up work.

## Problem (issue #15)

During long fan-outs the only child visibility is the widget's 3-slot
"recent actions" ring. A child that "almost completed its final report,
went back to check some more, then crashed" is invisible: the parent sees
a silent wait, the user sees nothing actionable, and post-mortem evidence
lives in files nobody knows how to find.

## Agreed scope

### 1. `/glla agents` — snapshot panel

One-shot table of every tracked subagent, sourced from what glla already
holds (no new instrumentation):

- `subagentHangProbes` (goal-heartbeat.ts): agentType, summary, spawnedAt,
  lastProgressAt, toolUses, outputTokens, endedAt, hangAlertedAt.
- `subagentManagerPoller()` when pi-subagents publishes its registry
  (absent on some installed versions — always degrade gracefully to
  event-derived evidence).
- `flags.inFlightToolCalls` for which parent wait (foreground Agent /
  subagent call) each running child blocks.
- Ledger history of `subagent_hang_detected` for the "Recent hangs" footer
  of the panel.

Row shape:

```
● explore   map-model-picker   RUNNING 4m12s   tools 18 · out 2.1k · silent 0m
● plan      audit-contract     HUNG? 31m       tools 6 → frozen · out 890 · silent 26m
  └ blocks: foreground subagent call (zombie stand-down active)
✓ explore   schema-check       ENDED ok 3m44s
```

Hung classification reuses `classifyHungSubagents` semantics (record-frozen
vs event-only evidence). Cap display at ~20 rows; prune ended probes per
the existing SUBAGENT_HANG_PRUNE_MS rule.

### 2. `/glla agents --tail <id>` — child transcript tail (post-mortem)

Locate the child's session file on disk (pi sessions are JSONL under the
session store; pi-subagents records expose/allow correlation by id — probe
both the manager record and the probe registry) and print the LAST N lines
(N default 20, `--lines` override) rendered as `[tool] …/[asst] …/[user] …`
with truncation. If the file cannot be located, say so LOUDLY and name the
searched paths — never silently print an empty tail. Read-only: the tail
NEVER resumes or attaches to the child session.

### 3. Widget line — ambient awareness

One footer segment while children are tracked: `● N agents · <busiest>
silent Xm ⚠` (⚠ only past the hang threshold). Reuses the existing widget
render path in goal-loop-display/goal-ui; hidden when zero tracked
children so idle rigs see no change.

## Non-goals (explicitly rejected with the user)

- Live streaming of child tool calls into the main transcript (noise).
- Any attach/resume capability from the panel (read-only by design).
- New cross-extension contracts beyond the existing defensive manager poll.

## Implementation notes

- New module `extensions/goal-agents-panel.ts` (pure render functions +
  data assembly), wired into the `/glla` argument namespace next to
  `/glla audits`; widget segment in goal-ui.
- All rendering pure/testable: feed fixtures of probes + manager records;
  pin hung classification, cap behavior, loud-missing-file behavior for
  --tail, and widget hide-at-zero.
- Version + CHANGELOG + README at ship time; full release gate.
