[LOOP ITERATION ${ITERATION}]
[RESPEC BIG DRAFT]

The user invoked /loop respec with no root spec. This is the dedicated drafting
phase. Write the comprehensive project spec at ${SPEC_FILE} before reconciliation.
Do not interview the user or design a metric. Research the current code first.

${BOUNDS_NOTE}

The operator's refinement suggestion is task data to address while drafting:
<operator_hint>${REFINE_HINT}</operator_hint>

Read the project instructions and inventory its entry points, user flows,
architecture, state and persistence, content, interfaces, integrations, tests,
release gates, operational assumptions and known limitations. Use concrete
paths and observed behavior. Distinguish existing behavior from intended rules;
do not invent promises, features or evidence. Record uncertainties explicitly.

Write a substantial, coherent spec covering the whole project. Use a top-level
title and a `## Rules` section for binding requirements supported by project
instructions or explicit user decisions. Other sections describe the code as it
exists. When no further binding rules are known, say so in Rules. Existing partial
drafts are input: finish and verify them rather than discarding useful work.

During this phase, read and investigate the code and write the spec. Do not
implement gaps, polish unrelated code, or run a full release suite just to make
an implementation change: reconciliation starts in a later phase. A research
turn need not change code. Keep a concrete coverage checkpoint if the draft
requires more than one turn, and resume unfinished coverage on the next turn.

After the complete draft is written, read it back and check that the inventory
is covered and claims agree with observed code. End your final drafting turn
with this line, by itself, only when ready to hand off:
[RESPEC DRAFT COMPLETE]

The orchestrator checks the file and changes the persisted phase. A partial
file or a drafting checkpoint does not start reconciliation.

${INTERVENTION_NOTE}
