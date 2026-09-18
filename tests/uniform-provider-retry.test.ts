// pi-goal-list-loop-audit — generic provider retry policy.
// Error wording is diagnostic only. It does not choose a cadence, fallback
// gate, manual hold, or hourly slot.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { mainModelFailureDelayMs, classifyMainModelFailure } from "../extensions/main-model-recovery.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const RECOVERY = fs.readFileSync("extensions/main-model-recovery.ts", "utf-8");
const DISPLAY = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");

test("the first provider retry is eager for every failure family", () => {
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  for (const raw of [
    "429 usage limit",
    "Token Plan rate limit reached",
    "insufficient credits",
    "401 invalid API key",
    "503 temporarily unavailable",
    "weird provider prose, no hint",
  ]) {
    assert.equal(mainModelFailureDelayMs(classifyMainModelFailure(raw), 1, 15, nowMs), 5_000, raw);
  }
});

test("later provider retries use one bounded configured ladder", () => {
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  for (const raw of ["429 retry in 4 hours", "billing required", "503 unavailable", "unknown failure"]) {
    assert.equal(mainModelFailureDelayMs(classifyMainModelFailure(raw), 2, 15, nowMs), 30 * 60_000, raw);
  }
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 unavailable"), 2, 45, nowMs), 90 * 60_000);
});

test("main-model recovery has no quota-derived policy branch", () => {
  assert.match(RECOVERY, /One uniform envelope for EVERY provider failure/);
  assert.doesNotMatch(RECOVERY, /Retry-After.*(?:honor|wins|outrank)/i);
  assert.doesNotMatch(RECOVERY, /allowRateLimit|isLongLivedFailureKind|SEND_REARM_QUOTA/);
  assert.doesNotMatch(SRC, /mainModelFallbackOnRateLimit|quotaRetryMinutes|failure\.kind === "quota"/);
});

test("the auditor durable plan is generic and keeps safe diagnostic copy", () => {
  assert.doesNotMatch(SRC, /isQuotaError|parseQuotaError|quota\.signal/);
  // The retry-wait pause keeps the exhausted-chain diagnostic ahead of the
  // failure display (auditor 22:39: parked state names the chain).
  assert.match(SRC, /auditor retry: \$\{exhaustedNotice\}\$\{failureCopy\.display\}/);
  assert.match(SRC, /uniform schedule/);
  assert.match(SRC, /auditor_retry_capped/);
  assert.doesNotMatch(SRC, /quota_retry_capped|Auditor still quota-limited|Quota auto-retry in/);
});

test("display surfaces identify generic recovery, not a guessed quota state", () => {
  assert.doesNotMatch(DISPLAY, /quotaSignal|parked on provider wall|waiting for quota reset/);
  assert.match(DISPLAY, /main-model recovery — retrying automatically/);
});
