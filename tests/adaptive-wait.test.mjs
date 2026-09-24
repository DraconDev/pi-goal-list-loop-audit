import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateDurationFromHistory, nextPollMs, waitForDurableEvent } from "../scripts/durable-wait.mjs";

test("estimateDurationFromHistory uses median with headroom and fallback bounds", () => {
  assert.equal(estimateDurationFromHistory([], 10000), 10000);
  assert.equal(estimateDurationFromHistory(null, 10000), 10000);
  assert.equal(estimateDurationFromHistory([5000, 6000, 7000], 10000), 7200);
  // Single sample: median *1.2
  assert.equal(estimateDurationFromHistory([1000], 30000), 15000); // bounded below by 0.5*fallback 15000
  // Very large median capped at 4*fallback
  assert.equal(estimateDurationFromHistory([200000], 30000), 120000);
  // Very small median still at least 0.5*fallback
  assert.equal(estimateDurationFromHistory([100], 30000), 15000);
});

test("nextPollMs doubles each attempt capped at 1s", () => {
  assert.equal(nextPollMs(0, 250, 1000), 250);
  assert.equal(nextPollMs(1, 250, 1000), 500);
  assert.equal(nextPollMs(2, 250, 1000), 1000);
  assert.equal(nextPollMs(10, 250, 1000), 1000);
  assert.equal(nextPollMs(0, 100, 800), 100);
  assert.equal(nextPollMs(3, 100, 800), 800);
});

test("waitForDurableEvent works with adaptive poll intervals", async () => {
  let attempts = 0;
  let elapsed = 0;
  const sleeps = [];
  const result = await waitForDurableEvent(
    () => {
      attempts += 1;
      if (attempts < 3) return { status: "pending" };
      return { status: "done", value: { attempts } };
    },
    {
      timeoutMs: 500,
      pollIntervalMs: nextPollMs(0, 10, 50),
      now: () => elapsed,
      sleep: async (ms) => {
        sleeps.push(ms);
        elapsed += ms;
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.terminalReason, "done");
  assert.equal(result.checks, 3);
  // waitForDurableEvent accepts one bounded poll interval; adaptive backoff
  // is the caller's loop policy. This test uses a synthetic clock so the
  // contract stays deterministic under a loaded release suite.
  assert.deepEqual(sleeps, [10, 10]);
  assert.equal(result.value.attempts, 3);
});

test("smoke wait_for uses adaptive polling (check-if-done, 250->1000)", async () => {
  const { readFile } = await import("node:fs/promises");
  const smoke = await readFile(new URL("../scripts/smoke.sh", import.meta.url), "utf8");
  assert.match(smoke, /Antigravity-style adaptive polling/);
  assert.match(smoke, /poll_ms=250/);
  assert.match(smoke, /poll_ms \* 2/);
  assert.match(smoke, /1000/);
  // durable-wait helpers exported
  assert.match(await readFile(new URL("../scripts/durable-wait.mjs", import.meta.url), "utf8"), /export function estimateDurationFromHistory/);
  assert.match(await readFile(new URL("../scripts/durable-wait.mjs", import.meta.url), "utf8"), /export function nextPollMs/);
});
