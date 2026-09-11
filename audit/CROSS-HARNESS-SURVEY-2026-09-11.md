# Cross-harness survey — 2026-09-11 (goal 20260911105735-wm1qh5)

Research-only. Six open harnesses cloned fresh into `.research/` (depth 1,
2026-09-11); seven parallel scout lanes, one per name plus a closed-source
pass. Prior audits reused, not duplicated:
`audit/PI-GOAL-X-COMPARISON-2026-08-27.md`,
`audit/CODEX-SUMMARY-2026-09-09.md`,
`audit/ANTIGRAVITY-CODEX-CLAUDE-PI-GOAL-X-2026-09-03.md`,
`audit/ANTIGRAVITY-TEAMWORK-PREVIEW-2026-09-04.md`.
Raw scout reports: `/var/tmp/glla-survey/*.md` (ephemeral; this file is the record).

## 1. tmonk/pi-goal-x (v0.31.2) — delta vs 2026-08-27 audit

Direct competitor (pi goal plugin). New since the prior audit (HEAD `fe430b2`):
- Forked-subagent supervision isolation: `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_DEPTH`
  detection, goal context stripped in children, no goal-tool init in children
  (`.research/pi-goal-x/extensions/goal-session-safety.ts:4-8`, CHANGELOG 0.31.1 #49).
- Settle-gated audit transcript queue: display-only audit events held until
  `ctx.isIdle()`, flushed at `agent_settled` with `triggerTurn:false`, kept out
  of provider context (`goal-session-safety.ts:23-42`, `goal-events.ts:535-538`).
- Continuation deferred from `agent_end` to `agent_settled` on pi 0.84
  (`goal-events.ts:527-538`).
- Buffered per-turn transaction: one lock/write/ledger-batch at turn end,
  revision-mismatch rejection, audit only flushed state (`goal-service.ts:162-260`).
- Atomic `update_goal_task` batches + pending-task completion gate
  (`goal-task-tools.ts:392-420`, `goal-completion.ts:39-52`).
- Post-compaction delta resync (focus task + contract + recent tail + last
  auditor finding) instead of full-state resend (`goal-compaction.ts:156-176`).
- Measured context program: cursor-paged detail getter, bounded caches,
  indexed ledger (`goal-detail.ts`, `goal-ledger-index.ts:14-37`).
- Not borrowed: Blocker Oracle nested consultant (conflicts with detached
  auditor isolation), unbounded retry ladder, in-process auditor.

## 2. openai/codex — delta vs 2026-09-09 audits

Rust monorepo (`codex-rs/`) + TS/Python SDKs. New vs prior coverage:
- Declarative exec policy: Starlark `prefix_rule(pattern, decision,
  justification, match, not_match)`, strictest-wins, load-time self-tests
  (`codex-rs/execpolicy/README.md`, `src/decision.rs`, `src/policy.rs`).
- Approvals model `Never|OnRequest|UnlessTrusted|Granular`, prompt-required +
  Never fails closed (`codex-rs/core/src/safety.rs`, `src/exec_policy.rs`).
- Model-context budget: incremental-only history, bounded injects, ≤10K
  tokens/item, typed `ContextualUserFragment` (`AGENTS.md`).
- Review fanout: `code-review` orchestrator spawns one subagent per
  `code-review-*` skill, numbered file:line findings
  (`.codex/skills/code-review/SKILL.md`).
- Rollout JSONL: canonical session records + cursor search + reverse scanner +
  sqlite metrics (`codex-rs/rollout/src/recorder.rs`, `search.rs`, `state_db.rs`).
- Terminal UX contract: fixed palette roles, human-vs-JSONL dual processors,
  `insta` snapshots required for visible UI change (`codex-rs/tui/styles.md`).
- Not borrowed: OS sandboxes (Seatbelt/seccomp/tokens), cloud-tasks/daemon,
  dropping the detached auditor for "smoothness" (already rejected).

## 3. anthropics/claude-code — fresh (prior coverage: one joint file)

Tree holds the plugin layer (`plugins/`), not the host binary:
- Agent frontmatter model: `agents/*.md` with `name/description/model/tools`,
  description + `<example>` triggering, least-privilege `tools:` allowlist;
  read-only explorer / planner / gate reviewer instances
  (`plugins/feature-dev/agents/code-explorer.md`, `code-architect.md`,
  `code-reviewer.md`).
- Hooks: 9 events (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SubagentStop/
  SessionStart/SessionEnd/PreCompact/Notification), matcher regex, JSON
  stdin/stdout, exit 0/2 semantics
  (`plugins/plugin-dev/skills/hook-development/SKILL.md`); instances include
  async background review with `asyncRewake` (`plugins/security-guidance/`)
  and a self-referential Stop loop (`plugins/ralph-wiggum/`, unbounded:
  do not copy as a driver).
- Skills as progressive disclosure: ~100-word metadata always in context /
  <5k-word body / `references/` on demand
  (`plugins/plugin-dev/skills/skill-development/SKILL.md`).
- Permissions: declarative allow/ask/deny + managed locks + Bash-only sandbox
  (`examples/settings/settings-strict.json`); plan mode is a permission
  posture (read-only auto, writes gated, `ExitPlanMode`).
- Review: two-stage propose-then-validate PR flow with per-issue validator
  subagents (`plugins/code-review/commands/code-review.md` steps 4-6);
  aspect-routed local review incl. zero-tolerance silent-failure hunter
  (`plugins/pr-review-toolkit/`).
- Not borrowed: host transcript/resume protocol, in-process Task VM
  mechanics, MDM enforcement, triage automation.

## 4. xai-org/grok-build — fresh

Rust, 83 crates, TUI + headless + ACP:
- Per-attempt doom-loop signal collector (no cross-attempt leakage) + capped
  recovery replay with truncation marker, clamped policy
  (`crates/codegen/xai-grok-sampler/src/doom_loop.rs`,
  `doom_loop_recovery.rs`).
- Lifecycle contribution model: hosts own loop control; data-only inputs +
  `TurnBoundary`/`QueuePolicy`/`ShutdownPolicy` traits
  (`crates/codegen/xai-agent-lifecycle/src/send/`).
- `CompletionRequirement { tool, reminder, recovery }` forces a tool call
  before turn end (`xai-grok-agent/src/config.rs:782-800`).
- Hash-chained workflow journal, capped (64MB/10k), engine budgets
  (`xai-workflow/src/journal.rs`, `lib.rs:14-17`).
- Fail-open typed hook bus, 8 events, pre_tool_use can allow/ask/deny +
  rewrite input (`xai-grok-hooks/src/lib.rs`).
- Compaction: segment store + INDEX, 512KB turn cap, 4 detail levels
  (`xai-compaction-transcript/src/lib.rs`); cross-session memory with
  sqlite-vec + MMR (`xai-grok-memory/`).
- Scheduler: `/loop [interval] <prompt>` recurring prompts
  (`xai-grok-pager/src/slash/commands/loop_cmd.rs`).
- Status-line as leaf crate with capability-gated row + versioned context
  schema (`xai-grok-status-line/src/lib.rs`, `context.rs`).
- Self-testing: 169 PTY e2e scenarios, subagent soak tests.
- Not borrowed: ACP/TUI stack, kernel sandbox, sampler wire internals,
  scheduler daemon, telemetry.

## 5. deepseek-ai/deepseek-harness — fresh (harness + plugin map)

Cordis plugin runtime + `dsh` launcher; NO privileged core, everything
(incl. loop, tools, session log) is a replaceable plugin
(`docs/architecture.md#cordis`). Plugin groups: `core`, `goal` (one durable
goal/session + `/goal` + round-driver), `bundle`/`boot`, capability seams
(`llm/shell/subprocess/terminal/sandbox/fs/lsp/web`), `subagent`
(delegation registry + ACP/Codex/Claude/SDK providers), `workflow`
(model-authored fan-out + `ralph`), `todo`, `plan`, `compaction` (auto +
tool-result pruner), `session` (JSONL/checkpoints/projections),
`session-query` (bounded reads + SQLite FTS + `/export`), `guard`
(repeat-tool reminder + tool timeouts), `interaction` (slash cmds without
model turn, approvals, `ask_user_question`), `settings`/`credentials`,
`hooks` (Claude/Codex bridges), `skill`, `schedule`, `feedback` (ratings
never fed to model), `runtime-diagnostics` (package-owned invariants).
- Goal has phases + `GoalBlockReason` but NO independent evaluator: model
  policy decides sufficiency, certification deferred
  (`packages/goal/goal-round-driver/README.md` Known Limitations).
  GLLA's detached auditor has no counterpart; do not copy the gap.
- Stealable: generated config/tool/event catalogs with freshness gates
  (`docs/config-catalog.md`); repeat-call guard + tool timeouts
  (`packages/guard/README.md`); tool-result pruner before compaction
  (`packages/compaction/README.md`); session-query evidence pack
  (`packages/session-query/README.md`); ralph bounded handoff schema
  (`status/summary/evidence/next/blocker`, `maxHandoffChars`)
  (`packages/workflow/tool-ralph/README.md`).
- Not borrowed: Cordis runtime, E2B/ACP transports, bilingual i18n gates.

## 6. MoonshotAI/kimi-code — fresh

TypeScript monorepo: CLI/TUI (`apps/kimi-code`), engine
(`packages/agent-core-v2`), REST+WS server, ACP (`kimi acp`).
- Bounded loop-control schema: steps/attempts/context-reserve/
  compaction-ratio, env+TOML, deprecations, actionable max-steps error
  (`agent-core-v2/src/agent/loop/configSection.ts`).
- Ordered lifecycle hook slot with before/after semantics (`src/hooks.ts`).
- Tool contract: typed results (`stopTurn/truncated/note/delivery/spill`),
  50K default cap (`src/tool/toolContract.ts`).
- Permissions: modes + policy + per-call approval + trust per install
  (`src/agent/permissionMode/`, `toolApproval/`).
- Task handles: `task-{list,output,stop,wait}` + coder/explore/plan subagents.
- Compaction service + handoff + queue deferral (`fullCompaction/`,
  `contextMemory/compactionHandoff.ts`); undo bounded by turns, refused
  across compaction (`agent/undo/undo.ts`).
- Replayable state keys + transcript L1-store-to-L4-view contract
  (`state/agentStateService.ts`, `packages/transcript/src/contract/`);
  replay/vis debuggers (`apps/vis`, `apps/kimi-inspect`).
- Self-verification: seam-based TDD skill (`.agents/skills/tdd/SKILL.md`),
  per-package vitest, changesets.
- Not borrowed: ACP/remote-control/media input, execution-layer internals
  (minidb, kaos, tree-sitter-bash), repo hygiene (comment-free lint).

## 7. Closed source: Antigravity + ZCode (bounded docs pass)

ZCode identified as Z.ai (Zhipu) desktop agentic IDE, official harness for
GLM models (https://zcode.z.ai/en); changelog top entry v3.11.2, Sep 4 2026
(https://zcode.z.ai/en/changelog). Harness itself is a proprietary binary
(one teardown calls it open-source, but no harness repo exists and npm
names are placeholders or 404; model weights are MIT, binary unverified).
Antigravity is alive and versioned: IDE 2.0 v2.12.2, CLI v1.2.0, SDK v0.1.16
(https://antigravity.google/docs/subagents/); Teamwork still preview-gated.
Checkable: ZCode Goal Mode semantics (`/goal`, one goal/session,
pause/resume/replace/clear, per-round met-check, origin-iteration checklist
pinning, round titles from prior verification's next action)
(https://zcode.z.ai/en/docs/goal); subagents (general-purpose + read-only
Explore) (https://zcode.z.ai/en/docs/subagents); hooks as stdin-JSON
subprocess, 8 events (https://zcode.z.ai/en/docs/hooks); Antigravity
subagent lifecycle/nesting/frontmatter
(https://antigravity.google/docs/subagents/).
Not checkable (unavailable-evidence): poll intervals, supervision loops,
state/persistence formats, verdict internals, harness license text,
Antigravity changelog deltas (garbled fetch), VentureBeat piece (walled).
Verdict: the assumption mostly holds. Both surfaces leak UX conventions
only; nothing overturns a GLLA design decision. Learnables:
origin-iteration checklist pinning (display convention, optional),
thought-level toggle (deferred, no demand), hooks-without-model-handle
(convergent with Claude). ZCode Goal Mode is narrower than GLLA
(one goal/session, self-certified rounds); its Explore/general-purpose
split repeats the Claude pattern.

## 8. Ranked steal table (idea -> concrete GLLA surface)

| # | Idea | From | GLLA surface |
|---|------|------|--------------|
| 1 | Atomic task batches + pending-task completion gate | pi-goal-x `goal-task-tools.ts:392-420`, `goal-completion.ts:39-52` | `/list`+`/goal` task tools, auditor contract check |
| 2 | Per-issue validator second pass for the auditor | claude `code-review.md` steps 5-6 | `scripts/goal-auditor-worker.mjs`, `goal-loop-auditor-process.ts` |
| 3 | Progressive-disclosure prompt packaging (metadata/body/references) | claude `skill-development/SKILL.md` | `prompts/`, continuation context, compaction path |
| 4 | Settle-gated audit transcript queue (`triggerTurn:false`) | pi-goal-x `goal-session-safety.ts:23-42` | auditor + display/widget |
| 5 | Buffered turn transaction + flush-before-audit | pi-goal-x `goal-service.ts:162-260` | orchestrator, `goal-loop-core.ts`, auditor dispatch |
| 6 | Review-orchestrator fanout (one subagent per dimension) | codex `.codex/skills/code-review/SKILL.md` | detached auditor (parallel verify agents) |
| 7 | Bounded loop-control schema (steps/attempts/reserve/ratio) | kimi `loop/configSection.ts`, grok `doom_loop.rs` | `/loop` recovery config, settings |
| 8 | `CompletionRequirement`-style must-call contract | grok `xai-grok-agent/config.rs:782-800` | `/goal` contract schema, auditor check |
| 9 | Delegated-session guard (`PI_SUBAGENT_DEPTH`) | pi-goal-x `goal-session-safety.ts:4-8` | orchestrator/activation, continuation |
| 10 | Post-compaction delta resync | pi-goal-x `goal-compaction.ts:156-176` | `goal-continuation.ts`, activation injection |
| 11 | Declarative exec policy + load-time self-tests | codex `execpolicy/` | auditor tool-gating in worker |
| 12 | Typed tool-result contract with spill accounting | kimi `tool/toolContract.ts` | tool result clipping, compaction |
| 13 | Least-privilege subagent tool allowlists | claude `code-explorer.md`, grok subagent template | subagent spawn config |
| 14 | Generated config/tool/event catalogs (freshness-gated) | deepseek `docs/config-catalog.md` | `/loop` project-audit, release check |
| 15 | Repeat-call guard + tool timeout policy | deepseek `packages/guard/README.md` | `/loop` bounded recovery |
| 16 | Tool-result pruner before compaction | deepseek `packages/compaction/README.md` | compaction surface |
| 17 | Session-query evidence pack (FTS + `/export`) | deepseek `packages/session-query/README.md` | `/list` queue + auditor evidence |
| 18 | Bounded child handoff schema (`maxHandoffChars`) | deepseek `tool-ralph/README.md` | subagent supervision |
| 19 | Origin-iteration checklist pinning (display-only) | ZCode `docs/goal` | goal progress rendering |
| 20 | Typed context-fragment budget (≤10K, no rewrite) | codex `AGENTS.md` | `completion-summary.ts` clipping |

Conscious rejections (audited, do not re-propose without new evidence):
self-certified rounds (deepseek, ZCode), in-process auditor (pi-goal-x),
smoothness-over-detachment (codex), unbounded Stop-loop drivers (claude
ralph-wiggum), OS sandboxes, transcript transplant, MDM/enterprise locks.
