# Failed recovery context growth

The Hellhunter screenshot reports repeated main-model recovery probes returning
404 and context above the model window. The provider endpoint failure is external
to GLLA. GLLA owns the retry dispatches and outgoing context projection.

Read-only inspection of session `01a10dd3-271b-71bc-9bb5-bbfe0782bdc5`
found 24 error-only assistant replies immediately following GLLA dispatches.
The dispatches contained roughly 7 MB of serialized prompt content, including
repeated complete project audit reports. Existing hygiene removed old assistant
errors but retained their triggering prompts. This left most failure-related
growth in outgoing context.

The always-on context and compaction hooks now remove an obsolete failed
assistant reply together with its immediately preceding owned `goal-event` or
`unsupervised-error-retry` prompt. This applies across modes, including ordinary
sessions without active GLLA work. The latest failed reply and its prompt remain
for diagnosis. Actual user requests, unrelated custom messages, user aborts and
assistant turns carrying tool calls remain intact. No saved transcript is edited.

The project builder separately dispatches a bounded JSON view of durable state:
complete adopted requirements and acceptance criteria, current tasks, latest
report/feedback excerpts and evidence references. Prior reports remain durable.
If the contract itself exceeds the limit, the dispatch explicitly requires scoped
durable reads before operational work; it cannot silently weaken acceptance.
The serialized state limit is 48,000 characters, including escaped characters.

Applying the production hygiene function to the old Hellhunter session removed
23 obsolete error/dispatch pairs while retaining the latest. Serialized message
characters fell from 8,235,897 to 1,616,382 (about 80% less). This is a replay
measurement, not a live provider token count. Project state measured separately
at 279,356 characters projects to 36,390, retaining every acceptance criterion.
Neither the external project nor its session was changed.

Verification: the initial failed-prompt regression failed before the fix.
97 tests passed across nine files, covering public hooks with optional checkpoint
projection disabled, ordinary failures, unsupervised retries, preservation of tool
and user interactions, compaction input, project dispatch integration and oversized
contracts. TypeScript and inventory verification are recorded alongside this
report after completion. Prepared version 0.39.11 remains unpublished.

The host's raw transcript estimate can remain high until real compaction succeeds;
filtering provider input does not rewrite that transcript or heal a 404 endpoint.
