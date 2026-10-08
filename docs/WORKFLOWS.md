# Put GLLA to work

Choose a finish line before choosing an automation mode. A useful contract says
what must be true, how it can be checked and what is outside scope. It should
not just say “improve quality” or prescribe every implementation step.

## Fix or ship one thing

```text
/goal plan Make failed login attempts understandable without revealing account existence
```

Use drafting to establish scope and checks. Ask for regression coverage and
observable behavior, not an assertion that the agent “looked carefully.”
When the agent submits completion, the detached auditor can inspect that evidence.
A rejected claim is further work, not a completed task.

For a known problem, a direct contract is useful:

```text
/goal Fix duplicate cache invalidation. Done when: a test reproduces duplicate invalidation; the fix prevents it; relevant tests pass; unrelated cache behavior remains unchanged.
```

## Audit a repository once

```text
/goal audit authentication and session handling
```

This starts a repository audit objective. It is distinct from `/goal verify`,
which asks the completion auditor to inspect the current goal.

A useful audit records real findings, fixes defects within the agreed scope,
and raises genuine product trade-offs instead of quietly choosing extra work.
Do not interpret “audit approved” as a security certification or a claim that
the whole repository is defect-free.

For repeated passes, use `/loop audit`; set limits and inspect its findings
rather than assuming more iterations always mean more value.

## Process several independent outcomes

Write a plan file with one auditable outcome per item:

```text
- Fix cache invalidation. Done when: regression tests pass.
- Explain installation and recovery. Done when: examples match current commands.
- Reduce startup regressions. Done when: existing behavior is covered by tests.
```

Then:

```text
/list import plan.md
/list show
```

Confirm the batch. Each item is worked and audited separately. The pool is not
a dependency scheduler: if order matters, make prerequisites explicit and
inspect the queue before choosing another item with `/list next <n>`.

## Build a project from intended capabilities

```text
/loop respec Build the missing capabilities in SPEC.md and prove them
```

Write the specification as observable capabilities. Keep binding constraints in
`## Rules`; distinguish desired behavior from what the repository already does.
Review the proposed requirements and acceptance criteria before adopting them.

The builder implements batches, claims them and submits them for verification.
Implemented is not verified. A failed test belongs to ongoing work; an external
blocker should name who can remove it, the exact action and expected evidence.
Use `/loop status` to inspect coverage and `/loop blockers` for recorded obstacles.
Scope revisions through `/loop refine ...` require confirmation when adopted
requirements change.

## Run an improvement process

Start with `/loop` when an honest numeric measure exists. Good candidates are
repeatable counts, sizes or timings with a stable measurement method. A falling
number is only useful if it represents the outcome: deleting tests to reduce
failures is not improvement.

If no honest metric exists, use a bounded metricless process:

```text
/loop start "improve the onboarding checklist" measure=none max=10 cadence=900
```

It has no metric plateau. Bounds or `/loop stop` end it; stopping does not prove
that every possible improvement was made. For adopted requirements with a real
completion gate, use respec instead.

## Before leaving a run unattended

- Confirm scope, permissions and what evidence counts as done.
- Configure models, fallback chains, notifications and retry limits deliberately.
- Set loop bounds and check whether auto-resume is intended.
- Avoid competing supervisors in the same session.
- Keep destructive/external actions behind the permissions you actually granted.
- Remember that auditing and recovery also consume model calls.

Inspect `/glla status` on return. A spinner is not proof of progress, a pause is
not completion, and a completion claim is not approval.

## When a result looks wrong

Check the archived contract and evidence—not just the final message. Explain
which observed behavior violates which acceptance criterion. Start a new fix
goal for an already archived result; use resume for eligible unfinished work.
Capture GLLA lifecycle problems with `/glla bug` and consult
[RECOVERY.md](RECOVERY.md). Do not delete state to make a warning disappear.
