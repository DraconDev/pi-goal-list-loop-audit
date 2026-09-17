import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForDurableEvent, readDurableFile } from "../scripts/durable-wait.mjs";

// Isolate production durable reads from event-delivery timing: the complete
// file exists before waiting. No timers, append races, or injected clock.
for (const scenario of [
  { name: "completion", value: { approved: true }, reason: "done", ok: true },
  { name: "provider failure", value: { event: "main_model_recovery_wait" }, reason: "provider-failure", ok: false },
  { name: "failure takes precedence over approval", value: { approved: true, event: "main_model_recovery_wait" }, reason: "provider-failure", ok: false },
]) {
  test(`prewritten durable state: ${scenario.name}`, { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "glla-prewritten-"));
    const file = path.join(directory, "active.jsonl");
    try {
      await writeFile(file, JSON.stringify(scenario.value) + "\n");
      const result = await waitForDurableEvent(
        () => readDurableFile(file, {
          doneNeedles: ['"approved":true'],
          terminalNeedles: [{ reason: "provider-failure", needle: '"event":"main_model_recovery_wait"' }],
        }),
        { timeoutMs: 5_000, pollIntervalMs: 5 },
      );
      assert.equal(result.ok, scenario.ok);
      assert.equal(result.terminalReason, scenario.reason);
      assert.equal(result.checks, 1, "prewritten state resolves on the first production read");
      assert.ok(result.elapsedMs <= 5_000, "observation remains within its deadline");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
