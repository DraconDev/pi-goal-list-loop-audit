import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MockPi, makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import { classifyMainModelFailure } from "../extensions/main-model-recovery.js";
import {
  __testOnlySetPressureTimeout,
  claimPressureAttempt,
  clearPressureAttempt,
  flushPressureAttempt,
  settlePressureAttempt,
} from "../extensions/context-pressure-attempt.js";

afterEach(() => { __testOnlySetPressureTimeout(undefined); });

function attemptSpies() {
  const events: string[] = [];
  let fallbacks = 0;
  return {
    events,
    options: {
      failure: classifyMainModelFailure("provider failed"),
      valid: () => true,
      fallback: () => { fallbacks++; },
      record: (e: string) => { events.push(e); },
      timeout: () => false,
      fallbacks: () => fallbacks,
    },
  };
}

test("success after the terminal hold is recorded distinctly, not silently swallowed", async () => {
  __testOnlySetPressureTimeout(40);
  const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: "late-success" } });
  ctx.isIdle = () => true;
  ctx.compact = () => {};
  const spies = attemptSpies();
  assert.equal(claimPressureAttempt(ctx, spies.options), true);
  assert.equal(flushPressureAttempt(ctx, { compactionInFlight: false }), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(settlePressureAttempt(ctx, "success"), true, "the late success is still consumed as owned");
  assert.ok(spies.events.includes("late-success"), `attempt transcript marks it late: ${spies.events.join(",")}`);
  clearPressureAttempt(ctx);
});

test("liveness clear keeps the durable budget; only an explicit reset spends it", () => {
  for (const reset of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-budget-"));
    const file = path.join(dir, "context-pressure-budget.json");
    const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: `budget-${reset}` } });
    const spies = attemptSpies();
    assert.equal(
      claimPressureAttempt(ctx, { ...spies.options, budget: { file, key: "goal:test" } }),
      true,
    );
    assert.ok(fs.existsSync(file), "the claim lands a durable budget file");
    if (reset) clearPressureAttempt(ctx, true);
    else clearPressureAttempt(ctx);
    assert.equal(fs.existsSync(file), reset, reset ? "explicit reset spends the budget" : "liveness clear keeps it for the healthy turn");
  }
});
