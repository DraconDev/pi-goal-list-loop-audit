// v0.38.104: the single automatic continuation retry must not claim a durable
// state it could not write. It used to mutate the live pending dispatch in RAM
// and discard persistDispatchRecord's boolean, so an unwritable .pi-glla left
// RAM saying retryCount=1 while the sidecar said 0 — a reload then re-armed
// the start watchdog and re-sent the identical payload.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlySetContinuationRetryBackoff,
  __testOnlySetContinuationStartTimeout,
} from "../extensions/loops/goal.js";
import { resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for the continuation retry state");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
}

function ledgerText(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  } catch {
    return "";
  }
}

function context(cwd: string, name: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: { name } });
}

let lastCwd = "";

afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  resetContinuationDispatchState(lastCwd);
  __testOnlySetContinuationStartTimeout(null);
  __testOnlySetContinuationRetryBackoff(null);
  pi.sent.length = 0;
});

test("v0.38.104 a retry that cannot be persisted is reported, not recorded as durable", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(250);
  __testOnlySetContinuationRetryBackoff(250);
  const cwd = tmpCwd();
  resetContinuationDispatchState(cwd);
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  lastCwd = cwd;
  const ctx = context(cwd, `retry-persist-${Date.now()}-${Math.random()}`);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.command("goal", "persistence-failure retry target — done when pinned", ctx);
    await tick();
    await waitUntil(() => pi.sent.length >= 1);
    const first = pi.sent[0]!.message.content ?? "";
    assert.ok(first.length > 0, "the first continuation was sent");

    // Break ONLY the dispatch sidecar: a directory at the record path makes
    // the atomic temp+rename fail from here on, so the retry's persist is the
    // first write to fail.
    const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
    fs.rmSync(sidecar, { force: true });
    fs.mkdirSync(sidecar, { recursive: true });

    // The start watchdog fires with no turn-start proof → the ONE automatic
    // retry. The send happens before the persist, so it must still land …
    await waitUntil(() => pi.sent.length >= 2, 8_000);
    assert.equal(pi.sent[1]!.message.content, first, "the retry re-sends the verbatim original payload");
    // … but the unrecordable retry is reported instead of ledgered as sent.
    await waitUntil(() => ledgerText(cwd).includes("continuation_retry_persist_failed"));
    const ledger = ledgerText(cwd);
    assert.doesNotMatch(ledger, /continuation_retry_sent/, "no durable 'retry sent' claim for an unpersisted retry");
    assert.match(ledger, /"retryWasSent":true/, "the ledger still records that the payload WAS sent");

    // Fail closed: the stood-down unacknowledged path runs instead of the
    // retry backoff, so no third automatic send is scheduled.
    const sendsAfterFailure = pi.sent.length;
    await tick(700);
    assert.equal(pi.sent.length, sendsAfterFailure, "no further automatic re-send after the unrecoverable persist failure");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("v0.38.104 a persistable retry still records retryCount durably", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(250);
  __testOnlySetContinuationRetryBackoff(250);
  const cwd = tmpCwd();
  resetContinuationDispatchState(cwd);
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  lastCwd = cwd;
  const ctx = context(cwd, `retry-durable-${Date.now()}-${Math.random()}`);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
  try {
    await pi.command("goal", "durable retry target — done when pinned", ctx);
    await tick();
    await waitUntil(() => ledgerText(cwd).includes("continuation_retry_sent"));
    const record = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { retryCount?: number; phase?: string };
    assert.equal(record.retryCount, 1, "the durable record carries the retry, not just RAM");
    assert.equal(record.phase, "accepted", "the retried record is still the accepted dispatch the watchdog watches");
    assert.doesNotMatch(ledgerText(cwd), /continuation_retry_persist_failed/);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
