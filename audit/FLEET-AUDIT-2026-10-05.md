# GLLA fleet audit after command, completion and model-switch fixes

Read-only observations on October 5, approximately 17:21–17:27 UTC. Scope is
GLLA ownership, recovery, audit progress, completed UI and compaction scheduling.
No external project, live terminal input, worker or runtime journal was changed.
The prepared source version is 0.39.8; loaded hosts have different versions.

## Findings and disposition

| Project | Observed behavior | Disposition |
| --- | --- | --- |
| Football Forever | Active project building; the objective is visible; a test command is running. Loaded 0.39.5. | The earlier objective was retained in the journal. Model-switch visibility/admission defect is covered by the prepared 0.39.8 regression, not evidence that this host loaded it. |
| Endless TD | Inactive project loop, old main-model-recovery stop, no recovery record after manual model selection. Loaded 0.39.7; main session is running tests. | Another saved instance of the GLLA model-switch defect. 0.39.8 admits and displays this legacy hold. Reload the extension, then `/glla resume` or `/loop resume` through public commands. Main-session activity alone does not reactivate loop supervision. |
| Freeport | Independent audit around 46 minutes; matching worker alive in project cwd; progress and recent tool completions advance. | Long audit, not an observed frozen worker. One project requirement awaits an owner design decision. No forced restart. |
| Eve | Audit worker alive initially; follow-up shows rejection applied and goal active with repair guidance. | Demonstrates final audit reconciliation and continuation rather than a parked verdict. |
| Darklord | Building became independent audit increment 6 during observation; matching worker has fresh activity. | Progress confirmed. Earlier 1.38M context sample is stale; current terminal is about 233k. |
| Junk Runner | Active project building increment 2; full test command running; loaded 0.39.7. | Earlier held audit is no longer the current state. |
| Chat | Active goal; rejected completion feedback visible; main session working; loaded 0.39.8. | Repairing real audit findings. Old 770k context sample is stale; current footer is about 85k. |
| Studio | Active list goal; rejected completion feedback visible; main session working; loaded 0.39.8. | Repairing real audit findings. Automatic transcript compaction fired at 205,684 tokens and completed about 32 seconds later. |
| Neonbreak | Complete project, all three adopted requirements verified, matching archive present; no GLLA widget or footer in current terminal. | Completion dismissal works in the live UI. Historical completion remains inspectable through status/archive. |
| Polis / Capture Anime Girls | Inactive loops with current bounded recovery records and future retry times after provider 404 responses. | External unavailable-model reports contained by GLLA. Distinct from the orphan recovery hold; no provider changes. |
| SEO | September 25 goal remains auditing, owner host absent; matching saved worker result contains `<disapproved/>`. | No running host to reconcile. Resume/load the original session and use GLLA public recovery commands. Worker `ok: true` is transport success, not audit approval. |

The survey covers 23 journal roots, including six with absent recorded host
processes. Those absent hosts are not classified as live stuck loops. A host
process being alive is also insufficient evidence of work: worker progress,
tool activity, phase changes and terminal state provide the additional checks.
Observation timestamps and retained context timestamps are kept separately.

## Compaction

Studio and Eve have successful recent automatic compaction events. Current
Chat and Darklord terminal context readings invalidate the older high readings
as evidence of current over-limit failures. Some working projects are still
above 200k. This remains an opportunistic idle-boundary target, not a hard cap
or a guarantee that an external summarizer succeeds. Failed summarization and
unavailable providers remain outside this repository's implementation scope;
GLLA's scheduling and safe continuation are covered by the existing audit and
regressions in COMPACTION-EVENTUALITY-2026-10-05.md.

## Evidence and validation

`fleet-audit-2026-10-05/observation.json` and `followup.json` retain journal
state, process/cwd observations, matching worker metadata, archive existence
and context sample age. `ui-observation.json` retains the displayed versions,
current context footer, working indicator and audit activity line. Project
objectives and raw auditor output are omitted from these tracked snapshots.

The combined 0.39.8 release gate is running; its final result will be recorded
here when it finishes. No additional implementation change was required by
this fleet observation. The command, completion dismissal and model-selection
fixes have their own reproductions and focused verification reports in audit/.
