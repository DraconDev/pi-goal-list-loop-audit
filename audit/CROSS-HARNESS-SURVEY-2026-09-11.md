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
  posture (read-only auto, writes gated, `ExitPlanMode`)
  (`CHANGELOG.md:1391,1527,1924,...`).
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
...[truncated 3881 chars]