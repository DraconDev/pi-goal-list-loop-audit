# The audit lane's own failure class, read from the text

**Trigger.** Operator report: projects were "struggling with their final audit".
The shipped package (npm `latest` = 0.39.65) turned out to hold a
reproducible final-audit dead end, and the unreleased tree that fixes it
turned out to carry a second, quieter problem in the same lane.

Shipped in **v0.39.68**.

## What was wrong, part 1 — the shipped version had a dead end

`tests/pre-audit-compaction.test.ts` →
*"a reload during the admission wait still launches the stored audit when
recovery consent exists"*.

| tree | result |
| --- | --- |
| v0.39.65 (npm `latest`) | **FAIL** |
| v0.39.66 / v0.39.67 (unreleased) | **PASS** |

Mechanism: the automatic parked-claim recovery only runs when the goal is
`paused`, but the dispatch gate required `status === "auditing"` for every
non-manual origin. The one automatic retry hit a gate it could never pass,
so the claim stayed parked at `completion audit: parked — no review recorded`
with `next: /list resume starts a fresh auditor` and the rest of the list
frozen behind it. v0.39.66 lets the owning automatic recovery discharge its
own admission debt, and adds per-cause park copy.

## What was wrong, part 2 — the class and the text disagreed

The audit lane already records a **typed** class for every auditor failure
(`auditorResultFailureClass`, `extensions/goal-loop-auditor-process.ts`):

```
no-verdict | timeout | transport | provider | context-exhausted
```

It is persisted on the claim (`auditorFailureClass`) and already decides the
resume policy. The **lane** decisions re-parsed the raw text instead — and
v0.39.67 widened that text test to admit unclassified failures ("in fact all
errors"), so the two started to disagree:

```
"Error: worker exited with code 1"   →  class: no-verdict   (the auditor's own failure)
                                      →  text test: "recoverable provider"
```

The consequence was that the audit lane's whole bound machinery was switched
off **for the failures it was built for**:

| bound | fires when | unclassified crash under v0.39.67 |
| --- | --- | --- |
| three-identical-failure slowdown marker | `!plan.unbounded` | **never** |
| 24h dispatch horizon | diagnostic is not provider-recoverable | **never** |
| one-shot automatic-recovery marker | diagnostic is not provider-recoverable | **bypassed** |
| retry cadence | provider-recoverable → 5 min | **5 min, forever** |

So an auditor that kept dying with its own crash text moved onto the
provider lane's unbounded five-minute cadence: a fresh detached auditor
every five minutes, forever, with no slowdown marker and no horizon. The
v0.39.67 changelog says the no-verdict failures "have their own retry plan
and would otherwise be replaced by main-model recovery" — the intent was
right; the implementation protected only the exact `AUDITOR_NO_VERDICT`
vocabulary, not the class it means.

## The fix

`extensions/auditor-lane.ts` (new leaf module) decides the lane from the
recorded class first:

- `no-verdict` and `context-exhausted` are failures a retry cannot fix → the
  claim keeps the auditor's own bounded lane (eager first attempt, hourly
  probe, three-identical-failure slowdown marker, 24h horizon, one-shot);
- everything else keeps v0.39.67's widened text test, so a real provider
  wall — including an unparseable one like `provider returned 503` — still
  retries with durable authority at the five-minute cadence;
- a claim with **no** recorded class (parked before the class existed) falls
  back to the text test, so no legacy claim silently changes lane.

The retry plan now reads the class of the failure it is planning for, not the
class the claim carried from the previous failure — the lane decision and the
recorded class must agree.

## Evidence

Before/after on the same inputs (`auditorRetryPlan`, the function that owns
the cadence and the horizon):

| failure text | class | v0.39.65 | v0.39.67 | v0.39.68 |
| --- | --- | --- | --- | --- |
| `Error: worker exited with code 1` | `no-verdict` | 5s → hourly, bounded | **5 min, unbounded** | 5s → hourly, bounded |
| `auditor produced no verdict marker` | `no-verdict` | 5s → hourly, bounded | 5s → hourly, bounded | unchanged |
| `429 rate limit exceeded` | `provider` | 5 min, unbounded | 5 min, unbounded | unchanged |
| `provider returned 503` | `provider` | 5s → hourly, bounded | 5 min, unbounded | unchanged |

Regression coverage (`tests/auditor-lane.test.ts`, 8 tests): 4 of them fail
on the pre-fix tree (`v0.39.67`) and pass on the fixed tree — the A/B is in
the test file's own assertions, not in prose.

```text
bun test tests/auditor-lane.test.ts              →  8 pass / 0 fail (new)
bun test tests/pre-audit-compaction.test.ts       → 14 pass / 0 fail
bun test tests/auditor-eager-retry.test.ts        → pass
bun test tests/persistent-provider-recovery.test.ts → pass
bun test tests/auditor-ladder-discipline.test.ts  → pass
bun test tests/completion-audit-park.test.ts      → pass
bun test tests/hourly-auditor-backstop.test.ts    → pass
bun test tests/infrastructure-retry.test.ts       → pass
bun test tests/auditor-error-paths.test.ts        → pass
   (93 pass / 0 fail across those 8 files)
bun test tests/behavioral-orchestrator.test.ts     → 159 pass / 0 fail
bun test tests/auditor-resume.test.ts             → pass
bun test tests/audit-unsettled-treadmill-cap.test.ts → pass
bun test tests/completed-audit-recovery.test.ts   → pass
bun test tests/pending-claim-lifecycle.test.ts    → pass
bun test tests/recovery-lifecycle-regression.test.ts → pass
bun test tests/retry-bounds.test.ts               → pass
bun test tests/audit-recovery-persistence.test.ts → pass
   (309 pass / 0 fail across those 8 files)
tsc --noEmit                                     → clean
```

## Not changed

- The provider lane is untouched: a named wall (quota, concurrency,
  transport, auth) still retries every five minutes, unbounded, with durable
  authority.
- The auditor's own ladder is untouched apart from who owns it: the eager
  first attempt, the hourly probe, the three-identical-failure slowdown
  marker and the 24h horizon behave exactly as before.
- A claim with no recorded class keeps today's behaviour.

## Release note

`v0.39.66` and `v0.39.67` were tagged but **never published to npm** — the
publish job only runs on a published GitHub Release, and no Release was
created for those tags. They ship inside **v0.39.68**, which is the first
version of this tree that reaches the registry.
