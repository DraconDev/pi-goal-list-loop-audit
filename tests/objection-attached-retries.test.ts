// pi-goal-list-loop-audit — objection-attached retries.
//
// Antigravity port (survey 2026-09-19): a retry argues the objection, not
// generic effort. GLLA extracted auditor objections into durable pendingTasks
// (rendered as AUDITOR TODO LIST in every continuation) ONLY when
// aggressiveMode was on; default-settings disapproval retries carried the
// full report but no extracted objection list. Pins:
//   1. Objection extraction works on any disapproval report (bullets with
//      missing/failing/not-done language; pure-evidence bullets skipped).
//   2. A report with no extractable objections still yields one durable
//      TODO pointing at the disapproval (never an empty list).
//   3. Both disapproval sites (detached auditor hook + manual verify path)
//      attach objections unconditionally — the aggressive gate keeps only
//      the cap-keep-going / no-progress-stop behaviors, never the TODOs.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { durableObjectionsForDisapproval } from "../extensions/goal-loop-core.js";

test("objection-attached retries: objection bullets extracted", () => {
  const report = [
    "<disapproved/>",
    "- The migration is missing the index on users.email.",
    "- Unit Tests: all green.",
    "- The rollback plan is incomplete: no down-migration.",
  ].join("\n");
  const objections = durableObjectionsForDisapproval(report);
  assert.equal(objections.length, 2, JSON.stringify(objections));
  assert.match(objections[0]!, /missing the index/);
  assert.match(objections[1]!, /incomplete/);
});

test("objection-attached retries: no extractable objections still yields one TODO", () => {
  const objections = durableObjectionsForDisapproval("<disapproved/>\nAll checks pass but the claim is unverified.");
  assert.equal(objections.length, 1, "never an empty TODO list");
  assert.match(objections[0]!, /disapproval/i);
});

test("objection-attached retries: both disapproval sites attach unconditionally", () => {
  for (const file of ["extensions/loops/goal-auditor-hooks.ts", "extensions/loops/goal-tools.ts"]) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /durableObjectionsForDisapproval\(/, `${file} routes objections through the shared helper`);
  }
  const hook = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.doesNotMatch(
    hook,
    /durableObjections = result\.disapproved && aggressive/,
    "detached path no longer gates TODOs on aggressiveMode",
  );
  const tools = fs.readFileSync("extensions/loops/goal-tools.ts", "utf8");
  assert.doesNotMatch(
    tools,
    /durableObjections = result\.disapproved && effectiveCap\.aggressiveMode/,
    "manual path no longer gates TODOs on aggressiveMode",
  );
});
