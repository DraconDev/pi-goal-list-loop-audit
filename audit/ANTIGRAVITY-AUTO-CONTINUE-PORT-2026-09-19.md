# Antigravity Auto-Continue Port — Survey Synthesis (2026-09-19)

Owner note: Antigravity runs relentlessly without mid-run questions, survives
quota-out, and produces informative summaries. This doc consolidates three
parallel scout surveys (prior research, live CLI surface, GLLA gap map) plus
the two prior Antigravity audits, and records what to port vs reject.

## Sources

- Scout `scout-prior`: `audit/ANTIGRAVITY-CODEX-CLAUDE-PI-GOAL-X-2026-09-03.md`
  (GLLA v0.38.4 keep-checking verdict), `audit/ANTIGRAVITY-TEAMWORK-PREVIEW-2026-09-04.md`
  (Teamwork roles, cost/quota numbers), `subagent-artifacts/.../antigravity-summary.md`
  (IDE v2.8.1 walkthrough artifacts, 20+ `walkthrough.md` instances).
- Scout `scout-cli`: live `agy` 1.2.6 CLI surface (`--help`, `models`,
  `remote-control status`), `~/.gemini/antigravity-cli` config/conversation
  stores, live 429 wall in `log/cli-20260918_185551.log` (2546 hits, never
  resolved in-window, busy-retry 45s→3m10s).
- Scout `scout-glla`: post-v0.38.68 gap map over `prompts/goal-loop-continuation.md`,
  `extensions/quota-retry.ts`, `extensions/main-model-recovery.ts`,
  `extensions/length-continue.ts`, `extensions/goal-continuation.ts`,
  `extensions/completion-summary.ts`, plus `audit/GEMINI-SUMMARY-GAP-2026-09-11.md`
  steal table and `audit/RICH-TERMINAL-SUMMARY-2026-09-11.md`.

## 1. No mid-run questions

Antigravity's trick is structural, not rhetorical: keep-checking tight-loops
on durable state with backoff; Teamwork splits scoping interview (confirm-gated
artifact) from autonomous execution; `agy` headless read-only commands
(`-p /usage`, `/model`, …) never start a turn or spend quota. Mid-run
`ask_question` and permission prompts exist but default-deny never blocks the
run (`--dangerously-skip-permissions`, `toolPermission: always-proceed`).

GLLA post-v0.38.68: question discipline is prompt-only
(`ACTIVE_EXECUTION_QUESTION_GUIDANCE` + `LONG_RUNNING_JUDGMENT_POLICY`) with
stall watchdog and decision-card vocabulary lock — strong SLA, weak
enforcement. **Port (task 2):** per-goal mid-run interruption budget with
auto-default-and-log fallback — count mid-run prompts/decision pauses,
auto-resolve a timed-out prompt to its `recommended` default, log the
assumption, queue the preference to `Left out:`.

## 2. Survives quota-out

Live evidence both sides: Antigravity `walkthrough.md` ships partial
completion first-class ("Generated 21 of 25 assets", `## Pending Assets (Quota
Limit Reached)`, `task.md` `[x]/[/]/[ ]` remainder, `*.resolved*` versioning);
`agy` retries transient 502/503/504, per-minute 429s, and mid-stream
interruptions in-process with exponential backoff preserving completed
tool-call outputs (1.2.7 caps per-attempt API backoff at 30s; Run-layer retries
longer). Rate limits never cost the session; headless API failure exits `3`
with structured `AGY_ERROR` JSON. Teamwork cost honesty: 93 subagents / 339M
tokens ≈ $916.92 for an OS build — strongest evidence GLLA's cheap-brief +
park-default bias is correct for a user-paid-meter plugin.

GLLA post-v0.38.68: uniform blind-retry envelope (5s → doubling → 5h cap, 24h
horizon, 10-ref fallback chain), auditor quota-exempt hammering + chain
reseed, heat-routed length exhaustion. Gaps — **port (tasks 3–5):**
(a) quota path honors `resetAt`/`Retry-After` for sleep duration instead of
voiding it in `mainModelFailureDelayMs`; (b) work-through-failover —
fallback-chain work proceeds while primary sleeps, background primary probe
with auto-failback; (c) quota-wait exempt from the 24h park horizon (park only
billing/auth/non-recoverable).

## 3. Informative summaries

Antigravity `walkthrough.md` shape: H1 + done-count lede + grouped `###` per
component with backticked files/symbols + `## Verification` with exact
re-run commands and pasted pass/fail + explicit remainder list; dedicated
aux-pane artifact tab + machine `metadata.json` sidecar. GLLA already stole
the shape (`GEMINI-SUMMARY-GAP` steal table → `RICH-TERMINAL-SUMMARY` v0.38.46,
parity v0.38.55, structured-long v0.38.6x) with deliberate rejects (no code
blocks, no lede+doc-link, budgets over unbounded length).

Remaining gap — **port (task 6):** mandatory evidence-density claim +
full-report pointer. Richness currently rides optional agent params; a flat
six-label claim with zero `path:line` tokens and zero gate rows still passes.
Require areas with evidenced findings + density lint, and restore rejected
steal #8 as a `full report: <archive path>` pointer so chat stays bounded but
the long narrative is one hop away.

## Also ported (prior-audit borrow candidates, still open)

- **(task 7)** Answer-agnostic pitfall registry per repo
  (`.pi-glla/pitfalls.md`, consulted at goal start — ledger is forensics,
  never distilled).
- **(task 8)** Objection-attached retries (link last disapproval report from
  goal file until retry passes, then archive; currently half-present).

## Explicitly not ported

Antigravity keep-checking proper (GLLA ContinuousSupervisor is strictly
faster: event→0ms poll vs 250–1000ms doubling); Antigravity-as-code, Codex
dropping detached auditor, Claude transcript/hook internals
(`CONTINUATION-APPROACH-COMPARISON-2026-08-15.md` no-transplant stands);
pi-goal-x unconditional `session_start` continuation / unbounded 50ms retry /
in-process auditor; 93-agent campaigns and full-state self-succession dumps
(would burn user budget unattended); AVO branding. Prior 09-03 Later items
(A8 heartbeat coalesce, A2 conditional marker, A1 payload escaping, Codex
compact continuation, A4 typed mutation service, A5 `/glla health`, A6
`stdio:pipe` capture) stay queued behind this batch.
