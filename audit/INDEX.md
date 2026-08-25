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

**Most recent (2026-08-25):**
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
