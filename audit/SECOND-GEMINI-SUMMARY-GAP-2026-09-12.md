# Second Gemini-summary gap — 2026-09-12 (v0.38.52 survey)

Five new Antigravity (Gemini 3.8 Flash) session reports inventoried against
GLLA v0.38.51 (which already ships grouped findings, echo headline,
duration line, 4+-group auto-table, budgets 12/400/6).

## Shots

- **A** `Screenshot_20260912_133301.png` (doomtap): trophy headline bar,
  `## What Was Delivered`, `### n. Name (Rn)` bold-lead sections,
  quality gates as bullets, `## Audit Artifacts` with handoff links.
  Same family as the 03:49 batch — no new structural ideas.
- **B** `Screenshot_20260912_133258.png` (come-get-me): `### Verification
  & Quality Gates` as a **2-col `Check | Result` table, 7 rows** (unit,
  typecheck, E2E, production build, audit-guard, desktop invariant, git
  invariants) with bold counts; pending-audit holding statement
  ("auditor running … will present the final report once the audit
  verdict is delivered").
- **C** `Screenshot_20260912_133239.png` (junk-runner): `### Goal Complete
  Verification` — every numbered deliverable carries **`Verification:
  <file:line…>` and `Test Results: <suite…>` sub-bullets**;
  mid-session tool-call chatter stays visible in the transcript.
- **D** `Screenshot_20260912_133231.png` (deathrun): **4-col `Quality Gate
  | Scope | Status | Notes` table, 9 rows + `VERDICT` row**; emoji
  section markers (`## ⚡ R3 …`, `## 🧪 Comprehensive Verification
  Summary`); commit-hash close line ("pushed to main (a8f3fad5)").
- **E** `Screenshot_20260912_133228.png` (deathrun): same family as A —
  no new structural ideas.

## Ranked steal table

| # | Convention (shot) | GLLA today | Verdict |
|---|---|---|---|
| 1 | Verification gates as a multi-row table (B, D) | `### Verification Summary` is 3-col, capped at 2 Tests rows + 1 Audit row | **ADOPT** — widen toward Gate\|Scope\|Status\|Notes with agent-supplied rows |
| 2 | Per-finding `Test Results:` sub-line (C) | Evidence tokens only, no test-results line per finding | **ADOPT** — optional `tests[]` parallel to findings |
| 3 | Emoji section markers (D) | Plain ASCII voice, uniform `•` discipline (v0.38.39) | **REJECT** — decoration without information; conflicts with voice discipline |
| 4 | Commit-hash close / artifact links in chat (D, A) | Machine paths archive-only (v0.38.39) | **REJECT** — owner-confirmed archive-only; re-opens settled debate |
| 5 | Trophy headline + verdict-first copy (A, E) | `## Done:` echo headline already verdict-first | **CONVERGENT** — no change |
| 6 | Pending-audit holding statement (B) | `auditor: queued` widget + queued-claim voice already exist | **CONVERGENT** — no change |

## Adoption (owner-grilled 2026-09-12)

- Scope: table expansion + per-finding test lines; no voice changes.
- Source: optional agent-supplied gate rows, sanitized at claim time
  (mirrors the `findingGroups` precedent); status DERIVED mechanically
  via `testsRowStatus` so no agent-controlled PASS; mechanical fallback
  keeps today's 3-col output byte-identical when absent.
- Chat close stays archive-only.
- Full ship: implement + tests + gate + version + release + publish.

## Shipped in v0.38.52

- `GateRow` + `sanitizeGateRows()` in `extensions/goal-loop-core.ts`
  (max 10 rows; gate 120 / scope 200 / notes 400 chars; unknown keys
  dropped; garbage degrades to absent); `PendingCompletion.gateRows`.
- `FindingGroup.tests?: string[]` + `MAX_GROUP_TESTS_CHARS=500`;
  `sanitizeFindingGroups` parses the parallel array clipped to findings.
- `buildRichTerminalParts(..., gates)` in
  `extensions/completion-summary.ts`: agent inventory widens the
  Verification table to Quality Gate | Scope | Status | Notes with
  `testsRowStatus`-derived statuses and supersedes the mechanical Tests
  rows; nested findings gain `Test Results:` sub-bullets, table rows gain
  `· Tests:` evidence; `takeBudgetedGroups` keeps tests aligned;
  byte-identical fallback when absent.
- `complete_goal gateRows` schema + claim/Esc/manual-archive threading
  (`goal-tools.ts`, `goal-orchestrator.ts`, `goal-auditor-hooks.ts`).
- Continuation prompt documents `gateRows` + `tests` with both fallbacks.
- `tests/second-gemini-gap.test.ts` (9 pins incl. a claim-to-chat E2E);
  `persistence-hardening` + `retry-bounds` call-shape pins re-baselined;
  `context-growth-measurement` 23_598 chars / 23_708 bytes (+602/+608
  proved exact) and `context-checkpoint` 27144 re-baselined.
