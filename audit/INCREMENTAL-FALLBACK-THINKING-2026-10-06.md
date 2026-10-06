# Incremental fallback thinking selection

The main fallback editor prompted for every selected model each time the chain
was saved. Adding Muse after configuring M3.1 therefore asked for both thinking
levels again. Prepared 0.39.13 compares the previous and selected chains
case-insensitively and prompts only for newly added models, preserving existing
pins and inheritance. Reordering and removal do not trigger thinking prompts.

A separate Main agent → Fallback thinking row lets the operator select one
saved model and change its supported level or inheritance without editing the
chain. The same model-capability helper and validation serve both flows.

The public editor regression exercises M3.1 alone, then M3.1 plus Muse, reorder,
and removal. It checks exactly which thinking prompts appear and preserves
both choices. Existing inheritance and unsupported-choice tests now exercise
the explicit per-model editor. All 89 tests across four files passed, along
with TypeScript, inventory and whitespace checks. Verification logs are in
`audit/incremental-fallback-thinking-2026-10-06/`. No live/global preferences were
changed. This change is prepared in 0.39.13 and is not published by this work.
