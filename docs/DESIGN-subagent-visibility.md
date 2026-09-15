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

Row shape (shipped one-glyph-line since v0.38.23: age-first single lines
replace the v0.38.22 two-line shape — footers deleted, ids live in
`/glla agents`; audit 2026-09-07 verified this against the doc and kept
the code — the doc, not the pins, was stale):

```
▶ explore · map-model-picker · active 8s
▶ plan · audit-contract · quiet 26m
⚠ plan · stuck-render · HUNG · quiet 31m · id e5f6…
```

Troubled rows append the short id; healthy rows stay self-contained
without the fleet panel (the v0.38.22 `└ check the Agents panel` footer
is gone — the row itself says what is wrong). `/glla agents` keeps the
full detail view (recent hangs read the durable `subagent_hang_detected`
ledger, absent when empty — never a placeholder).

The `└ blocks:` row renders only from an OBSERVED in-flight parent
subagent wait (tool args carry no run id, so per-row correlation is
impossible — the wait NAME is named, never inferred). The "Recent hangs"
footer reads the durable `subagent_hang_detected` ledger (last 3, absent
when empty — never a placeholder).

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

## v0.38.22 supersede — display unification (2026-09-05)

The compact-only doctrine above was the v0.37.1 jitter fix (raw per-second
silence ages re-laid out the editor every tick). v0.38.22 keeps the doctrine's
safety property by other means — `renderAgentsWidgetLines` buckets silence
ages exactly like the compact line, so the widget key only moves on genuine
state transitions — and restores rich ambient rows behind the
`subagentDisplayRichness` ladder (`quiet` canonical default since the
2026-09-07 flip — `rich` was the default before / `compact` / `quiet`, HUNG
never silent), plus — until v0.38.23 — the task-linkage header
(`→ <objective>`) only GLLA can show. v0.38.23 removes the header (the
card head already names the objective), collapses worker rows to one
glyph-first line each, forces the card below the chat
(`{ placement: "belowEditor" }`), and adds the evidence lifesign
(counter-derived breathing glyph + `stream {age}` readout + semantic
band colors on head and rows, queued capped at amber). Triplication/ordering against pi-subagents native panels is upstream
(nicobailon/pi-subagents#1931, read-only); GLLA owns its slot only and
documents the native escapes. Assembly is the pure `assembleAgentsExtras`
(pinned in `tests/subagent-display-richness.test.ts`).
