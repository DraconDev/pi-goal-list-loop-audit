# Antigravity `/teamwork-preview`: read-only survey + GLLA mapping (2026-09-04)

Status: research only. No code touched, no adoption mandated. Question from
note.md Next: what is Teamwork, and what (if anything) should GLLA learn.

## Sources

Read in full via fetch (primary): official docs `antigravity.google/docs/teamwork/`
("Teamwork agent teams (/teamwork-preview)"), `docs/subagents/`, official blog
"Teamwork: When AI Becomes a Research Partner" (Aug 27, 2026), official blog
"Google Antigravity Built an OS (and more)". Search-result level only
(Cloudflare/Reddit-walled, not fetched): Medium "Teamwork for long-running
tasks", `blog.google` Gemini-teams announcement, r/google_antigravity paid-tier
thread, AI-developers-forum billing thread.

## What it is

`/teamwork-preview` (paid plans, Antigravity 2.0 + CLI) runs a collaborative
multi-agent team for jobs too large for one session: multi-dozen-file refactors,
systems simulation, open research, multi-day work. Two phases:

- **Phase 1 — scoping interview.** The main agent interviews the user (scope,
  requirements, per-requirement independent verification, acceptance criteria,
  working directory), then produces a **reviewable prompt artifact** executed
  only on explicit confirmation.
- **Phase 2 — autonomous execution.** A `Sentinel` coordinator records the
  request, routes tasks, posts progress updates, and spawns the final `Success
  Auditor`. A `Project Orchestrator` breaks the brief into milestones,
  coordinates parallel tracks, and **hands off to a fresh successor between
  milestones** to prevent context degradation. `Explorers` (read-only),
  `Workers` (terminal+files, non-overlapping tracks), `Critic` (review),
  `Challenger` (adversarial tests/edge cases), `Auditor` (evidence-vs-output
  integrity) gate every milestone; `Success Auditor` runs the final end-to-end
  pass. Execution is pattern-driven (Distributed Coding, Iterative Coding,
  Document Review, Math/Proof, Long Proof, Self-Verification) with
  runtime-adaptive team sizing — patterns are specifications, not programs.

## Mechanisms worth naming precisely

- **Artifact handoffs over context sharing**: request / plan / progress
  artifacts in a dedicated dir (`~/teamwork_projects/{NAME}`); agents
  coordinate through files, never by pooling context.
- **Exclusive file ownership**: one worker per file at a time; per-agent
  scratch dirs; isolated project directories.
- **Integrity modes** (development/demo/benchmark): the Phase-1 interview maps
  "which shortcuts are off-limits" to a verification-strictness ladder
  (benchmark = from-scratch, stdlib-only, no mocked passes, ground-truth
  execution checks).
- **Falsifier-paired search + objection-preserving synthesis** (Long Proof):
  every candidate gets a dedicated breaker; refuted routes stay in the process
  **with objections attached**; tournament networks re-synthesize from
  candidates+critiques; verifier findings distill into an **answer-agnostic
  pitfall registry**; a shared knowledge dir records proved/failed/observed.
- **Self-succession for context limits**: the orchestrator counts spawns, then
  dumps full state to handoff files, kills its background tasks, and spawns a
  same-goals successor while the parent terminates.
- **Crons for stuck processes**: parallel work means hung workers stall the
  team; watchdogs own termination.
- **Cost/quota honesty**: the OS build took 93 subagents, 15,314 model calls,
  339M input tokens (2.6B with cache/output/thinking) ≈ **$916.92** at API
  pricing; even on the $200/mo Ultra plan a task or two exhausts the weekly
  quota mid-run, with a manual "Continue" resume after top-up.

## Mapping vs GLLA v0.38.20 (critical eye)

Convergent (validates existing GLLA choices, borrow nothing):

- Drafting-only scoping + explicit confirm (`propose_goal_draft` gated on user
  reply, v0.38.0) IS Phase 1, minus the prompt artifact file.
- Detached auditor + regression shield + Success-Auditor-like final gates IS
  the Critic/Challenger/Auditor tier at pi scale.
- Disk-state handoffs (goal file, ledger tail, compactor brief + resync) IS
  artifact coordination; the zombie watchdog IS the stuck-process cron; the
  over-cap starvation ladder + park-by-default IS quota handling — but with
  the opposite spend bet (see below).
- State-root owner lock IS exclusive ownership at session granularity.

Genuinely new (borrow candidates, smallest first):

1. **Answer-agnostic pitfall registry per repo** (BORROW). GLLA's ledger is
   forensics, never distilled. A small curated file (e.g. `.pi-glla/pitfalls.md`:
   "mechanical checker rejects X", "provider Y mangles Z") consulted at goal
   start would compound across goals. Cheap, disk-state-native, no runtime.
2. **Objection-attached retries** (HALF-PRESENT). Repair already feeds auditor
   TODOs back, but disapproved attempts are not preserved as first-class
   context with their objections. Keep the last disapproval report linked from
   the goal file until the retry passes, then archive it.
3. **Integrity-mode strictness knob** (CONDITIONAL, deferred). One GLLA
   strictness today; a dev/benchmark-style ladder mapped onto `aggressiveMode`
   would be principled but is scope creep without a field demand. Note only.
4. **Per-goal spend surfacing** (SMALL). `usage.tokensUsed` exists but the
   widget never shows cumulative cost. A compact spend line makes the
   park-by-default policy legible. Cheap; needs a real estimate source first.

## Why not adopt

Structural mismatch, not NIH. Antigravity is vertically integrated (IDE +
runtime + model billing) and can spend $917 + weekly quotas per task with a
manual "Continue". GLLA is a plugin on user-owned pi sessions with user-paid
meters: 93-agent campaigns, full-state handoff dumps, and tournament
re-synthesis would burn the user's budget unattended — exactly what the
starvation ladder and the ~2k compactor brief exist to prevent. Teamwork's own
numbers ($916.92, quota exhaustion in 1–2 tasks) are the strongest available
evidence that GLLA's cheap-brief + park-default + drafting-only-questions
bias is correct for its niche. Adopt the registry idea; leave the army behind.

## Disposition

No code changes. If pitfall-registry (1) is wanted later, open a fresh
selective slice behind tests like the v0.38.19 tracks; items (3)–(4) stay
deferred without field demand. Screenshots/Reddit-level claims above are
marked as such; everything else is from primary fetched sources.
