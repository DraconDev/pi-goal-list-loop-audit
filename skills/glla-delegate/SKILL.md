---
name: glla-delegate
description: "Use GLLA's audited goals and list queue from normal chat: queue explicit work, offer follow-ups before adding them, or draft a confirmed goal. Includes safe handling for pasted list-like input."
---

# GLLA delegation

GLLA is not a scratch task list. A queued item becomes an audited goal, and
when the queue is idle its first item may activate immediately. Use these
tools in the main session only:

- `list_status` is read-only and safe for inspection.
- If the user explicitly asks to queue, add, backlog, or list work, call
  `list_add` with the requested items. Do not turn a direct queue request
  into an unnecessary interview.
- If you discover a useful follow-up while doing other work, finish the
  current request and offer to queue it first. Queue it without another
  question only when the user has given standing permission such as
  “queue follow-ups as you find them.”
- If one durable, multi-hour objective is warranted, `propose_goal_draft`
  works only while a drafting session is already open (the user ran bare
  `/goal`, `/list`, or `/list add` with no args): interview only what is
  genuinely unknown, then propose; the user's Confirm dialog is the
  activation gate. Ask supervised vs run-to-done in the interview; pass
  `runToDone: true` only on an explicit user choice (it auto-resumes
  sessions and auto-defaults decisions until complete or a hard stop). From normal chat with no draft open, do NOT call
  `propose_goal_draft` — it refuses outside drafting mode. Ask the user to
  open drafting with bare `/goal`, or use `list_add` for straight queueing.
  Never activate a speculative raw seed.
  (Unless Auto-accept drafts is on in /glla settings, which skips the
  Confirm — never promise a dialog that setting suppresses.)
- Never call `list_activate` for an item the user has not selected or clearly
  authorized. Never control `/loop` bounds, metrics, or stopping on the
  user's behalf.

## Pasted list-like input

When the user supplies an explicitly structured list (marked items or
independent contracted records) and asks to use or add it, use the structure
and wording as supplied. Line wrapping alone does not make prose a list:
keep a paragraph as one item unless the user asks to split it or clarification
establishes independent tasks.
Strip only import syntax and empty headings/lines, then pass the resulting
items in one `list_add` call. Do **not** ask whether the user wants the list
“exact” or “refined”; there is no such choice. Clarify only a genuinely
ambiguous individual item, never turn a complete pasted list into a
meta-choice.

If a `/list` drafting session is already active, do not bypass its Confirm
gate with `list_add`: pass the complete pasted set once as `items[]` to
`propose_goal_draft` instead. This keeps one confirmation for the whole
batch and prevents partial activation.

Use the tools, not slash-command text, when acting. Worker and subagent
sessions do not own GLLA state; respect a foreign-session refusal instead of
routing around it.
