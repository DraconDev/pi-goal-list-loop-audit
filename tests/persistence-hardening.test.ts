// pi-goal-list-loop-audit — v0.28.6
// tests/persistence-hardening.test.ts
//
// Pins the v0.28.6 persistence-integrity hardening (audit findings E1 + T6 —
// audit/WRONG-OR-NOT-PREMIUM-2026-07-28.md Stream 2):
//   E1  a disk failure (ENOSPC/EACCES/wedged mount) used to THROW out of
//       appendLedger/writeGoalMd/archiveCurrentGoal mid-handler — killing
//       the orchestrator turn and silently diverging RAM from disk. Now
//       every persistence step runs through runPersistStep: failures latch
//       a session-wide degraded flag (loud first-failure notify + TUI flag),
//       RAM stays authoritative, the next successful write self-heals.
//   T6  schema drift — the goal schema and the Goal interface must not
//       diverge; plus readState corruption tolerance (a truncated trailing
//       active.jsonl line from a mid-write kill must not lose state).
//
// Includes REAL filesystem failure injection (not just source pins).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  appendLedger,
  writeGoalMd,
  readState,
  goalMdPath,
  isSafePersistedId,
  isPersistenceDegraded,
  lastPersistenceFailure,
  goalStateTransactionPath,
  writeGoalStateTransaction,
  MAX_AUDITOR_CANDIDATE_REFS,
} from "../extensions/goal-loop-core.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
const GOAL = readGoalRuntimeSource();
const DISPLAY = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
const SCHEMA = fs.readFileSync("schemas/goal.schema.json", "utf-8");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-persist-"));
}

/** A cwd whose .pi-glla path is a FILE — every mkdir/append under it fails. */
function brokenCwd(): string {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".pi-glla"), "not a directory");
  return dir;
}

test("readState: a truncated trailing active.jsonl line loads cleanly (mid-write kill)", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const good1 = JSON.stringify({ type: "state", value: { goal: null, list: [] }, at: "2026-07-28T10:00:00Z" });
  const good2 = JSON.stringify({ type: "state", value: { goal: { id: "g-good", status: "active" }, list: [] }, at: "2026-07-28T10:01:00Z" });
  const truncated = '{"type":"state","value":{"goal":{"id":"g-torn"'; // mid-write kill
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), good1 + "\n" + good2 + "\n" + truncated + "\n");
  const s = readState(cwd);
  assert.equal((s.goal as { id: string } | null)?.id, "g-good", "torn tail skipped, last good state wins");
  assert.deepEqual(s.list, []);
});

test("large JSONL records do not break forward or reverse ledger scans", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const stateLine = JSON.stringify({
    type: "state",
    value: { goal: { id: "g-chunk", objective: "chunk boundary", status: "active", policy: "goal" }, list: [] },
    at: "2026-07-28T10:01:00.000Z",
  });
  const largeEvent = JSON.stringify({ type: "telemetry", value: "x".repeat(70 * 1024), at: "2026-07-28T10:00:00.000Z" });
  const truncated = '{"type":"state","value":{"goal":{"id":"g-torn"';
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), `${largeEvent}\n${stateLine}\n${truncated}`);

  assert.equal(readState(cwd).goal?.id, "g-chunk", "forward scanning handles a record spanning read chunks");
  assert.equal(writeGoalStateTransaction(cwd, { goal: null, list: [] } as never), true);
  const transaction = JSON.parse(fs.readFileSync(goalStateTransactionPath(cwd), "utf8")) as { baseStateLineHash?: string };
  assert.equal(
    transaction.baseStateLineHash,
    createHash("sha256").update(stateLine, "utf8").digest("hex"),
    "reverse scanning skips a torn tail and fingerprints the latest valid state line",
  );
});

test("readState normalizes and bounds the detached-auditor recovery cursor", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const longRef = "x".repeat(500);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), JSON.stringify({
    type: "state",
    value: {
      goal: {
        id: "g-cursor",
        objective: "cursor recovery",
        status: "paused",
        policy: "goal",
        pendingCompletion: {
          phase: "quota-waiting",
          at: "2026-07-28T10:00:00.000Z",
          completionSummary: "claim",
          quotaAttempts: 7,
          auditorCandidateRefs: ["test/primary", "TEST/PRIMARY", ...Array.from({ length: 20 }, (_, i) => `test/fallback-${i}`)],
          auditorCandidateRef: longRef,
          auditorRetryCandidateRef: "test/primary",
          auditorRetryAttemptStartedAt: "2026-07-28T10:00:30.000Z",
          auditorAttemptedRefs: ["test/primary", "TEST/PRIMARY", "test/fallback-1"],
          auditorFailureCount: 99,
          auditorFailureClass: "not-a-class",
          auditorFallbackExhausted: true,
          auditorFailureAt: "not-a-date",
        },
      },
      list: [],
    },
    at: "2026-07-28T10:01:00.000Z",
  }) + "\n");

  const pending = readState(cwd).goal?.pendingCompletion;
  assert.equal(pending?.phase, "retry-waiting", "legacy quota-waiting is canonicalized");
  assert.equal(pending?.retryAttempts, 7, "legacy quota attempts remain readable under the generic name");
  assert.deepEqual(pending?.auditorCandidateRefs?.slice(0, 2), ["test/primary", "test/fallback-0"], "candidate refs are deduplicated case-insensitively");
  assert.equal(pending?.auditorCandidateRefs?.length, MAX_AUDITOR_CANDIDATE_REFS, "candidate refs preserve the complete bounded auditor chain");
  assert.equal(pending?.auditorCandidateRef?.length, 200, "candidate ref diagnostics are bounded");
  assert.equal(pending?.auditorRetryCandidateRef, "test/primary");
  assert.equal(pending?.auditorRetryAttemptStartedAt, "2026-07-28T10:00:30.000Z");
  assert.deepEqual(pending?.auditorAttemptedRefs, ["test/primary", "test/fallback-1"]);
  assert.equal(pending?.auditorFailureCount, 2, "failure cursor is clamped");
  assert.equal(pending?.auditorFailureClass, undefined, "unknown failure classes fail closed");
  assert.equal(pending?.auditorFallbackExhausted, true);
  assert.equal(pending?.auditorFailureAt, undefined, "invalid diagnostic timestamps are discarded");
  assert.equal((pending as any)?.quotaAttempts, undefined, "legacy quota key is not exposed to runtime policy");
});

test("readState recovers a transaction when the first state ledger line was never written", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goal-state.transaction.json"), JSON.stringify({
    schema: 1,
    at: "2026-07-28T09:59:00.000Z",
    state: { goal: { id: "g-first", objective: "first projection", status: "active", policy: "goal" }, list: [] },
  }));
  assert.equal(readState(cwd).goal?.id, "g-first", "the transaction is the only durable first projection");
});

test("goal transaction snapshot repairs a markdown-before-ledger crash", () => {
  const cwd = tmpdir();
  const oldAt = "2026-07-28T10:00:00.000Z";
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), JSON.stringify({
    type: "state",
    value: { goal: { id: "g-old", objective: "old", status: "active", policy: "goal" }, list: [] },
    at: oldAt,
  }) + "\n");
  const next = {
    goal: { id: "g-new", objective: "new", status: "paused", policy: "goal", autoContinue: true },
    list: [],
  } as never;
  assert.equal(writeGoalStateTransaction(cwd, next), true);
  assert.equal(fs.existsSync(goalStateTransactionPath(cwd)), true);
  assert.equal(readState(cwd).goal?.id, "g-new", "newer transaction wins when the state append was interrupted");
});

test("a committed state line wins over an orphaned older transaction", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goal-state.transaction.json"), JSON.stringify({
    schema: 1,
    at: "2026-07-28T10:00:00.000Z",
    state: { goal: { id: "g-old", objective: "old", status: "active", policy: "goal" }, list: [] },
  }));
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), JSON.stringify({
    type: "state",
    value: { goal: { id: "g-new", objective: "new", status: "active", policy: "goal" }, list: [] },
    at: "2026-07-28T10:01:00.000Z",
  }) + "\n");
  assert.equal(readState(cwd).goal?.id, "g-new", "a later state line is already committed");
});

test("same-millisecond transaction recovery uses the base-state fingerprint", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const at = "2026-07-28T10:02:00.000Z";
  const base = JSON.stringify({
    type: "state",
    value: { goal: { id: "g-base", objective: "base", status: "active", policy: "goal" }, list: [] },
    at,
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), `${base}\n`);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goal-state.transaction.json"), JSON.stringify({
    schema: 1,
    at,
    baseStateLineHash: createHash("sha256").update(base, "utf8").digest("hex"),
    state: { goal: { id: "g-transaction", objective: "transaction", status: "paused", policy: "goal" }, list: [] },
  }));
  assert.equal(readState(cwd).goal?.id, "g-transaction", "an interrupted transaction wins even when timestamps tie");

  const unrelated = JSON.stringify({
    type: "state",
    value: { goal: { id: "g-unrelated", objective: "unrelated", status: "active", policy: "goal" }, list: [] },
    at,
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), `${unrelated}\n`);
  assert.equal(readState(cwd).goal?.id, "g-unrelated", "a same-time unrelated state write is not rolled back by the orphan");
});

test("a newer transaction with a stale base fingerprint cannot roll back a later state line", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const later = JSON.stringify({
    type: "state",
    value: { goal: { id: "g-later", objective: "later", status: "active", policy: "goal" }, list: [] },
    at: "2026-07-28T10:01:00.000Z",
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), `${later}\n`);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "goal-state.transaction.json"), JSON.stringify({
    schema: 1,
    at: "2026-07-28T10:02:00.000Z",
    baseStateLineHash: createHash("sha256").update("an unrelated prior line", "utf8").digest("hex"),
    state: { goal: { id: "g-stale", objective: "stale", status: "paused", policy: "goal" }, list: [] },
  }));
  assert.equal(readState(cwd).goal?.id, "g-later", "a stale hashed transaction cannot resurrect an older snapshot");
});

test("invalid pending-audit phases are dropped to legacy recovery semantics", () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), JSON.stringify({
    type: "state",
    value: {
      goal: {
        id: "g-phase",
        status: "paused",
        policy: "goal",
        pendingCompletion: { at: "2026-07-28T10:00:00.000Z", phase: "garbage-phase" },
      },
      list: [],
    },
    at: "2026-07-28T10:01:00.000Z",
  }) + "\n");
  assert.equal(readState(cwd).goal?.pendingCompletion?.phase, undefined);
});

test("persisted ids are validated before state or filesystem use", () => {
  const cwd = tmpdir();
  assert.equal(isSafePersistedId("20260821075653-wvz7l4"), true);
  assert.equal(isSafePersistedId("../../outside"), false);
  const safeRoot = path.resolve(cwd, ".pi-glla", "goals");
  const invalidPath = path.resolve(goalMdPath(cwd, "../../outside"));
  assert.ok(invalidPath.startsWith(`${safeRoot}${path.sep}`), "invalid ids stay below .pi-glla/goals");

  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), JSON.stringify({
    type: "state",
    value: { goal: { id: "../../outside", objective: "untrusted", status: "active", policy: "goal" }, list: [] },
  }) + "\\n");
  assert.equal(readState(cwd).goal, null, "invalid persisted goal ids are not hydrated");
});

test("E1: disk failure latches the degraded flag, never throws; a landing write self-heals", () => {
  const bad = brokenCwd();
  assert.doesNotThrow(() => appendLedger(bad, "state", { goal: null, list: [] }));
  assert.equal(isPersistenceDegraded(), true, "failure latched");
  assert.equal(lastPersistenceFailure()?.what, "appendLedger");

  // writeGoalMd also guarded — and still returns the intended path:
  const file = writeGoalMd(bad, { id: "g1", objective: "x", status: "active", policy: "goal", autoContinue: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 }, createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T10:00:00Z" } as never);
  assert.ok(file.endsWith(path.join(".pi-glla", "goals", "g1.md")), "intended path returned even on failure");
  assert.equal(isPersistenceDegraded(), true);

  // self-heal: a write to a HEALTHY cwd lands → flag clears:
  const good = tmpdir();
  appendLedger(good, "state", { goal: null, list: [] });
  assert.equal(isPersistenceDegraded(), false, "a landing write clears the flag");
  assert.equal(lastPersistenceFailure(), null);
});

test("E1: all four persistence entry points run through runPersistStep", () => {
  assert.match(CORE, /export function runPersistStep<T>\(what: string, fn: \(\) => T\): T \| undefined/);
  assert.match(CORE, /runPersistStep\("appendLedger", \(\) => \{/);
  assert.match(CORE, /runPersistStep\("writeGoalMd", \(\) => \{/);
  assert.match(CORE, /runPersistStep\("readState", \(\) => /);
  assert.match(GOAL, /runPersistStep\("archiveCurrentGoal", \(\) => \{/);
});

test("E1: archive removes the active md ONLY when the archive landed", () => {
  assert.match(GOAL, /const archived = runPersistStep\("archiveCurrentGoal"[\s\S]*?\) === true;/);
  assert.match(GOAL, /writeArchiveIntent\(ctx\.cwd, \{/);
  assert.match(GOAL, /updateArchiveIntentPhase\(ctx\.cwd, "published"\)/);
  assert.match(GOAL, /updateArchiveIntentPhase\(ctx\.cwd, "state-persisted"\)/);
  assert.match(GOAL, /finalizeArchiveIntent\(ctx\.cwd, goal\.id\)/);
  const statePersisted = GOAL.indexOf("const terminalStateLanded = persistState(ctx);");
  const finalized = GOAL.indexOf("finalizeArchiveIntent(ctx.cwd, goal.id)");
  assert.ok(statePersisted >= 0 && finalized > statePersisted, "active markdown cleanup follows terminal state persistence");
  assert.doesNotMatch(GOAL.slice(0, statePersisted), /fs\.unlinkSync\(goalMdPath/, "archive publication must not remove active markdown early");
});

test("E1: archive destination is exclusive and cannot clobber a winner", () => {
  assert.match(GOAL, /if \(fs\.existsSync\(target\)\) \{[\s\S]*?archiveFence = true/);
  assert.match(GOAL, /fs\.writeFileSync\(temp, richMd, \{ encoding: "utf-8", flag: "wx" \}\)/);
  assert.match(GOAL, /buildRichArchiveSection\(terminalGoal, status, archivePath, opts\?\.findingGroups\)/, "archive carries the rich human layer over the machine record");
  assert.match(GOAL, /fs\.linkSync\(temp, target\)/);
  assert.doesNotMatch(GOAL, /fs\.writeFileSync\(target, (md|richMd)\)/, "archive writes must not replace an existing same-id record");
});

test("E1: loud first-failure notify + recovery notify at the persistState choke point", () => {
  assert.match(GOAL, /notifyPersistenceState\(ctx\); \/\/ v0\.28\.6 \(E1\): loud on the first failure/);
  assert.match(GOAL, /if \(isPersistenceDegraded\(\) && !persistenceDegradedNotified\) \{/);
  assert.match(GOAL, /⚠ Persistence degraded: \$\{err\?.what/);
  assert.match(GOAL, /Persistence recovered — \.pi-glla writes are landing again\./);
});

test("E1: TUI persistence-degraded flag (first widget line, until a write lands)", () => {
  assert.match(DISPLAY, /import \{ [^}]*isPersistenceDegraded, lastPersistenceFailure[^}]* \} from "\.\/goal-loop-core\.js";/);
  assert.match(DISPLAY, /if \((?:withAgents|inner) && isPersistenceDegraded\(\)\) \{/);
  assert.match(DISPLAY, /⚠ persistence degraded — \.pi-glla writes failing/);
});

test("T6: schema does not drift from the Goal interface", () => {
  const schema = JSON.parse(SCHEMA);
  const ifaceStart = CORE.indexOf("export interface Goal");
  const ifaceEnd = CORE.indexOf("\n}", ifaceStart);
  const iface = CORE.slice(ifaceStart, ifaceEnd);
  for (const key of Object.keys(schema.properties)) {
    assert.ok(iface.includes(key), `schema property "${key}" missing from the Goal interface`);
  }
  // The original check only caught schema additions. Also walk the persisted
  // top-level interface fields and the nested audit verdict so a new runtime
  // field cannot silently disappear from the published contract.
  const goalFields = [...iface.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]!);
  for (const key of goalFields) {
    assert.ok(schema.properties[key], `Goal interface field "${key}" missing from the schema`);
  }
  const verdictStart = CORE.indexOf("export interface AuditVerdict");
  const verdictEnd = CORE.indexOf("\n}", verdictStart);
  const verdict = CORE.slice(verdictStart, verdictEnd);
  const verdictSchema = schema.definitions.auditVerdict.properties;
  const verdictFields = [...verdict.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]!);
  for (const key of verdictFields) {
    assert.ok(verdictSchema[key], `AuditVerdict field "${key}" missing from the schema`);
  }
});
