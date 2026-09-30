// pi-goal-list-loop-audit — v0.38.104 full-audit follow-ups.
// tests/audit-followup-contract.test.ts
//
// The smaller defects this pass fixed alongside the two uncapped treadmills in
// tests/audit-unsettled-treadmill-cap.test.ts. Each pin below fails against the
// pre-fix source:
//
//   1. validateTaskProposal rejects a blank SUBTASK title. buildTaskList wrote
//      `s.trim()` unguarded, so one stray newline in a proposed subtask array
//      persisted a goal file that the published schema rejects
//      (`title: minLength: 1`) — and no surface reported it at write time.
//   2. countLiveDisapprovals agrees with liveDisapproval on a legacy history
//      that a later approval settled. /goal timeline counted with a raw
//      `superseded !== true` filter and told the user to re-submit work the
//      runtime had already accepted.
//   3. The published schema describes what the runtime actually persists: the
//      five PendingCompletion fields the terminal render writes, and the Task
//      deferral stamp, are typed — and `wallDeadlineAt`, which no GLLA code
//      has ever written, is gone rather than promising a field that never
//      appears.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

import { validateTaskProposal, countLiveDisapprovals, liveDisapproval, type AuditVerdict } from "../extensions/goal-loop-core.js";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas/goal.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

function goalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "20260929000000-abc123",
    objective: "Ship the bounded cap",
    status: "active",
    policy: "goal",
    autoContinue: false,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("blank subtask titles never reach persistence", () => {
  test("a blank subtask is rejected with its position named", () => {
    const error = validateTaskProposal([{ title: "Real task", subtasks: ["ok", "   ", ""] }]);
    assert.ok(error, "a blank subtask must be refused, not persisted");
    assert.match(error, /empty subtask at position 2/, `error=${error}`);
  });

  test("a blank top-level title is still refused", () => {
    assert.ok(validateTaskProposal([{ title: "   " }]), "the top-level check is unchanged");
  });

  test("a well-formed proposal with subtasks still passes", () => {
    assert.equal(validateTaskProposal([{ title: "Real task", subtasks: ["ok", "also ok"] }]), null);
  });

  test("the count cap is still enforced (the new check does not mask it)", () => {
    const error = validateTaskProposal([{ title: "Real task", subtasks: ["a", "b", "c", "d", "e", "f"] }]);
    assert.ok(error && /max 5/.test(error), `expected the count cap, got ${error}`);
  });
});

describe("live-objection counting agrees with the runtime", () => {
  const legacyRound = (over: Partial<AuditVerdict>): AuditVerdict => ({
    at: "2026-09-29T00:00:00.000Z",
    approved: false,
    disapproved: true,
    model: "anthropic/mock-model",
    ...over,
  });

  test("a legacy disapproval settled by a later approval is not live", () => {
    // No `superseded` flags anywhere: this history predates v0.38.21 pinning.
    const history: AuditVerdict[] = [
      legacyRound({ at: "2026-09-29T00:01:00.000Z" }),
      legacyRound({ at: "2026-09-29T00:02:00.000Z" }),
      { ...legacyRound({ at: "2026-09-29T00:03:00.000Z" }), approved: true, disapproved: false },
    ];
    assert.equal(liveDisapproval(history), undefined, "the runtime considers the set settled");
    assert.equal(countLiveDisapprovals(history), 0, "the count must agree with the runtime, not a raw filter");
  });

  test("a genuinely live objection is still counted", () => {
    const history: AuditVerdict[] = [
      legacyRound({ at: "2026-09-29T00:01:00.000Z" }),
      legacyRound({ at: "2026-09-29T00:02:00.000Z" }),
    ];
    assert.ok(liveDisapproval(history), "the newest disapproval is live");
    // A newer disapproval SUPERSEDES the older one: their objections are
    // settled context, not live targets. So the live set is the newest round,
    // not every unflagged row — which is exactly the second place a raw
    // `superseded !== true` filter disagrees with the runtime.
    assert.equal(countLiveDisapprovals(history), 1, "only the newest round is live");
  });

  test("an already-pinned history is counted the same way", () => {
    const history: AuditVerdict[] = [
      legacyRound({ at: "2026-09-29T00:01:00.000Z", superseded: true, supersededBy: "disapproval:2026-09-29T00:02:00.000Z" }),
      legacyRound({ at: "2026-09-29T00:02:00.000Z" }),
    ];
    assert.equal(countLiveDisapprovals(history), 1);
  });
});

describe("the published schema matches what the runtime persists", () => {
  test("the five terminal-render fields on a completion claim are accepted", () => {
    const goal = goalFixture({
      pendingCompletion: {
        at: "2026-09-29T00:00:00.000Z",
        leftOut: ["skipped the migration"],
        showVerification: true,
        gateRows: [{ gate: "tsc", command: "npx tsc --noEmit", scope: "repo", notes: "clean" }],
        findingGroups: [{ title: "Caps", findings: ["the shield branch is uncapped"], tests: ["8/8 pass"] }],
        timeoutEscalation: 3,
      },
    });
    assert.equal(validate(goal), true, JSON.stringify(validate.errors));
  });

  test("a task deferral stamp is accepted", () => {
    const goal = goalFixture({
      taskList: {
        version: 1,
        tasks: [{
          id: "1",
          title: "Real task",
          status: "pending",
          deferred: { reason: "needs a GPU", followUp: "rerun on the box", at: "2026-09-29T00:00:00.000Z" },
        }],
      },
    });
    assert.equal(validate(goal), true, JSON.stringify(validate.errors));
  });

  test("timeoutEscalation is bounded to [0, 100], matching the load clamp", () => {
    const claim = { at: "2026-09-29T00:00:00.000Z", timeoutEscalation: -1 };
    assert.equal(validate(goalFixture({ pendingCompletion: claim })), false, "a negative escalation is not a real state");
    assert.equal(validate(goalFixture({ pendingCompletion: { at: "2026-09-29T00:00:00.000Z", timeoutEscalation: 500 } })), false);
  });

  test("wallDeadlineAt is gone: no GLLA code has ever written it", () => {
    const defs = (schema as any).definitions.pendingCompletion.properties;
    assert.ok(!("wallDeadlineAt" in defs), "a promised field that never appears misleads every consumer");
  });

  test("the blank subtask the validator now blocks is exactly what the schema rejects", () => {
    const goal = goalFixture({
      taskList: { version: 1, tasks: [{ id: "1", title: "Real task", status: "pending", subtasks: [{ id: "1.1", title: "", status: "pending" }] }] },
    });
    assert.equal(validate(goal), false, "the schema and the validator must agree on the same rule");
  });
});
