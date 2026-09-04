# audit/ — index

Every shipped change carries an audit doc here (named `<TOPIC>-<date>.md`,
plus a `v0.34.x-<TOPIC>.md` symlink for versioned docs). Older docs
(≤ 2026-08-06) live in `audit/archive/`.

## Active focus (2026-08-17 → 2026-08-21)

The seven follow-up categories from the most recent full audit are
closed (host lifecycle, continuation dispatch, objective integrity,
explore retention, completion summaries, long-term preferences,
audit policy). The next pass owns the durable policy artifacts and
the open notes (`note.md` host lifecycle / completion recap /
long-term preferences).

**Most recent (2026-09-04):**
- `APPROVAL-NOTIFY-CLEANUP-2026-09-04.md` — v0.38.20 shipped: approval chat is outcome + ≤2 details + approval + record pointer, stale pre-verdict `Next:` stripped on all three `✓ done` paths; 19:20 field forensics (9.5-min audit disproves complete-before-verify, `…` cuts are word-boundary by design, tab runs pre-v0.38.18 code so `/reload`)
- `DISAPPROVAL-RESPONSE-DISPATCH-AND-WAITING-2026-09-04.md` — v0.38.19 shipped: busy-but-silent bypass sends the owed marker into pi's followUp queue after 5m of zero stream (track 2 root cause, not the aborter); `auditorDisplayPhase` projects awaiting-verdict only while auditing (track 3 state clear); both with empirical fail-before MockPi tests
- `COMPLETION-LIFECYCLE-TRILOGY-2026-09-04.md` — v0.38.18 shipped: pipe-syntax pipelines run shell-free (track 1), never-streamed turns park on first abort + honest rearm message (track 2), detached approval closes the transcript via fire-once followUp notice (track 3)
- `SUBAGENT-DIALECT-2026-09-04.md` — v0.38.16 shipped: prompts/strings speak the live `subagent` tool + `bg_wait` settle (dead tintinweb `Agent`/`get_subagent_result` gone); `isSubagentProviderFailure` matches the live names; tintinweb stays retired, pi-subagents 0.65 gets its own canary'd eval
- `PAUSE-ANTI-CONFABULATION-2026-09-04.md` — v0.38.15 shipped: `pause_goal` refuses blocker claims that name a missing GLLA tool (the call dispatching proves the batch landed) unless pi's own `Tool X not found` is quoted; new-tab incident forensics (zero tool errors, both claims disproven)
- `HUMAN-BRIEF-2026-09-04.md` — v0.38.14 shipped: every `✓ done` is now a human briefing (outcome-led, filler labels dropped, `none — <content>` keeps the content); placeholders never leak; pre-archive rule + prefix-strip fix documented
- `COMPLETION-SUMMARY-2026-09-04.md` — v0.38.13 shipped: the `✓ done` chat notify carries the six labels as one fact per line with word-boundary cuts (never `0 o…` mid-word again); single-line kept for widget + external; caught + fixed a post-archive null crash that swallowed the notify
- `LAST-WINS-2026-09-04.md` — v0.38.12 shipped: newest main session auto-takes the state root (old stands down, never signaled); `/goal start` replaces without dialog; archival failure never refuses the new objective (old preserved in ledger)
- `OWNER-TAKEOVER-2026-09-03.md` — v0.38.11 shipped: `/glla owner` inspection + consented `/glla takeover` (dead/recycled reclaim silent, live owner SIGTERMed after confirm + verified exit, never claim a survivor)
- `COMPACTOR-HANDOFF-2026-09-03.md` — v0.38.10 shipped: emergency-only compactor (chain → verified-free plan B → skip), prompt-in/text-out worker, warm handoff in resync+banner, desktop page on refuse
- `OVERCAP-STRATEGY-2026-09-03.md` — v0.38.9 shipped: the three rungs stated in order (trim always-on, guarded rotation, /new backstop) + viability ranking; ladder skips stale /compact retry; behavioral chain pins
- `TUI-DENSITY-2026-09-03.md` — v0.38.8 shipped: widget audits row, paused-status tally, ladder reflow, settings tab counts; before/after captures + 80-col pin
- `SESSION-VISIBILITY-2026-09-03.md` — v0.38.7 shipped: load-hold recovery banner (objective + next task + tally + resume from disk) + durable verdict tally on status line and /goal status; reload sessions answer "are we progressing?"
- `STARVATION-LADDER-2026-09-03.md` — v0.38.6 shipped: compact-first nudge at 85%, over-cap ladder (/compact retry / larger model / /new+resume + no-LLM backstop), send choke-point refuse, sticky refuse while ≥90%; 5-path ladder answers the over-cap question
- `DELTA-ONLY-CONTINUATION-2026-09-03.md` — v0.38.5 shipped: steady-state goal continuation is marker-only 45 chars (history holds state), resync+marker after compact, full 23k only on first-send/dirty (repair/recovery/audit); 1824 pass
- `CACHE-CRITICAL-ADDENDUM-2026-09-03.md` — cache-critical addendum: why a naked ≤160-char followUp marker would break GLLA (no `before_agent_start` systemPrompt authority) vs pi-goal-x `system.cache_control` + marker (45 chars vs GLLA 21–40k); A2 downgraded to CONDITIONAL paired, measured gate
- `ANTIGRAVITY-CODEX-CLAUDE-PI-GOAL-X-2026-09-03.md` — 4-harness keep-checking comparison vs GLLA ContinuousSupervisor 250ms→15s: Antigravity poll-only already ported, Codex smooth (compact prompt + 50ms idle gate, no heartbeat/auditor), Claude transcript + branch/plan lessons, pi-goal-x contender typed-revision/marker brevity — unified table + §6 borrow ranking (A8→A2→A1) — **errata: A2 now conditional per addendum**

**Most recent (2026-09-02):**
- `AVO-DEEP-DIVE-2026-09-02.md` — full paper+blog read of NVIDIA AVO (2603.24517 + 2026-08-21 ARC-AGI-3): Vary(Pt)=Agent(Pt,K,f), 40 versions/500 dirs in 7d B200, supervisor = conditional trajectory review, MHA+3.5%/FA4+10.5% → GQA 30-min transfer, vs PR #22/#36 map
- `v0.38.4` — `USER_INPUT_WAIT` zombie stand-down (PR #36 10-line slice): `pause_goal`/`propose_*`/`list_add`/`ask_user_question` stand down `BUSY+zero-stream` abort with own ledger `zombie_run_stood_down_user_input`; AVO+PRs closed

**2026-09-01:**
- `PR-AVO-DISPOSITION-2026-09-01.md` — read-only disposition of PRs #22/#36; neither merge as-is, selective stagnation/zombie ports only
- `CROSS-HARNESS-REVIEW-2026-09-01.md` — cross-harness review (pi-goal-x / dgoal / until-done / codex-goal / pi-goal / better-goal + Codex/Claude/DeepSeek hosts; 9 GLLA-owned deltas, 6 now / 4 defer)
- `SUBAGENT-PACKAGE-SELECTION-2026-09-01.md` — power-max audit of five subagent/orchestration packages; pin `pi-subagents@0.62.0` for GLLA
- `LIST-CONTINUOUS-HANDOFF-2026-09-01.md` — automatic handoff from successful standalone completion, waiting-queue `/glla resume`, and settle/fence regressions

**Previous (2026-08-31):**
- `LIVE-ACTIVITY-AND-RESUME-2026-08-31.md` — generation-scoped activity cleanup, real `/glla resume` host evidence, uniform auditor recovery, and queued-list disposition
- `UI-REPAINT-AND-AUDITOR-PROMPT-2026-08-31.md` — durable UI repaint bypass and escaped detached-auditor payload boundaries; Codex-informed follow-up
- `EXPLORE-CHILD-SESSION-TRIAGE-2026-08-29.md` — MMX-corroborated loadable Explore-session triage; fixed GLLA's exact child-transcript correlation while leaving Pi/pi-subagents session-picker ownership unchanged
- `LIST-STALL-REPRODUCTION-2026-08-29.md` — MockPi reproduction of the screenshot-shaped waiting queue and list-completion cascade; no confirmed GLLA-owned stall
- `AUDITOR-PARKED-NO-VERDICT-DISPOSITION-2026-08-29.md` — durable parked/no-verdict recovery validation and explicit provider-boundary disposition
- `PR-37-PROMPT-POLICY-ADAPTATION-2026-08-29.md` — read-only PR #37 review; current-main adaptation of explicit prompt-policy terminal handling

**Previous (2026-08-28):**
- `PI-GOAL-X-COMPARISON-2026-08-27.md` — fresh-clone full-repository comparison, transferable lessons, cautions, and non-adoption follow-up candidates

**Previous (2026-08-25):**
- `AUDITOR-BLANK-UNTIL-RESUME-2026-08-25.md` — objective/status remains visible while stale auditor context waits for continuation consent; v0.35.63
- `SUBAGENT-HOST-BOUNDARY-2026-08-25.md` — fail-closed child-session ownership and preserved host telemetry; v0.35.62
- `LIST-QUEUE-VISIBILITY-2026-08-25.md` — durable queue hydration and queue-only status/widget convergence across silent host replacement; v0.35.61
- `GETTICK-TOOL-VISIBILITY-2026-08-25.md` — pre-turn GLLA tool self-heal for the parked-objective / `Tool pause_goal not found` race; v0.35.60

**Previous (2026-08-21):**
- `EXTENSION-AUDIT-2026-08-21.md` — full package/runtime, lifecycle, prompt/trust-boundary, test/release survey; v0.35.14 hardening and deferred architecture ledger

**2026-08-19:**
- `GLLA-MENU-PRESENTATION-2026-08-19.md` — `/glla` menu noise review: literal session-model ref on inherited rows, composite-chain overflow, two-tab proposal (Status / About)
- `AUDIT-POLICY-CONTROLS-2026-08-19.md` — four-mode postaudit cadence contract: `none` / `completion-only` / `every-n-tasks` / `periodic` (default `completion-only`)
- `COMPLETION-SUMMARY-POLICY-2026-08-19.md` — six-label recap shape (Outcome / Changed / Evidence / Tests / Unresolved / Next) shipped in v0.35.5
- `LONG-TERM-PREFERENCES-POLICY-2026-08-19.md` — typed-boundary policy: current explicit intent > typed project setting > typed global setting > product default; landed as v0.35.6 regression pins
- `EXPLORE-SESSION-RETENTION-2026-08-19.md` — Explore-session provenance + retention boundaries
- `OBJECTIVE-INTEGRITY-2026-08-19.md` — small follow-up from the parallel integrity survey
- `CONTINUATION-DISPATCH-RELIABILITY-2026-08-19.md` — accepted-but-no-turn-start investigation, bounded retry, fence against upstream Pi replacement

**Validation / live evidence (2026-08-17):**
- `AUDITOR-LIVE-VALIDATION-2026-08-17.md` — auditor subprocess read-only allowlist + independence contract
- `FALLBACK-UNIFICATION-2026-08-17.md` — unified fallback chain walk across main / drafter / auditor / subagents
- `HOST-SESSION-LOST-CAPTURE-2026-08-17.md` — accepted-but-no-turn-start capture
- `LONG-RUNNING-PROFILE-2026-08-17.md` — long-running profile / live auditor clock (v0.35.3)

## v0.35.x release trail

| Version | Date | Audit doc | What landed |
|---|---|---|---|
| v0.35.63 | 2026-08-25 | `AUDITOR-BLANK-UNTIL-RESUME-2026-08-25.md` | objective/status stays visible while stale auditor context waits for continuation consent |
| v0.35.62 | 2026-08-25 | `SUBAGENT-HOST-BOUNDARY-2026-08-25.md` | fail-closed child-session ownership and preserved host telemetry |
| v0.35.61 | 2026-08-25 | `LIST-QUEUE-VISIBILITY-2026-08-25.md` | durable queue hydration and queue-only status/widget convergence across silent host replacement |
| v0.35.60 | 2026-08-25 | `GETTICK-TOOL-VISIBILITY-2026-08-25.md` | pre-turn agent-tool registration/self-heal; closes the `pause_goal not found` parked-objective race |
| v0.35.14 | 2026-08-21 | `EXTENSION-AUDIT-2026-08-21.md` | full extension audit; shell-free verification, lifecycle fencing, evidence/verdict hardening, ID validation, branch guard, release CI |
| v0.35.6 | 2026-08-19 | `LONG-TERM-PREFERENCES-POLICY-2026-08-19.md` | typed-boundary regression pins; conversation / completion / auditor / Explore transcripts cannot land in settings storage |
| v0.35.5 | 2026-08-19 | `COMPLETION-SUMMARY-POLICY-2026-08-19.md` | `complete_goal` schema adopts the six-label recap |
| v0.35.4 | 2026-08-16 | `CONTINUATION-DISPATCH-RELIABILITY-2026-08-19.md` (follow-up) | auditor reports in continuation prompts; repair-loop closure |
| v0.35.3 | 2026-08-15 | `LONG-RUNNING-PROFILE-2026-08-17.md` | live auditor clock and clearer recovery timing |
| v0.35.2 | 2026-08-15 | — | role-specific agent settings and compact values |
| v0.35.1 | 2026-08-15 | — | drafter agent controls and settings taxonomy |
| v0.35.0 | 2026-08-15 | — | explicit designer routing and drafting recovery |

## Versioned docs (v0.34.x symlinks → canonical doc)

| Version | Symlink | Canonical doc |
|---|---|---|
| v0.34.92 | v0.34.92-QUOTA-PROMPT-REMOVED.md | QUOTA-PROMPT-REMOVED-2026-08-08.md |
| v0.34.93 | v0.34.93-FORBIDDEN-MODEL-GATE.md | FORBIDDEN-MODEL-GATE-2026-08-08.md |
| v0.34.94 | v0.34.94-HOST-SESSION-LOST-SELF-HEAL.md | HOST-SESSION-LOST-SELF-HEAL-2026-08-08.md |
| v0.34.95 | v0.34.95-STATUS-TRANSPARENCY.md | STATUS-TRANSPARENCY-2026-08-08.md |
| v0.34.96 | v0.34.96-ABORTED-VS-COMPLETE.md | ABORTED-VS-COMPLETE-2026-08-08.md |
| v0.34.97 | v0.34.97-COMPACTION-VISIBLE.md | COMPACTION-VISIBLE-2026-08-08.md |
| v0.34.98 | v0.34.98-PAUSED-DECISION-SURFACE.md | PAUSED-DECISION-SURFACE-2026-08-08.md |
| v0.34.99 | v0.34.99-QUOTA-PROMPT-VERBOSITY.md | QUOTA-PROMPT-VERBOSITY-2026-08-08.md |
| v0.34.100 | v0.34.100-AUDITOR-SILENT-DEFAULT.md | AUDITOR-SILENT-DEFAULT-2026-08-08.md |
| v0.34.101 | v0.34.101-AUDITOR-AS-SUBAGENT-DESIGN.md | AUDITOR-AS-SUBAGENT-DESIGN.md |
| v0.34.102 | v0.34.102-FIELD-REPORT-TRIPLE-FIX.md | FIELD-REPORT-TRIPLE-FIX-2026-08-08.md |
| v0.34.103 | v0.34.103-REPLACE-RESUME-INTENT.md | REPLACE-RESUME-INTENT-2026-08-08.md |
| v0.34.104 | v0.34.104-IMAGE1-LIST-STALL-AND-COUNT-FIX.md | IMAGE1-LIST-STALL-AND-COUNT-FIX-2026-08-08.md |
| v0.34.105 | v0.34.105-SUBAGENT-HANG-WATCHDOG-QUOTA-BLINDSPOT.md | SUBAGENT-HANG-WATCHDOG-QUOTA-BLINDSPOT-2026-08-08.md |
| v0.34.108 | v0.34.108-GUIDANCE-LITERALS-AND-DEAD-CODE.md | GUIDANCE-LITERALS-AND-DEAD-CODE-2026-08-08.md |
| v0.34.109 | v0.34.109-GOAL-STATE-EXTRACTION.md | GOAL-STATE-EXTRACTION-2026-08-08.md |
| v0.34.110 | v0.34.110-GOAL-COMMANDS-EXTRACTION.md | GOAL-COMMANDS-EXTRACTION-2026-08-08.md |
| v0.34.111 | v0.34.111-GOAL-RECOVERY-EXTRACTION.md | GOAL-RECOVERY-EXTRACTION-2026-08-09.md |
| v0.34.112 | v0.34.112-GOAL-HEARTBEAT-EXTRACTION.md | GOAL-HEARTBEAT-EXTRACTION-2026-08-09.md |
| v0.34.113 | v0.34.113-GOAL-CONTINUATION-EXTRACTION.md | GOAL-CONTINUATION-EXTRACTION-2026-08-09.md |
| v0.34.114 | v0.34.114-GOAL-INSTALLER-THINNING.md | GOAL-INSTALLER-THINNING-2026-08-09.md |
| v0.34.115 | v0.34.115-MODEL-PICKER-MULTI-SELECT.md | MODEL-PICKER-MULTI-SELECT-2026-08-09.md |
| v0.34.116 | v0.34.116-SESSION-COMPACT-FALLBACK.md | SESSION-COMPACT-FALLBACK-2026-08-09.md |
| v0.34.117 | v0.34.117-STALE-CTX-AUTO-RECOVERY.md | STALE-CTX-AUTO-RECOVERY-2026-08-09.md |
| v0.34.118 | v0.34.118-BACKUPS-PICKER.md | BACKUPS-PICKER-2026-08-09.md |
| v0.34.119 | v0.34.119-NOTE-REMAINING-TRIAGE.md | NOTE-REMAINING-TRIAGE-2026-08-09.md |
| v0.34.121 | v0.34.121-NOTE-REMAINING-TRIAGE.md | NOTE-REMAINING-TRIAGE-2026-08-09.md |
| v0.34.121 | v0.34.121-HOST-SESSION-LOST.md | HOST-SESSION-LOST-2026-08-10.md |
| v0.34.121 | v0.34.121-PAUSED-WORKING-UI.md | PAUSED-WORKING-UI-2026-08-10.md |
| v0.34.121 | v0.34.121-DETACHED-AUDITOR-STATUS.md | DETACHED-AUDITOR-STATUS-2026-08-10.md |
| external reviews | EXTERNAL-REVIEWS-2026-08-09.md | EXTERNAL-REVIEWS-2026-08-09.md |
| v0.34.120 | v0.34.120-OBJECTIVE-LIFECYCLE.md | OBJECTIVE-LIFECYCLE-2026-08-09.md |
| v0.34.121 | v0.34.121-OBJECTIVE-LIFECYCLE-FOLLOWUP.md | OBJECTIVE-LIFECYCLE-FOLLOWUP-2026-08-09.md |

## Topic index (canonical docs, newest first)

**2026-09-01**
- PR-AVO-DISPOSITION-2026-09-01.md — PR #22/#36 AVO relevance, CI, lifecycle findings, and selective-port disposition
- CROSS-HARNESS-REVIEW-2026-09-01.md — cross-harness review (pi-goal-x/dgoal/until-done/codex-goal + Codex/Claude/DeepSeek hosts; 9 GLLA-owned deltas, pipe/health/heartbeat next)
- SUBAGENT-PACKAGE-SELECTION-2026-09-01.md — five-package power audit (pi-subagents 0.62.0 pinned, tintinweb/narumitw/dynamic-workflows/rpiv-advisor disposition) and README/external-recommendation updates
- LIST-CONTINUOUS-HANDOFF-2026-09-01.md — automatic standalone-goal/list handoff, waiting-queue `/glla resume`, and bounded successor settle

**2026-08-31**
- LIVE-ACTIVITY-AND-RESUME-2026-08-31.md — generation-scoped live activity, `/glla resume` RPC reproduction, auditor recovery, and queue disposition
- UI-REPAINT-AND-AUDITOR-PROMPT-2026-08-31.md — forced durable repaint and escaped auditor payload boundaries

**2026-08-29**
- EXPLORE-CHILD-SESSION-TRIAGE-2026-08-29.md — loadable Explore-session evidence, exact GLLA transcript correlation fix, and bounded screenshot attribution
- LIST-STALL-REPRODUCTION-2026-08-29.md — screenshot-shaped queue reproduction and explicit unresolved diagnostic gap
- PR-37-PROMPT-POLICY-ADAPTATION-2026-08-29.md — read-only PR #37 review and current-main adaptation; no blind cherry-pick

**2026-08-28**
- PI-GOAL-X-COMPARISON-2026-08-27.md — fresh-clone comparative learning audit; no runtime adoption

**2026-08-21**
- EXTENSION-AUDIT-2026-08-21.md — full extension survey, bounded hardening, and deferred architecture ledger

**2026-08-19**
- GLLA-MENU-PRESENTATION-2026-08-19.md — `/glla` menu noise review (literal session-model ref, composite-chain overflow) + Status / About tab proposal; no source change
- AUDIT-POLICY-CONTROLS-2026-08-19.md — four-mode postaudit cadence contract (`none` / `completion-only` / `every-n-tasks` / `periodic`); `auditCadence` is descriptive today, implementation deferred to a bounded feature pass
- COMPLETION-SUMMARY-POLICY-2026-08-19.md — six-label recap shape (Outcome / Changed / Evidence / Tests / Unresolved / Next); landed in v0.35.5
- LONG-TERM-PREFERENCES-POLICY-2026-08-19.md — typed-boundary policy: current explicit intent wins; landed in v0.35.6 as regression pins
- EXPLORE-SESSION-RETENTION-2026-08-19.md — Explore-session provenance + retention boundaries (Pi vs subagent vs glla own)
- OBJECTIVE-INTEGRITY-2026-08-19.md — small follow-up from the parallel integrity survey (buggy / previous-version objectives)
- CONTINUATION-DISPATCH-RELIABILITY-2026-08-19.md — accepted-but-no-turn-start investigation, bounded retry, fence against upstream Pi replacement

**2026-08-17**
- AUDITOR-LIVE-VALIDATION-2026-08-17.md — detached auditor subprocess read-only allowlist + independence contract
- FALLBACK-UNIFICATION-2026-08-17.md — unified fallback chain walk across main / drafter / auditor / subagents
- HOST-SESSION-LOST-CAPTURE-2026-08-17.md — accepted-but-no-turn-start capture and ledger wiring
- LONG-RUNNING-PROFILE-2026-08-17.md — live auditor clock and clearer recovery timing (v0.35.3)

**2026-08-15**
- PI-HOST-SESSION-REPLACEMENT-REQUEST-2026-08-15.md — Pi SDK boundary, requested event-safe replacement contract, and host acceptance tests
- CONTINUATION-APPROACH-COMPARISON-2026-08-15.md — Codex, Claude Code, and DeepSeek Harness continuation comparison and no-change decision

**2026-08-10**
- FAULTY-OBJECTIVE-RECOVERY-2026-08-10.md — provenance-first repair, non-recursive fallback queueing, and stale/auditor/continuation fences for suspicious objectives
- REVIEWER-ARCHIVE-METADATA-GUARD-2026-08-10.md — automatic postaudit no longer mines archived Objective/verification metadata into truncated, contract-less queue items; manual archive review remains available
- SESSION-START-AUDIT-RECOVERY-2026-08-10.md — validated fresh-session recovery for durable `recovery-pending` detached-auditor claims; ordinary cold starts remain held and Pi host replacement stays out of scope

**2026-08-09**
- NOTE-REMAINING-TRIAGE-2026-08-09.md — re-audit of every note.md item; summary canonicalization, whole-objective cancel, closure integration tests, truthful stale-ctx `/new` and subagent-transcript pi limitations, and 15-heading status matrix (v0.34.121)
- EXTERNAL-REVIEWS-2026-08-09.md — raw retrieval status and relevant ChatGPT review excerpts; Qwen HTTP 401 blocker
- OBJECTIVE-LIFECYCLE-2026-08-09.md — auto-close + final recap, one-active conflict choices, idempotent cancel/wipe, sidecar cleanup, and raw regression evidence (v0.34.120)
- OBJECTIVE-LIFECYCLE-FOLLOWUP-2026-08-09.md — closes the three auditor objections: active-loop cancel precedence, provider/dispatch wipe cleanup, and blank-start terminal closure (v0.34.121)
- HOST-SESSION-LOST-2026-08-10.md — correlates the new no-turn-start → stale-handle screenshots with raw ledger events and records the remaining pi-side replacement limitation
- PAUSED-WORKING-UI-2026-08-10.md — makes paused lifecycle ownership, queue/park state, last activity, and next transition explicit without changing lifecycle semantics
- DETACHED-AUDITOR-STATUS-2026-08-10.md — makes detached subprocess phase, evidence, freshness, verdict waiting, and next transition explicit while keeping MAIN supervising
- BACKUPS-PICKER-2026-08-09.md — dedicated Backups settings segment + ordered backup picker hides forbidden refs and removes no-op session/manual rows (v0.34.118)
- STALE-CTX-AUTO-RECOVERY-2026-08-09.md — programmatic /new on `isStaleApiError` so the user no longer has to type `/new` after pi's compact subsystem wedges (v0.34.117)
- SESSION-COMPACT-FALLBACK-2026-08-09.md — context-overflow classification + fallback chain walk when session_compact cannot release the prompt + /reload copy + stale-ctx one-liner (v0.34.116)
- MODEL-PICKER-MULTI-SELECT-2026-08-09.md — multi-select picker + unified model-selector + empty forbiddenModels default + subagentFallbacks chain (v0.34.115)
- GOAL-INSTALLER-THINNING-2026-08-09.md — decomposition step 6: goal.ts thin installer surface (v0.34.114)
- GOAL-CONTINUATION-EXTRACTION-2026-08-09.md — decomposition step 5: goal-continuation.ts extracted (v0.34.113)
- GOAL-HEARTBEAT-EXTRACTION-2026-08-09.md — decomposition step 4: goal-heartbeat.ts extracted (v0.34.112)
- GOAL-RECOVERY-EXTRACTION-2026-08-09.md — decomposition step 3: goal-recovery.ts extracted (v0.34.111)

**2026-08-08**
- GOAL-COMMANDS-EXTRACTION-2026-08-08.md — decomposition step 2: goal-commands.ts + goal-loop.ts extracted, zero behavior change (v0.34.110)
- GOAL-STATE-EXTRACTION-2026-08-08.md — decomposition step 1: goal-state.ts owns the state singleton (v0.34.109)
- GUIDANCE-LITERALS-AND-DEAD-CODE-2026-08-08.md — 7 guidance literals fixed + dead-code sweep + pin blind spot (v0.34.108)
- SUBAGENT-HANG-WATCHDOG-QUOTA-BLINDSPOT-2026-08-08.md — subagent hang watchdog blinded by main-model quota recovery (v0.34.105)
- IMAGE1-LIST-STALL-AND-COUNT-FIX-2026-08-08.md — list-stall settle window + completionSummary self-check (v0.34.104)
- REPLACE-RESUME-INTENT-2026-08-08.md — replace no longer cancels wait-goal resume (v0.34.103, GitHub #6)
- FIELD-REPORT-TRIPLE-FIX-2026-08-08.md — watchdog event-only fallback + recovering display + rearm no-turn diagnostic (v0.34.102)
- QUOTA-PROMPT-VERBOSITY-2026-08-08.md — quota-prompt verbosity (v0.34.99)
- PAUSED-DECISION-SURFACE-2026-08-08.md — paused decision surface (v0.34.98)
- COMPACTION-VISIBLE-2026-08-08.md — compaction visible state (v0.34.97)
- ABORTED-VS-COMPLETE-2026-08-08.md — aborted vs complete semantics (v0.34.96)
- STATUS-TRANSPARENCY-2026-08-08.md — status transparency (v0.34.95)
- HOST-SESSION-LOST-SELF-HEAL-2026-08-08.md — host-session-lost self-heal (v0.34.94)
- FORBIDDEN-MODEL-GATE-2026-08-08.md — forbidden-model gate (v0.34.93)
- QUOTA-PROMPT-REMOVED-2026-08-08.md — quota-prompt system removed (v0.34.92)
- AUDITOR-SILENT-DEFAULT-2026-08-08.md — auditor report-stream muted default (v0.34.100)
- END-OF-GOAL-RECAP-2026-08-08.md — end-of-goal recap rendering

**2026-08-07**
- AUDITOR-AS-SUBAGENT-DESIGN.md — auditor-as-subagent architecture (design only, v0.34.101)
- LOCAL-GOAL-LOOP-PLUGIN-AUDIT-2026-08-07.md — second local plugin audit
- AUDITOR-EAGER-RETRY-2026-08-07.md — auditor eager retry
- AUDITOR-PROGRESS-SIGNALS-2026-08-07.md — auditor progress signals
- CONFIRM-DRAFT-MARKDOWN-2026-08-07.md — confirm-draft markdown (GitHub #4)
- CONTEXT-STARVATION-REFUSE-2026-08-07.md — context-starvation refusal
- DEAD-COUNTDOWN-QUOTA-2026-08-07.md — dead countdown quota
- DESIGN-LIST-PARALLEL-2026-08-07.md — list parallel design
- HOST-SESSION-LOST-2026-08-07.md — host session lost
- HOURLY-QUOTA-PROBE-2026-08-07.md — hourly quota probe
- ID-INVALIDATION-2026-08-07.md — id invalidation
- INTERRUPT-DIDNT-CONTINUE-2026-08-07.md — interrupt didn't continue
- LIST-SUBTASKS-2026-08-07.md — list subtasks
- NO-TURN-START-RETRY-2026-08-07.md — no-turn-start retry (v0.34.88)
- QUOTA-WALL-REMOVED-2026-08-07.md — quota wall detection removed
- REVIEWER-ISSUE-MISPARSE-2026-08-07.md — reviewer issue misparse
- SHIELD-NON-ASCII-2026-08-07.md — shield non-ascii
- SPURIOUS-STALE-SELF-HEAL-2026-08-07.md — spurious stale self-heal
- STATUS-SURFACE-SEPARATION-2026-08-07.md — status surface separation
- STUCK-AUDITING-LATCH-2026-08-07.md — stuck auditing latch
- SUBAGENT-HANG-DETECTION-2026-08-07.md — subagent hang detection (v0.34.85)
- TERMINAL-GOAL-SUMMARY-2026-08-07.md — terminal goal summary

## Archive (≤ 2026-08-06, see audit/archive/)

- CHROME-EVALUATE-CAP-2026-08-06.md — chrome evaluate capability
- DEPLOYMENT-2026-08-06.md — deployment mechanics
- OPEN-ISSUES-2026-08-06.md — open issues tracker (superseded by GitHub issues)
- LOCAL-GOAL-LOOP-PLUGIN-AUDIT-2026-08-02.md — first local plugin audit
- WRONG-OR-NOT-PREMIUM-2026-07-28.md — wrong-or-not-premium analysis
- LONG-RUNNING-MODES.md — long-running modes research
- PARKED-IDEAS.md — parked ideas
- command-registration-routing.md — command registration routing notes
