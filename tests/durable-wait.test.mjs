import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  waitForDurableEvent,
  readDurableDirectoryCount,
  readDurableFile,
} from "../scripts/durable-wait.mjs";

async function scratchFile() {
  const directory = await mkdtemp("/tmp/glla-durable-wait-");
  const file = path.join(directory, "active.jsonl");
  await writeFile(file, '{"event":"pending"}\n');
  return { directory, file };
}

async function cleanup(directory, timers) {
  for (const timer of timers) clearTimeout(timer);
  await rm(directory, { recursive: true, force: true });
}

// Control fixture time, not the production deadline: real file IO remains
// awaited, so loaded CI cannot turn a 10ms fixture write into a late result.
function fixtureClock(afterSleep) {
  let elapsed = 0;
  let written = false;
  return {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
      if (!written) {
        written = true;
        await afterSleep();
      }
    },
  };
}

test("durable wait succeeds before its deadline and reports elapsed polling", async () => {
  const { directory, file } = await scratchFile();
  const timers = [];
  const clock = fixtureClock(() => appendFile(file, '{"event":"done"}\n'));
  try {
    const result = await waitForDurableEvent(
      () => readDurableFile(file, { doneNeedles: ['"event":"done"'] }),
      { timeoutMs: 250, pollIntervalMs: 5, ...clock },
    );
    assert.equal(result.ok, true);
    assert.equal(result.terminalReason, "done");
    assert.ok(result.elapsedMs < 250, `wait took ${result.elapsedMs}ms`);
    assert.ok(result.checks >= 2, "the reader was polled after the initial read");
  } finally {
    await cleanup(directory, timers);
  }
});

test("durable wait returns a real timeout instead of treating elapsed time as success", async () => {
  const { directory, file } = await scratchFile();
  try {
    const result = await waitForDurableEvent(
      () => readDurableFile(file, { doneNeedles: ['"event":"never"'] }),
      { timeoutMs: 30, pollIntervalMs: 5, ...fixtureClock(async () => {}) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.terminalReason, "timeout");
    assert.ok(result.elapsedMs >= 30, `timeout returned early at ${result.elapsedMs}ms`);
    assert.ok(result.elapsedMs < 300, `timeout exceeded its bound at ${result.elapsedMs}ms`);
  } finally {
    await cleanup(directory, []);
  }
});

test("a late done observation after the deadline is a timeout, not success", async () => {
  let clock = 0;
  const result = await waitForDurableEvent(
    () => {
      clock = 11;
      return { status: "done" };
    },
    { timeoutMs: 10, pollIntervalMs: 1, now: () => clock, sleep: async () => {} },
  );
  assert.equal(result.ok, false);
  assert.equal(result.terminalReason, "timeout");
  assert.equal(result.elapsedMs, 11);
});

test("archive-count waits use the same durable deadline and return the observed count", async () => {
  const { directory } = await scratchFile();
  const timers = [];
  const clock = fixtureClock(() => writeFile(path.join(directory, "two.md"), ""));
  try {
    await writeFile(path.join(directory, "one.md"), "");
    const result = await waitForDurableEvent(
      () => readDurableDirectoryCount(directory, { minimum: 2 }),
      { timeoutMs: 250, pollIntervalMs: 5, ...clock },
    );
    assert.equal(result.ok, true);
    assert.equal(result.terminalReason, "done");
    assert.equal(result.value.count, 2);
  } finally {
    await cleanup(directory, timers);
  }
});

test("a restarted waiter observes the same durable file without an old timer", async () => {
  const { directory, file } = await scratchFile();
  const timers = [];
  const firstClock = fixtureClock(() => appendFile(file, '{"event":"restart"}\n'));
  try {
    const first = await waitForDurableEvent(
      () => readDurableFile(file, {
        doneNeedles: ['"event":"done"'],
        terminalNeedles: [{ reason: "restart", needle: '"event":"restart"' }],
      }),
      { timeoutMs: 250, pollIntervalMs: 5, ...firstClock },
    );
    assert.equal(first.terminalReason, "restart");

    const secondClock = fixtureClock(() => appendFile(file, '{"event":"done"}\n'));
    const second = await waitForDurableEvent(
      () => readDurableFile(file, { doneNeedles: ['"event":"done"'] }),
      { timeoutMs: 250, pollIntervalMs: 5, ...secondClock },
    );
    assert.equal(second.ok, true);
    assert.equal(second.terminalReason, "done");
  } finally {
    await cleanup(directory, timers);
  }
});

test("provider recovery is a terminal reason, never a false approval or timeout", async () => {
  const { directory, file } = await scratchFile();
  const timers = [];
  try {
    const result = await waitForDurableEvent(
      () => readDurableFile(file, {
        doneNeedles: ['"approved":true'],
        terminalNeedles: [{ reason: "provider-failure", needle: '"event":"main_model_recovery_wait"' }],
      }),
      { timeoutMs: 250, pollIntervalMs: 5, ...fixtureClock(async () => {
        await appendFile(file, JSON.stringify({ event: "main_model_recovery_wait" }) + "\n");
      }) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.terminalReason, "provider-failure");
    assert.ok(result.elapsedMs < 250, "provider failure should end the wait promptly");
  } finally {
    await cleanup(directory, timers);
  }
});

test("smoke harness uses the durable wait CLI for durable outcomes", async () => {
  const smoke = await readFile(new URL("../scripts/smoke.sh", import.meta.url), "utf8");
  assert.match(smoke, /scripts\/durable-wait\.mjs/);
  assert.match(smoke, /wait_for_durable/);
  assert.match(smoke, /wait_for_archive_count/);
});

