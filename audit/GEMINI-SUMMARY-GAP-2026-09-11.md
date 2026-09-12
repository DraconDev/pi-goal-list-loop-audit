# Gemini summary gap — survey of 4 Antigravity/Gemini report screenshots (2026-09-11)

Goal `20260912022138-wfk27s`. All four shots are Konsole tabs running
Antigravity agent sessions (`: agy` tabs, `Gemini 3.8 Flash · medium`
model line). Every claim below is traceable to a visible element in one
of the four files; nothing is inferred about model internals.

Source files (outside the repo, owner field captures):

- `Screenshot_20260911_221917.png` (shot A) — end-game/loot report
- `Screenshot_20260911_235839.png` (shot B) — combat-audio test report
- `Screenshot_20260911_235831.png` (shot C) — 12-screen audit final report
- `Screenshot_20260911_235824.png` (shot D) — ship-width/music/map report

## 1. Per-shot inventory

### Shot A — grouped areas + verification gates

- `Synthesizing Report for User Request` preface line, then a
  request-mirroring title:
  `### In-Combat Audio Silencing, Mosquito Ship Fix, & End-Game Screen Overhaul`.
- Numbered area sections (`#### 1. In-Combat Voice & SFX De-Spamming`,
  `#### 2. Fixed "Mosquito Ship" Sticking Physics`,
  `#### 3. Overhauled End-Game Screen (GameOverModal.svelte)`).
- Bold-lead bullets (`Disabled Combat Speech In-Flight:`, `Disengage Timer
  & Repulsion:`, `Outward Tactical Steering:`) with second-level nesting
  (energy-shield bump vs direct hull scrape sub-bullets).
- Near-every claim carries an inline `file:line` link
  (`soundManager.ts:430`, `sim.ts:4505-4530`, `spec-hp`, stat pills).
- `#### 4. Verification & Quality Gates` with bold exact counts
  (`732/732 tests`, `0 errors and 0 warnings`) plus a platform-invariant line.
- `Thought for 4s, 406 tokens` process line above the report.
- Length: ~60 visible lines for one report.

### Shot B — deep nesting + inline code + build timing

- `### 1. Eliminated Woman Talking Voice Across the Game` with
  `Completely Silenced Spoken Voice Calls:` bold lead, inline code
  (`public voiceEnabled: boolean = false;`, `soundManager.ts:333`) and
  second-level nesting (`Removed Page-Level Speech Triggers:` with two
  call-site sub-bullets carrying `+page.svelte:260` / `:145` links).
- `### 2. End-Game Screen Overhaul: ...` mixes prose, an inline code block
  (Svelte `$effect`), and three-level bullets (Header / Item Profile /
  Stat Chips with emoji glyphs and stat-pill tokens).
- `### 3. Verification & Quality Gates`: `732/732 tests (0 failures)`,
  `0 errors and 0 warnings`, `build ... 2.67s`, platform-invariant line.
- Length: longest of the four (~80+ lines with the code block).

### Shot C — tabular multi-item layout (the standout)

- Highlighted banner title
  (`Comprehensive Screen Audit & Polish — Final Report`), one prose lede
  sentence, and a pointer to the full report doc (`full_audit_report.md`).
- `### Key Screen-by-Screen Updates` is a **12-row table**
  (Screen | Route | Key Polish & Ergonomic Fixes) — one row per screen,
  dense fix tokens per row, no nesting needed.
- `### Global Design System Upgrades`: numbered bold-lead list
  (Persistent Atmospheric Backdrop, Non-Destructive Glitch Text, ...).
- `### Automated Verification & Release Status`: `0 errors, 0 warnings`,
  `2,768 passed, 0 failed`, `24 full-resolution screenshots`,
  `0 console errors and 0 page errors`.
- Lesson: tables beat nesting once items span many areas.

### Shot D — Root Cause / Fixes Applied sub-structure

- `### Summary of Completed Improvements`, then `#### 1/2/3` areas, each
  with the same two-part skeleton: `Root Cause:` prose with inline code,
  then `Fixes Applied:` nested bullets with file links
  (`Ship.svelte`, `ShipParallax.svelte`, `global.d.ts`, `Map.svelte`).
- `### Verification Results`: `700 / 700 test files (5,848 tests
  passing)`, `0 errors`, `All 128 map E2E tests ... passed cleanly`.
- Most disciplined structure of the four; maps 1:1 onto grouped findings.

## 2. Ranked steal table

| Rank | Steal | Source | GLLA mapping | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Grouped findings with 2-level nesting | A, B, D | finding-groups parameter + nested render, flat fallback | ADOPT (goal core) |
| 2 | Tabular layout for multi-area runs | C | auto-table at 4+ groups | ADOPT (goal core) |
| 3 | `file:line` evidence token on each claim | A, B, D | standardized `path:line` token, repo-relative only | ADOPT (goal core) |
| 4 | Request-echo headline | A, B, D titles; C banner | headline echoes the objective, outcome second | ADOPT (goal core) |
| 5 | Bold exact verification counts | A, B, C, D | verification table adopts bold `n/n` counts | ADOPT (fold into table) |
| 6 | Duration/process line | Thought lines, B build timing | one compact turns/elapsed/audits line | ADOPT (goal core) |
| 7 | Root Cause / Fixes Applied skeleton | D | nesting guidance in agent docs, not renderer structure | GUIDANCE ONLY |
| 8 | Lede prose + full-report doc link | C | REJECT for chat — archive already is the full record; chat stays bounded | REJECT |
| 9 | Inline multi-line code blocks | B | REJECT — short inline tokens only; blocks violate width + honesty budgets | REJECT |
| 10 | 60–80-line unbounded length | A–D | REJECT as-is — budgets rise (12 / 400 / 6 floor) but stay capped | BOUND |

## 3. Budget recommendation (adopted floor: 12 / 400 / 6)

- Findings 8 → 12: the examples average 3–4 areas × 3 claims; 12 grouped
  findings cover a large completion without truncation.
- Value 200 → 400 chars: one Gemini claim with a file:line token and a
  count runs 150–250 chars; 400 fits a nested parent plus its evidence.
- Next 4 → 6: unchanged shape, headroom for multi-area follow-ups.
- Hard rule preserved: every surface still clips at clause boundaries,
  never mid-word; tables escape pipes as the verification table does.
