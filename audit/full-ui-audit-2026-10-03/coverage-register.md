# UI coverage register

Current source inventory: `surface-inventory.json` (TypeScript AST, not an
assumed filename list). Four custom components, one message renderer, five
registered commands, five custom-dialog factories, 34 selects, 27 inputs,
eight confirms, 589 notification calls, and one widget/status publisher each.

| Surface family | Current source | Authoritative verification |
| --- | --- | --- |
| All settings and nested editors | settings-menu.ts; loops/goal-settings-ui.ts; goal-settings.ts | settings-menu-complete, settings-editors, settings-invalid-report, settings-stale-save, glla-ui-command-audit; per-tab actual rendered frames |
| Settings layout, navigation, search, focus, full values | SettingsMenuComponent; openSettingsUI | ui-experience-audit; glla-table-menu; production-factory row/tab continuity test; dark/light gallery at 40/60/80/120 columns |
| Single model selection and registry/manual fallback | ModelPickerComponent; promptModelRef | model-picker; auditor-picker-parity; settings-editors; forbidden-model-policy; height/width and Unicode regression tests |
| Ordered fallback chains, extension sets, unavailable refs | MultiModelPickerComponent; promptModelRefs; allowed-extension editor | multi-model-picker; main-model-fallback-settings; fallback-order-runtime; glla-ui-command-audit; short-terminal browse/order fixtures |
| Goal/list/loop contract confirmation | ConfirmDraftComponent; goal-session confirmDraft | confirm-draft; behavioral-orchestrator; ui-experience-audit; start-inference; drafting-questionnaire; list interview/draft tests; actual beginning/end/consent frames |
| Paused, decision, error, timed wait and standby reminders | action-reminder.ts; pause_goal | action-reminder; pause-decision-interrupt; action-reminder abort ownership tests; five dark/light actual message-renderer states |
| Goal/loop/queue/worker/auditor status and cards | goal-loop-display.ts; loops/goal-ui.ts; goal-agents-panel.ts | display; goal-loop-display; activity-first-status; audit-lifecycle-surfaces; paused-status-action-first; waiting-on-subagent-pause; subagent-display-richness; 16 state fixtures and explicit widths 0/1/20/40/60/80/120 |
| Status, timeline, queue, loops and overview | goal-commands.ts; goal-loop.ts | goal-timeline; glla-status-ux; list ownership/group tests; ui-command-view-audit; 144 actual registered-handler views |
| Stats, audit history/health, agents and settings text | goal-commands.ts | stats-outcomes/challenges; glla-stale-context; glla-bug-capture; settings-editors; auditor telemetry; command-view artifact includes each read-only family |
| Mutation confirmations and user cancellation | command/editor dispatcher, wipe, takeover, list removal | glla-ui-command-audit; state-root-owner; takeover; confirm-draft; settings-stale-save; behavioral-orchestrator |
| Command discovery, routes, errors and usage | goal-activation.ts; goal-commands.ts; goal-loop.ts | command-registration-collisions; completion-trailing-space; ui-polish; all canonical route coverage; behavioral dispatcher tests |
| Completed/archive/approval summaries and delivery | completion-summary.ts; approval-render-store.ts; terminal render delivery | terminal-approval-render; approval-notify; audit-lifecycle-surfaces; screenshot disapproval; summary store/canonical render tests |
| RPC/headless, stale hosts, ownership and package loading | public hooks and fallback factories | session-rpc-rebind; confirm-draft; settings-editors; lifecycle-recovery; glla-stale-context; Jiti and packed-artifact gates |

The complete release sweep includes the existing tests above; the register
explains their relationship to the UI contract rather than treating a green
aggregate as proof by itself. Gallery frames execute production components,
with the installed Pi dark/light themes. PNGs are raster previews of those ANSI
frames, not a claim of a live provider session or a screenshot of every host UI
mode. HTML and JSON retain every frame for inspection.
