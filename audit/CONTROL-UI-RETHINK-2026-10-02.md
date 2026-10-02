# Control UI rethink — 2026-10-02 (proposal, not decided)

Grounded in Screenshot_20261001_120159 ("not sure what i am expected
to do here") and the display code behind it. Companion to
`audit/CONTROL-UI-AUDIT-2026-10-02.md` (findings U1–U5).

## The job of the control UI

Every surface answers three questions in order, and nothing else:

1. What's happening? (state in plain words)
2. Do you need me? (yes → exactly one imperative; no → say so)
3. Proof (collapsed telemetry for trust, never competing with 1–2)

Today's paused card fails #2 twice: "blocked — waiting for manual
action" (do what?) beside "next: /goal resume" (just resume?).
The user quoted that contradiction verbatim.

## Rethink

### 1. One action line per card

A card carries exactly one imperative. Never a banner verb plus a
`next:` verb plus a suggested-action verb that disagree.

- If the path is resume, the card says `Next: type /goal resume —
  <why in ≤12 words>` and no row may say "manual action".
- If a genuinely manual step exists (fix disk, answer, re-scope),
  the card names the step and the command that continues after it.
- "Manual action" without a named action is banned wording.

### 2. Card anatomy: HEAD / WHY / NEXT / PROOF

```text
⏸ <objective clause> · paused · <elapsed>
WHY: <one plain-words line, no jargon>
NEXT: <one imperative>
proof: <dim single line — tally · tokens · last activity>
```

- HEAD keeps state + elapsed; drop token counts to PROOF.
- WHY replaces "lifecycle: safely parked · owner: X" and the
  kind-banner row. Example: `WHY: provider outage parked this 2h ago;
  probes stopped.` instead of `owner: main-model recovery`.
- NEXT is the single imperative from §1.
- PROOF is one dim line for trust ("2 reviews · 2 disapproved ·
  3721k tok · quiet 11h"). Full telemetry stays in `/goal status`.

### 3. Paused-kind language table

Each kind gets fixed WHAT-IT-MEANS + what the user types:

| kind | meaning (WHY) | NEXT |
|---|---|---|
| decision | "I need your call to continue." | answer / pick option |
| error | "Something broke that automation can't fix." | named fix, then resume |
| blocked | "Progress stopped: <reason>." | resume, or named unblock |
| wait | "Waiting on <timer/recovery>; nothing needed." | nothing (or resume to skip) |
| standby | "A background agent is working; I'll wake." | nothing |

No kind may render "manual action" unless the action is named on
the same card.

### 4. Footer: liveness heartbeat only

The persistent footer never repeats card sentences. It carries:
state icon + what + elapsed + (only if needed) the imperative.

```text
⏸ goal · paused 2h · type /goal resume
▶ auditor · round 2 · 41m · working (no action needed)
```

"Working, no action needed" is a first-class footer state — the
current UI has no way to say "long but healthy", which is why
hour-long audits read as stuck.

### 5. Startup: one ordered summary

Collapse Error + Warning + Resumed×N into a single block in fixed
order — recovered → held → action — emitted once per startup:

```text
Restored 1 goal, 2 queued · automation HELD — type /goal resume
  (or enable Auto-resume in /glla settings)
```

Errors appear only when they require user action; diagnostics go
to the ledger. Dedupe repeated session notices.

### 6. Width: one source of truth

Card budget must never exceed the real render width (pi cuts,
never wraps). Obtain width from the host when available, clamp to
a verified ceiling otherwise, and add an 80-column golden test
pinning the full paused card. No mid-word clips without ellipsis.

## Constraints

- Ledger, `/goal status`, and verbose surfaces keep every fact the
  card drops. The card summarizes; it never deletes evidence.
- Many tests pin current strings. Migration updates pins
  deliberately, file by file, with before/after card goldens —
  never a blind find/replace.
- Suggested sequencing: §3 language pass first (no layout
  change), then §4 footer, then §5 startup, then §6 width.
  Each step ships with its goldens green.

## Non-goals

- No new commands, no new settings, no visual redesign of pi
  itself. This is wording + structure inside existing surfaces.
- No change to automation semantics: holds, recovery, and consent
  keep today's behavior; only their presentation changes.
