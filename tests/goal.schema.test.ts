// Published goal contract tests. These validate real fixtures against
// schemas/goal.schema.json itself; they do not maintain a second hand-written
// Goal shape that can drift from the shipped artifact.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas/goal.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const validate: ValidateFunction = new Ajv({ allErrors: true, strict: false }).compile(schema);

function goalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "20260923000000-abc123",
    objective: "Ship the audited contract",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 1000 },
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function errors(value: unknown): string {
  return validate.errors?.map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ") ?? "unknown validation error";
}

test("schema accepts active goal and queued-list goal fixtures", () => {
  assert.equal(validate(goalFixture()), true, errors(goalFixture()));
  assert.equal(validate(goalFixture({ policy: "list", parentId: "parent-1" })), true);
});

test("schema rejects invalid status and missing required usage", () => {
  const badStatus = goalFixture({ status: "BOGUS" });
  assert.equal(validate(badStatus), false);
  assert.match(errors(badStatus), /status/);
  const missingUsage = goalFixture();
  delete missingUsage.usage;
  assert.equal(validate(missingUsage), false);
  assert.match(errors(missingUsage), /usage/);
});

test("schema validates nested task and audit-verdict required fields", () => {
  const valid = goalFixture({
    taskList: {
      version: 1,
      tasks: [{
        id: "1",
        title: "Verify the gate",
        status: "pending",
        verificationContract: "timeout 120 bun test tests/focus.test.ts",
        subtasks: [{ id: "1.1", title: "Inspect output", status: "in_progress" }],
      }],
    },
    auditHistory: [{
      at: "2026-09-23T00:01:00.000Z",
      approved: true,
      disapproved: false,
      model: "test/auditor",
    }],
  });
  assert.equal(validate(valid), true, errors(valid));

  const missingTaskTitle = structuredClone(valid) as {
    taskList: { tasks: Array<{ title?: string }> };
  };
  delete missingTaskTitle.taskList.tasks[0]!.title;
  assert.equal(validate(missingTaskTitle), false);
  assert.match(errors(missingTaskTitle), /title/);
});
