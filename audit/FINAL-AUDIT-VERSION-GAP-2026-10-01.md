# Final-audit "still stuck" report — SUPERSEDED (2026-10-01)

> ⚠ CORRECTION (22:30 UTC): the version-gap conclusion below is WRONG.
> pi loads GLLA from the repo checkout itself (`../../Dev/pi-plugins/
> pi-goal-list-loop-audit` in `~/.pi/agent/settings.json`), NOT from the
> stale `~/.npm-global` 0.38.104 copy. Sessions run 0.38.107 + unreleased
> working-tree changes (as of their start time). The per-case liveness
> observations stand; the "upgrade to fix" recommendation does not — the
> operator's "says latest but doesnt work" report is against CURRENT code
> and remains open. See follow-up inspection below.

> Original inspection ~20:43–20:50 UTC (read-only; nothing modified).

## Top finding

The installed GLLA is **0.38.104**; the audit fixes shipped in **0.38.107**
(published to npm, never installed here), and the liveness fixes are still
unreleased in this repo. Every symptom in the report matches the old
behavior, and no live case contradicts the new code.

## Case evidence

- **chat** (`dracon-platform/web/chat`): final audit ran 18 min over 2 live
  rounds (claim 20:02:43Z, result published 20:20:54Z, settled the SAME
  second, archived, completion notice posted). Mechanism healthy — but on
  0.38.104 the round-2 "second audit pass" visibility (0.38.107) was absent,
  so the user watched 18 min of generic running. Perception: stuck.
- **dracon-platform root**: auditing LIVE (started 20:38Z, progress.json
  advancing within the last minute). Healthy; will look equally static on
  .104 during round 2.
- **browser-extensions-shared**: ACTIVE and progressing (bash evidence every
  1–3 min through 20:45Z). Between calls the .104 card shows no stream age
  and no action recency — exactly the gap the unreleased stream-age fallback
  closes.
- **dracon-strategy**: active, just started (20:42Z). **eve**: loop running,
  no goal. **dracon-log/studio**: idle.

## Gap inventory (installed 0.38.104 vs available)

| Fix | Ships in | Installed? |
|---|---|---|
| Completed-audit recovery (orphan reconcile) | 0.38.107 | NO |
| Second-audit-pass visibility | 0.38.107 | NO (0 matches in installed display) |
| Loop "looks frozen" cadence countdown | 0.38.105 | NO |
| Dynamic draft / owner honesty / action-first status | unreleased (repo) | NO |
| Stream-age fallback + action recency | unreleased (repo) | NO |

## Incidental: `manual-verify` settlement origin is a mislabel

Chat's settlement ledgered `origin: "manual-verify"` with NO
`manual_audit_requested` event and NO user/agent verify call in the session
(the last tool call was `complete_goal` at 20:02:43Z). The origin is stamped
by the `complete_goal` tool's shared settlement block
(extensions/loops/goal-tools.ts:1675), which also settles detached
completions via background chains. Forensically misleading — worth a
follow-up rename (e.g. pass the real origin through) so the next triage
does not chase a phantom manual intervention. Not changed in this audit.

## Fix-forward

1. Upgrade the global install to ≥0.38.107 (published; `npm view`
   confirms): the audit fixes go live for new sessions. Running sessions
   keep the loaded .104 until restarted — do NOT restart mid-audit.
2. Cut the next release with the unreleased UI/liveness work (note.md
   already queues "do a release after"), then upgrade again.
3. Optional: relabel the `manual-verify` settlement origin.
