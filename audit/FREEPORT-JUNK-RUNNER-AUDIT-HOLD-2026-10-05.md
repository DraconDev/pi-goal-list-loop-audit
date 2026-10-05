# Project increment audits misclassified as continuation stalls

Read-only observations of Freeport and Junk Runner at approximately 06:51–07:00
UTC on 2026-10-05. Implementation changes are confined to GLLA. Neither host,
project source, live journal, nor owner marker was changed by this investigation.

## Observed disposition

- Freeport: project revision 1, increment 5, auditing claim retained; loop held
  since 2026-10-04T22:55:08.606Z after five continuation refires. Its loaded
  version is 0.39.0. Saved physical job has no verdict: `Auditor aborted.`
  The worker completed 64 tool calls; its last call finished at
  **22:55:07.150Z**, less than two seconds before the stall escalation. This
  is direct evidence that active detached work was misclassified.
- Junk Runner: revision 1, increment 1, auditing claim retained; loop held
  since 2026-10-04T22:04:48.870Z for the same continuation-refire reason.
  Its host restarted at 06:49 on 2026-10-05 and displays 0.39.1. The main
  session was executing a search during inspection, but the project remained
  held. Startup retention reaped one job; no saved job result remained to
  establish that old worker's verdict or exact cancellation mechanism.
- Freeport also records an unresolved theft-rule design decision. This is a
  separate product blocker, not permission to change that game's economy here.

## GLLA defect and correction

The heartbeat protected detached goal completion audits with the goal audit
in-flight flag, but did not protect detached project increment dispatches.
Increment audit work intentionally leaves the main session idle. The heartbeat
therefore scheduled main-session continuations, counted the absent turns as
stalls, and eventually set the loop inactive. Project audit progress then saw
that inactive loop and cancelled the worker.

0.39.2 checks the actual running dispatcher for the exact project root, loop
start and logical audit attempt before counting a continuation stall. A saved
claim alone, a different attempt or root, an inactive loop, or a cancelled
controller cannot suppress the heartbeat. Existing detached worker timeouts,
fallback policy, ownership checks and explicit pause behavior remain in force.

Held audit cards now say **Audit held** and expose the durable stop reason.
The compact footer points to `/loop resume`, instead of suggesting that an
auditing phase alone proves an active worker.

## Validation and recovery

58 focused tests passed across six files, including real worker dispatch,
claim replacement and cleanup, held-card rendering, heartbeat wiring and
release contract. TypeScript, Jiti shared-state binding, installed 0.39.2
tarball import, bounded launcher/worker RPC and delegate skill loading passed.
The full release gate was not rerun for this patch. Neighbor checks are recorded
separately in the evidence directory.

0.39.2 is prepared, not published. Existing hosts must load the corrected code:
`/reload`, then `/loop resume`. Resume preserves the saved claim and uses normal
GLLA dispatch/reconciliation. It does not manufacture an approval. This
investigation did not send commands to either terminal or resume held work.

Evidence: `audit/project-audit-heartbeat-2026-10-05/`.
