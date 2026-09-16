# pi-goal-list-loop-audit — design

This document records the architectural choices and why. v0.1.0 decisions are
below; later releases append addenda rather than rewrite history.

## Scope

| Loop | Status |
|---|---|
| Loop 1 (single ordered goal with auditor) | **shipped v0.1.0** |
| Loop 2 (list — many goals in a queue) | **shipped v0.2.0** |
| Loop 3 (loop — metric-driven forever) | **shipped v0.3.0** |
| Completion release (compaction, token guard, branch mode) | **shipped v0.4.0** |

## Addendum v0.2.0 (list + shield + drafting)

- **`/list` queue**: items are full goals (objective + contract). The active
  goal and the queue share one `State`; `setGoal`/`archiveCurrentGoal`
  preserve `state.list` explicitly (an early draft wiped it). Completing a
  list-sourced goal auto-activates the next item (v0.10.0: aborts no longer
  auto-advance — `/list next` and `list_activate` pick explicitly).
- **regression_shield**: the auditor's report must contain an `<evidence>`
  block quoting raw tool output per verification-contract item. Enforcement is
  **orchestrator-side** (`goal-loop-shield.ts`, pure): an `<approved/>`
  without complete evidence becomes a disapproval. This closes the
  "`bash true` rubber-stamp" hole pi-goal-x documented as accepted-risk.
- **Drafting**: `/goal` with no args sends a drafting prompt; the agent
  clarifies, then `propose_goal_draft` opens a real Confirm dialog. Direct
  activation stays available via `/goal "<objective>"`.
- **Inline contract extraction**: one-liner objectives
  (`Create x. Done when: grep -q ok x`) extract the contract — the
  line-start-only extractor silently disarmed the shield on every one-liner.

## Addendum v0.3.0 (metric loop + tasks + notify)

- **Loop 3 is metric-driven, not vibes-driven** (the anti-doorknob law: the
  loop only believes a number). The **orchestrator** runs the user's `measure`
  command after every `agent_end`; the agent never self-reports. Termination:
  plateau (`window` stalls), iteration cap, `/loop stop`. No auditor in
  loop 3 — the metric is the verdict. No git auto-revert: on regression the
  agent is told to undo its own change (safe with uncommitted user work).
- **`propose_task_list`** with anti-drift caps (20 tasks / 5 subtasks) —
  pi-goal-x flaw #4. Confirm dialog before the list is set.
- **`notify=<cmd>`**: fire-and-forget shell-out on goal complete / goal pause /
  loop stop, message as `$1`. Settings parser is quote-aware.

## Addendum v0.5.0–v0.29.6 (current state — the long-session era)

The v0.4.0 addendum closed the scaffold era. v0.5.0 through v0.29.6 are 25+
releases of unattended-rig hardening; the full record is CHANGELOG.md. The
architectural decisions that changed the SHAPE of the system:

- **Self-watchdog is baked in** (v0.5.0): a 15s heartbeat owns liveness —
  supervising + idle + nothing scheduled + 60s quiet → re-fire. External
  liveness plugins are retired.
- **The restore gate** (v0.26.9 tri-state; hardened v0.28.30, v0.29.4): a
  bare `pi` start HOLDS everything and paints it — nothing auto-starts from
  persisted state. In-session reload/fork/compaction continues automatically.
  `autoResume` (on → any session start resumes; off → never) is **global-only**
  (v0.29.5) after a stale per-project opt-in silently overrode the global hold.
- **Drafts and restores are decoupled** (v0.29.4): `autoAcceptDrafts` is the
  pre-consent for in-session drafts — they START immediately — and for the
  generated finding batch at the end of `/list audit`. Direct bulk imports
  remain Confirm-gated. `autoResume` gates only launch-time restore. "The
  session auto-starts in some cases ok; launching pi must not."
- **User aborts mean STOP** (v0.29.4/0.29.5): an aborted turn is exempt from
  stall accounting, stands the chain down with no auto re-fire, and the
  stand-down gates the heartbeat + post-compaction refires. The 5-abort loud
  pause is the backstop.
- **One active thing, auto-arbitrated** (v0.28.21 guards; v0.29.6 load-time
  arbitration): at most one live artifact. Dirty stacked states at load are
  resolved deterministically — most recent activity keeps the slot, the loser
  is archived (recoverable), no picker. `/glla wipe` (v0.28.31) is the manual,
  Confirm-gated clean slate.
- **The completion lifecycle owns its pauses** (v0.29.1): storm/stall
  escalation never pauses `auditing` goals; a stranded `auditing` state (no
  live auditor; lifecycle rebinds retry stored claims immediately (the 90s
  heartbeat path is only a fallback); send/pause/notify storms
  rearm once per cycle; the provider-error brake (v0.28.13) keeps cross-cycle
  memory and parks after 6 consecutive errors.
- **The audit loop is the project reviewer** (v0.29.0): `/loop audit` runs
  fresh audit passes every iteration, appends findings to
  `.pi-glla/audit-loop/findings.md`, fixes the top open ones; the orchestrator
  counts open boxes as the measure and the plateau stop ends it. The
  reviewer's reflexive fire-audit-on-clean cascade is opt-in (it paid for
  verification twice and was hydra fuel).
- **Git discipline is prompt-law** (v0.29.2): continuation/draft prompts
  forbid inventing git identities or branches (field incidents: agents
  committing as `phase-e-agent <phase-e@local>`).
- **Reviewer = strategist, not verifier** (v0.24.6–v0.29.0): the reviewer
  scans sources and proposes list items through the standard drafting +
  Confirm path; it never audits work — the isolated auditor is the only
  verifier.

## Addendum v0.34.16 (lifecycle handoff)

- **Recovery crosses pi's lifecycle, never the terminal**: `session_shutdown`
  persists fresh same-process continuation debt in
  `.pi-glla/session-handoff.json`, records the shutdown reason, and clears all
  session-owned timers. A fresh `session_start` consumes matching debt and
  continues from its new context. No stale callback is allowed to use the old
  `ctx` or `pi` reference.
- **Quit is not implicit resume consent**: a shutdown with `reason: "quit"`
  removes any handoff debt, records `session_handoff_suppressed`, and marks
  the owner sidecar so the next same-pid startup is not mistaken for a
  replacement rebind. The global `autoResume` policy remains independent and
  explicit.
- **True orphans stay honest**: once pi invalidates an extension without a
  fresh lifecycle event, the extension cannot repair its host. glla stops
  stale work, preserves the artifact, and tells the user to restart pi only
  when no replacement arrives. `autoReloadOnStale` and `autoRecovery` remain
  deprecated deserialization compatibility fields; they do not select a
  transport.

## Addendum v0.34.21 (completion-audit lifecycle observability)

- **The durable claim owns recovery state**: `pendingCompletion.phase` is
  `running`, `recovery-pending`, or `quota-waiting`. Missing phase is legacy
  state and is treated as recovery-pending after a fresh lifecycle event.
  The isolated attempt id prevents an old generation from finalizing a newer
  attempt; legacy wall-deadline metadata is not a lifetime bound.
- **Rebind recovery is immediate but consent-aware**: a replacement
  `session_start` converts an old running claim to recovery-pending and
  retries it immediately when the lifecycle handoff or global `autoResume`
  supplies consent. A cold startup with autoResume off paints the pending
  claim and waits for `/goal resume`.
- **Auditor liveness has event-derived layers**: no-event inactivity aborts
  after 10m only when no auditor tool is active; a live verification tool may
  finish, and the complete isolated run has no unconditional wall-clock cap.
  Each auditor tool also has an independent five-minute ceiling. These
  watchdog outcomes are infrastructure failures, never verdicts, and the
  stored claim remains retryable.

## Addendum v0.34.22 (detached completion auditor)

- **Completion verification is process-isolated, not nested**: `complete_goal`
  persists the claim and job request, then returns immediately. A detached
  extension-less worker launches `pi --mode rpc` with only `read`, `grep`,
  `find`, `ls`, and `bash`; it never receives the parent `ExtensionContext`,
  never loads glla extensions or project context files. In current power mode,
  bash is not an OS sandbox: it can write repository or goal-state files, so
  the worker's isolation is process/API isolation rather than immutability. The
  worker has independent per-tool and confirmed-silence bounds, with no
  unconditional wall-clock expiry. This removes the previous nested
  `AgentSession` from the main pi process and prevents a provider stall in the
  auditor from occupying the executor's turn.
- **Durable job protocol**: request, progress, lock, and result files live
  under `.pi-glla/audit-jobs/<attemptId>/`. Requests and results are hashed and
  atomically written. The parent validates attempt/request identity, verdict
  markers, read-tool use, and `regression_shield` before applying any result.
  A result from a stale generation is ignored; fresh lifecycle recovery creates
  a new attempt. Cancellation clears the pending claim and best-effort stops
  the worker.
- **Windows launch and rename safety**: Windows npm installations expose the
  `pi.cmd` shim rather than a directly executable `pi` binary. The worker uses
  an explicitly quoted `cmd.exe /d /s /c` boundary with verbatim arguments,
  while POSIX keeps direct shell-less execution. Parent and worker atomic JSON
  writes retry transient Windows rename locks without unlinking the prior
  snapshot first, preserving the old-or-new reader guarantee.
- **Truthful asynchronous UI**: `auditor queued`, `auditor running`, and
  `audit recovery pending` are distinct. The main session can continue
  rendering and accepting input while the worker audits; completion/archive or
  disapproval/continuation happens only after durable result consumption.
- **Event-derived worker liveness**: no session event for 10 minutes while
  no auditor tool is active aborts the worker; a five-minute per-tool ceiling
  remains armed while a tool is open. There is no unconditional wall-clock
  bound, so active output/tool progress may continue indefinitely. Watchdog
  outcomes are infrastructure failures, never verdicts, and the claim remains
  retryable.

## Addendum v0.34.24 (dispatch proof and display projection safety)

- **Accepted is not started**: every automated follow-up records a versioned,
  generation/owner-bound dispatch in `.pi-glla/continuation-dispatch.json`
  before calling `sendMessage({ triggerTurn: true })`. `before_agent_start`
  with the matching marker is the strongest proof; compatible low-level start
  events are accepted for older pi builds. The sidecar is cleared only after
  proof or an explicit terminal send outcome.
- **No blind trigger storm**: an accepted dispatch has one bounded start-proof
  timer. If no start event arrives, glla records an unresolved dispatch, keeps
  the goal/list item durable, stands down automatic sends, and tells the user
  how to use a fresh lifecycle or explicit resume. It does not inject terminal
  input, restart pi, or treat a successful API return as a turn.
- **Generation-safe recovery**: replacement/shutdown clears in-memory pending
  state; a new session records and clears any old sidecar, then the existing
  restore/autoResume consent rules decide whether to retry. Late foreign or
  old-generation events cannot acknowledge a new dispatch.
- **Display-only sanitization**: terminal/ANSI/OSC, bidi, and zero-width
  controls are removed from status, widget, notification, confirmation, and
  status-tool projections. Persisted objectives, contracts, prompts, ledger
  values, and auditor inputs remain unchanged.

## Addendum v0.34.31 (main-session model recovery)

> Historical rollout note: this section records the older reason-aware
> recovery implementation. The active policy is the v0.34.142 addendum below;
> quota/rate-limit wording no longer selects fallback or retry timing.

- **Global recovery policy**: `mainModelFallbacks`,
  `mainModelFallbackOnRateLimit`, `mainModelRetryMinutes`, and
  `hourlyQuotaProbe` are global-only, so the runtime and settings provenance
  cannot disagree about which recovery policy is active.
- **Ordered global fallback agents**: `mainModelFallbacks` is an explicit ordered list
  of up to 10 `provider/model` references. A provider/quota error selects the
  first eligible authenticated candidate for account/plan/billing/auth failures,
  calls `setModel`, and lets the next supervised turn test it; later failures
  walk the list left-to-right. Explicit HTTP 429/request-rate failures also
  walk the list when global `mainModelFallbackOnRateLimit` is on (default); off
  keeps them on the current model with bounded retry + hourly probe cadence.
  The detached auditor's model cascade remains a separate subsystem. The
  ordered-chain editor lives in the **Main agent** settings tab: Space toggles
  membership, Tab enters an explicit order mode where ↑/↓ moves a chain row,
  and clearing the list removes the global key. The attempted cursor is durable, so a reload cannot
  restart at an already-failed rung.
- **No accepted-send inference**: model rotation occurs only after a provider
  failure is observed (or after a 15-minute, five-minute-silent provider-held
  retry storm). A successful `sendMessage()` return is never treated as a
  started turn.
- **Durable recovery instead of abandonment**: when all candidates fail,
  `.pi-glla/active.jsonl` stores the primary, active candidate, attempted set,
  retry time, and supervisor kind. Unhinted recovery waits use the configured
  `mainModelRetryMinutes` base and double per attempt up to 5h; factual
  provider hints win when in budget, while `hourlyQuotaProbe` is a separate
  optional :00:30 ticker. A paused goal/held loop remains resumable. A fresh
  startup obeys the existing `autoResume` consent gate.
- **Successful-turn reset**: a real non-error agent end on the preferred
  primary clears the recovery cycle. In the current failback policy, a
  successful fallback turn instead arms the durable preferred-primary probe;
  `mainModelFailback=sticky` retains the historical immediate reset. Manual
  model selection cancels it; host restore selections do not, and user aborts
  do not masquerade as success. Goal/list/loop cancellation clears its timer
  and durable state.

## Addendum v0.34.48–v0.34.56 (lifecycle/recovery hardening — the stale-handle era)

Between the v0.34.31 recovery envelope and the v0.34.57 quota fast-engagement, the
recovery story hardened around the **stale extension handle** — the field-observed
shape (hegemon/polis 2026-07-26+) where pi invalidates the extension API on session
replacement without delivering a successor `session_start`:

- **Honest stale entry everywhere** (v0.34.51/52): `warnIfStaleAtEntry` probes at
  entry (since v0.28.1), but the probe's return value used to be discarded by the
  mutation paths. Now every `/list` mutation (add/remove/next/clear/cancel) and the
  bare `/glla` settings surface refuse on a stale handle with the standard recovery
  message — a session that cannot announce or run its writes must not make them.
  Mutating `/glla` actions (wipe/cancel/reviewer/postaudit/tooloverride) refuse with
  a `settings_mutation_refused_stale` ledger trail; read-only surfaces stay usable
  with the warning. This is the plugin side of the missing-replacement contract: fail
  closed, never guess, never pretend success.
- **Settings routing clarity** (v0.34.53): `/list settings` is a verb, handled
  explicitly BEFORE the natural-language dump fallthrough — a ledgered redirect to
  `/glla`, never a drafting seed. `/list add settings …` remains the only way an item
  literally named "settings" enters the queue.
- **Lifecycle-recovery harness** (v0.34.54): a behavioral suite proves the two-phase
  contract — stale handle: `/list show` warns and does not pretend, settings refuse
  wholesale; fresh `session_start`: both render cleanly with no stale residue.
- **Command-registration collision model** (v0.34.55): pi's `resolveRegisteredCommands`
  flattens extensions in load order and suffixes EVERY registration of a duplicated
  command name (`name:1`, `name:2`, …) — the bare name becomes owned by nobody and
  dispatch stops routing it while a collision exists. The model is read from the
  installed pi core (hermetic, never modified) and records a process-scoped
  routing diagnostic, making collisions reproducible without rewriting tracked
  repository files or touching pi.
- **Unmatched telemetry stays unmatched** (v0.34.56): tool starts/ends without a
  counterpart are represented as explicitly unmatched facts, never falsely paired —
  the report surface stays truthful (the AuditProgress/AuditorProgress dual-interface
  rule: display evidence-gates on `unmatchedStarts + unmatchedEnds > 0`).
- **Uniform retry envelope, no text-trust** (v0.34.51 historical baseline): error
  text was not trusted to pick a retry policy. The current ordered-fallback policy
  supersedes that baseline: account/plan/billing/auth failures may walk the configured
  chain, while explicit HTTP 429/request-rate failures walk it when
  `mainModelFallbackOnRateLimit` is on (default), or remain on the current model
  when it is off. Both paths use the configured bounded ladder plus optional
  hourly ticker. Positive-
  evidence futile classes (context/output-token limits, user aborts) plus auditor
  watchdog timeouts never auto-retry; provider hints are honored only within the
  5h probe budget.

## Addendum v0.34.57 (quota walls engage recovery fast)

> Historical rollout note: the knowledge-window and quota-specific branches
> described here are retained for design history only and are not active in
> v0.34.142.

- **Knowledge-window escalation**: a surfaced long-lived failure (quota /
  billing / auth) records a 30-minute knowledge window. A send-rearm storm
  inside that window escalates into the recovery envelope after 3 minutes of
  failed sends (plus the unchanged 5-minute activity silence gate) instead of
  the generic 15 minutes — a wedge right after a quota wall is almost always
  the same wall, and blind re-sends into it are pure waste.
- **Transient failures stay fast**: 5xx/stream/network failures are
  short-lived by definition and never record the knowledge signal; they keep
  the 5s→3m error ladder and the pi-core retry budget.
- **Armed by configuration**: the envelope is inert without
  `mainModelFallbacks` (rotation) — an empty list means "park and probe the
  same model" instead of switching pools. When the list is non-empty, the
  runtime tries one eligible fallback at a time in persisted order, skips
  forbidden/unavailable refs, and parks only after the ordered chain is
  exhausted. Explicit HTTP 429/rate-limit errors remain request-rate signals,
  not token-limit labels; the global `mainModelFallbackOnRateLimit` switch
  controls whether they walk that chain or stay current, and the optional
  :00:30 hourly ticker can retry them.

## Addendum Unreleased (process ownership and bounded fallback hardening)

- **Worker ownership is durable**: detached auditor locks are rewritten with
  the worker PID, allowing a replacement host to reap stale workers for the
  same completion claim. Parent cancellation waits for exit and escalates to
  the detached POSIX process group or Windows `taskkill /t` tree, so nested
  shells/tests cannot outlive their worker.
- **Test/smoke teardown is explicit**: direct worker fixtures and the tmux smoke
  harness clean their owned process trees and temporary directories on normal,
  failed, or interrupted exits. Browser processes are not launched by this
  package; external Chrome automation remains outside this lifecycle boundary.

## Addendum v0.35.x (one-shot parked completion-audit recovery)

- **The parked claim owns a durable one-shot fence**: a
  `recovery-pending` `pendingCompletion` records whether its automatic
  recovery retry has been consumed, plus the dispatch time and session
  generation. Missing metadata on legacy claims means eligible, so old
  claims remain recoverable without inventing a new completion assertion.
- **Healthy events, not timers, trigger the retry**: a validated lifecycle
  successor/Auto-resume or successful bounded main-model recovery may claim
  one parked audit. The helper rechecks the current generation, live context,
  goal identity, phase, and objective guard before starting the detached
  worker. The phase transition and durable marker land before the worker is
  launched, so repeated events cannot create a retry storm.
- **Manual recovery remains authoritative**: a failed automatic attempt keeps
  the exact claim in `recovery-pending` and its marker consumed; cold startup
  remains held unless the existing Auto-resume policy or a validated lifecycle
  handoff supplies consent. `/goal resume` still starts a direct fresh audit.

## Addendum v0.34.142 (generic provider recovery)

- **No quota availability check exists in the live policy**: provider text,
  status codes, billing/rate-limit words, and upstream retry hints do not
  select a recovery branch, fallback gate, or delay. They may remain as
  bounded diagnostics for forensics and redaction only.
- **One retry envelope covers every recoverable provider failure**: the first
  retry is eager at 5 seconds, later retries use the configured bounded
  ladder, and the optional `hourlyRetryProbe` adds a blind `:00:30` retry
  after every hour starts. Main-model recovery and detached-auditor recovery
  use this same reason-agnostic rule, with existing context/user-abort and
  safety-horizon exceptions.
- **Preferred-primary failback is durable and supervised**:
  `mainModelFailback=auto` (the default) does not treat a successful fallback
  turn as proof that the original primary is healthy. The recovery record keeps
  `primary`, records `primaryProbeAt`, and uses
  `mainModelPrimaryProbeMinutes` (15 by default) to select the primary for one
  real supervised probe. A primary success clears the episode; a provider
  failure walks back to the serving fallback and schedules the next reverse
  probe. `sticky` preserves the legacy permanent fallback choice. The
  `primaryProbeInFlight` marker and pending switch survive a session boundary.
- **Legacy state is inert**: old `quota-waiting` phases, quota-named retry
  counters, and provider-hint fields are accepted only long enough to load
  and normalize old files. Canonical persisted state uses `retry-waiting`,
  `retryAttempts`, `retryFirstAt`, and `retryUntil`.

## Addendum v0.35.71 (GLLA-only external-failure containment)

GLLA is a workflow supervisor, not a maintenance fork of its host ecosystem.
The repository changes only GLLA-owned code. Pi-core, OS, provider, and
third-party-plugin failures may be observed through public hooks and contained
by durable GLLA state (for example, a BUSY/no-stream turn can be aborted,
parked, and retried within a finite configured budget), but GLLA never edits
those external implementations or claims to repair them. Reports whose only
code lives outside GLLA are explicitly documented and disposed of as
out-of-scope.

The zero-stream budget defaults to three automatic re-dispatches and accepts
0–10. Each uninterrupted silent attempt consumes one slot; a real stream
starts a fresh episode. Exhaustion leaves the goal/list item/loop parked for
explicit resume. Generation, supervisor-pause, persistence, and dispatch
ownership fences remain authoritative throughout.

## Addendum v0.35.0 (long-running judgment, Designer, and drafting chain)

- **Judgment is a prompt-level contract**: drafting and continuation preserve
  the objective and verification contract, prefer durable root-cause fixes,
  allow only safe/reversible/testable in-scope workarounds, and ask one focused
  question only at a genuine scope, priority, permission, or irreversible-action
  boundary. The unattended fallback is explicit and never infers provider or
  quota state.
- **Designer routing is explicit, persisted, and read-only**: `Agent: Designer`,
  `Role: designer`, and `Designer: yes` are declarations rather than natural
  language classification. The role is carried by goals, queue items, and task
  plans; continuation injects the hand-off; a managed `Designer.md` uses only
  read/search tools; unavailable role/provider falls back to an inline design
  checkpoint.
- **Drafting owns a temporary agent lease**: the `/goal`, `/list`, and `/loop`
  interviews resolve a separate primary/fallback chain, select a model-specific
  thinking level, retry the existing interview after generic provider errors,
  and restore the original model and thinking level after confirmation or
  interruption. A current-session last resort is bounded and does not enter
  main-goal recovery. A generation fence and serialized restore prevent
  stale-session or overlapping-draft agent changes.
- **Host replacement remains host-owned**: Pi event contexts do not expose the
  command-only `newSession`/`fork`/`switchSession` operations. glla therefore
  persists the work and truthfully asks for `/new` when no replacement boundary
  arrives; the proposed event-safe host API is recorded in the audit docs.

## Addendum v0.4.0 (completion)

- **Auditor compaction enabled** (flaw #3 — the last open one). Safety:
  the shield is orchestrator-side, so compaction can only weaken the
  auditor's evidence → disapproval, never a false approval.
- **Token guard**: real accumulation from assistant-message `usage.totalTokens`
  (deduped across replayed `agent_end` history). Crossing `tokenlimit`
  (opt-in; off by default since v0.12.0) pauses the goal with a clear reason.
- **Loop 3 `branch=1`**: scratch branch `pi-glla-loop/<ts>-<slug>`; commit per
  improvement, `git reset --hard` per regression — scratch branch only.
  Refuses non-git dirs and dirty trees; returns to the original branch on
  stop with merge instructions.
- **Resumption notice** on `session_start` (replaces the impossible
  "plugin vanished" self-check: absent code cannot run).

## Scope of v0.1.0 (original)

Single loop only — **loop 1**, the single ordered goal.

**Why ship loop 1 first**: the user asked for it, it's the highest-value loop, and getting the auditor + drafting right matters more than breadth.

## Architectural decisions

### Decision 1: Anti-bamboozle via isolated auditor

The single most important property of this plugin is that the implementing agent cannot bamboozle the verifier. The way to achieve this structurally:

1. The auditor runs in a **detached pi RPC process with a fresh agent session**.
2. The auditor has **no extensions, no skills, no prompts, no themes, and no context files**.
3. The auditor has the **power-mode audit tools**: `read`, `grep`, `find`, `ls`, and `bash`. Bash is intentionally available for bounded verifier scripts, tests, git inspection, and behavior reproduction; this is a policy-guided capability, not an OS-level read-only sandbox.
4. The auditor **cannot see the implementing conversation and receives no glla
   extension APIs or parent state handles**. This is not an OS-level sandbox:
   intentional bash power mode means a prompt-injected command or verifier can
   write repository/glla files or plant evidence. The parent still validates
   attempt/request identity, tool evidence, `regression_shield`, and revision
   before applying a result.

This is based on `pi-goal-x/extensions/goal-auditor.ts:148-156`, with the
current detached worker adding the explicitly accepted bash power mode and
`regression_shield` revalidation.

### Decision 2: regression_shield in v0.2.0

v0.1.0 ships the same auditor behaviour as pi-goal-x. The author of pi-goal-x documented an honest caveat (verbatim):

> "the guarantee is deliberately just 'the auditor ran at least one successful tool', not 'it inspected the right content': there is no cheap, honest way to tell a requirement-relevant `read` from `bash true`, an empty `grep`, or a read of an executor-planted file."

We accept this caveat for v0.1.0. v0.2.0 will add **regression_shield**: an explicit requirement that the auditor's report must include raw output (a `cat`, a `grep -A 5 <file>`, a `bash <user-script>`) for every item in `verificationContract`. Without that evidence, the auditor's `<approved/>` is rejected by the orchestrator.

### Decision 3: Hard 5-minute backoff cap (SUPERSEDED v0.35.4)

The #1 complaint about pi-goal-x in our audit (user-stated) was "1-hour waits". The cause is exponential backoff with no ceiling.

v0.1.0 shipped a hard 5-minute cap. After 5 minutes of consecutive backoff:
1. TUI badge turns red with "Last activity: 5m+".
2. User can press `r` to force-continue or `s` to skip to next pending task.
3. Optional: configure Telegram/web push notification.

> **Superseded (v0.35.4):** the cap had zero production call sites and was
> removed (`extensions/goal-loop-backoff.ts` header). The live envelope is
> the eager 5s first retry + hourly-aligned ladder with stall-ladder/heartbeat
> coverage — see README's retry section.

### Decision 4: No drafting phase in v0.1.0 (deferred to v0.2.0)

The user identified vague-correction as a key strength of pi-goal-x. But shipping it in v0.1.0 doubles the scope and we won't get the auditor right if we split focus.

v0.1.0 ships `/goal "<objective>"` only — same UX as pi-goal-x's `/goal-set`. v0.2.0 adds the drafting protocol with structured `goal_questionnaire` widget.

This is a deliberate trade-off. If the user wants drafting in v0.1.0, say so and I'll prioritise.

### Decision 5: One package per loop (not three packages)

Some alternatives considered:
- Three packages: `pi-goal-list-loop-audit`, `pi-goal-list-loop-audit-list`, `pi-goal-list-loop-audit-loop`.
- One package with three subcommands: `/goal`, `/list`, `/loop`.

We choose **one package with subcommands**. Reasoning:
- Single install (`pi install npm:pi-goal-list-loop-audit`).
- All three loops share state machine, schemas, scaffolding.
- v0.1.0 only ships loop 1, but the package already declares loop 2 and loop 3 as `pi.commands` so users see what is coming.

### Decision 6: Forks pi-goal-x rather than reimplements

Why not write from scratch?
- The auditor pattern is sound and small (one function: `runGoalCompletionAuditor`).
- The drafting phase logic is sound and small.
- The continuation loop is sound and small.
- The compaction discipline is battle-tested.

We fork pi-goal-x 0.19.0 source. We then **simplify by removing the broken parts** (markdown summaries, unbounded backoff) and **clean the seams** (split the single `goal.ts` file into per-loop files).

This is a **clean break** by decision of the user. We do not interop with `pi-goal-x`'s `.pi/goals/` directory.

### Decision 7: Per-loop file split (superseded)

> **Superseded by consolidation (v0.8.0).** The planned per-loop files below
> never shipped: loops 1+2 live together in `extensions/loops/goal.ts`
> (one state machine, one loop driver), loop 3's helpers in
> `extensions/loops/forever.ts`, rendering in `goal-loop-display.ts`,
> drafting inline in `goal.ts` + `prompts/`. Kept for history.

| File | Purpose | Lines |
|---|---|---|
| `extensions/loops/goal.ts` | Loops 1+2 (single goal + list of goals) | shipped |
| `extensions/loops/forever.ts` | Loop 3 (metric loop helpers) | shipped |
| `extensions/goal-loop-core.ts` | Shared state machine, types, JSONL | shipped |
| `extensions/goal-loop-auditor.ts` | Auditor prompt + compatibility helper | shipped |
| `extensions/goal-loop-auditor-process.ts` | Detached worker protocol, IPC, and shield revalidation | shipped |
| `scripts/goal-auditor-worker.mjs` | Extension-less RPC auditor child | shipped |
| `extensions/goal-loop-display.ts` | Status line + /goal status rendering | shipped |
| `prompts/goal-loop-continuation.md` | Templated continuation prompt | ~80 |
| `prompts/goal-loop-auditor.md` | Templated auditor prompt | ~80 |
| `prompts/goal-loop-draft.md` | Templated drafting prompt | v0.2.0 |
| `schemas/goal.schema.json` | JSON Schema for goal state | ~50 |

### Decision 8: Status machine

```ts
// Historical sketch from v0.2.0 planning. The SHIPPED Status union is
// "active" | "auditing" | "complete" | "paused" | "aborted" (drafting is a
// UI phase, not a persisted status).
type Status =
  | "drafting"        // v0.2.0 (planned; not a persisted Status value)
  | "active"
  | "auditing"
  | "complete"
  | "paused"
  | "aborted";
```

States owned by the orchestrator:
- `active` → next iteration
- `auditing` → detached auditor queued/running (or recovery pending)
- `complete` → archived
- `paused` → user-resumable
- `aborted` → user-cancelled

Transitions:
```
drafting → active          (user confirms draft)
active → active            (continue work)
active → auditing          (complete_goal called)
auditing → complete        (auditor <approved/>)
auditing → active          (auditor <disapproved/>; reset iteration counter)
active → paused            (pause_goal called, or stuck > 5 min, or empty turn)
paused → active            (user /goal resume, or resume_goal when the user authorized continuation in conversation)
active → aborted           (user /goal cancel)
```

### Decision 9: JSONL state (deterministic compaction)

Goal state lives in `.pi-glla/active.jsonl`. Each line is a state transition. On compaction, the summary is rebuilt deterministically from the JSONL (autoresearch pattern).

This protects against model-generated summaries losing fidelity.

### Decision 10: Hard pause + escape hatches

| Trigger | Action |
|---|---|
| Detached auditor running | Main turn remains free; `/goal cancel` discards the pending claim and stops the worker best-effort |
| `Esc` during agent turn | Pause |
| User `/goal pause` | Pause |
| User `/goal cancel` | Abort (wipes active goal) |
| Stall watchdog (3 consecutive no-tool turns) | Pause + notify |
| Empty turn (no tool calls) | Pause (no momentum) |

## Open follow-ups (post-v0.1.0)

| Priority | Item | When |
|---|---|---|
| HIGH | Drafting phase with structured Q&A | v0.2.0 |
| HIGH | regression_shield for auditor | v0.2.0 |
| MEDIUM | Native TUI form widget | v0.2.0 |
| MEDIUM | Loop 2 (list) | v0.2.0 |
| MEDIUM | Loop 3 (loop) | v0.3.0 |
| LOW | Telegram push | v0.3.0 |
| LOW | Sub-task auto-close | v0.3.0 |

## Addendum v0.35.6 (Unattended autonomy, audit cadence, and parallelization)

- **Two-phase decision architecture (upfront grilling → zero pauses during execution)**:
  - Drafting upfront is the sole interview boundary: the agent asks sharp questions about architecture, scope, error conditions, and test commands.
  - Active execution is 100% unattended: the agent picks sensible architectural defaults, records rationale, and continues without interrupting the user for obvious choices or secondary questions. Non-blocking notes are deferred to the completion summary.
  - Premium engineering standards: mandatory root-cause fixes, full TypeScript type safety, and comprehensive test coverage. If an approach fails verification after 2 attempts, the agent autonomously steps back and pivots to an alternative architecture.
- **Audit cadence across modes**:
  - `/goal`: Evaluated by the detached isolated auditor at goal completion (`complete_goal`).
  - `/list`: Evaluated by the detached isolated auditor at the completion of **every individual list task** before unlocking and activating item $N+1$. This prevents list drift, ensuring that errors in early tasks do not cascade into downstream tasks.
  - `/loop`: Shell metric command evaluated on every iteration; LLM auditor does not run on intermediate iterations.
- **Parallelization architecture & opportunities**:
  - *Current*: Parallel subagent exploration fan-out (spawning multiple `Explore` agents in one turn) and parallel disjoint-worktree implementation (`general-purpose` workers with `isolation: "worktree"`). Detached auditor runs concurrently in background OS process.
  - *Opportunities*: Concurrent `/list` dispatch across non-conflicting tasks using isolated worktrees to eliminate head-of-line blocking for large queues, plus background contract rehearsals.

## Addendum v0.35.7–v0.35.31 (consolidated behavior addenda)

Per the doc convention, these releases appended the following architectural
shapes (details in CHANGELOG.md; each is pinned by tests):

- **Supervisor freeze — `/glla pause` (v0.35.15/17)**: freezes ALL automatic
  machinery (re-arms, recovery probes, auto-resume, continuation dispatch,
  proactive notifies) without touching active work or a running detached
  auditor. Distinct from goal pause; only `/glla resume` clears it.
- **Load hold (v0.35.23)**: a cold session load that restores pending state
  WITHOUT explicit consent holds automation (`loadHoldAt`) until an explicit
  work command releases it. Refines the restore-gate consent story above.
- **Auditor picker parity (v0.35.24)**: `promptModelRef` accepts
  `excludeRefs`; forbiddenModels policy refs are filtered from lists AND
  refused on typed input (`forbidden_model_switch`).
- **Zero-stream zombie park + RESUMABLE_STOP (v0.35.25/26)**: a run with no
  provider activity parks as `stopped: automatic zero-stream abort…` and
  `/loop resume` retries it; the zombie watchdog stands down while tracked
  subagent waits are in flight via ONE shared `SUBAGENT_WAIT_TOOL_NAMES`
  predicate (no per-site name lists).
- **Windows auditor launch, gate-before-quote (v0.35.27)**: unsafe-arg
  rejection runs on EVERY argument before the quoting decision; bare tokens
  reach cmd.exe untouched so pnpm .CMD shims resolve.
- **Heartbeat due-wait backstop + recovery notice (v0.35.28)**: wall-clock
  comparison against persisted `pauseResumeAt` in the tick resumes lapsed
  wait/error-brake parks after a 90s grace (consent-gated); successful
  recoveries stamp `autoResumedAt`/`autoResumedEvent` and the continuation
  prompt renders a RECOVERY NOTICE instead of waiting on a fired signal.
- **Tracked-subagent visibility (v0.35.29)**: `getSubagentAgentsSnapshot()`
  (read-only probe views with hung classification) feeds `/glla agents`,
  `/glla agents --tail <id>` (read-only child transcript tail), and a widget
  segment — pure rendering in `extensions/goal-agents-panel.ts`.
- **Durable last-outcome retention (v0.35.30)**: archiving writes
  `state.lastOutcome`; the widget keeps one dim ✓/▪ line for 24h after the
  slot empties so a finished audit stays visible after the turn ends.
- **Loop plateau vs never-moved baselines (v0.35.31)**: flat metric readings
  count toward plateau only once the metric has demonstrably moved; a metric
  that NEVER moves gets its own loud bounded stop. Audit loops keep their
  purpose-built deferred-baseline + reprieve semantics verbatim.

## Addendum v0.36.3 (subagent orchestration — power-max pin)

- **One pinned orchestrator**: `pi-subagents@0.62.0` is the power-max companion
  for GLLA. Capability ceiling chosen over minimalism: `runs.all` parallel
  fan-out, `runs.lanes` worker→review→fix chains, `outputSchema` +
  `acceptance` structured verification, `runs.host` gated shell, worktree
  isolation, model routing (`subagents.defaultModel` / `subagentModelOverrides`
  / `modelScope`), missions/schedules, and durable recovery. GLLA supervises
  via `subagent:async-started` + durable `status.json` + versioned stop RPC
  (ownership/generation-checked). The 0.x pin is exact because the 93k-line
  surface moves fast; upgrades run a compatibility canary.
- **One owner, no stacking**: `@tintinweb/pi-subagents` (legacy),
  `@narumitw/pi-subagents` (minimal without durable status/workflow), and
  `@quintinshaw/pi-dynamic-workflows` (complement-only LLM-vote helpers) are
  not stacked as second orchestrators in the same session — duplicate tools and
  competing events create ambiguous ownership. `@juicesharp/rpiv-advisor`
  remains a composable second-opinion reviewer.

## Addendum v0.36.2 (continuous list handoff)

- **A list is a continuous work plan**: after a standalone goal reaches a
  successful terminal archive, an already-waiting queue is handed to the same
  activation choke point used by list-item completion. The bounded
  `LIST_COMPLETION_SETTLE_MS` window still protects the first successor
  continuation from the host's completion acknowledgement settling. User
  aborts do not auto-advance, and one-active-thing, suspicious-objective,
  sidecar, persistence, carryover, and loop-owner fences remain authoritative.
- **Resume repairs waiting queues**: `/glla resume` hydrates durable queue
  sidecars, records `list_queue_resume`, and explicitly activates the waiting
  head when no higher-priority goal, loop, auditor, or provider-recovery plane
  owns the surface. Cold-load automation remains consent-gated; this command
  is the consent boundary.
- **Selection remains explicit**: `/list next` is still available for a
  deliberate skip or non-head choice. It is no longer required between
  successful list items.

## Addendum v0.37.1 (folder-scoped audits)

- **Primary scope is the cwd project**: `listAuditCollectTarget`, `projectAuditTarget`, and `auditTarget` now state "current project rooted at the cwd where pi was opened (treat any nested .git as a separate project boundary — do not walk into parent or sibling projects)". The TIGHT scout brief is "named directories under cwd" — external code outside cwd may be READ only to diagnose a failure that blocks the current project, and a finding about external code is valid only when it affects the current project (a typo in an unrelated sibling project is out of scope and never auto-queued). This closes the "audit the parent when you opened a subproject" leak observed when hellhunter was audited from the dracon-platform root and vice-versa.

## Files

- `docs/DESIGN.md` — **this file**
- `README.md` — quickstart
- `docs/INDEX.md` — shipped documentation and architecture entry points
- `README.md` — user-facing installation and operating guidance

Historical audit notes are repository-only and are intentionally not part of
the published package.

