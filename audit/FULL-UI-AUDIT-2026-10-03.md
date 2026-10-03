# Full UI audit — 2026-10-03

Objective: audit the full GLLA UI and improve it where necessary, including
layout changes. Scope covers GLLA-owned terminal UI and its public Pi hooks.
Pi core, providers, OS, and other plugins remain outside the implementation
boundary. Prior audits are pointers; current source and rendered behavior
are authoritative.

## Completion requirements

1. Inventory every GLLA custom component, widget/status state, command view,
   editor, confirmation, fallback dialog, and completion/notification surface.
2. Check settings discoverability, effective values/provenance, selected-row
   continuity, cancellation, keyboard navigation, and readability across tabs.
3. Check single and ordered/set pickers: search, selection, disabled entries,
   order, empty results, long values, and terminal width/height constraints.
4. Check draft review: full contract remains reviewable, choices stay visible,
   keyboard actions work, and acceptance/cancellation retain their semantics.
5. Check goal/loop/queue/worker/auditor cards across live, paused, held,
   recovery, completion, and empty states. State and next-action text must
   agree with durable state. Rendered rows must fit the available space.
6. Check commands, headless/RPC fallbacks, confirmations, approval summaries,
   notifications, errors, and option wording for accuracy and useful actions.
7. Produce and inspect actual rendered evidence with narrow/normal/wide and
   short-terminal cases; record fixes and consciously retained tradeoffs.
8. Verify affected behavior and broad UI regression suites, synchronize
   version/changelog/docs/inventory, and prove the packed extension still loads.

Status: in progress. No completion claim yet.
